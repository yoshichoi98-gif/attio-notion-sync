// Populate each Partnerships company's inline "Notes & Tasks" table + master rows by walking the
// Attio list and hitting the deployed Worker's /sync-deal once per company.
//
// Paced at 5s: Notion sits behind Cloudflare's WAF, which 403s the Worker on bursts. Idempotent —
// safe to re-run. Reads ids from ATTIO (not Notion) so it also works on a first, empty run.
//
//   node scripts/backfill-partnerships.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const WORKER = "https://attio-notion-sync.example.workers.dev";
const LIST_SLUG = "partnerships";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`https://api.attio.com/v2/lists/${LIST_SLUG}/entries/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ limit: 50 }),
});
const entries = (await res.json())?.data ?? [];
const ids = [...new Set(entries.map((e) => e.parent_record_id).filter(Boolean))];
console.log(`${ids.length} companies in "${LIST_SLUG}"`);

let ok = 0, failed = 0;
for (const [i, id] of ids.entries()) {
  try {
    const r = await fetch(`${WORKER}/sync-deal?token=${env.MANUAL_SYNC_TOKEN}&deal=${id}`);
    const j = await r.json();
    const hit = (j.results ?? []).map((x) => `${x.list}(tasks:${x.openTasks},notes:${x.notesPushed})`).join(" ");
    console.log(`[${i + 1}/${ids.length}] ${id.slice(0, 8)} ${r.status} ${hit || JSON.stringify(j).slice(0, 120)}`);
    if (j.ok) ok++; else failed++;
  } catch (e) {
    failed++;
    console.error(`[${i + 1}/${ids.length}] ${id.slice(0, 8)} ERROR`, String(e).slice(0, 120));
  }
  if (i < ids.length - 1) await sleep(5000);
}
console.log(`\ndone: ${ok} ok, ${failed} failed`);
