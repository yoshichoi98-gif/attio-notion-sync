// One-time: add the "Attio Deal ID" matching property + backfill the 5 existing rows.
// Safe to re-run (PATCH is idempotent). node scripts/setup-notion.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const DB = "00000000000000000000000000000021";

async function call(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
}

// pageId -> { dealId, expectedTitle }  (recorded when the rows were created)
const MAP = {
  "00000000-0000-0000-0000-000000000026": { dealId: "00000000-0000-0000-0000-000000000024", t: "Riverside Clinical Research" },
  "00000000-0000-0000-0000-000000000027": { dealId: "00000000-0000-0000-0000-000000000028", t: "Harbor Research - New Business" },
  "00000000-0000-0000-0000-000000000029": { dealId: "00000000-0000-0000-0000-000000000030", t: "Apex Research - New Business" },
  "00000000-0000-0000-0000-000000000031": { dealId: "00000000-0000-0000-0000-000000000032", t: "Oakridge Clinical Research - Pilot" },
  "00000000-0000-0000-0000-000000000033": { dealId: "00000000-0000-0000-0000-000000000034", t: "Bloom Research - Pilot" },
};

// 1) Add the property (no-op if it already exists).
const add = await call("PATCH", `/databases/${DB}`, { properties: { "Attio Deal ID": { rich_text: {} } } });
console.log("add property:", add.status, add.status === 200 ? "ok" : JSON.stringify(add.j));

// 2) Backfill each row, verifying the title first.
for (const [pageId, { dealId, t }] of Object.entries(MAP)) {
  const page = await call("GET", `/pages/${pageId}`);
  const title = page.j?.properties?.Deal?.title?.[0]?.plain_text ?? "";
  if (page.status !== 200) { console.log(`SKIP ${pageId}: fetch ${page.status}`); continue; }
  if (title !== t) { console.log(`SKIP ${pageId}: title mismatch ("${title}" != "${t}")`); continue; }
  const upd = await call("PATCH", `/pages/${pageId}`, {
    properties: { "Attio Deal ID": { rich_text: [{ text: { content: dealId } }] } },
  });
  console.log(`stamp "${title}" -> ${dealId.slice(0, 8)}…:`, upd.status === 200 ? "ok" : JSON.stringify(upd.j));
}
