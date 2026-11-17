// Add the "Deal Type" select column to a deals database (targets with dealTypeColumn: true).
// Idempotent: leaves the column alone if it already exists. Run BEFORE deploying a target with
// dealTypeColumn, or the sync 400s on "Deal Type is not a property". Reads creds from ../.dev.vars.
//   node scripts/add-deal-type-column.mjs [dbId]   (defaults to the [Alex] Active Deals DB)
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const DB = process.argv[2] || "00000000-0000-0000-0000-000000000022";
const COLUMN = "Deal Type";
const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

async function api(path, init) {
  const r = await fetch(`https://api.notion.com/v1${path}`, { headers: H, ...init });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

const db = await api(`/databases/${DB}`);
if (db.properties[COLUMN]) {
  console.log(`"${COLUMN}" already exists (${db.properties[COLUMN].type}) — nothing to do`);
} else {
  await api(`/databases/${DB}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        [COLUMN]: {
          select: {
            options: [
              { name: "New Business", color: "blue" },
              { name: "Expansion/Upsell", color: "green" },
            ],
          },
        },
      },
    }),
  });
  console.log(`added "${COLUMN}" to`, db.title?.[0]?.plain_text ?? DB);
}
