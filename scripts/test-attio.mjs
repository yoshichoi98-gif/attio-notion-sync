// Read-only validation of the Attio endpoints the Worker relies on.
// Usage: node scripts/test-attio.mjs   (reads ATTIO_API_KEY from ../.dev.vars)
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = env.ATTIO_API_KEY;
const H = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const BASE = "https://api.attio.com";

const DEAL = "00000000-0000-0000-0000-000000000024"; // Riverside deal
const COMPANY = "00000000-0000-0000-0000-000000000037"; // Riverside company

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

console.log("KEY present:", !!KEY, "len:", KEY?.length);

const entries = await call("POST", `/v2/lists/active_deals/entries/query`, { limit: 50 });
console.log("\n[1] list entries:", entries.status, "count:", entries.json?.data?.length);
console.log("    first entry keys:", Object.keys(entries.json?.data?.[0] ?? {}));
console.log("    parent_record_id sample:", JSON.stringify(entries.json?.data?.[0]?.parent_record_id ?? entries.json?.data?.[0]?.parent_record ?? null));

const deal = await call("GET", `/v2/objects/deals/records/${DEAL}`);
const v = deal.json?.data?.values ?? {};
console.log("\n[2] deal record:", deal.status, "value keys:", Object.keys(v).slice(0, 30));
console.log("    name:", JSON.stringify(v.name?.[0] ?? null));
console.log("    stage:", JSON.stringify(v.stage?.[0] ?? null));
console.log("    owner:", JSON.stringify(v.owner?.[0] ?? null));
console.log("    associated_company:", JSON.stringify(v.associated_company?.[0] ?? null));
console.log("    next_steps:", JSON.stringify(v.next_steps?.[0] ?? null));

const company = await call("GET", `/v2/objects/companies/records/${COMPANY}`);
console.log("\n[3] company name:", company.status, JSON.stringify(company.json?.data?.values?.name?.[0]?.value ?? null));

const tasks = await call("GET", `/v2/tasks?linked_object=deals&linked_record_id=${DEAL}&limit=50`);
console.log("\n[4] tasks (deal):", tasks.status, "count:", Array.isArray(tasks.json?.data) ? tasks.json.data.length : tasks.json);
console.log("    first task:", JSON.stringify(tasks.json?.data?.[0] ?? null).slice(0, 400));

const members = await call("GET", `/v2/workspace_members`);
console.log("\n[5] members:", members.status, "count:", members.json?.data?.length);
console.log("    first member:", JSON.stringify(members.json?.data?.[0] ?? null).slice(0, 300));
