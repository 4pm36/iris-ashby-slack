import crypto from "node:crypto";

// ===== Configuration =====
// Un poste Ashby -> un channel Slack.
// Pour ajouter un poste plus tard : ajouter une ligne ici.
// L'ID du channel se trouve dans Slack : clic droit sur le channel > Copier le lien (fin de l'URL, commence par "C").
const JOB_CHANNELS = {
  // First RevOps -> channel de test (à remplacer par #hiring-revops après le test)
  "7788d2f2-bbd0-4a8d-8ee5-a778ee2c3099": process.env.SLACK_CHANNEL_REVOPS,
};

const TIMEZONE = "Europe/Paris";

// ===== Ashby =====
const API = "https://api.ashbyhq.com";

async function call(endpoint, body) {
  const auth = Buffer.from(`${process.env.ASHBY_API_KEY}:`).toString("base64");
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Ashby ${endpoint}: ${JSON.stringify(json.errors ?? json)}`);
  return json.results;
}

function verifySignature(rawBody, header) {
  const digest = crypto
    .createHmac("sha256", process.env.ASHBY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(`sha256=${digest}`);
  const received = Buffer.from(header || "");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

const getApplication = (applicationId) => call("application.info", { applicationId });
const getInterview = (id) => call("interview.info", { id });

// ===== Slack =====
async function slack(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

async function postMessage({ channel, text, threadTs }) {
  const json = await slack("chat.postMessage", { channel, text, thread_ts: threadTs, unfurl_links: false });
  return json.ts;
}

// Retrouve le message principal du candidat : celui qui contient le lien vers sa candidature Ashby.
// Parcourt les 1000 derniers messages du channel (largement assez pour un channel de poste).
async function findThread(channel, applicationId) {
  let cursor;
  for (let page = 0; page < 5; page++) {
    const json = await slack("conversations.history", { channel, limit: 200, cursor });
    const hit = json.messages.find((m) => m.text?.includes(`/applications/${applicationId}`));
    if (hit) return hit.ts;
    cursor = json.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

// Textes déjà postés dans le thread (message principal + réponses), pour éviter les doublons.
async function threadTexts(channel, ts) {
  const json = await slack("conversations.replies", { channel, ts, limit: 200 });
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return json.messages.map((m) => unescape(m.text || ""));
}

// ===== Format des messages =====
// "mar. 28/10 14h" ou "mar. 28/10 14h30"
function formatDate(iso) {
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: TIMEZONE,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const min = parts.minute === "00" ? "" : parts.minute;
  return `${parts.weekday} ${parts.day}/${parts.month} ${Number(parts.hour)}h${min}`;
}

function interviewers(event) {
  return (event.interviewers || []).map((u) => u.firstName).join(", ");
}

// "Screening mar. 28/10 14h · Wallerand"
function eventLine(title, event) {
  return [`${title} ${formatDate(event.startTime)}`, interviewers(event)].filter(Boolean).join(" · ");
}

// ===== Webhook =====
// Brique 1 : un entretien est planifié -> thread du candidat dans le channel du poste.
// - pas encore de thread : on le crée ("🆕 ...")
// - thread existant : on répond dedans ("📅 ...")
// Le thread est retrouvé dans Slack grâce au lien Ashby du message principal : rien n'est stocké ailleurs.
// Pas encore géré : feedbacks, changements d'étape, annulations.


export async function POST(request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("ashby-signature"))) {
    return new Response("bad signature", { status: 401 });
  }

  const payload = JSON.parse(raw);
  if (payload.action === "ping") return new Response("pong");

  if (["interviewScheduleCreate", "interviewScheduleUpdate"].includes(payload.action)) {
    await onInterviewScheduled(payload.data.interviewSchedule);
  }
  return new Response("ok");
}

async function onInterviewScheduled(schedule) {
  if (schedule.status !== "Scheduled" || !schedule.interviewEvents?.length) return;

  const application = await getApplication(schedule.applicationId);
  const channel = JOB_CHANNELS[application.job?.id];
  if (!channel) return; // poste pas (encore) branché

  const events = [...schedule.interviewEvents].sort(
    (a, b) => new Date(a.startTime) - new Date(b.startTime)
  );
  const lines = [];
  for (const event of events) {
    const interview = await getInterview(event.interviewId);
    lines.push(eventLine(interview.title, event));
  }

  const name = application.candidate.name;
  const link = `https://app.ashbyhq.com/candidates/${application.candidate.id}/applications/${application.id}/feed`;

  let ts = await findThread(channel, application.id);
  let toPost = lines;
  if (!ts) {
    const [first, ...rest] = lines;
    ts = await postMessage({ channel, text: `🆕 *${name}* · ${first} · <${link}|Ashby>` });
    toPost = rest;
  } else {
    // Ashby renvoie le même planning à chaque modification : on ne reposte pas une ligne déjà présente.
    const already = await threadTexts(channel, ts);
    toPost = lines.filter((line) => !already.some((t) => t.includes(line)));
  }
  for (const line of toPost) await postMessage({ channel, threadTs: ts, text: `📅 ${line}` });
}
