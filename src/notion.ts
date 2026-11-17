import type { AttioKind, Env } from "./config";
import { NOTION_PROPS, kvPut } from "./config";

const BASE = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

async function notion(env: Env, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Notion ${init?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const richText = (s: string | null) => [{ type: "text", text: { content: s ?? "" } }];

/** The "Source" badge on a task row: the record it came from. Mirrors AttioTask.source. */
export type TaskSource = "Deal" | "Account";

export interface DealPageFields {
  deal: string | null;
  company: string | null;
  companyRecordId: string | null;
  companyDomains: string | null;
  accountStatus: string | null;
  nextSteps: string | null;
  stage: string | null;
  priority: string | null;
  owner: string | null;
  attioDealId: string;
  lastInteraction: string | null; // ISO date/timestamp or null
  dealType?: string | null; // only written when PageOpts.dealType is set
}

const COMPANY_URL = (id: string) => `https://app.attio.com/your-workspace/company/${id}/overview`;
const DEAL_URL = (id: string) => `https://app.attio.com/your-workspace/deals/record/${id}`;

/** Where a row's own record lives in Attio. Options default to the deal shape + global labels. */
export interface PageOpts {
  props?: Record<keyof typeof NOTION_PROPS, string>;
  kind?: AttioKind;
  dealType?: boolean; // this database has a "Deal Type" column (SyncTarget.dealTypeColumn)
}

function toProps(f: DealPageFields, opts: PageOpts = {}): Record<string, any> {
  const P = opts.props ?? NOTION_PROPS;
  const isCompany = opts.kind === "companies";
  const props: Record<string, any> = {
    [P.deal]: { title: richText(f.deal) },
    [P.companyDomains]: { rich_text: richText(f.companyDomains) },
    [P.attioDealId]: { rich_text: richText(f.attioDealId) },
  };
  // A companies target has no separate "Associated Company" (the row IS the company) and no
  // next-steps attribute on the object, so those columns don't exist in its database.
  if (!isCompany) {
    const companyCell = f.company
      ? [{ type: "text", text: { content: f.company, ...(f.companyRecordId ? { link: { url: COMPANY_URL(f.companyRecordId) } } : {}) } }]
      : [];
    props[P.company] = { rich_text: companyCell };
    props[P.nextSteps] = { rich_text: richText(f.nextSteps) };
  }
  if (f.attioDealId) {
    props[P.attioLink] = {
      rich_text: [{ type: "text", text: { content: "Open", link: { url: isCompany ? COMPANY_URL(f.attioDealId) : DEAL_URL(f.attioDealId) } } }],
    };
  }
  if (f.stage) props[P.stage] = { select: { name: f.stage } };
  if (f.priority) props[P.priority] = { select: { name: f.priority } };
  if (f.accountStatus) props[P.accountStatus] = { select: { name: f.accountStatus } };
  if (f.owner) props[P.owner] = { select: { name: f.owner } };
  if (opts.dealType) props[P.dealType] = { select: f.dealType ? { name: f.dealType } : null };
  // Last Interaction: set the date (or clear it) every sync — sourced from the company.
  props[P.lastInteraction] = { date: f.lastInteraction ? { start: f.lastInteraction.slice(0, 10) } : null };
  return props;
}

/** Set the "Next Task Due" date on a deal row (earliest open-task deadline, or clear it). */
export async function setNextTaskDue(env: Env, pageId: string, dateISO: string | null): Promise<void> {
  await notion(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { [NOTION_PROPS.nextTaskDue]: { date: dateISO ? { start: dateISO.slice(0, 10) } : null } } }),
  });
}

