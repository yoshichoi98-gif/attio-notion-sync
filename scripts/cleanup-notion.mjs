// One-time cleanup: ensure exactly one active Notion page per deal in the Attio list.
// Archives duplicates and orphans (deals no longer in the list). node scripts/cleanup-notion.mjs
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const NH = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const DB = "00000000000000000000000000000021";

// live deal ids
const le = await (await fetch("https://api.attio.com/v2/lists/active_deals/entries/query", {
  method: "POST", headers: { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ limit: 50 }),
})).json();
const live = new Set((le.data || []).map((e) => e.parent_record_id));

// all active pages
let pages = [], cursor;
do {
  const q = await (await fetch(`https://api.notion.com/v1/databases/${DB}/query`, { method: "POST", headers: NH, body: JSON.stringify({ page_size: 100, start_cursor: cursor }) })).json();
  pages.push(...q.results); cursor = q.has_more ? q.next_cursor : null;
} while (cursor);

const byId = {};
for (const p of pages) {
  const id = p.properties?.["Attio Deal ID"]?.rich_text?.[0]?.plain_text || "(none)";
  (byId[id] = byId[id] || []).push({ pageId: p.id, created: p.created_time });
}

const toArchive = [];
for (const [id, list] of Object.entries(byId)) {
  list.sort((a, b) => a.created.localeCompare(b.created)); // keep earliest
  if (id !== "(none)" && live.has(id)) toArchive.push(...list.slice(1).map((x) => x.pageId)); // dupes
  else toArchive.push(...list.map((x) => x.pageId)); // orphan / no-id: archive all
}

console.log(`live deals: ${live.size} | active pages: ${pages.length} | to archive: ${toArchive.length}`);
let done = 0;
for (const pageId of toArchive) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { method: "PATCH", headers: NH, body: JSON.stringify({ archived: true }) });
  if (r.ok) done++; else console.log("  archive failed", pageId, r.status);
}
const missing = [...live].filter((id) => !byId[id]);
console.log(`archived ${done}. live deals missing a page (will be created on next sync): ${missing.length}`);
