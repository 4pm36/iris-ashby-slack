// Iris — test du refus sur UNE candidature (vérifier de quel compte Ashby envoie le mail), sans passer par le bouton.
// Header Authorization: Bearer CRON_SECRET.
//   /api/refus-test?job=<jobId>                                -> liste les écartés encore en Application Review (rien n'est fait)
//   /api/refus-test?job=<jobId>&application=<id>               -> essai à sec sur cette candidature (rien n'est fait)
//   /api/refus-test?job=<jobId>&application=<id>&confirm=1     -> refus réel de cette seule candidature (mail + archivage)
// Ignore REFUS_ACTIF : c'est une commande explicite, limitée à une candidature écartée.

import { refuseEcartes } from "../lib/refus.js";

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job");
  if (!jobId) return new Response("paramètre job manquant", { status: 400 });
  const only = params.get("application");
  try {
    const r = await refuseEcartes(jobId, { only, dryRun: !(only && params.get("confirm") === "1") });
    return Response.json(only ? r : { job: r.job, template: r.template, reason: r.reason, ecartes: r.ids });
  } catch (e) {
    return Response.json({ error: String(e.message) }, { status: 400 });
  }
}
