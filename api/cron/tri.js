// Iris — tri automatique des candidatures, lundi, mercredi et vendredi à 9h (heure de Paris)
//
// Deux crons Vercel (7h et 8h UTC) pour gérer heure d'été / d'hiver : on ne trie qu'à 9h Paris.
// Chaque poste ouvert dans Ashby est trié dans son propre appel à /api/tri-poste (temps limite par poste,
// et une erreur sur un poste ne bloque pas les autres). Les postes sans Kick off + Scorecard remplis sont ignorés.
// Test à la main : /api/cron/tri?force=1 (header Authorization: Bearer CRON_SECRET) -> vrai envoi aux recruteurs !
//                  pour tester un seul poste sans rien envoyer aux recruteurs : voir api/tri-poste.js

import { openJobs } from "../../lib/tri.js";
import { postMessage } from "../../lib/iris.js";

export const maxDuration = 300;

function parisHour(d) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(d));
}

export async function GET(request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  if (url.searchParams.get("force") !== "1" && parisHour(new Date()) !== 9) return Response.json({ skipped: true });

  const jobs = await openJobs();
  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        const res = await fetch(`${url.origin}/api/tri-poste?job=${job.id}`, { headers: { authorization: auth } });
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
  return Response.json(results);
}
