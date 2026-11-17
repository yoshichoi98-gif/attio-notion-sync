// Recreate the Attio webhook with a secret token in its URL (?token=...), and save
// ATTIO_WEBHOOK_TOKEN to .dev.vars. node scripts/recreate-attio-webhook.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const raw = readFileSync(".dev.vars", "utf8");
const env = Object.fromEntries(
  raw.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" };
const BASE = "https://attio-notion-sync.example.workers.dev/attio-webhook";
const LIST_IDS = [
  "00000000-0000-0000-0000-000000000038", // Active Deals
  "00000000-0000-0000-0000-000000000040", // [Alex] Active Deals
  "00000000-0000-0000-0000-000000000041", // Partnerships (companies)
];
// Lists whose STAGE lives on the list entry rather than the record, so an entry-value edit has to
// trigger a sync. Only Partnerships: the deals lists carry stage on the deal itself (already
// covered by record.updated), and subscribing them would make reconcileDeals fire on deals-list
// entry edits it does not fire on today.
const ENTRY_STAGE_LIST_IDS = new Set(["00000000-0000-0000-0000-000000000041"]);
const DEALS_OBJECT_ID = "00000000-0000-0000-0000-000000000039";
const COMPANIES_OBJECT_ID = "00000000-0000-0000-0000-000000000042"; // see note below
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000043";
const listFilter = (id) => ({ "$and": [{ field: "id.list_id", operator: "equals", value: id }] });
const wsFilter = { "$and": [{ field: "id.workspace_id", operator: "equals", value: WORKSPACE_ID }] };

const TOKEN = env.ATTIO_WEBHOOK_TOKEN && env.ATTIO_WEBHOOK_TOKEN.length > 10
  ? env.ATTIO_WEBHOOK_TOKEN
  : randomBytes(24).toString("hex");
const TARGET = `${BASE}?token=${TOKEN}`;

const api = async (m, p, b) => {
  const r = await fetch(`https://api.attio.com${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
};

const list = await api("GET", "/v2/webhooks");
const existing = (list.j?.data ?? []).filter((w) => (w?.target_url ?? "").startsWith(BASE));
// Extra copies (e.g. from an interrupted earlier run) are still worth removing.
for (const w of existing.slice(1)) {
  console.log("deleted duplicate", w.id.webhook_id, (await api("DELETE", `/v2/webhooks/${w.id.webhook_id}`)).status);
}

// NOTE on companies `record.updated`: deliberately NOT subscribed. Attio can only filter on
// id.object_id, not "is in list X", so it would wake the Worker for EVERY company edit in the
// workspace (including enrichment writes) to serve a handful of partner companies. Field changes on
// those arrive via the hourly reconcile + the rotating cron refresh instead; list membership,
// entry values (Prospecting) and tasks are all still real-time below. The Worker already gates
// events by object kind, so enabling this is just uncommenting the line:
//   { event_type: "record.updated", filter: { "$and": [{ field: "id.object_id", operator: "equals", value: COMPANIES_OBJECT_ID }] } },
const subscriptions = [
  { event_type: "record.updated", filter: { "$and": [{ field: "id.object_id", operator: "equals", value: DEALS_OBJECT_ID }] } },
  { event_type: "task.created", filter: wsFilter },
  { event_type: "task.updated", filter: wsFilter },
  { event_type: "task.deleted", filter: wsFilter },
];
for (const id of LIST_IDS) {
  subscriptions.push({ event_type: "list-entry.created", filter: listFilter(id) });
  subscriptions.push({ event_type: "list-entry.deleted", filter: listFilter(id) });
  // Entry-value changes: the Partnerships stage (`prospecting`) lives on the entry, so without
  // this a stage change would only surface on the next cron pass.
  if (ENTRY_STAGE_LIST_IDS.has(id)) subscriptions.push({ event_type: "list-entry.updated", filter: listFilter(id) });
}
// Update in place when one already exists — no window where the webhook is missing.
const keep = existing[0];
const res = keep
  ? await api("PATCH", `/v2/webhooks/${keep.id.webhook_id}`, { data: { target_url: TARGET, subscriptions } })
  : await api("POST", "/v2/webhooks", { data: { target_url: TARGET, subscriptions } });
console.log(keep ? "patched" : "created", "status:", res.status, "webhook_id:", res.j?.data?.id?.webhook_id);
if (res.status >= 400) { console.error(JSON.stringify(res.j).slice(0, 500)); process.exit(1); }
console.log("subscriptions now:", res.j?.data?.subscriptions?.length);

const next = raw.includes("ATTIO_WEBHOOK_TOKEN=")
  ? raw.replace(/^ATTIO_WEBHOOK_TOKEN=.*$/m, `ATTIO_WEBHOOK_TOKEN=${TOKEN}`)
  : raw.trimEnd() + `\nATTIO_WEBHOOK_TOKEN=${TOKEN}\n`;
writeFileSync(".dev.vars", next);
console.log("saved ATTIO_WEBHOOK_TOKEN to .dev.vars (token length:", TOKEN.length, ")");
