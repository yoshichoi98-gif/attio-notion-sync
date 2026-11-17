// End-to-end test of two-way task mirroring on the Riverside deal. Reads ../.dev.vars.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const KEY = env.ATTIO_API_KEY, NT = env.NOTION_TOKEN, TOK = env.MANUAL_SYNC_TOKEN;
const DEAL = "00000000-0000-0000-0000-000000000024";
const DB = "00000000-0000-0000-0000-000000000035";
const YOSHI = "00000000-0000-0000-0000-000000000036";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attio(path, init) {
  const r = await fetch(`https://api.attio.com${path}`, { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, ...init });
  return { code: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
}
async function notion(path, init) {
  const r = await fetch(`https://api.notion.com/v1${path}`, { headers: { Authorization: `Bearer ${NT}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, ...init });
  return r.json();
}
async function sync() {
  const r = await fetch(`https://attio-notion-sync.example.workers.dev/sync-deal?token=${TOK}&deal=${DEAL}`);
  return r.json();
}
async function rowForTask(taskId) {
  const d = await notion(`/databases/${DB}/query`, { method: "POST", body: JSON.stringify({ page_size: 50 }) });
  return d.results.find((r) => (r.properties?.Link?.rich_text?.[0]?.href || "").includes(taskId));
}
const ok = (c, m) => console.log(`${c ? "✅" : "❌"} ${m}`);

// STEP 1: Attio create -> Notion row appears.
const c = await attio(`/v2/tasks`, { method: "POST", body: JSON.stringify({ data: { format: "plaintext", content: "mirror test", is_completed: false, deadline_at: null, assignees: [], linked_records: [{ target_object: "deals", target_record_id: DEAL }] } }) });
const TID = c.body?.data?.id?.task_id;
console.log("created Attio task:", TID);
await sync(); await sleep(800);
let row = await rowForTask(TID);
ok(!!row, "STEP1 Attio->Notion: row created for the task");

// STEP 2: Notion sets Done -> Attio completed.
await notion(`/pages/${row.id}`, { method: "PATCH", body: JSON.stringify({ properties: { Status: { select: { name: "Done" } } } }) });
await sleep(1200); await sync(); await sleep(800);
let t = await attio(`/v2/tasks/${TID}`);
ok(t.body?.data?.is_completed === true, "STEP2 Notion->Attio: marking Done set Attio is_completed=true");

// STEP 3: Attio reopens + assigns Yoshi -> Notion reflects.
await attio(`/v2/tasks/${TID}`, { method: "PATCH", body: JSON.stringify({ data: { is_completed: false, deadline_at: null, assignees: [{ referenced_actor_type: "workspace-member", referenced_actor_id: YOSHI }] } }) });
await sleep(800); await sync(); await sleep(800);
row = await rowForTask(TID);
const status = row?.properties?.Status?.select?.name;
const assignees = (row?.properties?.Assignee?.multi_select ?? []).map((o) => o.name);
ok(status === "Open", `STEP3 Attio->Notion: reopened (status=${status})`);
ok(assignees.includes("Yoshi Choi"), `STEP3 Attio->Notion: assignee synced (${assignees.join(",")})`);

// STEP 4: Notion deletes the row -> Attio task deleted.
await notion(`/pages/${row.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
await sleep(1200); await sync(); await sleep(800);
t = await attio(`/v2/tasks/${TID}`);
ok(t.code === 404 || t.body?.data?.is_deleted, `STEP4 Notion->Attio delete: Attio task gone (http ${t.code})`);

// STEP 5: Attio delete -> Notion row archived.
const c2 = await attio(`/v2/tasks`, { method: "POST", body: JSON.stringify({ data: { format: "plaintext", content: "delete-from-attio test", is_completed: false, deadline_at: null, assignees: [], linked_records: [{ target_object: "deals", target_record_id: DEAL }] } }) });
const TID2 = c2.body?.data?.id?.task_id;
await sync(); await sleep(800);
let row2 = await rowForTask(TID2);
ok(!!row2, "STEP5a Attio->Notion: 2nd task row created");
await attio(`/v2/tasks/${TID2}`, { method: "DELETE" });
await sleep(600); await sync(); await sleep(800);
row2 = await rowForTask(TID2);
ok(!row2, "STEP5b Attio delete -> Notion row archived");

console.log("done.");
