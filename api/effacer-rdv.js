// Supprime les messages « a pris RDV pour son entretien Screencall / Initial Screen » qu'Iris a postés
// par erreur dans le thread d'un candidat (channel #hiring-* du poste). Rien d'autre n'est touché.
//
// À la main (header Authorization: Bearer CRON_SECRET) :
//   /api/effacer-rdv?job=<jobId Ashby>&application=<applicationId Ashby>

import { JOB_CHANNELS, findThread, threadMessages, slack, SCREENING } from "../lib/iris.js";

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const channel = JOB_CHANNELS[params.get("job")];
  const applicationId = params.get("application");
  if (!channel || !applicationId) return new Response("job (branché sur un channel) et application requis", { status: 400 });
  const ts = await findThread(channel, applicationId);
  if (!ts) return Response.json({ supprimés: 0, raison: "pas de thread pour ce candidat" });
  const rdv = (await threadMessages(channel, ts)).filter((m) => /a pris RDV pour son entretien/.test(m.text) && SCREENING.test(m.text));
  for (const m of rdv) await slack("chat.delete", { channel, ts: m.ts });
  return Response.json({ supprimés: rdv.length, restants: (await threadMessages(channel, ts).catch(() => [])).length });
}
