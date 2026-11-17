// Backfill: run targeted sync for every deal in the list (one Worker request each),
// so every deal page gets their task table. node scripts/backfill-tasks.mjs
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const WORKER = "https://attio-notion-sync.example.workers.dev";

const entries = await fetch("https://api.attio.com/v2/lists/active_deals/entries/query", {
  method: "POST", headers: { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ limit: 50 }),
}).then((r) => r.json());
const ids = (entries?.data ?? []).map((e) => e.parent_record_id).filter(Boolean);
console.log("deals in list:", ids.length);

let ok = 0;
for (const id of ids) {
  const r = await fetch(`${WORKER}/sync-deal?token=${env.MANUAL_SYNC_TOKEN}&deal=${id}`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (r?.ok) { ok++; console.log(`  ${id.slice(0, 8)}… open tasks: ${r.result?.openTasks}`); }
  else console.log(`  ${id.slice(0, 8)}… ERROR ${JSON.stringify(r).slice(0, 200)}`);
}
console.log(`done: ${ok}/${ids.length} synced`);
