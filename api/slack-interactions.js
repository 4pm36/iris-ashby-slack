// Clics Slack d'Iris (Slack app > Interactivity > Request URL = /api/slack-interactions)
// Message privé de demande de feedback : feedback global (zone de texte) + un bouton par note.
// Clic sur une note -> feedback enregistré dans Ashby au nom de l'intervieweur, message remplacé par un merci,
// puis feedback posté dans le thread du candidat.

import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { postMessage } from "../lib/iris.js";
import { submitFeedback } from "../lib/demandes.js";
import { postFeedback } from "../lib/feedback.js";

function verifySlack(raw, headers) {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature") || "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "v0=" + crypto.createHmac("sha256", process.env.SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export async function POST(request) {
  const raw = await request.text();
  if (!verifySlack(raw, request.headers)) return new Response("bad signature", { status: 401 });
  const payload = JSON.parse(new URLSearchParams(raw).get("payload"));

  // Clic sur un bouton de note (iris_note_4 … iris_note_1) : envoie le feedback avec cette note
  const send = payload.type === "block_actions" && payload.actions?.find((a) => a.action_id?.startsWith("iris_note_"));
  if (!send) return new Response("");

  const note = JSON.parse(send.value).v;
  const text = payload.state?.values?.texte?.v?.value?.trim();
  if (!text) return new Response(""); // feedback global vide : le bouton ne fait rien

  // Slack attend une réponse en moins de 3 s : on répond tout de suite et on travaille ensuite.
  waitUntil(
    (async () => {
      let result;
      try {
        result = await submitFeedback(send.value, text);
      } catch (e) {
        // Ne devrait pas arriver (3 essais). Le message de l'intervieweur reste tel quel, il peut renvoyer ;
        // Léa est prévenue avec le contenu du feedback pour pouvoir le saisir elle-même.
        console.error("envoi feedback", e);
        if (process.env.SLACK_USER_ID) {
          await postMessage({
            channel: process.env.SLACK_USER_ID,
            text:
              `⚠️ Le feedback de <@${payload.user.id}> sur <${JSON.parse(send.value).l}|${JSON.parse(send.value).n}> n'a pas pu être enregistré dans Ashby ` +
              `(${String(e.message).slice(0, 200)}).\nNote : ${note}\nFeedback : "${text}"`,
          }).catch(() => {});
        }
        return;
      }
      await fetch(payload.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: `✅ Merci ! Ton feedback sur *${result.name}* (note ${note}) est enregistré.`,
        }),
      }).catch((e) => console.error("réponse Slack", e));
      if (result.feedback) await postFeedback(result.feedback).catch((e) => console.error("thread", e));
    })()
  );
  return new Response("");
}
