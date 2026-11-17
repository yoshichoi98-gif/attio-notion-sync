// Create the Attio webhook -> Worker. Prints the signing secret to set as ATTIO_WEBHOOK_SECRET.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" };
const TARGET = "https://attio-notion-sync.example.workers.dev/attio-webhook";
const LIST_ID = "00000000-0000-0000-0000-000000000038"; // Active Deals
const DEALS_OBJECT_ID = "00000000-0000-0000-0000-000000000039";

const api = async (method, path, body) => {
  const r = await fetch(`https://api.attio.com${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
};

// What's already there?
const existing = await api("GET", "/v2/webhooks");
console.log("existing webhooks:", existing.status, "count:", existing.j?.data?.length);
for (const w of existing.j?.data ?? []) console.log("   -", w?.id?.webhook_id, w?.target_url, (w?.subscriptions ?? []).map((s) => s.event_type).join(","));

// Try to create with filtered subscriptions.
const payload = {
  data: {
    target_url: TARGET,
    subscriptions: [
      { event_type: "list-entry.created", filter: { "$and": [{ field: "list_id", operator: "equals", value: LIST_ID }] } },
      { event_type: "list-entry.deleted", filter: { "$and": [{ field: "list_id", operator: "equals", value: LIST_ID }] } },
      { event_type: "record.updated", filter: { "$and": [{ field: "object_id", operator: "equals", value: DEALS_OBJECT_ID }] } },
    ],
  },
};
const created = await api("POST", "/v2/webhooks", payload);
console.log("\ncreate status:", created.status);
console.log(JSON.stringify(created.j, null, 2).slice(0, 1200));
