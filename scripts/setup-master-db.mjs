// Create (or find) the [Alex] master "All Notes & Tasks" flat table: one row per task/note
// across the whole list, with the deal as a relation + rollup columns for the deal's fields.
// Idempotent: re-running finds the existing DB by title and just re-ensures the rollups.
// Prints the database id to paste into src/config.ts (MASTER_DB_ID).
//
//   node scripts/setup-master-db.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

const PARENT_PAGE = "00000000-0000-0000-0000-000000000025"; // Sales Workspace page
const DEALS_DB = "00000000-0000-0000-0000-000000000022"; // [Alex] Active Deals DB (relation target)
const TITLE = "All Notes & Tasks — [Alex] Active Deals";

async function call(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

// Base schema (everything except rollups, which need the relation to exist first).
const BASE_PROPS = {
  "Item": { title: {} },
  "Type": { select: { options: [{ name: "Note", color: "blue" }, { name: "Task", color: "orange" }] } },
  "Status": { select: { options: [{ name: "Open", color: "yellow" }, { name: "Done", color: "green" }] } },
  "Assignee": { multi_select: { options: [
    { name: "Yoshi Choi", color: "blue" },
    { name: "Alex Morgan", color: "green" },
    { name: "Sam Lee", color: "orange" },
    { name: "Dana Park", color: "purple" },
  ] } },
  "Deal": { relation: { database_id: DEALS_DB, type: "single_property", single_property: {} } },
  "Link": { rich_text: {} },
  "Due": { date: {} },
  "Created": { date: {} },
  "Completed": { date: {} },
  "Updated": { last_edited_time: {} },
  "Source": { select: { options: [{ name: "Deal", color: "purple" }, { name: "Account", color: "brown" }] } },
  "Attio Deal ID": { rich_text: {} }, // which deal this row belongs to (scoping / routing)
  "Row Key": { rich_text: {} }, // stable synthetic id for NOTE rows (tasks match by Link)
};

// Rollups off the Deal relation. rollup_property_name must match the deals-DB property names.
const ROLLUPS = {
  "Deal Stage": { rollup: { relation_property_name: "Deal", rollup_property_name: "Deal Stage", function: "show_original" } },
  "Deal Owner": { rollup: { relation_property_name: "Deal", rollup_property_name: "Deal Owner", function: "show_original" } },
  "Company": { rollup: { relation_property_name: "Deal", rollup_property_name: "Associated Company", function: "show_original" } },
  "Priority": { rollup: { relation_property_name: "Deal", rollup_property_name: "Priority", function: "show_original" } },
  "Account Status": { rollup: { relation_property_name: "Deal", rollup_property_name: "Account Status", function: "show_original" } },
};

// 1) Find an existing master DB by title among the parent page's children (idempotency).
async function findExisting() {
  let cursor;
  for (;;) {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const data = await call("GET", `/blocks/${PARENT_PAGE}/children${q}`);
    for (const b of data.results ?? []) {
      if (b.type === "child_database" && b.child_database?.title === TITLE) return b.id;
    }
    if (!data.has_more) return null;
    cursor = data.next_cursor;
  }
}

let dbId = await findExisting();
if (dbId) {
  console.log("Found existing master DB:", dbId);
} else {
  const db = await call("POST", "/databases", {
    parent: { type: "page_id", page_id: PARENT_PAGE },
    title: [{ type: "text", text: { content: TITLE } }],
    properties: BASE_PROPS,
  });
  dbId = db.id;
  console.log("Created master DB:", dbId);
}

// 2) Ensure the rollups (separate PATCH — they reference the "Deal" relation by name).
await call("PATCH", `/databases/${dbId}`, { properties: ROLLUPS });
console.log("Rollups ensured (Deal Stage / Deal Owner / Company / Priority / Account Status).");

console.log("\n=> Paste this into src/config.ts  MASTER_DB_ID:\n   " + dbId + "\n");
