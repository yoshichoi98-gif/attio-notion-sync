// Roll out the embedded "Notes & Tasks" table to deal pages.
// - creates an inline DB (on top) if missing, removes old markdown/free-text blocks
// - upserts Task rows from Attio (Done = struck through; clickable LINK)
// - migrates any pre-existing free-text body lines into Note rows (fresh DBs only)
// Idempotent. Limit to one deal for testing:  ONLY="Riverside" node scripts/rollout-notes-tasks.mjs
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const NH = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
const AH = { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" };
const DEALS_DB = "00000000000000000000000000000021";
const ONLY = process.env.ONLY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nx(m, p, b) { const r = await fetch("https://api.notion.com/v1" + p, { method: m, headers: NH, body: b ? JSON.stringify(b) : undefined }); await sleep(120); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`notion ${m} ${p} ${r.status} ${JSON.stringify(j).slice(0,200)}`); return j; }
async function at(m, p, b) { const r = await fetch("https://api.attio.com" + p, { method: m, headers: AH, body: b ? JSON.stringify(b) : undefined }); await sleep(120); return r.json().catch(() => ({})); }

const taskUrl = (id) => `https://app.attio.com/your-workspace/tasks?command-menu-page=task&id=${id}`;
const rt = (s, { strike = false, url = null } = {}) => [{ type: "text", text: { content: s, ...(url ? { link: { url } } : {}) }, annotations: { strikethrough: strike } }];

const SCHEMA = {
  "Item": { title: {} },
  "Type": { select: { options: [{ name: "Note", color: "blue" }, { name: "Task", color: "orange" }] } },
  "Status": { select: { options: [{ name: "Open", color: "yellow" }, { name: "Done", color: "green" }] } },
  "Due": { date: {} },
  "Assignee": { rich_text: {} },
  "Source": { select: { options: [{ name: "Deal", color: "purple" }, { name: "Account", color: "brown" }] } },
  "Link": { rich_text: {} },
  "Logged": { created_time: {} },
  "Updated": { last_edited_time: {} },
};

async function members() {
  const d = await at("GET", "/v2/workspace_members");
  const m = {}; for (const x of d?.data ?? []) m[x.id?.workspace_member_id ?? x.workspace_member_id] = [x.first_name, x.last_name].filter(Boolean).join(" ") || x.email_address;
  return m;
}
async function dealCompanyId(dealId) { const d = await at("GET", `/v2/objects/deals/records/${dealId}`); return d?.data?.values?.associated_company?.[0]?.target_record_id ?? null; }
async function tasksFor(object, recordId, source, mem) {
  if (!recordId) return [];
  const d = await at("GET", `/v2/tasks?linked_object=${object}&linked_record_id=${recordId}&limit=50`);
  return (d?.data ?? []).map((t) => ({ id: t.id?.task_id, content: (t.content_plaintext ?? t.content ?? "").trim(), due: t.deadline_at ? t.deadline_at.slice(0, 10) : null, done: !!t.is_completed, assignee: mem[t.assignees?.[0]?.referenced_actor_id ?? t.assignees?.[0]?.workspace_member_id] ?? "—", source }));
}

function taskProps(t) {
  const p = {
    "Item": { title: rt(t.content, { strike: t.done }) },
    "Type": { select: { name: "Task" } },
    "Status": { select: { name: t.done ? "Done" : "Open" } },
    "Assignee": { rich_text: rt(t.assignee, { strike: t.done }) },
    "Source": { select: { name: t.source } },
    "Link": { rich_text: rt("LINK", { strike: t.done, url: taskUrl(t.id) }) },
  };
  p["Due"] = t.due ? { date: { start: t.due } } : { date: null };
  return p;
}

async function processDeal(deal, mem) {
  const { pageId, name, dealId } = deal;
  const companyId = await dealCompanyId(dealId);
  const tasks = [...await tasksFor("deals", dealId, "Deal", mem), ...await tasksFor("companies", companyId, "Account", mem)];

  // page children: find existing Notes & Tasks DB; collect deletable blocks + free-text lines
  const children = (await nx("GET", `/blocks/${pageId}/children?page_size=100`)).results ?? [];
  let dbId = null; const freeText = []; const toDelete = [];
  for (const b of children) {
    if (b.type === "child_database" && b.child_database?.title === "Notes & Tasks") { dbId = b.id; continue; }
    if (["paragraph", "bulleted_list_item", "numbered_list_item"].includes(b.type)) {
      const s = (b[b.type].rich_text ?? []).map((x) => x.plain_text).join("").trim();
      if (s) freeText.push(s);
    }
    toDelete.push(b.id);
  }
  for (const id of toDelete) await nx("DELETE", `/blocks/${id}`);

  let fresh = false;
  if (!dbId) { const db = await nx("POST", "/databases", { parent: { type: "page_id", page_id: pageId }, is_inline: true, title: rt("Notes & Tasks"), properties: SCHEMA }); dbId = db.id; fresh = true; }

  // existing rows -> map task-id(from Link url) -> rowId
  const rows = []; let cur;
  do { const q = await nx("POST", `/databases/${dbId}/query`, { start_cursor: cur, page_size: 100 }); rows.push(...q.results); cur = q.has_more ? q.next_cursor : null; } while (cur);
  const taskRowByTaskId = {}; let noteCount = 0;
  for (const r of rows) {
    const ty = r.properties?.Type?.select?.name;
    const url = r.properties?.Link?.rich_text?.[0]?.href || r.properties?.Link?.rich_text?.[0]?.text?.link?.url || "";
    const m = url.match(/id=([0-9a-f-]{36})/i);
    if (ty === "Task" && m) taskRowByTaskId[m[1]] = r.id;
    if (ty === "Note") noteCount++;
  }

  // migrate free-text -> Note rows (only on a fresh DB)
  if (fresh) for (const line of freeText) await nx("POST", "/pages", { parent: { database_id: dbId }, properties: { "Item": { title: rt(line) }, "Type": { select: { name: "Note" } } } });

  // upsert task rows
  let created = 0, updated = 0;
  for (const t of tasks) {
    if (!t.id) continue;
    const existing = taskRowByTaskId[t.id];
    if (existing) { await nx("PATCH", `/pages/${existing}`, { properties: taskProps(t) }); updated++; }
    else { await nx("POST", "/pages", { parent: { database_id: dbId }, properties: taskProps(t) }); created++; }
  }
  console.log(`  ✓ ${name}: db=${fresh ? "created" : "existing"} tasks(+${created}/~${updated}) notes(${noteCount}${fresh ? "+" + freeText.length : ""})`);
}

// gather deals
const deals = []; let cur;
do { const q = await nx("POST", `/databases/${DEALS_DB}/query`, { start_cursor: cur, page_size: 100 }); for (const p of q.results) deals.push({ pageId: p.id, name: p.properties?.Deal?.title?.[0]?.plain_text ?? "(untitled)", dealId: p.properties?.["Attio Deal ID"]?.rich_text?.[0]?.plain_text ?? "" }); cur = q.has_more ? q.next_cursor : null; } while (cur);
const target = deals.filter((d) => d.dealId && (!ONLY || d.name.toLowerCase().includes(ONLY.toLowerCase())));
console.log(`processing ${target.length} deal(s)${ONLY ? ` (ONLY=${ONLY})` : ""}`);
const mem = await members();
for (const d of target) { try { await processDeal(d, mem); } catch (e) { console.log(`  ✗ ${d.name}: ${e.message}`); } }
console.log("rollout done");
