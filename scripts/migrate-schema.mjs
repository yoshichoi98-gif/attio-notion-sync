// One-time: ensure every deal's Notes & Tasks table has the Created (date) column and
// an Assignee (multi_select) column. Idempotent. node scripts/migrate-schema.mjs
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const DEALS_DB = "00000000000000000000000000000021";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nx = async (m, p, b) => { const r = await fetch("https://api.notion.com/v1" + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); await sleep(120); return { s: r.status, j: await r.json().catch(() => ({})) }; };

const pages = []; let cur;
do { const q = await nx("POST", `/databases/${DEALS_DB}/query`, { start_cursor: cur, page_size: 100 }); for (const p of q.j.results) pages.push({ id: p.id, name: p.properties?.Deal?.title?.[0]?.plain_text ?? "?" }); cur = q.j.has_more ? q.j.next_cursor : null; } while (cur);
console.log("deal pages:", pages.length);

let ok = 0, skip = 0;
for (const pg of pages) {
  const ch = await nx("GET", `/blocks/${pg.id}/children?page_size=50`);
  const db = (ch.j.results || []).find((b) => b.type === "child_database");
  if (!db) { console.log(`  - ${pg.name}: no table yet`); skip++; continue; }
  // Convert Assignee -> multi_select and ensure Created (date) exists.
  const r = await nx("PATCH", `/databases/${db.id}`, { properties: { "Created": { date: {} }, "Assignee": { multi_select: {} } } });
  if (r.s === 200) { ok++; } else { console.log(`  ✗ ${pg.name}: ${JSON.stringify(r.j).slice(0, 160)}`); }
}
console.log(`migrated ${ok} tables (${skip} had no table)`);
