// Iris — refus des candidats écartés d'un poste, déclenché UNIQUEMENT par le clic sur le bouton
// « Refuser les N écartés » du message de tri (api/slack-interactions.js). Jamais appelé par le tri lui-même.
//
// Au clic :
// 1. Candidats concernés = verdict "écarté" dans le journal de tri (Notion) ET encore en Application Review
//    dans Ashby au moment du clic (Ashby reste la source de vérité ; les "sans CV" ne sont jamais touchés).
// 2. Chaque candidature est revérifiée juste avant d'être archivée, puis passée à l'étape Archived du poste
//    avec la raison d'archivage RAISON et le mail de refus (template Ashby), programmé à 18h32 (heure de Paris)
//    le jour du clic, ou le jour ouvré suivant si le clic a lieu après 18h32, le week-end ou un jour férié.
// 3. Écritures jamais réessayées automatiquement : un mail de refus ne doit pas partir deux fois.
//
// Interrupteur : tant que la variable Vercel REFUS_ACTIF n'est pas à "1", un clic fait un essai à sec
// (il dit qui serait refusé, sans rien écrire dans Ashby).

import { ashby, listAll } from "./iris.js";
import { readJournal, normalize } from "./notion.js";

const APPLICATION_REVIEW = /^application review$/i;
const CONCURRENCY = 3;

// ===== Heure d'envoi du mail (choix de Léa) =====
// 18h32 le jour du clic ; clic à 18h32 ou après : 18h32 le lendemain ; jamais le samedi, le dimanche ni un jour férié
// (vendredi soir ou week-end : lundi 18h32 ; veille de jour férié : jour ouvré suivant).
const HEURE_MAIL = [18, 32];

// Jours fériés en France (métropole) d'une année : dates fixes + lundi de Pâques, Ascension, lundi de Pentecôte.
function easter(year) {
  // Algorithme de Meeus/Jones/Butcher (calendrier grégorien)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day, 12);
}
const holidayCache = new Map();
function holidays(year) {
  if (!holidayCache.has(year)) {
    const key = (t) => new Date(t).toISOString().slice(0, 10);
    const fixed = ["01-01", "05-01", "05-08", "07-14", "08-15", "11-01", "11-11", "12-25"].map((md) => `${year}-${md}`);
    const e = easter(year);
    holidayCache.set(year, new Set([...fixed, ...[1, 39, 50].map((n) => key(e + n * 864e5))]));
  }
  return holidayCache.get(year);
}
const dayOff = (t) => {
  const d = new Date(t);
  return [0, 6].includes(d.getUTCDay()) || holidays(d.getUTCFullYear()).has(d.toISOString().slice(0, 10));
};
const TZ = "Europe/Paris";

function parisParts(t) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)])
  );
  return { ...p, hour: p.hour % 24 };
}

// Instant UTC correspondant à une heure de Paris (gère l'heure d'été / d'hiver)
function parisTime(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const p = parisParts(guess);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return guess - offset;
}

export function mailSendAt(now = Date.now()) {
  const p = parisParts(now);
  const [h, m] = HEURE_MAIL;
  let day = Date.UTC(p.year, p.month - 1, p.day, 12); // midi UTC : sert seulement à compter les jours du calendrier
  if (p.hour > h || (p.hour === h && p.minute >= m)) day += 864e5;
  while (dayOff(day)) day += 864e5; // week-end ou jour férié -> jour ouvré suivant
  const d = new Date(day);
  return new Date(parisTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m)).toISOString();
}

// Templates de mail de refus Ashby (choix de Léa, 17/11/2026)
export const TEMPLATE_FR = "Application Rejection";
export const TEMPLATE_EN = "Application rejection - EN"; // postes à l'étranger
// Raison d'archivage Ashby (texte de la raison dans Ashby > Admin > Archive reasons)
export const RAISON = "Fit with the Job"; // choix de Léa, 17/11/2026 (majuscules et accents ignorés)

