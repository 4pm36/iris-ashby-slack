// Iris — Résumé quotidien des entretiens (DM Slack à 19h, heure de Paris)
//
// Sources :
//   1. Ashby : entretiens planifiés dans Ashby sur tes process
//   2. Ton Google Agenda : RDV pris via tes liens de réservation ("20 min avec Léa..." / "30 min avec Léa...")
//      -> gardés seulement si la question "Par quel poste es-tu intéressé(e) ?" a une réponse
//
// Variables d'environnement Vercel : ASHBY_API_KEY, SLACK_BOT_TOKEN, SLACK_USER_ID, LEA_EMAIL,
// GOOGLE_ICAL_URL, CRON_SECRET
// Test à la main : /api/cron/resume-entretiens?force=1 (avec le header Authorization: Bearer CRON_SECRET)

const ASHBY = "https://api.ashbyhq.com";
const TZ = "Europe/Paris";
const BOOKING_TITLE = /min avec Léa/i;
const BOOKING_QUESTION = "Par quel poste es-tu intéressé(e) ?";

async function ashby(endpoint, body = {}) {
  const res = await fetch(`${ASHBY}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.ASHBY_API_KEY}:`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Ashby ${endpoint}: ${JSON.stringify(json.errors ?? json)}`);
  return json;
}

// Date "AAAA-MM-JJ" et heure, en heure de Paris
function parisDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function parisHour(d) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d));
}

// Lien LinkedIn si renseigné dans Ashby, sinon lien du profil Ashby
function candidateLink(cand) {
  const linkedin = (cand.socialLinks ?? []).find((l) => /linkedin/i.test(l.type ?? l.url))?.url;
  return linkedin ?? cand.profileUrl ?? `https://app.ashbyhq.com/candidates/${cand.id}`;
}

// ---------- Google Agenda (fichier iCal) ----------

function parseBookings(ics, today, now) {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // dé-plie les lignes iCal
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT" && ev) {
      const b = toBooking(ev, today, now);
      if (b) out.push(b);
      ev = null;
    } else if (ev) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).split(";")[0];
      const value = line.slice(i + 1);
      if (key === "DTSTART") ev.DTSTART = value;
      else if (key === "ATTENDEE") ev.ATTENDEES = (ev.ATTENDEES ?? "") + " " + value;
      else if (key === "SUMMARY" || key === "DESCRIPTION" || key === "STATUS") ev[key] = value;
    }
  }
  return out;
}

function unescapeIcs(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function toBooking(ev, today, now) {
  const summary = unescapeIcs(ev.SUMMARY ?? "");
  if (!BOOKING_TITLE.test(summary) || ev.STATUS === "CANCELLED" || !ev.DTSTART) return null;

  // Date de début : "20261104T134500Z" (UTC) ou "20261104T144500" (heure locale)
  const m = ev.DTSTART.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) {
    const start = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    if (parisDate(start) !== today || start > now) return null;
  } else if (`${y}-${mo}-${d}` !== today) return null;

  // Description : on enlève le HTML et on lit la réponse à la question
  const text = unescapeIcs(ev.DESCRIPTION ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
  const q = rows.findIndex((r) => r.startsWith(BOOKING_QUESTION));
  const poste = q >= 0 ? rows[q].slice(BOOKING_QUESTION.length).trim() || rows[q + 1] || "" : "";
  if (!poste) return null; // pas de réponse = pas un candidat

  const name = summary.match(/\(([^)]+)\)\s*$/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const emails = `${text} ${ev.ATTENDEES ?? ""}`.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  const email = emails.find((e) => !/@beparallel\.com$/i.test(e));
  return { name, email: email?.toLowerCase(), poste };
}

// ---------- Cron ----------

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const force = new URL(request.url).searchParams.get("force") === "1";
  // Deux crons (17h et 18h UTC) pour gérer heure d'été / d'hiver : on n'envoie qu'à 19h Paris
  if (!force && parisHour(now) !== 19) return Response.json({ skipped: true });

  const today = parisDate(now);

  // Ton ID utilisateur Ashby
  const me = (await ashby("user.search", { email: process.env.LEA_EMAIL })).results;
  const myId = Array.isArray(me) ? me[0]?.id : me?.id;

  const lines = [];
  const seenCandidates = new Set();

  // 1. Ashby : entretiens créés ces 60 derniers jours (pagination)
  const schedules = [];
  let cursor;
  do {
    const r = await ashby("interviewSchedule.list", {
      createdAfter: now.getTime() - 60 * 24 * 3600 * 1000,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    schedules.push(...r.results);
    cursor = r.moreDataAvailable ? r.nextCursor : undefined;
  } while (cursor);

  // Entretiens qui ont eu lieu aujourd'hui (un planning annulé n'est plus "Scheduled"/"Complete" ou n'a plus de créneau)
  const byApplication = new Map(); // applicationId -> Map(interviewerId -> nom ou null)
  for (const s of schedules) {
    if (/cancel/i.test(String(s.status))) continue;
    for (const ev of s.interviewEvents ?? []) {
      const start = new Date(ev.startTime);
      if (parisDate(start) !== today || start > now) continue;
      const who = byApplication.get(s.applicationId) ?? new Map();
      for (const id of ev.interviewerUserIds ?? []) if (!who.has(id)) who.set(id, null);
      for (const u of ev.interviewers ?? []) who.set(u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || null);
      byApplication.set(s.applicationId, who);
    }
  }

  async function userName(id, known) {
    if (known) return known;
    const u = (await ashby("user.info", { userId: id })).results;
    return `${u.firstName} ${u.lastName}`.trim();
  }

  for (const [applicationId, who] of byApplication) {
    const app = (await ashby("application.info", { applicationId })).results;

    // Seulement tes process : tu es dans l'équipe de recrutement ou tu as fait l'entretien
    const inHiringTeam = (app.hiringTeam ?? []).some((m) => m.userId === myId);
    if (myId && !inHiringTeam && !who.has(myId)) continue;

    const cand = (await ashby("candidate.info", { id: app.candidate.id })).results;
    seenCandidates.add(cand.id);

    const others = [...who].filter(([id]) => id !== myId);
    const names = await Promise.all(others.map(([id, n]) => userName(id, n)));
    const avec = names.length ? ` avec ${names.join(", ")}` : "";

    lines.push(`• <${candidateLink(cand)}|${cand.name}> ${app.job?.title ?? ""}${avec}`);
  }

  // 2. Google Agenda : RDV pris via tes liens de réservation
  if (process.env.GOOGLE_ICAL_URL) {
    const ics = await fetch(process.env.GOOGLE_ICAL_URL).then((r) => r.text());
    for (const b of parseBookings(ics, today, now)) {
      let cand;
      if (b.email) {
        const found = (await ashby("candidate.search", { email: b.email })).results;
        cand = Array.isArray(found) ? found[0] : found;
      }
      if (cand && seenCandidates.has(cand.id)) continue; // déjà listé via Ashby
      if (cand) seenCandidates.add(cand.id);

      const nom = cand ? `<${candidateLink(cand)}|${cand.name}>` : b.name;
      lines.push(`• ${nom} ${b.poste}${cand ? "" : " (pas dans Ashby)"}`);
    }
  }

  if (lines.length === 0) return Response.json({ sent: false, reason: "aucun entretien" });

  const text = `Résumé des entretiens de la journée :\n\n${lines.join("\n")}`;
  const slack = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: process.env.SLACK_USER_ID, text, unfurl_links: false }),
  }).then((r) => r.json());

  if (!slack.ok) throw new Error(`Slack: ${slack.error}`);
  return Response.json({ sent: true, count: lines.length });
}
