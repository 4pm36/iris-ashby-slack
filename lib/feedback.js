// Feedback soumis -> messages dans le thread du candidat.
// Utilisé par le cron (feedbacks remplis dans Ashby) et par la fenêtre Slack d'Iris (feedbacks remplis dans Slack).

import {
  JOB_CHANNELS,
  getApplication,
  jobPlan,
  recruiterOf,
  hiringManagerOf,
  postMessage,
  findThread,
  threadMessages,
  hasMarker,
  mention,
  applicationLink,
  slack,
  slackGet,
} from "./iris.js";

// Note globale (1 à 4) et feedback global, lus d'après le formulaire.
export function readFeedback(f) {
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

// Poste le feedback (et le message de suite selon la note) dans le thread du candidat.
// Ne poste jamais deux fois le même feedback (repère invisible sur chaque message). Renvoie le nombre de messages postés.
export async function postFeedback(f) {
  const application = await getApplication(f.applicationId);
  const channel = JOB_CHANNELS[application.job?.id];
  if (!channel) return 0; // poste pas (encore) branché

  const plan = await jobPlan(application.job.id);
  const kind = plan.kindByStage.get(plan.stageByInterview.get(f.interviewId)) ?? null;
  // Prise de références, ou feedback saisi dans Ashby sans entretien (ex. ref check) : rien dans le thread
  if (!f.interviewId || kind === "reference") return 0;
  if (kind === "screening") return postScreeningFeedback(f, application, channel);

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
    // Note en gras, feedback à la ligne en citation (chaque ligne précédée de ">")
    const quote = text ? ` avec ce feedback :\n${text.split("\n").map((l) => `>${l}`).join("\n")}` : "";
    await postMessage({
      channel,
      threadTs: ts,
      text: `${author} a mis la note de *${note ?? "?"}*${quote}`,
      metadata: { event_type: "iris_feedback", event_payload: { feedback_id: f.id } },
    });
    count++;
  }

  if (!hasMarker(messages, "iris_suite", sameFeedback)) {
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

// ===== Feedback de screening =====
// Note 3 ou 4 : ouvre le thread du candidat (ou répond dedans s'il existe déjà) :
//   "@recruteur a mis la note de *3* sur <Candidat> ! @hiring manager, tu retrouveras son feedback en thread."
//   puis le feedback en réponse dans le thread.
// Note 1 ou 2 : rien.
async function postScreeningFeedback(f, application, channel) {
  const { note, text } = readFeedback(f);
  if (!note) return 0;
  const name = application.candidate.name;
  const link = applicationLink(application);
  const recruiter = await mention(f.submittedByUser); // le recruteur est l'auteur du feedback de screening

  if (note <= 2) return 0;

  let ts = await findThread(channel, application.id);
  const messages = ts ? await threadMessages(channel, ts) : [];
  const sameFeedback = (p) => p.feedback_id === f.id;
  let count = 0;

  if (!hasMarker(messages, "iris_feedback", sameFeedback)) {
    const hm = await mention(await hiringManagerOf(application));
    // Aucun hiring manager trouvé dans Ashby : on tague Léa à la place
    const lea = process.env.SLACK_USER_ID ? `<@${process.env.SLACK_USER_ID}>` : "Léa";
    const to = hm || `${lea} (pas de hiring manager renseigné dans Ashby pour ce poste)`;
    const metadata = { event_type: "iris_feedback", event_payload: { feedback_id: f.id } };
    const posted = await postMessage({
      channel,
      threadTs: ts ?? undefined,
      text: `${recruiter} a mis la note de *${note}* sur <${link}|${name}> ! ${to}, tu retrouveras son feedback en thread.`,
      metadata,
    });
    count++;
    if (!ts) {
      // Le cron et le clic Slack peuvent traiter le même feedback au même instant : si un autre message
      // pour ce feedback a été posté avant le nôtre, on supprime le nôtre et on s'arrête là (l'autre poste la suite).
      const first = await firstRootFor(channel, f.id);
      if (first && first !== posted) {
        await slack("chat.delete", { channel, ts: posted }).catch(() => {});
        return 0;
      }
      ts = posted;
    }
  }

  if (!hasMarker(messages, "iris_suite", sameFeedback)) {
    const quote = (text || "(pas de commentaire)").split("\n").map((l) => `>${l}`).join("\n");
    await postMessage({
      channel,
      threadTs: ts,
      text: quote,
      metadata: { event_type: "iris_suite", event_payload: { feedback_id: f.id } },
    });
    count++;
  }
  return count;
}

// Plus ancien message principal du channel portant le repère de ce feedback
async function firstRootFor(channel, feedbackId) {
  if (process.env.DRY_RUN) return null;
  const h = await slackGet("conversations.history", { channel, limit: 50, include_all_metadata: true });
  const same = h.messages.filter(
    (m) => m.metadata?.event_type === "iris_feedback" && m.metadata.event_payload?.feedback_id === feedbackId
  );
  return same.length ? same[same.length - 1].ts : null; // l'historique est du plus récent au plus ancien
}

// Message selon l'étape et la note, pour les étapes après le screening (rien pour l'entretien final)
async function followUp(kind, note, application, f) {
  if (!note) return null;
  if (kind === "hm") {
    const recruiter = await mention(await recruiterOf(application));
    if (note <= 2)
      return `${recruiter}, malheureusement le candidat a échoué à cette étape, pense à lui envoyer un mail de refus 😢`;
    return `${recruiter}, le candidat a réussi son entretien, il peut passer à l'étape suivante 🎉`;
  }
  return null;
}