// Poste à l'étranger : pays du lieu du poste dans Ashby, sinon le titre ("GTM Lead US", "… Germany").
const ABROAD_TITLE = /\b(US|USA|UK|Germany|Deutschland|Spain|Italy|Belgium|Netherlands|Switzerland)\b/;
export async function rejectionTemplate(job, read = ashby) {
  if (job.locationId) {
    try {
      const loc = (await read("location.info", { locationId: job.locationId })).results;
      const country = loc?.address?.postalAddress?.addressCountry;
      if (country) return /^(france|fr|fra)$/i.test(country.trim()) ? TEMPLATE_FR : TEMPLATE_EN;
    } catch {}
  }
  return ABROAD_TITLE.test(job.title ?? "") ? TEMPLATE_EN : TEMPLATE_FR;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

// Tout ce qu'il faut pour archiver, vérifié AVANT la première écriture : sinon, rien n'est touché.
async function setup(jobId) {
  const job = (await ashby("job.info", { id: jobId })).results;
  const plan = (await ashby("jobInterviewPlan.info", { jobId })).results;
  const archived = (plan.stages ?? []).filter((s) => s.type === "Archived");
  if (archived.length !== 1) throw new Error(`étape Archived introuvable dans le plan d'entretiens de ${job.title}`);

  const templateName = await rejectionTemplate(job);
  const templates = await listAll("communicationTemplate.list", {});
  const template = templates.find((t) => normalize(t.title) === normalize(templateName));
  if (!template) throw new Error(`template de mail « ${templateName} » introuvable dans Ashby`);
  if (template.intendedTypes && !template.intendedTypes.includes("email"))
    throw new Error(`le template « ${templateName} » n'est pas un template de mail`);

  const reasons = (await ashby("archiveReason.list", {})).results.filter((r) => !r.isArchived);
  const reason = RAISON && reasons.find((r) => normalize(r.text) === normalize(RAISON));
  if (!reason) {
    const org = reasons.filter((r) => r.reasonType === "RejectedByOrg").map((r) => `« ${r.text} »`).join(", ");
    throw new Error(
      `raison d'archivage ${RAISON ? `« ${RAISON} » introuvable dans Ashby` : "pas encore choisie (RAISON dans lib/refus.js)"}. Raisons « rejeté par nous » : ${org || "aucune"}`
    );
  }
  return { job, stage: archived[0], template: { id: template.id, name: template.title }, reason };
}

// Candidatures à refuser : "écarté" dans le journal ET encore actives en Application Review dans Ashby.
async function targets(jobId) {
  const journal = await readJournal(jobId);
  const active = await listAll("application.list", { jobId, status: "Active" });
  return active.filter(
    (a) => APPLICATION_REVIEW.test(a.currentInterviewStage?.title ?? "") && journal.get(a.id)?.verdict === "écarté"
  );
}

// dryRun : rien n'est écrit dans Ashby. only : une seule candidature (test, api/refus-test.js), qui doit être un écarté.
// Renvoie { job, template, reason, sendAt, refused: [noms], ids, skipped, errors: [{ name, error }], dryRun }
export async function refuseEcartes(jobId, { dryRun = process.env.REFUS_ACTIF !== "1", only = null } = {}) {
  const { job, stage, template, reason } = await setup(jobId);
  let apps = await targets(jobId);
  if (only) {
    apps = apps.filter((a) => a.id === only);
    if (!apps.length) throw new Error(`candidature ${only} : pas un écarté encore en Application Review sur ${job.title}`);
  }
  const refused = [];
  const errors = [];
  const ids = [];
  let skipped = 0;
  const sendAt = mailSendAt();

  await mapLimit(apps, CONCURRENCY, async (a) => {
    const name = a.candidate?.name ?? a.id;
    try {
      // Revérifiée juste avant d'écrire : quelqu'un a pu la bouger depuis (ou un double clic).
      const now = (await ashby("application.info", { applicationId: a.id })).results;
      if (now.status !== "Active" || !APPLICATION_REVIEW.test(now.currentInterviewStage?.title ?? "")) {
        skipped++;
        return;
      }
      if (!dryRun)
        await ashby("application.changeStage", {
          applicationId: a.id,
          interviewStageId: stage.id,
          archiveReasonId: reason.id,
          archiveEmail: { communicationTemplateId: template.id, sendAt },
        });
      refused.push(name);
      ids.push({ name, applicationId: a.id });
    } catch (e) {
      errors.push({ name, error: String(e.message).slice(0, 200) });
    }
  });

  return { job: job.title, template: template.name, reason: reason.text, sendAt, refused, ids, skipped, errors, dryRun };
}
