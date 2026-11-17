// End-to-end webhook test on the Riverside TEST deal:
// change next_steps in Attio -> expect the webhook to push it to Notion -> then revert.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const DEAL = "00000000-0000-0000-0000-000000000024";
const DB = "00000000000000000000000000000021";
const marker = `webhook test ${Math.floor(performance.now())}`;

const attio = (m, p, b) => fetch(`https://api.attio.com${p}`, {
  method: m, headers: { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" },
  body: b ? JSON.stringify(b) : undefined,
});
const notion = (p, b) => fetch(`https://api.notion.com/v1${p}`, {
  method: "POST", headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
  body: JSON.stringify(b),
}).then((r) => r.json());

async function notionNextSteps() {
  const q = await notion(`/databases/${DB}/query`, { filter: { property: "Attio Deal ID", rich_text: { equals: DEAL } }, page_size: 1 });
  return q?.results?.[0]?.properties?.["Next Steps Notes"]?.rich_text?.[0]?.plain_text ?? "";
}

console.log("before  | Notion Next Steps:", JSON.stringify(await notionNextSteps()));
const set = await attio("PATCH", `/v2/objects/deals/records/${DEAL}`, { data: { values: { next_steps: marker } } });
console.log("patched | Attio next_steps ->", JSON.stringify(marker), "status", set.status);

let propagated = false;
const t0 = performance.now();
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const v = await notionNextSteps();
  if (v === marker) { propagated = true; console.log(`PROPAGATED in ~${((performance.now() - t0) / 1000).toFixed(1)}s`); break; }
  process.stdout.write(".");
}
if (!propagated) console.log("\nNOT propagated within ~18s (check `wrangler tail`).");

// revert
await attio("PATCH", `/v2/objects/deals/records/${DEAL}`, { data: { values: { next_steps: "" } } });
console.log("reverted Attio next_steps to empty.");
