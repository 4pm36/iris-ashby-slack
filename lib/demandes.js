// Demandes de feedback envoyées par Iris en message privé, à la fin de chaque entretien.
// Le message contient le feedback global (zone de texte) puis un bouton par note (vert 4-3, rouge 2-1) qui envoie.
// Iris enregistre le feedback dans Ashby au nom de l'intervieweur puis le poste dans le thread du candidat.
// Une seule relance, 30 min après la fin de l'entretien, si le feedback n'est toujours pas soumis.

import {
  JOB_CHANNELS,
  ashby,
  listAll,
  getApplication,
  getInterview,
  slack,
  slackGet,
  slackUserId,
  postMessage,
  formatDate,
} from "./iris.js";

const MIN = 60 * 1000;
const WINDOW = 15 * MIN; // marge si un passage du cron est manqué (le repère évite les doublons)
const RELANCE_AFTER = 30 * MIN;

// ===== Envoi des demandes (appelé chaque minute par le cron) =====
export async function sendFeedbackRequests(now) {
  const t = now.getTime();
  const schedules = await listAll("interviewSchedule.list", { createdAfter: t - 30 * 24 * 60 * MIN });

  const todo = [];
  for (const s of schedules) {
    if (!/scheduled|complete/i.test(String(s.status))) continue;
    for (const ev of s.interviewEvents ?? []) {
      // Fin de l'entretien, ou création du créneau s'il a été ajouté dans Ashby après coup
      const end = Math.max(Date.parse(ev.endTime), Date.parse(ev.createdAt ?? 0) || 0);
      if (end <= t && end > t - WINDOW) todo.push({ s, ev, kind: "demande" });
      else if (end <= t - RELANCE_AFTER && end > t - RELANCE_AFTER - WINDOW) todo.push({ s, ev, kind: "relance" });
    }
  }

  let sent = 0;
  const feedbackCache = new Map();
  for (const { s, ev, kind } of todo) {
    try {
      const application = await getApplication(s.applicationId);
      if (!JOB_CHANNELS[application.job?.id]) continue; // poste pas (encore) branché

      if (!feedbackCache.has(application.id))
        feedbackCache.set(application.id, await listAll("applicationFeedback.list", { applicationId: application.id }));
      const done = feedbackCache.get(application.id);

      for (const user of ev.interviewers ?? []) {
        if (user.isFeedbackRequired === false) continue;
        if (done.some((f) => f.interviewEventId === ev.id && f.submittedByUser?.id === user.id)) continue;
        sent += await sendRequest({ application, ev, user, kind });
      }
    } catch (e) {
      console.error("demande feedback", ev.id, e);
    }
  }
  return { checked: todo.length, sent };
}

async function sendRequest({ application, ev, user, kind }) {
  const slackId = await slackUserId(user);
  if (!slackId) return 0;

  // Déjà envoyé ? On relit les derniers messages privés d'Iris avec cette personne.
  let dm = slackId;
  if (!process.env.DRY_RUN) {
    dm = (await slack("conversations.open", { users: slackId })).channel.id;
    const history = await slackGet("conversations.history", { channel: dm, limit: 100, include_all_metadata: true });
    const already = history.messages.some(
      (m) =>
        m.metadata?.event_type === "iris_demande" &&
        m.metadata.event_payload?.event_id === ev.id &&
        m.metadata.event_payload?.kind === kind
    );
    if (already) return 0;
  }

  const interview = await getInterview(ev.interviewId);
  const form = await formFor(ev.interviewId);
  const name = application.candidate.name;
  const intro =
    kind === "relance"
      ? `⏰ Petit rappel : ton feedback sur *${name}* (entretien ${interview.title} ${formatDate(ev.startTime)}) est toujours attendu.`
      : `Ton entretien *${interview.title}* avec *${name}* vient de se terminer. Donne ton feedback ici, il sera enregistré dans Ashby et ajouté au thread du candidat.`;

  // Tout ce qu'il faut pour enregistrer le feedback, porté par chaque bouton de note (+ la note elle-même)
  const meta = { a: application.id, e: ev.id, u: user.id, n: name, f: form.formId, np: form.note.path, tp: form.text.path };

  // Un bouton par note : vert pour 4 et 3, rouge pour 2 et 1. Cliquer sur la note envoie le feedback.
  const noteButtons = [...(form.note.selectableValues ?? [])]
    .filter((o) => !o.isArchived)
    .sort((a, b) => Number(b.value) - Number(a.value))
    .map((o) => ({
      type: "button",
      style: Number(o.value) >= 3 ? "primary" : "danger",
      text: { type: "plain_text", text: String(o.value) }, // juste le chiffre
      action_id: `iris_note_${o.value}`,
      value: JSON.stringify({ ...meta, v: String(o.value) }),
    }));

  await postMessage({
    channel: dm,
    text: intro,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: intro } },
      {
        type: "input",
        block_id: "texte",
        label: { type: "plain_text", text: "Feedback global" },
        element: { type: "plain_text_input", action_id: "v", multiline: true },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Puis clique sur ta note pour envoyer 👇" }] },
      { type: "actions", block_id: "note", elements: noteButtons },
      ...(ev.feedbackLink
        ? [{ type: "context", elements: [{ type: "mrkdwn", text: `<${ev.feedbackLink}|Ouvrir dans Ashby>` }] }]
        : []),
    ],
    metadata: { event_type: "iris_demande", event_payload: { event_id: ev.id, kind } },
  });
  return 1;
}

// Champs "note globale" et "feedback global" du formulaire de l'entretien
const formCache = new Map();
async function formFor(interviewId) {
  const formId = (await getInterview(interviewId)).feedbackFormDefinitionId;
  if (!formCache.has(formId)) {
    const def = (await ashby("feedbackFormDefinition.info", { feedbackFormDefinitionId: formId })).results;
    const fields = def.formDefinition.sections.flatMap((s) => s.fields.map((x) => x.field ?? x));
    const note = fields.find((x) => /overall recommendation/i.test(x.title));
    const text = fields.find((x) => /feedback global/i.test(x.title)) ?? fields.find((x) => x.path === "feedback");
    formCache.set(formId, { formId, note, text });
  }
  return formCache.get(formId);
}

// ===== Clic sur "Envoyer" : enregistre le feedback dans Ashby au nom de l'intervieweur =====
// Renvoie le feedback tel qu'Ashby l'a enregistré.
export async function submitFeedback(value, text) {
  const m = JSON.parse(value);
  const note = m.v;
  const body = {
    applicationId: m.a,
    interviewEventId: m.e,
    userId: m.u,
    formDefinitionId: m.f,
    feedbackForm: {
      fieldSubmissions: [
        { path: m.np, value: note },
        { path: m.tp, value: { type: "text/plain", value: text } },
      ],
    },
  };
  // Jusqu'à 3 essais (coupure réseau ou Ashby momentanément indisponible)
  for (let attempt = 1; ; attempt++) {
    try {
      await ashby("applicationFeedback.submit", body);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  const all = await listAll("applicationFeedback.list", { applicationId: m.a });
  const feedback = all
    .filter((f) => f.interviewEventId === m.e && f.submittedByUser?.id === m.u)
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))[0];
  return { feedback, name: m.n, note };
}
