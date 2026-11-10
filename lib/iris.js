import crypto from "node:crypto";

// ===== Configuration =====
// Un poste Ashby -> un channel Slack.
// Pour ajouter un poste plus tard : ajouter une ligne ici.
// L'ID du channel se trouve dans Slack : clic droit sur le channel > Copier le lien (fin de l'URL, commence par "C").
export const JOB_CHANNELS = {
  "7788d2f2-bbd0-4a8d-8ee5-a778ee2c3099": "C0C6U9EPCD6", // First RevOps -> #hiring-revops
};

const TIMEZONE = "Europe/Paris";

// ===== Ashby =====
const API = "https://api.ashbyhq.com";

export async function ashby(endpoint, body) {
  const auth = Buffer.from(`${process.env.ASHBY_API_KEY}:`).toString("base64");
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Ashby ${endpoint}: ${JSON.stringify(json.errors ?? json)}`);
  return json;
}
const call = async (endpoint, body) => (await ashby(endpoint, body)).results;

// Toutes les pages d'une liste Ashby
export async function listAll(endpoint, body) {
  const out = [];
  let cursor;
  do {
    const r = await ashby(endpoint, { limit: 100, ...body, ...(cursor ? { cursor } : {}) });
    out.push(...r.results);
    cursor = r.moreDataAvailable ? r.nextCursor : undefined;
  } while (cursor);
  return out;
}

export function verifySignature(rawBody, header) {
  const digest = crypto
    .createHmac("sha256", process.env.ASHBY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const expected = Buffer.from(`sha256=${digest}`);
  const received = Buffer.from(header || "");
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export const getApplication = (applicationId) => call("application.info", { applicationId });

const interviewCache = new Map();
export async function getInterview(id) {
  if (!interviewCache.has(id)) interviewCache.set(id, await call("interview.info", { id }));
  return interviewCache.get(id);
}

export function applicationLink(application) {
  return `https://app.ashbyhq.com/candidates/${application.candidate.id}/applications/${application.id}/feed`;
}

// ===== Étapes =====
// Règle : Screening = "Initial Screen" / "Screencall"
//         Hiring Manager = "First Round" / "HM itw"
//         Final = toute étape active après l'étape Hiring Manager, sauf "References"
const SCREENING = /initial screen|screencall/i;
const HIRING_MANAGER = /first round|hm itw/i;

const planCache = new Map();
// Étapes du poste : id d'étape -> étape (screening / hm / final / null), id d'entretien -> id d'étape
export async function jobPlan(jobId) {
  if (planCache.has(jobId)) return planCache.get(jobId);
  const plan = await call("jobInterviewPlan.info", { jobId });
  const stages = [...plan.stages].sort((a, b) => a.orderInInterviewPlan - b.orderInInterviewPlan);
  const hmOrder = stages.find((s) => HIRING_MANAGER.test(s.title))?.orderInInterviewPlan;
  const kindByStage = new Map();
  const stageByInterview = new Map();
  for (const s of stages) {
    let kind = null;
    if (SCREENING.test(s.title)) kind = "screening";
    else if (HIRING_MANAGER.test(s.title)) kind = "hm";
    else if (hmOrder != null && s.orderInInterviewPlan > hmOrder && s.type === "Active" && !/reference/i.test(s.title))
      kind = "final";
    kindByStage.set(s.id, kind);
    for (const a of s.activities ?? []) for (const i of a.interviews ?? []) stageByInterview.set(i.interviewId, s.id);
  }
  const result = { kindByStage, stageByInterview };
  planCache.set(jobId, result);
  return result;
}

// ===== Recruteur / Hiring manager d'une candidature =====
// Recruteur = la personne qui a fait l'entretien de screening ; hiring manager = celle du First Round.
// Si l'entretien n'a pas (encore) eu lieu : le rôle "Recruiter" / "Hiring Manager" de la Hiring Team Ashby.
async function interviewerOfStage(application, kind) {
  const plan = await jobPlan(application.job.id);
  const schedules = await listAll("interviewSchedule.list", { applicationId: application.id });
  const events = schedules
    .filter((s) => plan.kindByStage.get(s.interviewStageId) === kind && /scheduled|complete/i.test(String(s.status)))
    .flatMap((s) => s.interviewEvents ?? [])
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return events.flatMap((e) => e.interviewers ?? [])[0] ?? null;
}

