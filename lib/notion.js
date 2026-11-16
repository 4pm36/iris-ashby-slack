// Notion pour le tri des candidatures (lib/tri.js)
// 1. Critères du poste : pages "Kick off" et "Scorecard" sous la page du poste dans la base "Job infos".
// 2. Journal de tri : une ligne par candidature déjà triée (mémoire d'Iris, personne n'a rien à y faire).
//
// Variable d'environnement : NOTION_TOKEN (intégration Notion d'Iris, connectée à "Job infos" et au journal).

// Base "Job infos" (People > Talent Acquisition)
const JOB_INFOS_DB = "359ef7290c5f805a8c3ef1c19de44d1f";
// Base "Journal de tri" (page privée "Iris – Journal de tri")
const JOURNAL_DB = "41aef7290c5f81e193dfd5d0e8d3d687";

const FILLED_MIN_CHARS = 300; // en dessous : page considérée comme vide (template pas rempli)

export async function notion(path, { method = "GET", body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Limite Notion (~3 requêtes/s) : on attend et on réessaie
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1000));
      continue;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(`Notion ${method} ${path}: ${json.message ?? res.status}`);
    return json;
  }
}

async function queryAll(databaseId, body = {}) {
  const out = [];
  let cursor;
  do {
    const r = await notion(`databases/${databaseId}/query`, {
      method: "POST",
      body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function childrenOf(blockId) {
  const out = [];
  let cursor;
  do {
    const r = await notion(`blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const plain = (richText) => (richText ?? []).map((t) => t.plain_text).join("");

// "Senior Fullstack Engineer" == "senior   fullstack engineer" == "🧾 Senior Fullstack Engineer"
export const normalize = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ===== Critères du poste =====

// Sous-pages d'une page (y compris dans des colonnes / toggles), sans entrer dans les sous-pages elles-mêmes
async function childPages(pageId) {
  const pages = [];
  for (const b of await childrenOf(pageId)) {
    if (b.type === "child_page") pages.push({ id: b.id, title: b.child_page.title, edited: b.last_edited_time });
    else if (b.has_children && b.type !== "child_database") pages.push(...(await childPages(b.id)));
  }
  return pages;
}

// Texte d'une page (titres, listes, tableaux, contenu des toggles…) + date de dernière modification de ses blocs
async function pageText(blockId, depth = 0) {
  const lines = [];
  let edited = "";
  const indent = "  ".repeat(depth);
  for (const b of await childrenOf(blockId)) {
    if (b.last_edited_time > edited) edited = b.last_edited_time;
    if (b.type === "child_page" || b.type === "child_database") continue; // autre page : pas lue
    const v = b[b.type] ?? {};
    let line = null;
    switch (b.type) {
      case "heading_1": line = `# ${plain(v.rich_text)}`; break;
      case "heading_2": line = `## ${plain(v.rich_text)}`; break;
      case "heading_3": line = `### ${plain(v.rich_text)}`; break;
      case "bulleted_list_item": case "toggle": line = `- ${plain(v.rich_text)}`; break;
      case "numbered_list_item": line = `1. ${plain(v.rich_text)}`; break;
      case "to_do": line = `- [${v.checked ? "x" : " "}] ${plain(v.rich_text)}`; break;
      case "table_row": line = `| ${(v.cells ?? []).map(plain).join(" | ")} |`; break;
      default: if (v.rich_text) line = plain(v.rich_text);
    }
    if (line?.trim()) lines.push(indent + line);
    if (b.has_children) {
      const nested = b.type === "table" || b.type.startsWith("column") ? depth : depth + 1;
      const sub = await pageText(b.id, nested);
      if (sub.text) lines.push(sub.text);
      if (sub.edited > edited) edited = sub.edited;
    }
  }
  return { text: lines.join("\n"), edited };
}

async function readPage(page) {
  const [{ text, edited }, info] = await Promise.all([pageText(page.id), notion(`pages/${page.id}`)]);
  const version = [edited, page.edited, info.last_edited_time].filter(Boolean).sort().at(-1);
  return { ...page, text, version };
}

// Une seule page doit correspondre ; sinon on ne devine pas.
function pickOne(pages, label, jobTitle) {
  if (pages.length > 1)
    throw new CriteriaError(`plusieurs pages ${label} sous « ${jobTitle} » dans Notion (${pages.map((p) => `« ${p.title} »`).join(", ")}) : garder une seule page`);
  return pages[0] ?? null;
}

export class CriteriaError extends Error {} // problème à signaler à Léa (pas une simple absence de critères)

// Critères du poste, ou { skip: raison } si le poste n'a pas (encore) de KO et de scorecard remplis.
export async function jobCriteria(jobTitle) {
  const rows = await queryAll(JOB_INFOS_DB);
  const matches = rows.filter((r) => normalize(plain(r.properties?.Nom?.title)) === normalize(jobTitle));
  if (!matches.length) return { skip: "pas de page dans Job infos" };
  if (matches.length > 1) throw new CriteriaError(`plusieurs pages « ${jobTitle} » dans Job infos`);

  const pages = await childPages(matches[0].id);
  let scorecards = pages.filter((p) => /scorecard/i.test(p.title));
  // "Product Manager Scorecards" -> les scorecards rangées dedans
  const nested = (await Promise.all(scorecards.map((p) => childPages(p.id)))).flat().filter((p) => /scorecard/i.test(p.title));
  if (nested.length) scorecards = nested;
  const scorecard = pickOne(scorecards, "Scorecard", jobTitle);
  const ko = pickOne(pages.filter((p) => /kick[\s-]?off/i.test(p.title)), "Kick off", jobTitle);
  if (!scorecard) return { skip: "pas de page Scorecard" };
  if (!ko) return { skip: "pas de page Kick off" };

  const [koPage, scPage] = await Promise.all([readPage(ko), readPage(scorecard)]);
  if (scPage.text.length < FILLED_MIN_CHARS) return { skip: "scorecard pas remplie" };
  if (koPage.text.length < FILLED_MIN_CHARS) return { skip: "kick off pas rempli" };

  return {
    text: `=== Kick-off ===\n${koPage.text}\n\n=== Scorecard ===\n${scPage.text}`,
    version: [koPage.version, scPage.version].sort().at(-1),
  };
}

// ===== Journal de tri =====

const text = (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 2000) } }] : [] });