/** Find an existing deal page in a given database by its Attio Deal ID. Returns page id or null. */
export async function findDealPage(env: Env, dbId: string, attioDealId: string): Promise<string | null> {
  // KV cache first (read-after-write consistent enough to dodge Notion's property-index lag).
  const cached = await env.SYNC_STATE.get(`page:${dbId}:${attioDealId}`);
  if (cached) return cached;
  const data = await notion(env, `/databases/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: NOTION_PROPS.attioDealId, rich_text: { equals: attioDealId } },
      page_size: 1,
    }),
  });
  const pid = data?.results?.[0]?.id ?? null;
  if (pid) await kvPut(env, `page:${dbId}:${attioDealId}`, pid);
  return pid;
}

export async function createDealPage(env: Env, dbId: string, f: DealPageFields, opts: PageOpts = {}): Promise<string> {
  const data = await notion(env, `/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: toProps(f, opts),
    }),
  });
  const id = data?.id;
  if (id) await kvPut(env, `page:${dbId}:${f.attioDealId}`, id);
  return id;
}

/** All active deal pages in a database (including any duplicates) — for self-healing reconcile. */
export async function listAllDealPages(
  env: Env,
  dbId: string,
): Promise<{ attioDealId: string; pageId: string; created: string }[]> {
  const out: { attioDealId: string; pageId: string; created: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const data = await notion(env, `/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
    });
    for (const p of data?.results ?? []) {
      const id = p?.properties?.[NOTION_PROPS.attioDealId]?.rich_text?.[0]?.plain_text ?? "";
      if (id) out.push({ attioDealId: id, pageId: p.id, created: p.created_time });
    }
    if (!data?.has_more) break;
    cursor = data?.next_cursor;
  }
  return out;
}

export async function updateDealPage(env: Env, pageId: string, f: DealPageFields, opts: PageOpts = {}): Promise<void> {
  await notion(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: toProps(f, opts) }),
  });
}

/** Archive (trash) a page — used when a deal is removed from the Attio list. */
export async function archivePage(env: Env, pageId: string): Promise<void> {
  await notion(env, `/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
}

/**
 * Read a page's "Attio Deal ID" + its parent database id. A deal row has both set
 * (parent = one of the main deal DBs). Used to resolve Notion events to (deal, target).
 */
export async function pageDealAndDb(env: Env, pageId: string): Promise<{ dealId: string; mainDbId: string } | null> {
  try {
    const data = await notion(env, `/pages/${pageId}`);
    const dealId = data?.properties?.[NOTION_PROPS.attioDealId]?.rich_text?.[0]?.plain_text;
    const mainDbId = data?.parent?.database_id;
    return dealId && mainDbId ? { dealId, mainDbId } : null;
  } catch {
    return null;
  }
}

/**
 * A Notes & Tasks inline DB id -> the deal + main DB of the page it lives on.
 * Cached on the inline-DB id; on miss, resolve via the inline DB's parent (deal) page.
 */
export async function notesDbToDeal(env: Env, notesDbId: string): Promise<{ dealId: string; mainDbId: string } | null> {
  const cached = await env.SYNC_STATE.get(`dealby_notesdb:${notesDbId}`);
  if (cached) { try { return JSON.parse(cached); } catch { /* fall through */ } }
  try {
    const db = await notion(env, `/databases/${notesDbId}`);
    const pageId = db?.parent?.page_id;
    if (!pageId) return null;
    const res = await pageDealAndDb(env, pageId);
    if (res) await kvPut(env, `dealby_notesdb:${notesDbId}`, JSON.stringify(res));
    return res;
  } catch {
    return null;
  }
}

/** Read a Notes & Tasks row's Type (Note/Task) + Item text — for the Slack alert. */
export async function readRowSummary(env: Env, pageId: string): Promise<{ type: string | null; item: string } | null> {
  try {
    const data = await notion(env, `/pages/${pageId}`);
    const type = data?.properties?.Type?.select?.name ?? null;
    const item = (data?.properties?.Item?.title ?? []).map((t: any) => t.plain_text).join("").trim();
    return { type, item };
  } catch {
    return null;
  }
}

export async function getPageBlocks(env: Env, pageId: string): Promise<any[]> {
  const data = await notion(env, `/blocks/${pageId}/children?page_size=100`);
  return data?.results ?? [];
}

/** Plain text of all top-level blocks ABOVE the tasks heading = the strategy notes. */
export function extractStrategyText(blocks: any[], tasksHeading: string): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading_2" && b.heading_2?.rich_text?.[0]?.plain_text === tasksHeading) break;
    const rt = b?.[b.type]?.rich_text;
    lines.push(Array.isArray(rt) ? rt.map((x: any) => x.plain_text).join("") : "");
  }
  return lines.join("\n").trim();
}

