import crypto from "node:crypto";
import {
  JOB_CHANNELS,
  verifySignature,
  getApplication,
  getInterview,
  applicationLink,
  jobPlan,
  postMessage,
  findThread,
  threadMessages,
  hasMarker,
  formatDate,
  formatDay,
  formatHour,
  mentionAll,
} from "../lib/iris.js";

// ===== Webhook =====
// Un entretien est planifié -> thread du candidat dans le channel du poste.
// - Screening / Hiring Manager : "<Candidat (lien Ashby)> a pris RDV pour son entretien <Étape> avec @interviewer le …"
// - Final : message avec le planning complet des interviews
// - pas encore de thread : ce message devient le thread du candidat
// - thread existant : on répond dedans
// Chaque message contient l'id du planning Ashby dans son lien : un même planning n'est jamais posté deux fois.
// Le thread est retrouvé dans Slack grâce au lien Ashby du message principal : rien n'est stocké ailleurs.
// Les feedbacks et les relances sont gérés par api/cron/suivi.js.

const STAGE_LABELS = { screening: "Recruiter/Initial Screen", hm: "Hiring Manager" };

export async function POST(request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("ashby-signature"))) {
    return new Response("bad signature", { status: 401 });
  }

  const payload = JSON.parse(raw);
  if (payload.action === "ping") return new Response("pong");

  if (["interviewScheduleCreate", "interviewScheduleUpdate"].includes(payload.action)) {
    const sc = payload.data.interviewSchedule;
    console.log(payload.action, sc.id, sc.status, `${sc.interviewEvents?.length ?? 0} créneau(x)`); // visible dans les logs Vercel
    await onInterviewScheduled(sc);
  }
  return new Response("ok");
}

async function onInterviewScheduled(schedule) {
  // Dans Ashby, annuler un entretien ne met pas le planning en "Cancelled" :
  // il repasse "à planifier" sans créneau. Tout planning qui n'est plus "Scheduled" = annulation.
  if (schedule.status !== "Scheduled" || !schedule.interviewEvents?.length) return onInterviewCancelled(schedule);

  const application = await getApplication(schedule.applicationId);
  const channel = JOB_CHANNELS[application.job?.id];
  if (!channel) return; // poste pas (encore) branché

  const plan = await jobPlan(application.job.id);
  const kind = plan.kindByStage.get(schedule.interviewStageId) ?? null;

  const events = [...schedule.interviewEvents].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  let ts = await findThread(channel, application.id);
  const already = ts ? await threadMessages(channel, ts) : [];

  if (kind === "final") return postFinalPlanning({ application, schedule, events, channel, ts, already });

  const name = application.candidate.name;
  const link = applicationLink(application);
  for (const event of events) {
    // Repère invisible (dans le lien) : planning + heure. Même heure = déjà posté ; nouvelle heure = RDV décalé, on reposte.
    const key = `s=${schedule.id}.${Date.parse(event.startTime) / 1000}`;
    if (already.some((m) => m.text.includes(key))) continue;
    const label = STAGE_LABELS[kind] ?? (await getInterview(event.interviewId)).title;
    const who = await mentionAll(event.interviewers);
    const text =
      `<${link}?${key}|${name}> a pris RDV pour son entretien ${label}` +
      (who ? ` avec ${who}` : "") +
      ` ${formatDate(event.startTime)}`;
    const posted = await postMessage({ channel, text, threadTs: ts });
    if (!ts) ts = posted; // le premier message devient le thread du candidat
  }
}

// Entretien final : un seul message avec tout le planning.
// Reposté seulement si le planning change (horaires, entretiens ou intervieweurs).
async function postFinalPlanning({ application, schedule, events, channel, ts, already }) {
  const signature = crypto
    .createHash("sha1")
    .update(JSON.stringify(events.map((e) => [e.startTime, e.endTime, e.interviewId, (e.interviewerUserIds ?? []).sort()])))
    .digest("hex")
    .slice(0, 12);
  if (hasMarker(already, "iris_final", (p) => p.schedule_id === schedule.id && p.signature === signature)) return;

  const name = application.candidate.name;
  const link = applicationLink(application);
  const key = `s=${schedule.id}.${Date.parse(events[0].startTime) / 1000}`;

  const lines = [];
  let day = null;
  for (const e of events) {
    const d = formatDay(e.startTime);
    if (d !== day) {
      lines.push(d.charAt(0).toUpperCase() + d.slice(1));
      day = d;
    }
    const title = (await getInterview(e.interviewId)).title;
    const who = await mentionAll(e.interviewers);
    lines.push(`• ${formatHour(e.startTime)}–${formatHour(e.endTime)} · ${title}${who ? ` · ${who}` : ""}`);
  }

  const lea = process.env.SLACK_USER_ID ? `<@${process.env.SLACK_USER_ID}>` : "Léa";
  const text =
    `Hello, nous recevons <${link}?${key}|${name}> pour son entretien final le ${formatDay(events[0].startTime)} ` +
    `pour le poste de ${application.job.title}.\n\n` +
    `Voici son profil : <${link}|Ashby Profile>\n\n` +
    `*Planning des interviews :*\n${lines.join("\n")}\n\n` +
    `Ce thread vous servira à échanger sur le candidat pendant l'entretien. ` +
    `Un feedback vous sera demandé en privé à la fin de votre tour.\n\n` +
    `Si le candidat ne réussit pas le case, signalez-le à ${lea} en lui donnant votre feedback, elle le raccompagnera.\n\n` +
    `Bonne interview ! 😊`;

  const end = Math.max(...events.map((e) => Date.parse(e.endTime) / 1000));
  await postMessage({
    channel,
    text,
    threadTs: ts ?? undefined,
    metadata: { event_type: "iris_final", event_payload: { schedule_id: schedule.id, signature, end } },
  });
}

// Annulation : on retrouve dans le thread les RDV postés pour ce planning et pas encore annulés,
// et on poste pour chacun : "L'entretien <Titre> de <Candidat> prévu le mar. 27/10 à 12h15 a été annulé"
async function onInterviewCancelled(schedule) {
  const application = await getApplication(schedule.applicationId);
  const channel = JOB_CHANNELS[application.job?.id];
  if (!channel) return;

  const ts = await findThread(channel, application.id);
  if (!ts) return;
  const texts = (await threadMessages(channel, ts)).map((m) => m.text);

  const name = application.candidate.name;
  const base = applicationLink(application);
  const booked = new RegExp(`s=${schedule.id}\\.(\\d+)\\|`);

  for (const t of texts) {
    const m = t.match(booked);
    if (!m) continue;
    const key = `c=${schedule.id}.${m[1]}`;
    if (texts.some((x) => x.includes(key))) continue; // déjà annoncé
    const title =
      (t.match(/pour son entretien (.+?) (?:avec .+ )?le \S+ \d{2}\/\d{2} à \S+$/) || [])[1] ||
      (t.includes("pour son entretien final") ? "final" : "");
    const when = formatDate(new Date(Number(m[1]) * 1000).toISOString());
    await postMessage({
      channel,
      threadTs: ts,
      text: `L'entretien${title ? " " + title : ""} de <${base}?${key}|${name}> prévu ${when} a été annulé`,
    });
    texts.push(key);
  }
}
