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

// Lectures Slack en POST "form-urlencoded" (format accepté par toutes les méthodes Slack).
async function slackGet(method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
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
    const json = await slackGet("conversations.history", { channel, limit: 200, ...(cursor ? { cursor } : {}) });
    const hit = json.messages.find((m) => m.text?.includes(`/applications/${applicationId}`));
    if (hit) return hit.ts;
    cursor = json.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

// Textes déjà postés dans le thread (message principal + réponses), pour éviter les doublons.
async function threadTexts(channel, ts) {
  let json;
  try {
    json = await slackGet("conversations.replies", { channel, ts, limit: 200 });
  } catch (e) {
    console.error(e); // on poste quand même plutôt que de bloquer
    return [];
  }
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return json.messages.map((m) => unescape(m.text || ""));
}

// ===== Format des messages =====
// "le mar. 28/10 à 14h" ou "le mar. 28/10 à 14h30"
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
  return `le ${parts.weekday} ${parts.day}/${parts.month} à ${Number(parts.hour)}h${min}`;
}

// Tag Slack de l'interviewer (retrouvé par son email). Si introuvable : son prénom.
const slackIdCache = new Map();
async function mention(user) {
  if (!user?.email) return user?.firstName || "";
  if (!slackIdCache.has(user.email)) {
    let id = null;
    try {
      id = (await slackGet("users.lookupByEmail", { email: user.email })).user.id;
    } catch {}
    slackIdCache.set(user.email, id);
  }
  const id = slackIdCache.get(user.email);
  return id ? `<@${id}>` : user.firstName;
}

async function interviewers(event) {
  const tags = [];
  for (const u of event.interviewers || []) tags.push(await mention(u));
  return tags.filter(Boolean).join(", ");
}

// ===== Webhook =====
// Brique 1 : un entretien est planifié -> thread du candidat dans le channel du poste.
// Message : "<Candidat (lien Ashby)> a pris RDV pour son entretien <Titre> avec @interviewer"
// - pas encore de thread : ce message devient le thread du candidat
// - thread existant : on répond dedans
// Chaque message contient l'id du planning Ashby dans son lien : un même planning n'est jamais posté deux fois.
// Le thread est retrouvé dans Slack grâce au lien Ashby du message principal : rien n'est stocké ailleurs.
// Pas encore géré : feedbacks, changements d'étape, annulations.


export async function POST(request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("ashby-signature"))) {
    return new Response("bad signature", { status: 401 });
  }

  const payload = JSON.parse(raw);
  if (payload.action === "ping") return new Response("pong");
  if (payload.action === "applicationUpdate") {
    // Test : savoir si Ashby envoie ce webhook quand un feedback est soumis (on ne poste rien).
    const a = payload.data?.application;
    console.log("applicationUpdate", a?.id, a?.status, a?.currentInterviewStage?.title, Object.keys(payload.data || {}).join(","));
    return new Response("ok");
  }

  if (["interviewScheduleCreate", "interviewScheduleUpdate"].includes(payload.action)) {
    const sc = payload.data.interviewSchedule;
    console.log(payload.action, sc.id, sc.status, `${sc.interviewEvents?.length ?? 0} créneau(x)`); // visible dans les logs Vercel
    await onInterviewScheduled(payload.data.interviewSchedule);
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

  const name = application.candidate.name;
  const link = `https://app.ashbyhq.com/candidates/${application.candidate.id}/applications/${application.id}/feed`;

  let ts = await findThread(channel, application.id);
  const already = ts ? await threadTexts(channel, ts) : [];

  const events = [...schedule.interviewEvents].sort(
    (a, b) => new Date(a.startTime) - new Date(b.startTime)
  );
  for (const event of events) {
    // Repère invisible (dans le lien) : planning + heure. Même heure = déjà posté ; nouvelle heure = RDV décalé, on reposte.
    const key = `s=${schedule.id}.${Date.parse(event.startTime) / 1000}`;
    if (already.some((t) => t.includes(key))) continue;
    const interview = await getInterview(event.interviewId);
    const who = await interviewers(event);
    const text =
      `<${link}?${key}|${name}> a pris RDV pour son entretien ${interview.title}` +
      (who ? ` avec ${who}` : "") +
      ` ${formatDate(event.startTime)}`;
    const posted = await postMessage({ channel, text, threadTs: ts });
    if (!ts) ts = posted; // le premier message devient le thread du candidat
  }
}

// Annulation : on retrouve dans le thread les RDV postés pour ce planning et pas encore annulés,
// et on poste pour chacun : "L'entretien <Titre> de <Candidat> prévu le mar. 27/10 à 12h15 a été annulé"
async function onInterviewCancelled(schedule) {
  const application = await getApplication(schedule.applicationId);
  const channel = JOB_CHANNELS[application.job?.id];
  if (!channel) return;

  const ts = await findThread(channel, application.id);
  if (!ts) return;
  const texts = await threadTexts(channel, ts);

  const name = application.candidate.name;
  const base = `https://app.ashbyhq.com/candidates/${application.candidate.id}/applications/${application.id}/feed`;
  const booked = new RegExp(`s=${schedule.id}\\.(\\d+)\\|`);

  for (const t of texts) {
    const m = t.match(booked);
    if (!m) continue;
    const key = `c=${schedule.id}.${m[1]}`;
    if (texts.some((x) => x.includes(key))) continue; // déjà annoncé
    const title = (t.match(/pour son entretien (.+?) (?:avec .+ )?le \S+ \d{2}\/\d{2} à \S+$/) || [])[1] || "";
    const when = formatDate(new Date(Number(m[1]) * 1000).toISOString());
    await postMessage({
      channel,
      threadTs: ts,
      text: `L'entretien${title ? " " + title : ""} de <${base}?${key}|${name}> prévu ${when} a été annulé`,
    });
    texts.push(key);
  }
}