/**
 * Replace the "📋 Tasks (from Attio)" section at the end of a deal page with a fresh
 * table. Everything from the tasks heading downward is removed, then re-appended — so
 * the strategy-notes content ABOVE the heading is left untouched.
 */
export async function setTasksSection(
  env: Env,
  pageId: string,
  heading: string,
  rows: string[][],
  preBlocks?: any[],
): Promise<void> {
  const blocks = preBlocks ?? await getPageBlocks(env, pageId);
  const idx = blocks.findIndex(
    (b) => b.type === "heading_2" && b.heading_2?.rich_text?.[0]?.plain_text === heading,
  );
  if (idx >= 0) {
    for (const b of blocks.slice(idx)) await notion(env, `/blocks/${b.id}`, { method: "DELETE" });
  }

  const children: any[] = [
    { object: "block", type: "heading_2", heading_2: { rich_text: richText(heading) } },
  ];
  if (rows.length) {
    const header = ["Task", "Source", "Status", "Due", "Assignee"];
    children.push({
      object: "block",
      type: "table",
      table: {
        table_width: 5,
        has_column_header: true,
        has_row_header: false,
        children: [header, ...rows].map((cells) => ({
          object: "block",
          type: "table_row",
          table_row: { cells: cells.map((c) => richText(c)) },
        })),
      },
    });
  } else {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText("No open tasks from Attio.") },
    });
  }
  await notion(env, `/blocks/${pageId}/children`, { method: "PATCH", body: JSON.stringify({ children }) });
}

// ===== Notes & Tasks unified per-deal inline table =====
export const NT_TITLE = "Notes & Tasks";
const ATTIO_TASK_URL = (id: string) => `https://app.attio.com/your-workspace/tasks?command-menu-page=task&id=${id}`;
const cell = (s: string, opts: { strike?: boolean; url?: string } = {}): any[] => [
  { type: "text", text: { content: s, ...(opts.url ? { link: { url: opts.url } } : {}) }, annotations: { strikethrough: !!opts.strike } },
];

// Column order: Item (title, pinned first by Notion) then Type, Status, Assignee, Link, Due, Logged, Updated, Source
const NT_SCHEMA: Record<string, any> = {
  "Item": { title: {} },
  "Type": { select: { options: [{ name: "Note", color: "blue" }, { name: "Task", color: "orange" }] } },
  "Status": { select: { options: [{ name: "Open", color: "yellow" }, { name: "Done", color: "green" }] } },
  "Assignee": { multi_select: { options: [
    { name: "Yoshi Choi", color: "blue" },
    { name: "Alex Morgan", color: "green" },
    { name: "Sam Lee", color: "orange" },
    { name: "Dana Park", color: "purple" },
  ] } },
  "Link": { rich_text: {} },
  "Due": { date: {} },
  "Created": { date: {} }, // unified date: tasks = Attio create date, notes = their logged/creation date
  "Completed": { date: {} }, // task completion date (Attio completed_at); blank while open
  "Updated": { last_edited_time: {} },
  "Source": { select: { options: [{ name: "Deal", color: "purple" }, { name: "Account", color: "brown" }] } },
};

