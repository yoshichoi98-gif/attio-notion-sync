// Populate the [Alex] master table immediately (instead of waiting for cron to rotate).
// Pulls every Alex deal id from its Notion deals DB, then hits the Worker's /sync-deal for
// each, paced ~5s apart (Notion's Cloudflare WAF blocks bursts). Safe to re-run (idempotent sync).
//
//   node scripts/backfill-master.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const DEALS_DB = "00000000-0000-0000-0000-000000000022"; // [Alex] Active Deals DB
const WORKER = "https://attio-notion-sync.example.workers.dev";
const TOKEN = env.MANUAL_SYNC_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Collect deal ids (+ names) from the Alex deals DB.
const deals = [];
let cursor;
for (;;) {
  const res = await fetch(`https://api.notion.com/v1/databases/${DEALS_DB}/query`, {
    method: "POST", headers: H, body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
  });
  const j = await res.json();
  for (const p of j.results ?? []) {
    const id = p.properties?.["Attio Deal ID"]?.rich_text?.[0]?.plain_text ?? "";
    const name = p.properties?.Deal?.title?.[0]?.plain_text ?? "";
    if (id) deals.push({ id, name });
  }
  if (!j.has_more) break;
  cursor = j.next_cursor;
}
console.log(`Found ${deals.length} Alex deals. Backfilling master table (5s pace)...\n`);

// 2) Trigger a targeted sync for each (populates the master rows + relation).
for (const [i, d] of deals.entries()) {
  try {
    const res = await fetch(`${WORKER}/sync-deal?token=${encodeURIComponent(TOKEN)}&deal=${d.id}`);
    const j = await res.json().catch(() => ({}));
    console.log(`[${i + 1}/${deals.length}] ${d.name || d.id}: ${res.status} ${JSON.stringify(j.results ?? j)}`);
  } catch (err) {
    console.log(`[${i + 1}/${deals.length}] ${d.name || d.id}: ERROR ${err}`);
  }
  if (i < deals.length - 1) await sleep(5000);
}
console.log("\nBackfill done.");
