// Clics Slack d'Iris (Slack app > Interactivity > Request URL = /api/slack-interactions)
// Message privé de demande de feedback : feedback global (zone de texte) + un bouton par note.
// Clic sur une note -> feedback enregistré dans Ashby au nom de l'intervieweur, message remplacé par un merci,
// puis feedback posté dans le thread du candidat.
// Message privé de tri : bouton « Refuser les N écartés » (lib/refus.js) -> mail de refus + archivage dans Ashby,
// puis le bouton est remplacé par le résultat.

import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { postMessage } from "../lib/iris.js";
import { submitFeedback } from "../lib/demandes.js";
import { postFeedback } from "../lib/feedback.js";
import { refuseEcartes } from "../lib/refus.js";

export const maxDuration = 300; // refus de ~200 candidatures après la réponse à Slack

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

async function respond(url, body) {
  if (process.env.DRY_RUN) return console.log("[DRY RUN] réponse Slack", JSON.stringify(body));
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch((e) =>
    console.error("réponse Slack", e)
  );
}

// "aujourd'hui vers 16h13" / "demain vers 8h32"
function parisHour(iso) {
  const fmt = (d, o) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", ...o }).format(d);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value])
  );
  const day = { day: "2-digit", month: "2-digit" };
  const when = fmt(new Date(iso), day) === fmt(new Date(), day) ? "aujourd'hui" : "demain";
  return `${when} vers ${Number(p.hour)}h${p.minute}`;
}

function parisDay() {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit" }).format(new Date());
}

// Clic sur « Refuser les N écartés » : le bouton disparaît tout de suite (pas de double clic), puis le résultat le remplace.
export async function handleRefus(payload, action) {
  const { j: jobId, n } = JSON.parse(action.value);
  const who = `<@${payload.user.id}>`;
  const original = (payload.message?.blocks ?? []).filter((b) => b.block_id !== "iris_refus");
  const text = payload.message?.text ?? "Tri des candidatures";
  await respond(payload.response_url, {
    replace_original: true,
    text,
    blocks: [...original, context(`⏳ Refus des écartés en cours (lancé par ${who})…`)],
  });

  let result;
  try {
    result = await refuseEcartes(jobId);
  } catch (e) {
    // Rien n'a été écrit (vérifications faites avant la première écriture) : le bouton revient.
    console.error("refus", jobId, e);
    await respond(payload.response_url, {
      replace_original: true,
      text,
      blocks: [...original, context(`⚠️ Refus non lancé : ${esc(String(e.message).slice(0, 400))}`), ...(payload.message?.blocks ?? []).filter((b) => b.block_id === "iris_refus")],
    });
    if (process.env.SLACK_USER_ID && process.env.SLACK_USER_ID !== payload.user.id)
      await postMessage({ channel: process.env.SLACK_USER_ID, text: `⚠️ Refus des écartés (clic de ${who}) non lancé : ${esc(String(e.message).slice(0, 400))}` }).catch(() => {});
    return;
  }

  const { refused, errors, dryRun } = result;
  const skipped = result.skipped + Math.max(0, n - refused.length - errors.length - result.skipped);
  const parts = [
    dryRun
      ? `🧪 Essai à sec (REFUS_ACTIF pas à 1), rien n'a été fait dans Ashby : ${refused.length} candidat${refused.length > 1 ? "s" : ""} aurai${refused.length > 1 ? "ent" : "t"} été refusé${refused.length > 1 ? "s" : ""} et archivé${refused.length > 1 ? "s" : ""}`
      : `✅ ${refused.length} écarté${refused.length > 1 ? "s" : ""} refusé${refused.length > 1 ? "s" : ""} et archivé${refused.length > 1 ? "s" : ""} par ${who} le ${parisDay()} (mail « ${esc(result.template)} », envoyé par Ashby vers ${parisHour(result.sendAt)})`,
  ];
  if (skipped) parts.push(`${skipped} n'étai${skipped > 1 ? "ent" : "t"} plus en Application Review : pas touché${skipped > 1 ? "s" : ""}`);
  if (errors.length) parts.push(`⚠️ ${errors.length} erreur${errors.length > 1 ? "s" : ""} (à refuser à la main) : ${errors.map((e) => esc(e.name)).join(", ")}`);
  // Essai à sec : le bouton revient (utilisable pour de vrai une fois REFUS_ACTIF à 1)
  const button = dryRun ? (payload.message?.blocks ?? []).filter((b) => b.block_id === "iris_refus") : [];
  await respond(payload.response_url, { replace_original: true, text, blocks: [...original, context(parts.join(" · ").slice(0, 2900)), ...button] });

  if (errors.length && !dryRun && process.env.SLACK_USER_ID)
    await postMessage({
      channel: process.env.SLACK_USER_ID,
      text: `⚠️ Refus ${esc(result.job)} : ${errors.length} échec(s)\n${errors.map((e) => `• ${esc(e.name)} : ${esc(e.error)}`).join("\n")}`.slice(0, 3900),
    }).catch(() => {});
}

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

  // Clic sur « Refuser les N écartés » (message de tri)
  const refus = payload.type === "block_actions" && payload.actions?.find((a) => a.action_id === "iris_refus");
  if (refus) {
    // Slack attend une réponse en moins de 3 s : on répond tout de suite et on travaille ensuite.
    waitUntil(handleRefus(payload, refus).catch((e) => console.error("refus", e)));
    return new Response("");
  }

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