/** Find (cached) or create the inline Notes & Tasks DB on a deal page; clears old markdown task blocks. */
export async function ensureNotesTasksDb(env: Env, pageId: string): Promise<string> {
  const key = `notesdb_page:${pageId}`;
  const cached = await env.SYNC_STATE.get(key);
  if (cached) return cached;
  const blocks = await getPageBlocks(env, pageId);
  let dbId: string | null = null;
  const stale: string[] = [];
  for (const b of blocks) {
    if (b.type === "child_database" && b.child_database?.title === NT_TITLE) dbId = b.id;
    else stale.push(b.id); // remove every other block so the table is the page's top content
  }
  for (const id of stale) { try { await notion(env, `/blocks/${id}`, { method: "DELETE" }); } catch { /* ignore */ } }
  if (!dbId) {
    const db = await notion(env, `/databases`, {
      method: "POST",
      body: JSON.stringify({ parent: { type: "page_id", page_id: pageId }, is_inline: true, title: richText(NT_TITLE), properties: NT_SCHEMA }),
    });
    dbId = db.id;
  }
  await kvPut(env, key, dbId as string);
  return dbId as string;
}

export interface LinkedTaskRow {
  rowId: string;
  content: string;
  completed: boolean;
  due: string | null; // YYYY-MM-DD or null
  assignees: string[]; // member display names
  createdDay: string | null; // row's Created date (YYYY-MM-DD) — to detect missing/stale date cols
  completedDay: string | null; // row's Completed date (YYYY-MM-DD)
}
export interface NotesTasksRows {
  // Task rows linked to an Attio task -> their current Notion-side field values.
  linkedTaskRows: Record<string, LinkedTaskRow>;
  noteRows: { rowId: string; text: string; created: string; hasCreated: boolean; lastEdited: string }[];
  // Task-type rows a user created in Notion that aren't linked to an Attio task yet.
  newTaskRows: { rowId: string; content: string; due: string | null; assignees: string[]; completed: boolean }[];
  // Extra rows that point at a task id already claimed by another row (race dups) -> archive.
  dupTaskRowIds: string[];
}
export async function queryNotesTasksRows(env: Env, dbId: string): Promise<NotesTasksRows> {
  const out: NotesTasksRows = { linkedTaskRows: {}, noteRows: [], newTaskRows: [], dupTaskRowIds: [] };
  let cursor: string | undefined;
  for (;;) {
    const data = await notion(env, `/databases/${dbId}/query`, { method: "POST", body: JSON.stringify({ start_cursor: cursor, page_size: 100 }) });
    for (const r of data?.results ?? []) {
      const ty = r.properties?.Type?.select?.name;
      const lk = r.properties?.Link?.rich_text?.[0];
      const url = lk?.href || lk?.text?.link?.url || "";
      const m = url.match(/id=([0-9a-fA-F-]{36})/);
      if (ty === "Task") {
        const content = (r.properties?.Item?.title ?? []).map((t: any) => t.plain_text).join("").trim();
        const completed = r.properties?.Status?.select?.name === "Done";
        const due = (r.properties?.Due?.date?.start ?? null)?.slice(0, 10) || null;
        const assignees = (r.properties?.Assignee?.multi_select ?? []).map((o: any) => o.name).filter(Boolean);
        if (m) {
          if (out.linkedTaskRows[m[1]]) out.dupTaskRowIds.push(r.id); // keep first, drop the rest
          else out.linkedTaskRows[m[1]] = {
            rowId: r.id, content, completed, due, assignees,
            createdDay: (r.properties?.Created?.date?.start ?? null)?.slice(0, 10) || null,
            completedDay: (r.properties?.Completed?.date?.start ?? null)?.slice(0, 10) || null,
          };
        }
        else if (content) {
          // No Attio link yet => a task the user created in Notion. Queue it to push to Attio.
          out.newTaskRows.push({ rowId: r.id, content, due, assignees, completed });
        }
      }
      if (ty === "Note") {
        const set = r.properties?.Created?.date?.start;
        out.noteRows.push({
          rowId: r.id,
          text: (r.properties?.Item?.title ?? []).map((t: any) => t.plain_text).join(""),
          created: set || r.created_time, // existing Created, else the row's true creation time
          hasCreated: !!set,
          lastEdited: r.last_edited_time, // drives two-way note conflict resolution (newer wins)
        });
      }
    }
    if (!data?.has_more) break;
    cursor = data?.next_cursor;
  }
  return out;
}