function hiringTeamRole(application, role) {
  return (application.hiringTeam ?? []).find((m) => m.role === role) ?? null;
}

export async function recruiterOf(application) {
  return (await interviewerOfStage(application, "screening")) ?? hiringTeamRole(application, "Recruiter");
}

export async function hiringManagerOf(application) {
  return (await interviewerOfStage(application, "hm")) ?? hiringTeamRole(application, "Hiring Manager");
}

// ===== Slack =====
export async function slack(method, body) {
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
export async function slackGet(method, params) {
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

// metadata : repère invisible attaché au message ({ event_type, event_payload }), relu pour éviter les doublons.
// DRY_RUN=1 : affiche le message au lieu de le poster (tests en local).
export async function postMessage({ channel, text, threadTs, metadata, blocks }) {
  if (process.env.DRY_RUN) {
    console.log(`\n[DRY RUN] ${threadTs ? `réponse dans le thread ${threadTs}` : "nouveau message"} (${channel})` +
      (metadata ? ` ${JSON.stringify(metadata)}` : "") + `\n${text}` + (blocks ? `\n[+ ${blocks.length} blocs]` : ""));
    return threadTs ?? "dry-run-ts";
  }
  const json = await slack("chat.postMessage", { channel, text, blocks, thread_ts: threadTs, unfurl_links: false, metadata });
  return json.ts;
}

// Retrouve le message principal du candidat : celui qui contient le lien vers sa candidature Ashby.
// Parcourt les 1000 derniers messages du channel (largement assez pour un channel de poste).
export async function findThread(channel, applicationId) {
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

// Messages déjà postés dans le thread (message principal + réponses) : texte + repère invisible.
export async function threadMessages(channel, ts) {
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const out = [];
  let cursor;
  do {
    const json = await slackGet("conversations.replies", {
      channel, ts, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}),
    });
    out.push(...json.messages.map((m) => ({ ts: m.ts, text: unescape(m.text || ""), metadata: m.metadata ?? null })));
    cursor = json.response_metadata?.next_cursor;
  } while (cursor);
  return out;
}

export const hasMarker = (messages, type, test) =>
  messages.some((m) => m.metadata?.event_type === type && test(m.metadata.event_payload ?? {}));

// ===== Format des messages =====
function parisParts(iso) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: TIMEZONE,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
}

// "14h" ou "14h30"
export function formatHour(iso) {
  const p = parisParts(iso);
  return `${Number(p.hour)}h${p.minute === "00" ? "" : p.minute}`;
}

// "mar. 28/10"
export function formatDay(iso) {
  const p = parisParts(iso);
  return `${p.weekday} ${p.day}/${p.month}`;
}

// "le mar. 28/10 à 14h" ou "le mar. 28/10 à 14h30"
export function formatDate(iso) {
  return `le ${formatDay(iso)} à ${formatHour(iso)}`;
}

// Tag Slack d'une personne Ashby (retrouvée par son email). Si introuvable : son prénom.
const slackIdCache = new Map();
export async function slackUserId(user) {
  if (!user?.email) return null;
  if (!slackIdCache.has(user.email)) {
    let id = null;
    try {
      id = (await slackGet("users.lookupByEmail", { email: user.email })).user.id;
    } catch {}
    slackIdCache.set(user.email, id);
  }
  return slackIdCache.get(user.email);
}

export async function mention(user) {
  const id = await slackUserId(user);
  return id ? `<@${id}>` : user?.firstName || "";
}

export async function mentionAll(users) {
  const tags = [];
  for (const u of users || []) tags.push(await mention(u));
  return tags.filter(Boolean).join(", ");
}
