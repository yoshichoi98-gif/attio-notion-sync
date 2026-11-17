// Confirm bulk-fetch strategies to minimize Worker subrequests.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" };
const call = async (path, body) => {
  const r = await fetch(`https://api.attio.com${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

// A) all deals in one query (how many are there?)
const deals = await call(`/v2/objects/deals/records/query`, { limit: 50 });
console.log("[A] deals query:", deals.status, "count:", deals.j?.data?.length);

// B) companies filtered by record_id $in  (3 known ids)
const ids = ["00000000-0000-0000-0000-000000000037", "00000000-0000-0000-0000-000000000044", "00000000-0000-0000-0000-000000000045"];
const inFilter = await call(`/v2/objects/companies/records/query`, { filter: { record_id: { $in: ids } }, limit: 50 });
console.log("[B] companies $in filter:", inFilter.status, "count:", inFilter.j?.data?.length,
  inFilter.status !== 200 ? JSON.stringify(inFilter.j).slice(0, 300) : "");
if (inFilter.status === 200) {
  for (const c of inFilter.j.data ?? []) console.log("    -", c?.values?.name?.[0]?.value, c?.id?.record_id);
}
