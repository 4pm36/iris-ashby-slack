// Iris — suivi des candidats, appelé toutes les minutes (cron-job.org, header Authorization: Bearer CRON_SECRET)
//
// 1. Feedbacks : Ashby ne prévient pas quand un feedback est soumis, donc Iris regarde chaque minute
//    les feedbacks soumis dans l'heure et poste dans le thread du candidat :
//    "@auteur a mis la note de X avec ce feedback : "…"" puis, selon l'étape et la note, un message de suite.
// 2. Relances (une fois par heure) : candidat toujours en entretien final 48 h puis 7 jours après celui-ci.
//
// Doublons : chaque message posté porte un repère invisible (metadata Slack), relu avant de poster.
// Test à la main : /api/cron/suivi?relances=1 (force les relances), avec le header Authorization.

import {
  JOB_CHANNELS,
  listAll,
  getApplication,
  applicationLink,
  jobPlan,
  recruiterOf,
  hiringManagerOf,
  postMessage,
  findThread,
  threadMessages,
  hasMarker,
  mention,
} from "../../lib/iris.js";

// feedbacks soumis dans la dernière heure (FEEDBACK_WINDOW_MIN : autre durée, pour les tests en local)
const FEEDBACK_WINDOW_MS = Number(process.env.FEEDBACK_WINDOW_MIN || 60) * 60 * 1000;
const HOUR = 3600 * 1000;

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const now = new Date();
  const forceReminders = new URL(request.url).searchParams.get("relances") === "1";

  const feedbacks = await processFeedbacks(now);
  const reminders = forceReminders || now.getUTCMinutes() === 0 ? await processReminders(now) : null;
  return Response.json({ feedbacks, reminders });
}

// ===== 1. Feedbacks =====

// Note globale (1 à 4) et feedback global, lus d'après le formulaire.
function readFeedback(f) {
  const fields = (f.formDefinition?.sections ?? []).flatMap((s) => (s.fields ?? []).map((x) => x.field ?? x));
  const noteField = fields.find((x) => /overall recommendation/i.test(x.title)) ?? { path: "overall_recommendation" };
  const textField = fields.find((x) => /feedback global/i.test(x.title)) ?? { path: "feedback" };

  let note = f.submittedValues?.[noteField.path];
  const label = noteField.selectableValues?.find((s) => String(s.value) === String(note))?.label;
  note = parseInt(label ?? note, 10);

  let text = f.submittedValues?.[textField.path];
  if (text && typeof text === "object") text = text.value ?? "";
  return { note: Number.isFinite(note) ? note : null, text: String(text ?? "").trim() };
}

async function processFeedbacks(now) {
  const since = now.getTime() - FEEDBACK_WINDOW_MS;
  const all = await listAll("applicationFeedback.list", { createdAfter: since });
  const recent = all
    .filter((f) => f.submittedAt && Date.parse(f.submittedAt) >= since)
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));

  let posted = 0;
  for (const f of recent) {
    try {
      posted += await handleFeedback(f);
    } catch (e) {
      console.error("feedback", f.id, e); // on continue avec les autres
    }
  }
  return { checked: recent.length, posted };
}

async function handleFeedback(f) {
  const application = await getApplication(f.applicationId);
  const channel = JOB_CHANNELS[application.job?.id];
  if (!channel) return 0; // poste pas (encore) branché

  const ts = await findThread(channel, application.id);
  if (!ts) {
    console.log("feedback", f.id, "pas de thread pour la candidature", application.id);
    return 0;
  }
  const messages = await threadMessages(channel, ts);
  const sameFeedback = (p) => p.feedback_id === f.id;
  let count = 0;

  const { note, text } = readFeedback(f);
  const author = await mention(f.submittedByUser);

  if (!hasMarker(messages, "iris_feedback", sameFeedback)) {
    const body = text ? ` avec ce feedback : "${text}"` : "";
    await postMessage({
      channel,
      threadTs: ts,
      text: `${author} a mis la note de ${note ?? "?"}${body}`,
      metadata: { event_type: "iris_feedback", event_payload: { feedback_id: f.id } },
    });
    count++;
  }

  if (!hasMarker(messages, "iris_suite", sameFeedback)) {
    const plan = await jobPlan(application.job.id);
    const kind = plan.kindByStage.get(plan.stageByInterview.get(f.interviewId)) ?? null;
    const suite = await followUp(kind, note, application, f);
    if (suite) {
      await postMessage({
        channel,
        threadTs: ts,
        text: suite,
        metadata: { event_type: "iris_suite", event_payload: { feedback_id: f.id } },
      });
      count++;
    }
  }
  return count;
}

// Message selon l'étape et la note (rien pour l'entretien final)
async function followUp(kind, note, application, f) {
  if (!note) return null;
  if (kind === "screening") {
    // le recruteur est l'auteur du feedback de screening
    const recruiter = await mention(f.submittedByUser);
    if (note <= 2) return `${recruiter}, n'oublie pas d'envoyer un mail de refus`;
    if (note === 3) return `${await mention(await hiringManagerOf(application))}, que penses-tu de ce profil ?`;
    return null;
  }
  if (kind === "hm") {
    const recruiter = await mention(await recruiterOf(application));
    if (note <= 2)
      return `${recruiter}, malheureusement le candidat a échoué à cette étape, pense à lui envoyer un mail de refus 😢`;
    return `${recruiter}, le candidat a réussi son entretien, il peut passer à l'étape suivante 🎉`;
  }
  return null;
}

// ===== 2. Relances après l'entretien final =====

async function processReminders(now) {
  let posted = 0;
  for (const [jobId, channel] of Object.entries(JOB_CHANNELS)) {
    if (!channel) continue;
    const plan = await jobPlan(jobId);
    const apps = await listAll("application.list", { jobId, status: "Active" });
    for (const application of apps) {
      // Toujours à l'étape de l'entretien final (pas passé en Offer / Archivé / References)
      if (plan.kindByStage.get(application.currentInterviewStage?.id) !== "final") continue;
      try {
        posted += await remind(application, channel, now);
      } catch (e) {
        console.error("relance", application.id, e);
      }
    }
  }
  return { posted };
}

async function remind(application, channel, now) {
  const ts = await findThread(channel, application.id);
  if (!ts) return 0;
  const messages = await threadMessages(channel, ts);

  // Fin de l'entretien final = fin du dernier créneau du planning final posté par Iris
  const ends = messages
    .filter((m) => m.metadata?.event_type === "iris_final")
    .map((m) => Number(m.metadata.event_payload?.end));
  if (!ends.length) return 0;
  const elapsed = now.getTime() - Math.max(...ends) * 1000;

  let delay = null;
  if (elapsed >= 7 * 24 * HOUR) delay = "7 jours";
  else if (elapsed >= 48 * HOUR) delay = "48 h";
  if (!delay || hasMarker(messages, "iris_relance", (p) => p.delay === delay)) return 0;

  const full = await getApplication(application.id); // hiringTeam complet
  const recruiter = await mention(await recruiterOf(full));
  const name = `<${applicationLink(full)}|${full.candidate.name}>`;
  await postMessage({
    channel,
    threadTs: ts,
    text: `${recruiter}, ${name} a passé son entretien final il y a plus de ${delay}, n'oublie pas de lui faire un retour.`,
    metadata: { event_type: "iris_relance", event_payload: { delay } },
  });
  return 1;
}
