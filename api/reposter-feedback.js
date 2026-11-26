// Feedback qu'Iris a posté par erreur dans le thread d'un message écrit par quelqu'un d'autre
// (ex. un tri collé à la main qui cite plusieurs candidats) : supprime ces messages d'Iris,
// puis reposte le même feedback normalement (nouveau thread du candidat ouvert par Iris, ou son thread existant).
// Seuls les messages d'Iris portant un repère de feedback (iris_feedback / iris_suite) sont supprimés.
//
// À la main (header Authorization: Bearer CRON_SECRET) :
//   /api/reposter-feedback?job=<jobId Ashby>&application=<applicationId Ashby>

import { JOB_CHANNELS, listAll, slack, slackGet, threadMessages } from "../lib/iris.js";
import { postFeedback } from "../lib/feedback.js";

const MARKERS = ["iris_feedback", "iris_suite"];

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const channel = JOB_CHANNELS[params.get("job")];
  const applicationId = params.get("application");
  if (!channel || !applicationId) return new Response("job (branché sur un channel) et application requis", { status: 400 });

  const botId = (await slack("auth.test", {})).bot_id;
  // Messages principaux qui citent la candidature mais ne sont PAS d'Iris
  const roots = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const json = await slackGet("conversations.history", { channel, limit: 200, ...(cursor ? { cursor } : {}) });
    roots.push(...json.messages.filter((m) => m.bot_id !== botId && m.text?.includes(`/applications/${applicationId}`)));
    cursor = json.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  const feedbackIds = new Set();
  let supprimés = 0;
  for (const root of roots) {
    for (const m of await threadMessages(channel, root.ts)) {
      if (!MARKERS.includes(m.metadata?.event_type)) continue;
      feedbackIds.add(m.metadata.event_payload?.feedback_id);
      await slack("chat.delete", { channel, ts: m.ts });
      supprimés++;
    }
  }
  if (!feedbackIds.size) return Response.json({ supprimés, repostés: 0, raison: "aucun message d'Iris dans un thread qui n'est pas le sien" });

  const feedbacks = await listAll("applicationFeedback.list", { applicationId });
  let repostés = 0;
  for (const f of feedbacks.filter((x) => feedbackIds.has(x.id))) repostés += await postFeedback(f);
  return Response.json({ supprimés, repostés });
}