/** Stamp a note row's Created date (from its creation time) — done once, never overwrites. */
export async function setNoteCreated(env: Env, rowId: string, iso: string): Promise<void> {
  await notion(env, `/pages/${rowId}`, { method: "PATCH", body: JSON.stringify({ properties: { Created: { date: { start: iso } } } }) });
}

function taskProps(t: { id: string; content: string; deadline: string | null; created: string | null; completed: boolean; completedAt?: string | null; assignees: string[]; source: string }): Record<string, any> {
  const d = t.completed;
  return {
    "Item": { title: cell(t.content || "(task)", { strike: d }) },
    "Type": { select: { name: "Task" } },
    "Status": { select: { name: d ? "Done" : "Open" } },
    "Assignee": { multi_select: t.assignees.map((n) => ({ name: n })) },
    "Link": { rich_text: cell("LINK", { strike: d, url: ATTIO_TASK_URL(t.id) }) },
    "Due": t.deadline ? { date: { start: t.deadline.slice(0, 10) } } : { date: null },
    "Created": t.created ? { date: { start: t.created } } : { date: null },
    "Completed": t.completedAt ? { date: { start: t.completedAt } } : { date: null },
    "Source": { select: { name: t.source } },
  };
}

export async function upsertTaskRow(env: Env, dbId: string, t: any, existingRowId?: string): Promise<void> {
  if (existingRowId) await notion(env, `/pages/${existingRowId}`, { method: "PATCH", body: JSON.stringify({ properties: taskProps(t) }) });
  else await notion(env, `/pages`, { method: "POST", body: JSON.stringify({ parent: { database_id: dbId }, properties: taskProps(t) }) });
}

export async function archiveRow(env: Env, rowId: string): Promise<void> {
  await notion(env, `/pages/${rowId}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
}

/** After creating the Attio task for a Notion-authored row, stamp its Link (+ Source) so future syncs match it. */
export async function setTaskRowLink(env: Env, rowId: string, taskId: string, completed: boolean, source: TaskSource = "Deal"): Promise<void> {
  await notion(env, `/pages/${rowId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        "Link": { rich_text: cell("LINK", { strike: completed, url: ATTIO_TASK_URL(taskId) }) },
        "Source": { select: { name: source } },
      },
    }),
  });
}

/** Set the Item (title) text of any Notes & Tasks / master row (used for two-way note text sync). */
export async function setRowItemText(env: Env, rowId: string, text: string): Promise<void> {
  await notion(env, `/pages/${rowId}`, { method: "PATCH", body: JSON.stringify({ properties: { "Item": { title: richText(text) } } }) });
}

/** Create a NOTE row in a per-deal Notes & Tasks table (used when a note originates in the master table). Returns row id. */
export async function createNoteRow(env: Env, dbId: string, text: string, createdISO?: string): Promise<string> {
  const props: Record<string, any> = { "Item": { title: richText(text) }, "Type": { select: { name: "Note" } } };
  if (createdISO) props["Created"] = { date: { start: createdISO } };
  const data = await notion(env, `/pages`, { method: "POST", body: JSON.stringify({ parent: { database_id: dbId }, properties: props }) });
  return data?.id;
}

// ===== master "All Notes & Tasks" flat table =====
// One row per task/note across the whole list. Same task/note columns as the per-deal table, plus
// a relation to the record's row (rollups hang off it; named "Deal" on the deals targets and
// "Company" on Partnerships — hence `relProp`), an "Attio Deal ID" scoping key, and a "Row Key"
// stable id for note rows (tasks match by the Link URL's task id, exactly like the per-deal table).
// "Attio Deal ID" keeps its name on every target: routing reads it before the target is known.

