// Add a "Completed" date property to every deal's "Notes & Tasks" inline table,
// across both main deal databases. Reads NOTION_TOKEN from ../.dev.vars.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const TOKEN = env.NOTION_TOKEN;
const MAIN_DBS = ["00000000000000000000000000000021", "00000000-0000-0000-0000-000000000022"];
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const r = await fetch(`https://api.notion.com/v1${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status}`);
  return r.json();
}

let patched = 0, already = 0;
for (const mainDb of MAIN_DBS) {
  const pages = [];
  let cursor;
  do {
    const d = await api(`/databases/${mainDb}/query`, { method: "POST", body: JSON.stringify({ start_cursor: cursor, page_size: 100 }) });
    pages.push(...d.results.map((p) => p.id));
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  console.log(`main DB ${mainDb}: ${pages.length} pages`);
  for (const pageId of pages) {
    const blocks = await api(`/blocks/${pageId}/children?page_size=100`);
    const db = blocks.results.find((b) => b.type === "child_database" && b.child_database?.title === "Notes & Tasks");
    if (!db) continue;
    const cur = await api(`/databases/${db.id}`);
    if (cur.properties?.["Completed"]) { already++; process.stdout.write("="); continue; }
    await api(`/databases/${db.id}`, { method: "PATCH", body: JSON.stringify({ properties: { "Completed": { date: {} } } }) });
    patched++; process.stdout.write(".");
    await sleep(150); // gentle: avoid the WAF burst block
  }
}
console.log(`\nadded to ${patched} tables, ${already} already had it`);
