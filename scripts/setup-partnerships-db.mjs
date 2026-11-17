// Create (or find) the Notion home for the Attio "Partnerships" companies list:
//   Sales Workspace
//     └── Partnerships                        (wrapper page)
//           ├── Partnerships                  (one row per company)
//           └── All Notes & Tasks — Partnerships   (master flat table, 🔏)
//
// Idempotent: re-running finds each piece by title and only re-ensures the rollups.
// Prints the ids to paste into src/config.ts.
//
//   node scripts/setup-partnerships-db.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

const ACCOUNT_STRATEGY = "00000000-0000-0000-0000-000000000025";
const WRAPPER_TITLE = "Partnerships";
const MAIN_TITLE = "Partnerships";
const MASTER_TITLE = "All Notes & Tasks — Partnerships";

async function call(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

const MEMBERS = [
  { name: "Yoshi Choi", color: "blue" },
  { name: "Alex Morgan", color: "green" },
  { name: "Sam Lee", color: "orange" },
  { name: "Dana Park", color: "purple" },
];

// Attio list-entry `prospecting` statuses, in pipeline order. Names must match Attio EXACTLY —
// a mismatch makes Notion silently create a second, differently-coloured option on first write.
const PROSPECTING = [
  { name: "Prospecting", color: "gray" },
  { name: "Intro Meeting", color: "blue" },
  { name: "Negotiating", color: "orange" },
  { name: "Terms Agreed", color: "purple" },
  { name: "Signed", color: "green" },
];
const PRIORITY = [
  { name: "Critical", color: "red" }, { name: "High", color: "orange" },
  { name: "Medium", color: "yellow" }, { name: "Low", color: "green" },
  { name: "Very Low", color: "gray" },
];
const ACCOUNT_STATUS = [
  { name: "Prospect", color: "purple" }, { name: "In Sales", color: "pink" },
  { name: "Pilot", color: "red" }, { name: "Customer", color: "gray" },
  { name: "Churned", color: "brown" }, { name: "Do Not Contact", color: "default" },
  { name: "Disqualified", color: "orange" },
];

const MAIN_PROPS = {
  "Company": { title: {} },
  "Prospecting": { select: { options: PROSPECTING } },
  "Account Owner": { select: { options: MEMBERS.map(({ name, color }) => ({ name, color })) } },
  "Priority": { select: { options: PRIORITY } },
  "Account Status": { select: { options: ACCOUNT_STATUS } },
  "Company Domains": { rich_text: {} },
  "Last Interaction": { date: {} },
  "Next Task Due": { date: {} },
  "Attio Link": { rich_text: {} },
  // Match key. Named "Attio Deal ID" on EVERY target on purpose: webhook routing resolves a
  // Notion page back to an Attio record by this property before it knows which target the page
  // belongs to, so a per-target name would be circular. Hide this column in the view.
  "Attio Deal ID": { rich_text: {} },
};

const masterProps = (mainDbId) => ({
  "Item": { title: {} },
  "Type": { select: { options: [{ name: "Note", color: "blue" }, { name: "Task", color: "orange" }] } },
  "Status": { select: { options: [{ name: "Open", color: "yellow" }, { name: "Done", color: "green" }] } },
  "Assignee": { multi_select: { options: MEMBERS } },
  "Company": { relation: { database_id: mainDbId, type: "single_property", single_property: {} } },
  "Link": { rich_text: {} },
  "Due": { date: {} },
  "Created": { date: {} },
  "Completed": { date: {} },
  "Updated": { last_edited_time: {} },
  "Source": { select: { options: [{ name: "Deal", color: "purple" }, { name: "Account", color: "brown" }] } },
  "Attio Deal ID": { rich_text: {} },
  "Row Key": { rich_text: {} },
});

// Rollups off the "Company" relation. rollup_property_name must match MAIN_PROPS names.
const ROLLUPS = Object.fromEntries(
  ["Prospecting", "Account Owner", "Company Domains", "Priority", "Account Status"].map((p) => [
    p, { rollup: { relation_property_name: "Company", rollup_property_name: p, function: "show_original" } },
  ]),
);

/** Find a child page / child database of `parent` by its title. */
async function findChild(parent, type, title) {
  let cursor;
  for (;;) {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const data = await call("GET", `/blocks/${parent}/children${q}`);
    for (const b of data.results ?? []) {
      if (type === "child_page" && b.type === "child_page" && b.child_page?.title === title) return b.id;
      if (type === "child_database" && b.type === "child_database" && b.child_database?.title === title) return b.id;
    }
    if (!data.has_more) return null;
    cursor = data.next_cursor;
  }
}

// 1) Wrapper page under Sales Workspace.
let wrapper = await findChild(ACCOUNT_STRATEGY, "child_page", WRAPPER_TITLE);
if (wrapper) {
  console.log("Found existing wrapper page:", wrapper);
} else {
  const p = await call("POST", "/pages", {
    parent: { type: "page_id", page_id: ACCOUNT_STRATEGY },
    icon: { type: "emoji", emoji: "🤝" },
    properties: { title: { title: [{ type: "text", text: { content: WRAPPER_TITLE } }] } },
  });
  wrapper = p.id;
  console.log("Created wrapper page:", wrapper);
}

// 2) Main companies DB.
let mainDb = await findChild(wrapper, "child_database", MAIN_TITLE);
if (mainDb) {
  console.log("Found existing Partnerships DB:", mainDb);
} else {
  const db = await call("POST", "/databases", {
    parent: { type: "page_id", page_id: wrapper },
    title: [{ type: "text", text: { content: MAIN_TITLE } }],
    properties: MAIN_PROPS,
  });
  mainDb = db.id;
  console.log("Created Partnerships DB:", mainDb);
}

// 3) Master flat table (needs the main DB id for its relation).
let masterDb = await findChild(wrapper, "child_database", MASTER_TITLE);
if (masterDb) {
  console.log("Found existing master DB:", masterDb);
} else {
  const db = await call("POST", "/databases", {
    parent: { type: "page_id", page_id: wrapper },
    icon: { type: "emoji", emoji: "🔏" },
    title: [{ type: "text", text: { content: MASTER_TITLE } }],
    properties: masterProps(mainDb),
  });
  masterDb = db.id;
  console.log("Created master DB:", masterDb);
}

// 4) Rollups (separate PATCH — they reference the "Company" relation by name).
await call("PATCH", `/databases/${masterDb}`, { properties: ROLLUPS });
console.log("Rollups ensured:", Object.keys(ROLLUPS).join(" / "));

console.log(`
=> Paste into src/config.ts:
   PARTNERSHIPS_DB_ID        = "${mainDb}"
   PARTNERSHIPS_MASTER_DB_ID = "${masterDb}"
   (wrapper page: ${wrapper})
`);