/** Task props for a master row = per-deal task props + Deal relation + Attio Deal ID. */
function masterTaskProps(relProp: string, dealPageId: string, attioDealId: string, t: Parameters<typeof taskProps>[0]): Record<string, any> {
  return {
    ...taskProps(t),
    [relProp]: { relation: [{ id: dealPageId }] },
    "Attio Deal ID": { rich_text: richText(attioDealId) },
  };
}

export async function upsertMasterTaskRow(env: Env, masterDbId: string, relProp: string, dealPageId: string, attioDealId: string, t: any, existingRowId?: string): Promise<void> {
  const props = masterTaskProps(relProp, dealPageId, attioDealId, t);
  if (existingRowId) await notion(env, `/pages/${existingRowId}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
  else await notion(env, `/pages`, { method: "POST", body: JSON.stringify({ parent: { database_id: masterDbId }, properties: props }) });
}

/** After creating the Attio task for a master-authored task row, stamp Link/Source/relation/deal id. */
export async function setMasterTaskRowLink(env: Env, rowId: string, taskId: string, completed: boolean, relProp: string, dealPageId: string, attioDealId: string, source: TaskSource = "Deal"): Promise<void> {
  await notion(env, `/pages/${rowId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        "Link": { rich_text: cell("LINK", { strike: completed, url: ATTIO_TASK_URL(taskId) }) },
        "Source": { select: { name: source } },
        [relProp]: { relation: [{ id: dealPageId }] },
        "Attio Deal ID": { rich_text: richText(attioDealId) },
      },
    }),
  });
}

/** Create/update a NOTE row in the master table (Row Key ties it to its per-deal twin). */
export async function upsertMasterNoteRow(
  env: Env,
  masterDbId: string,
  relProp: string,
  dealPageId: string,
  attioDealId: string,
  note: { rowKey: string; text: string; createdISO?: string },
  existingRowId?: string,
): Promise<string> {
  const props: Record<string, any> = {
    "Item": { title: richText(note.text) },
    "Type": { select: { name: "Note" } },
    [relProp]: { relation: [{ id: dealPageId }] },
    "Attio Deal ID": { rich_text: richText(attioDealId) },
    "Row Key": { rich_text: richText(note.rowKey) },
  };
  if (note.createdISO) props["Created"] = { date: { start: note.createdISO } };
  if (existingRowId) { await notion(env, `/pages/${existingRowId}`, { method: "PATCH", body: JSON.stringify({ properties: props }) }); return existingRowId; }
  const data = await notion(env, `/pages`, { method: "POST", body: JSON.stringify({ parent: { database_id: masterDbId }, properties: props }) });
  return data?.id;
}

/** Stamp a master row's Row Key (links a master-authored note back to its per-deal twin). */
export async function setMasterRowKey(env: Env, rowId: string, rowKey: string): Promise<void> {
  await notion(env, `/pages/${rowId}`, { method: "PATCH", body: JSON.stringify({ properties: { "Row Key": { rich_text: richText(rowKey) } } }) });
}

export interface MasterRows {
  linkedTaskRows: Record<string, LinkedTaskRow>; // Attio task id -> master row
  newTaskRows: { rowId: string; content: string; due: string | null; assignees: string[]; completed: boolean }[];
  dupTaskRowIds: string[];
  noteRows: { rowId: string; rowKey: string; text: string; lastEdited: string }[]; // notes WITH a Row Key
  newNoteRows: { rowId: string; text: string; lastEdited: string }[]; // notes the user created here (no Row Key yet)
}

/**
 * All master rows for ONE deal, matched by the Deal relation OR the Attio Deal ID column.
 * The relation alone is not enough: if a deal's page is ever re-created (its old page archived),
 * every existing master row still points at the DEAD page id and would look like it belongs to no
 * deal — orphaned forever, and invisible to both the task reconcile and the orphan cleanup. Matching
 * the deal id as well lets those rows be adopted (upsert re-points the relation) instead.
 */
