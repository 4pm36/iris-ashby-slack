// Iris — suivi des candidats, appelé toutes les minutes (cron-job.org, header Authorization: Bearer CRON_SECRET)
//
// 1. Demandes de feedback : à la fin d'un entretien, Iris envoie en privé à chaque intervieweur un message avec
//    la note + le feedback à remplir directement dans le message (lib/demandes.js). Relance 30 min après si rien n'est soumis.
// 2. Feedbacks : Ashby ne prévient pas quand un feedback est soumis directement dans Ashby, donc Iris regarde
//    chaque minute les feedbacks soumis dans l'heure et les poste dans le thread du candidat (lib/feedback.js).
// 3. Relances (une fois par heure) : candidat toujours en entretien final 48 h puis 7 jours après celui-ci.
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
  postMessage,
  findThread,
  threadMessages,
  hasMarker,
  mention,
} from "../../lib/iris.js";
import { postFeedback } from "../../lib/feedback.js";
import { sendFeedbackRequests } from "../../lib/demandes.js";

// feedbacks soumis dans la dernière heure (FEEDBACK_WINDOW_MIN : autre durée, pour les tests en local)
const FEEDBACK_WINDOW_MS = Number(process.env.FEEDBACK_WINDOW_MIN || 60) * 60 * 1000;
const HOUR = 3600 * 1000;

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const now = new Date();
  const forceReminders = new URL(request.url).searchParams.get("relances") === "1";

  const demandes = await sendFeedbackRequests(now).catch((e) => (console.error("demandes", e), { error: String(e) }));
  const feedbacks = await processFeedbacks(now);
  const reminders = forceReminders || now.getUTCMinutes() === 0 ? await processReminders(now) : null;
  return Response.json({ demandes, feedbacks, reminders });
}

// ===== Feedbacks soumis dans Ashby =====

async function processFeedbacks(now) {
  const since = now.getTime() - FEEDBACK_WINDOW_MS;
  const all = await listAll("applicationFeedback.list", { createdAfter: since });
  const recent = all
    .filter((f) => f.submittedAt && Date.parse(f.submittedAt) >= since)
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));

  let posted = 0;
  for (const f of recent) {
    try {
      posted += await postFeedback(f);
    } catch (e) {
      console.error("feedback", f.id, e); // on continue avec les autres
    }
  }
  return { checked: recent.length, posted };
}

// ===== Relances après l'entretien final =====

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
