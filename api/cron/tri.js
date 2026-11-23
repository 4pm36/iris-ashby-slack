// Iris — tri automatique des candidatures, lundi, mercredi et vendredi à 9h (heure de Paris)
//
// Déclenché par cron-job.org (comme /api/cron/suivi) : lundi, mercredi, vendredi à 9h00 Europe/Paris,
// header Authorization: Bearer CRON_SECRET. Plus de cron Vercel : sur le plan Hobby, il part à une minute
// au hasard dans l'heure, et le 18/11 il n'est pas parti du tout. Garde-fou : on ne trie qu'entre 9h et 9h59 Paris.
// Chaque poste ouvert dans Ashby est trié dans son propre appel à /api/tri-poste (temps limite par poste,
// et une erreur sur un poste ne bloque pas les autres). Les postes sans Kick off + Scorecard remplis sont ignorés.
// Interrupteur : rien ne part aux recruteurs tant que la variable Vercel TRI_ACTIF n'est pas à "1".
// Test à la main : /api/cron/tri?force=1 (header Authorization: Bearer CRON_SECRET) -> vrai envoi aux recruteurs !
//                  pour tester un seul poste sans rien envoyer aux recruteurs : voir api/tri-poste.js

import { openJobs } from "../../lib/tri.js";
import { postMessage } from "../../lib/iris.js";
import { waitUntil } from "@vercel/functions";

export const maxDuration = 300;

function parisHour(d) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(d));
}

export async function GET(request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });

  if (process.env.TRI_ACTIF !== "1") return Response.json({ skipped: "TRI_ACTIF pas à 1" });

  const url = new URL(request.url);
  if (url.searchParams.get("force") !== "1" && parisHour(new Date()) !== 9) return Response.json({ skipped: true });

  const jobs = await openJobs();
  // Réponse immédiate (cron-job.org coupe au bout de 30 s) ; le tri continue en arrière-plan.
  waitUntil(trierTout(jobs, url.origin, auth));
  return Response.json({ started: jobs.map((j) => j.title) });
}

async function trierTout(jobs, origin, auth) {
  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        const res = await fetch(`${origin}/api/tri-poste?job=${job.id}`, { headers: { authorization: auth } });
        return res.ok ? await res.json() : { job: job.title, error: `HTTP ${res.status}` };
      } catch (e) {
        return { job: job.title, error: String(e.message) };
      }
    })
  );
  console.log(JSON.stringify(results));

  // Poste dont l'appel n'a pas abouti (ex. délai dépassé) : rien n'a été envoyé, on prévient Léa.
  const failed = results.filter((r) => /^HTTP|fetch/i.test(r.error ?? ""));
  if (failed.length && process.env.SLACK_USER_ID) {
    await postMessage({
      channel: process.env.SLACK_USER_ID,
      text: `⚠️ Tri des candidatures non abouti pour : ${failed.map((r) => `${r.job} (${r.error})`).join(", ")}. Iris réessaiera au prochain passage.`,
    }).catch(() => {});
  }

  // Poste ouvert dans Ashby sans page du même nom dans Notion (Job infos) : pas trié, on prévient Léa.
  const sansPage = results.filter((r) => r.skipped === "pas de page dans Job infos");
  if (sansPage.length && process.env.SLACK_USER_ID) {
    await postMessage({
      channel: process.env.SLACK_USER_ID,
      text:
        `⚠️ Pas de tri des CV pour ${sansPage.map((r) => `*${r.job}*`).join(", ")} : aucune page de ce nom dans Notion (Job infos). ` +
        `Le titre de la page Notion doit être exactement celui du poste dans Ashby.`,
    }).catch(() => {});
  }
}
