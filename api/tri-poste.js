// Iris — tri des candidatures d'UN poste (lib/tri.js). Appelé par api/cron/tri.js pour chaque poste ouvert.
//
// Test à la main (header Authorization: Bearer CRON_SECRET) :
//   /api/tri-poste?job=<jobId Ashby>&test=1          -> message à Léa seulement, journal pas modifié
//   /api/tri-poste?job=<jobId Ashby>&test=1&fresh=1  -> idem, en relisant tous les CV (ignore les verdicts déjà notés)
//   /api/tri-poste?job=<jobId Ashby>&note=<applicationId> -> trie cette seule candidature et, si top ou limite,
//                                                            écrit la vraie note sur sa fiche Ashby (rien dans Slack)
//   /api/tri-poste?job=<jobId Ashby>&effacer=AAAA-MM-JJ -> supprime les messages de tri de ce poste envoyés
//                                                          depuis cette date au recruteur (rien n'est re-trié)

import { triPoste, noteTest, effacerTris } from "../lib/tri.js";

export const maxDuration = 300;

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const jobId = params.get("job");
  if (!jobId) return new Response("paramètre job manquant", { status: 400 });
  const effacer = params.get("effacer");
  if (effacer) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effacer)) return new Response("effacer=AAAA-MM-JJ", { status: 400 });
    try {
      return Response.json(await effacerTris(jobId, effacer));
    } catch (e) {
      return Response.json({ error: String(e.message) }, { status: 400 });
    }
  }
  const note = params.get("note");
  if (note) {
    try {
      return Response.json(await noteTest(jobId, note));
    } catch (e) {
      return Response.json({ error: String(e.message) }, { status: 400 });
    }
  }
  const test = params.get("test") === "1";
  // Interrupteur : sans TRI_ACTIF=1, seul le mode test est permis (rien ne part aux recruteurs)
  if (!test && process.env.TRI_ACTIF !== "1") return Response.json({ skipped: "TRI_ACTIF pas à 1 (utiliser test=1)" });
  const result = await triPoste(jobId, { test, fresh: params.get("fresh") === "1" });
  return Response.json(result);
}