export async function queryMasterRows(env: Env, masterDbId: string, relProp: string, dealPageId: string, dealId: string): Promise<MasterRows> {
  const out: MasterRows = { linkedTaskRows: {}, newTaskRows: [], dupTaskRowIds: [], noteRows: [], newNoteRows: [] };
  let cursor: string | undefined;
  for (;;) {
    const data = await notion(env, `/databases/${masterDbId}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          or: [
            { property: relProp, relation: { contains: dealPageId } },
            { property: "Attio Deal ID", rich_text: { equals: dealId } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      }),
    });
    for (const r of data?.results ?? []) {
      const ty = r.properties?.Type?.select?.name;
      const item = (r.properties?.Item?.title ?? []).map((t: any) => t.plain_text).join("").trim();
      if (ty === "Task") {
        const lk = r.properties?.Link?.rich_text?.[0];
        const url = lk?.href || lk?.text?.link?.url || "";
        const m = url.match(/id=([0-9a-fA-F-]{36})/);
        const completed = r.properties?.Status?.select?.name === "Done";
        const due = (r.properties?.Due?.date?.start ?? null)?.slice(0, 10) || null;
        const assignees = (r.properties?.Assignee?.multi_select ?? []).map((o: any) => o.name).filter(Boolean);
        if (m) {
          if (out.linkedTaskRows[m[1]]) out.dupTaskRowIds.push(r.id);
          else out.linkedTaskRows[m[1]] = {
            rowId: r.id, content: item, completed, due, assignees,
            createdDay: (r.properties?.Created?.date?.start ?? null)?.slice(0, 10) || null,
            completedDay: (r.properties?.Completed?.date?.start ?? null)?.slice(0, 10) || null,
          };
        } else if (item) {
          out.newTaskRows.push({ rowId: r.id, content: item, due, assignees, completed });
        }
      } else if (ty === "Note") {
        const rowKey = (r.properties?.["Row Key"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim();
        if (rowKey) out.noteRows.push({ rowId: r.id, rowKey, text: item, lastEdited: r.last_edited_time });
        else if (item) out.newNoteRows.push({ rowId: r.id, text: item, lastEdited: r.last_edited_time });
      }
    }
    if (!data?.has_more) break;
    cursor = data?.next_cursor;
  }
  return out;
}

/**
 * Every master row's (rowId, dealId) pair, for orphan sweeps. Rows whose deal has left the list are
 * otherwise unreachable once its deal page is archived: the per-deal cleanup is driven by the live
 * deal pages, so a row that outlived its page is in no one's scope.
 */
export async function listMasterRowDealIds(env: Env, masterDbId: string): Promise<{ rowId: string; dealId: string }[]> {
  const out: { rowId: string; dealId: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const data = await notion(env, `/databases/${masterDbId}/query`, {
      method: "POST",
      body: JSON.stringify({ start_cursor: cursor, page_size: 100 }),
    });
    for (const r of data?.results ?? []) {
      const dealId = (r.properties?.["Attio Deal ID"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim();
      if (dealId) out.push({ rowId: r.id, dealId });
    }
    if (!data?.has_more) break;
    cursor = data?.next_cursor;
  }
  return out;
}

/** Resolve a master row to its deal id — via the Attio Deal ID column, else the Deal relation. For webhook routing. */
export async function masterRowToDeal(env: Env, rowId: string, relProp = "Deal"): Promise<string | null> {
  try {
    const data = await notion(env, `/pages/${rowId}`);
    const direct = (data?.properties?.["Attio Deal ID"]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim();
    if (direct) return direct;
    const relPage = data?.properties?.[relProp]?.relation?.[0]?.id;
    if (relPage) { const res = await pageDealAndDb(env, relPage); return res?.dealId ?? null; }
    return null;
  } catch {
    return null;
  }
}
