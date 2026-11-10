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
