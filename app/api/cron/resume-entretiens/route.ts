// Iris — Résumé quotidien des entretiens (DM Slack à 19h, heure de Paris)
//
// Sources :
//   1. Ashby : entretiens planifiés dans Ashby sur tes process
//   2. Ton Google Agenda : RDV pris via tes liens de réservation ("20 min avec Léa..." / "30 min avec Léa...")
//      -> gardés seulement si la question "Par quel poste es-tu intéressé(e) ?" a une réponse
//
// Variables d'environnement (Vercel > Settings > Environment Variables) :
//   ASHBY_API_KEY    clé API Ashby (droits : candidates, interviews, jobs, users en lecture)
//   SLACK_BOT_TOKEN  token du bot Iris (xoxb-...), scope chat:write
//   SLACK_USER_ID    ton ID Slack (profil Slack > ⋮ > Copier l'ID de membre), ex. U0123ABC
//   LEA_EMAIL        ton email Ashby, ex. lea.marx@beparallel.com
//   GOOGLE_ICAL_URL  Google Agenda > Paramètres > ton agenda > "Adresse secrète au format iCal"
//   CRON_SECRET      une chaîne au hasard (Vercel l'envoie automatiquement au cron)

const ASHBY = "https://api.ashbyhq.com";
const TZ = "Europe/Paris";
const BOOKING_TITLE = /min avec Léa/i;
const BOOKING_QUESTION = "Par quel poste es-tu intéressé(e) ?";

async function ashby(endpoint: string, body: Record<string, unknown> = {}) {
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
function parisDate(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function parisHour(d: Date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d));
}

// Lien LinkedIn si renseigné dans Ashby, sinon lien du profil Ashby
function candidateLink(cand: any): string | undefined {
  const linkedin = (cand.socialLinks ?? []).find((l: any) => /linkedin/i.test(l.type ?? l.url))?.url;
  return linkedin ?? cand.profileUrl;
}

// ---------- Google Agenda (fichier iCal) ----------

type Booking = { name: string; email?: string; poste: string };

function parseBookings(ics: string, today: string, now: Date): Booking[] {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // dé-plie les lignes iCal
  const out: Booking[] = [];
  let ev: Record<string, string> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT" && ev) {
      const b = toBooking(ev, today, now);
      if (b) out.push(b);
      ev = null;
    } else if (ev) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [key, ...params] = line.slice(0, i).split(";");
      const value = line.slice(i + 1);
      if (key === "DTSTART") ev.DTSTART = value, ev.DTSTART_PARAMS = params.join(";");
      else if (key === "ATTENDEE") ev.ATTENDEES = (ev.ATTENDEES ?? "") + " " + value;
      else if (key === "SUMMARY" || key === "DESCRIPTION" || key === "STATUS") ev[key] = value;
    }
  }
  return out;
}

function unescapeIcs(s: string) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function toBooking(ev: Record<string, string>, today: string, now: Date): Booking | null {
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
  const poste = q >= 0 ? (rows[q].slice(BOOKING_QUESTION.length).trim() || rows[q + 1] || "") : "";
  if (!poste) return null; // pas de réponse = pas un candidat

  const name = summary.match(/\(([^)]+)\)\s*$/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const emails = `${text} ${ev.ATTENDEES ?? ""}`.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  const email = emails.find((e) => !/@beparallel\.com$/i.test(e));
  return { name, email: email?.toLowerCase(), poste };
}

// ---------- Cron ----------

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const force = new URL(req.url).searchParams.get("force") === "1"; // pour tester à la main
  // Deux crons (17h et 18h UTC) pour gérer heure d'été / d'hiver : on n'envoie qu'à 19h Paris
  if (!force && parisHour(now) !== 19) return Response.json({ skipped: true });

  const today = parisDate(now);

  // Ton ID utilisateur Ashby
  const me = (await ashby("user.search", { email: process.env.LEA_EMAIL })).results;
  const myId: string | undefined = Array.isArray(me) ? me[0]?.id : me?.id;

  const lines: string[] = [];
  const seenCandidates = new Set<string>();

  // 1. Ashby : entretiens créés ces 60 derniers jours (pagination)
  const schedules: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await ashby("interviewSchedule.list", {
      createdAfter: now.getTime() - 60 * 24 * 3600 * 1000,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    schedules.push(...r.results);
    cursor = r.moreDataAvailable ? r.nextCursor : undefined;
  } while (cursor);

  // Garder les entretiens qui ont eu lieu aujourd'hui (et pas annulés)
  const byApplication = new Map<string, Set<string>>(); // applicationId -> interviewers
  for (const s of schedules) {
    if (String(s.status).toLowerCase().includes("cancel")) continue;
    for (const ev of s.interviewEvents ?? []) {
      const start = new Date(ev.startTime);
      if (parisDate(start) !== today || start > now) continue;
      const set = byApplication.get(s.applicationId) ?? new Set<string>();
      for (const id of ev.interviewerUserIds ?? []) set.add(id);
      byApplication.set(s.applicationId, set);
    }
  }

  const userNames = new Map<string, string>();
  async function userName(id: string) {
    if (!userNames.has(id)) {
      const u = (await ashby("user.info", { userId: id })).results;
      userNames.set(id, `${u.firstName} ${u.lastName}`.trim());
    }
    return userNames.get(id)!;
  }

  for (const [applicationId, interviewers] of byApplication) {
    const app = (await ashby("application.info", { applicationId })).results;

    // Seulement tes process : tu es dans l'équipe de recrutement ou tu as fait l'entretien
    const inHiringTeam = (app.hiringTeam ?? []).some((m: any) => m.userId === myId);
    if (myId && !inHiringTeam && !interviewers.has(myId)) continue;

    const cand = (await ashby("candidate.info", { id: app.candidate.id })).results;
    seenCandidates.add(cand.id);
    const link = candidateLink(cand);

    const others = [...interviewers].filter((id) => id !== myId);
    const avec = others.length ? ` avec ${(await Promise.all(others.map(userName))).join(", ")}` : "";

    const nom = link ? `<${link}|${cand.name}>` : cand.name;
    lines.push(`• ${nom} ${app.job?.title ?? ""}${avec}`);
  }

  // 2. Google Agenda : RDV pris via tes liens de réservation
  if (process.env.GOOGLE_ICAL_URL) {
    const ics = await fetch(process.env.GOOGLE_ICAL_URL).then((r) => r.text());
    for (const b of parseBookings(ics, today, now)) {
      let cand: any;
      if (b.email) {
        const found = (await ashby("candidate.search", { email: b.email })).results;
        cand = Array.isArray(found) ? found[0] : found;
      }
      if (cand && seenCandidates.has(cand.id)) continue; // déjà listé via Ashby
      if (cand) seenCandidates.add(cand.id);

      const name = cand?.name ?? b.name;
      const link = cand ? candidateLink(cand) : undefined;
      const nom = link ? `<${link}|${name}>` : name;
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
