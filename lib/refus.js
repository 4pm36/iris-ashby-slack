// Iris — refus des candidats écartés d'un poste, déclenché UNIQUEMENT par le clic sur le bouton
// « Refuser les N écartés » du message de tri (api/slack-interactions.js). Jamais appelé par le tri lui-même.
//
// Au clic :
// 1. Candidats concernés = verdict "écarté" dans le journal de tri (Notion) ET encore en Application Review
//    dans Ashby au moment du clic (Ashby reste la source de vérité ; les "sans CV" ne sont jamais touchés).
// 2. Chaque candidature est revérifiée juste avant d'être archivée, puis passée à l'étape Archived du poste
//    avec la raison d'archivage RAISON et le mail de refus (template Ashby), envoyé à l'heure par défaut d'Ashby
//    (le lendemain matin, 9h32).
// 3. Écritures jamais réessayées automatiquement : un mail de refus ne doit pas partir deux fois.
//
// Interrupteur : tant que la variable Vercel REFUS_ACTIF n'est pas à "1", un clic fait un essai à sec
// (il dit qui serait refusé, sans rien écrire dans Ashby).

import { ashby, listAll } from "./iris.js";
import { readJournal, normalize } from "./notion.js";

const APPLICATION_REVIEW = /^application review$/i;
const CONCURRENCY = 3;

// Templates de mail de refus Ashby (choix de Léa, 17/11/2026)
export const TEMPLATE_FR = "Application Rejection";
export const TEMPLATE_EN = "Application rejection - EN"; // postes à l'étranger
// Raison d'archivage Ashby (texte exact de la raison dans Ashby > Admin > Archive reasons). À choisir par Léa.
export const RAISON = "";

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

// dryRun : rien n'est écrit dans Ashby. Renvoie { job, template, reason, refused: [noms], skipped, errors: [{ name, error }] }
export async function refuseEcartes(jobId, { dryRun = process.env.REFUS_ACTIF !== "1" } = {}) {
  const { job, stage, template, reason } = await setup(jobId);
  const apps = await targets(jobId);
  const refused = [];
  const errors = [];
  let skipped = 0;

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
          archiveEmail: { communicationTemplateId: template.id }, // sendAt absent : défaut Ashby (lendemain 9h32)
        });
      refused.push(name);
    } catch (e) {
      errors.push({ name, error: String(e.message).slice(0, 200) });
    }
  });

  return { job: job.title, template: template.name, reason: reason.text, refused, skipped, errors, dryRun };
}