// applicationId -> { pageId, candidateId, name, verdict, pour, contre, version, firstSeen }
export async function readJournal(jobId) {
  const rows = await queryAll(JOURNAL_DB, { filter: { property: "Job ID", rich_text: { equals: jobId } } });
  const journal = new Map();
  for (const r of rows) {
    const p = r.properties;
    journal.set(plain(p["Application ID"].title), {
      pageId: r.id,
      candidateId: plain(p["Candidate ID"].rich_text),
      name: plain(p.Nom.rich_text),
      verdict: p.Verdict.select?.name ?? null,
      pour: plain(p.Pour.rich_text),
      contre: plain(p.Contre.rich_text),
      version: plain(p["Version critères"].rich_text),
      firstSeen: p["Premier tri"].date?.start ?? null,
    });
  }
  return journal;
}

// Nouvelle ligne, ou mise à jour (re-tri après changement des critères) en gardant la date du premier tri.
export async function writeJournal({ pageId, applicationId, candidateId, name, jobId, jobTitle, verdict, pour, contre, version, firstSeen }) {
  const properties = {
    "Application ID": { title: [{ text: { content: applicationId } }] },
    "Candidate ID": text(candidateId),
    Nom: text(name),
    Poste: text(jobTitle),
    "Job ID": text(jobId),
    Verdict: { select: { name: verdict } },
    Pour: text(pour),
    Contre: text(contre),
    "Version critères": text(version),
    "Premier tri": { date: { start: firstSeen } },
  };
  if (pageId) await notion(`pages/${pageId}`, { method: "PATCH", body: { properties } });
  else await notion("pages", { method: "POST", body: { parent: { database_id: JOURNAL_DB }, properties } });
}
