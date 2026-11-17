// Seed the Assignee multi_select options onto every deal's "Notes & Tasks" inline table.
// Notion only auto-creates an option when a value is first written; this pre-seeds the team
// so every team member is always pickable. Reads creds from ../.dev.vars.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const TOKEN = env.NOTION_TOKEN, DEALS_DB = "00000000000000000000000000000021";
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const OPTIONS = [
  { name: "Yoshi Choi", color: "blue" },
  { name: "Alex Morgan", color: "green" },
  { name: "Sam Lee", color: "orange" },
  { name: "Dana Park", color: "purple" },
];

async function api(path, init) {
  const r = await fetch(`https://api.notion.com/v1${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

// All deal pages.
const pages = [];
let cursor;
do {
  const d = await api(`/databases/${DEALS_DB}/query`, { method: "POST", body: JSON.stringify({ start_cursor: cursor, page_size: 100 }) });
  pages.push(...d.results.map((p) => p.id));
  cursor = d.has_more ? d.next_cursor : undefined;
} while (cursor);

console.log(`deal pages: ${pages.length}`);
let patched = 0, skipped = 0;
for (const pageId of pages) {
  const blocks = await api(`/blocks/${pageId}/children?page_size=100`);
  const db = blocks.results.find((b) => b.type === "child_database" && b.child_database?.title === "Notes & Tasks");
  if (!db) { skipped++; continue; }
  try {
    // Preserve existing options (by name, no recolor) and only add the missing members.
    const cur = await api(`/databases/${db.id}`);
    const existing = cur.properties?.Assignee?.multi_select?.options ?? [];
    const have = new Set(existing.map((o) => o.name));
    const toAdd = OPTIONS.filter((o) => !have.has(o.name));
    if (!toAdd.length) { patched++; process.stdout.write("="); continue; }
    const merged = [...existing.map((o) => ({ name: o.name })), ...toAdd];
    await api(`/databases/${db.id}`, { method: "PATCH", body: JSON.stringify({ properties: { Assignee: { multi_select: { options: merged } } } }) });
    patched++;
    process.stdout.write(".");
  } catch (e) { console.error("\n", db.id, String(e).slice(0, 120)); }
}
console.log(`\npatched ${patched} tables, ${skipped} pages had no table`);
