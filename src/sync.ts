import type { Env, SyncTarget } from "./config";
import {
  getListEntries, getListEntriesCached, getDealsByIds, getCompaniesByIds, getMembers,
  getDealRow, getDealsByType, getCompanyMeta, listTasks, upsertStrategyNote, createDealTask,
  updateAttioTask, deleteAttioTask, type AttioTask, type DealRow,
} from "./attio";
import {
  MEMBER_FALLBACK, getTargets, kvPut, kvDelete, propsFor, objectSlug, masterRelProp, isClosedWon,
} from "./config";
import {
  listAllDealPages, createDealPage, updateDealPage, findDealPage, archivePage,
  ensureNotesTasksDb, queryNotesTasksRows, upsertTaskRow, archiveRow, setNoteCreated,
  setTaskRowLink, setNextTaskDue, type DealPageFields, type LinkedTaskRow,
  queryMasterRows, upsertMasterTaskRow, setMasterTaskRowLink, upsertMasterNoteRow,
  createNoteRow, setRowItemText, listMasterRowDealIds, type MasterRows,
  type PageOpts, type TaskSource,
} from "./notion";

// Small non-crypto string hash for change-detection (note-push churn guard).
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// Canonical task snapshots for 3-way change detection (which side edited since last sync).
function taskSnap(x: { content: string; completed: boolean; due: string | null; assignees: string[] }): string {
  return JSON.stringify({ c: (x.content || "").trim(), d: !!x.completed, u: x.due || null, a: [...x.assignees].sort() });
}
function editSnap(x: { completed: boolean; due: string | null; assignees: string[] }): string {
  return JSON.stringify({ d: !!x.completed, u: x.due || null, a: [...x.assignees].sort() });
}
function editPart(snapStr: string): string {
  try { const o = JSON.parse(snapStr); return JSON.stringify({ d: !!o.d, u: o.u || null, a: o.a || [] }); } catch { return ""; }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export interface DealSyncResult {
  pageId: string | null;
  openTasks: number;
  notesPushed: boolean;
  tasksCreated: number;
  skipped?: boolean;
}

/**
 * Does a deal belong to this target through its alsoIncludeDealType rule (rather than its list)?
 * Closed Won deals fall out of the rule, so a won upsell leaves the table on its own.
 */
export function matchesDealTypeRule(target: SyncTarget, row: DealRow): boolean {
  return !!target.alsoIncludeDealType && (target.kind ?? "deals") === "deals"
    && row.dealType === target.alsoIncludeDealType && !isClosedWon(row.stage);
}

/** The deals a target holds by rule alone. Empty for targets without one. */
async function ruleDeals(env: Env, target: SyncTarget): Promise<DealRow[]> {
  if (!target.alsoIncludeDealType || (target.kind ?? "deals") !== "deals") return [];
  return (await getDealsByType(env, target.alsoIncludeDealType)).filter((r) => matchesDealTypeRule(target, r));
}

/**
 * Drop every cached snapshot for a deal in one target. Critical when a deal's row goes away:
 * a surviving `taskstate:` snapshot makes the next sync of a fresh/empty table look like the user
 * deleted every row, which the task reconcile would answer by deleting the Attio tasks.
 */
async function purgeDealState(env: Env, target: SyncTarget, dealId: string): Promise<void> {
  await kvDelete(env, `page:${target.dbId}:${dealId}`);
  await kvDelete(env, `taskstate:${target.dbId}:${dealId}`);
  await kvDelete(env, `note_hash:${target.dbId}:${dealId}`);
  if (target.masterDbId) await kvDelete(env, `taskstate:${target.masterDbId}:${dealId}`);
}

/** Archive a deal's master rows + its deal page in this target, then clear its cached state. */
async function purgeDealFromTarget(env: Env, target: SyncTarget, dealId: string, pageId: string): Promise<void> {
  if (target.masterDbId) {
    try {
      const mr = await queryMasterRows(env, target.masterDbId, masterRelProp(target), pageId, dealId);
      const rowIds = [
        ...Object.values(mr.linkedTaskRows).map((r) => r.rowId),
        ...mr.newTaskRows.map((r) => r.rowId),
        ...mr.dupTaskRowIds,
        ...mr.noteRows.map((r) => r.rowId),
        ...mr.newNoteRows.map((r) => r.rowId),
      ];
      for (const id of rowIds) {
        try { await archiveRow(env, id); } catch (err) { console.error("archive master row", id, err); }
      }
    } catch (err) { console.error("archive master rows", dealId, err); }
  }
  try { await archivePage(env, pageId); } catch (err) { console.error("archive page", pageId, err); }
  await purgeDealState(env, target, dealId);
}

/**
 * A company record expressed as a DealRow so the one engine drives both kinds of target.
 * `companyRecordId` is deliberately null: it means "a DIFFERENT company this row is associated
 * with", which for a companies row would double-count its own tasks and re-link its own name.
 */
async function companyAsRow(env: Env, companyId: string, stage: string | null): Promise<DealRow> {
  const c = await getCompanyMeta(env, companyId);
  return {
    dealId: companyId,
    name: c.name,
    companyRecordId: null,
    nextSteps: null, // no such attribute on companies — the column is absent from the DB
    stage, // from the list ENTRY, not the record
    priority: c.priority,
    ownerMemberId: c.ownerMemberId,
    dealType: null,
  };
}

/**
 * Per-deal lock around the core sync. Real-time triggers (Notion webhook + the Attio
 * task.created it causes + cron) can fire for the same deal within the same second; the
 * lock collapses them into one run and re-runs once more if edits land mid-sync — this
 * prevents the duplicate-row / double-create races between concurrent syncs.
 */
export async function syncOneDeal(env: Env, dealId: string, target: SyncTarget): Promise<DealSyncResult> {
  const ZERO: DealSyncResult = { pageId: null, openTasks: 0, notesPushed: false, tasksCreated: 0 };
  const lockKey = `lock:${target.dbId}:${dealId}`;
  const dirtyKey = `dirty:${target.dbId}:${dealId}`;
  const cur = await env.SYNC_STATE.get(lockKey);
  if (cur && Date.now() - Number(cur) < 12000) {
    // Another sync is in flight; flag it so that run picks up this change too.
    await kvPut(env, dirtyKey, "1", { expirationTtl: 60 });
    return { ...ZERO, skipped: true };
  }
  let result: DealSyncResult = ZERO;
  for (let i = 0; i < 3; i++) {
    await kvPut(env, lockKey, String(Date.now()), { expirationTtl: 60 });
    await kvDelete(env, dirtyKey);
    try { result = await syncOneDealCore(env, dealId, target); }
    finally { await kvDelete(env, lockKey); }
    if (!(await env.SYNC_STATE.get(dirtyKey))) break; // nothing arrived during the run
  }
  return result;
}

/**
 * Targeted real-time sync for ONE deal into ONE target database: upsert its row + mirror
 * its Notes & Tasks table. Cheap (~10 API calls) — stays under the free-plan subrequest cap.
 */
async function syncOneDealCore(
  env: Env,
  dealId: string,
  target: SyncTarget,
): Promise<DealSyncResult> {
  const pageOpts: PageOpts = { props: propsFor(target), kind: target.kind, dealType: !!target.dealTypeColumn };
  const relProp = masterRelProp(target);
  const objSlug = objectSlug(env, target);
  // A companies target's own tasks/notes are the account's, not a deal's.
  const taskSource: TaskSource = target.kind === "companies" ? "Account" : "Deal";

  // A record that has left this target's Attio list must not have — or keep — a row here.
  // Nothing else enforces this on the per-record path: targetsForDeal() routes on "has a Notion
  // page" alone, and the archived-page recovery below ends in createDealPage(), so ANY Attio
  // activity on a de-listed record used to resurrect its row indefinitely.
  // This lookup doubles as the stage source for targets whose stage lives on the LIST ENTRY
  // (Partnerships), so `prospecting` costs no extra request.
  let entries = await getListEntriesCached(env, target.listSlug, target.stageEntryAttr);
  let entry = entries.find((e) => e.recordId === dealId);
  // Never remove on a cached miss — a record added seconds ago would still look absent.
  if (!entry) {
    entries = await getListEntries(env, target.listSlug, target.stageEntryAttr);
    entry = entries.find((e) => e.recordId === dealId);
  }
  // Not on the list, but the target may also take it by Deal Type. Judged on the live record, so a
  // deal that just turned Closed Won (or stopped being an upsell) is removed on this very sync.
  let ruleRow: DealRow | null = null;
  if (!entry && target.alsoIncludeDealType) {
    const r = await getDealRow(env, dealId);
    if (matchesDealTypeRule(target, r)) {
      ruleRow = r;
      entry = { recordId: dealId, stage: null }; // deals carry their stage on the record
    }
  }
  if (!entry) {
    const stale = await findDealPage(env, target.dbId, dealId);
    if (stale) {
      await purgeDealFromTarget(env, target, dealId, stale);
      console.log("DELISTED", target.label, dealId, "-> archived row", stale);
    }
    await purgeDealState(env, target, dealId);
    return { pageId: null, openTasks: 0, notesPushed: false, tasksCreated: 0, skipped: true };
  }

  const members = await getMembers(env);
  // `companies` targets have no deal record: the company IS the row, so its meta supplies the
  // name/priority/owner that a deal would carry, and the stage comes off the list entry above.
  const row: DealRow = target.kind === "companies"
    ? await companyAsRow(env, dealId, entry.stage)
    : ruleRow ?? await getDealRow(env, dealId);
  const meta = target.kind === "companies"
    ? await getCompanyMeta(env, dealId)
    : (row.companyRecordId ? await getCompanyMeta(env, row.companyRecordId) : null);

  const fields: DealPageFields = {
    deal: row.name,
    company: meta?.name ?? null,
    companyRecordId: row.companyRecordId,
    companyDomains: meta?.domains.join(", ") || null,
    accountStatus: meta?.accountStatus ?? null,
    nextSteps: row.nextSteps,
    stage: row.stage,
    priority: row.priority,
    owner: row.ownerMemberId ? members[row.ownerMemberId] ?? MEMBER_FALLBACK[row.ownerMemberId] ?? null : null,
    attioDealId: dealId,
    lastInteraction: meta?.lastInteraction ?? null,
    dealType: row.dealType,
  };

  let pageId = await findDealPage(env, target.dbId, dealId);
  if (pageId) {
    try {
      await updateDealPage(env, pageId, fields, pageOpts);
    } catch (e) {
      if (!String(e).includes("archived")) throw e;
      // Cached page was archived/trashed -> drop the stale cache, re-resolve to a live page
      // (the fresh Notion query excludes archived), recreating it if none remains.
      await kvDelete(env, `page:${target.dbId}:${dealId}`);
      pageId = await findDealPage(env, target.dbId, dealId);
      if (pageId) await updateDealPage(env, pageId, fields, pageOpts);
      else pageId = await createDealPage(env, target.dbId, fields, pageOpts);
    }
  } else {
    pageId = await createDealPage(env, target.dbId, fields, pageOpts);
  }

  // Ensure the embedded "Notes & Tasks" table exists, then read its current rows.
  const perDbId = await ensureNotesTasksDb(env, pageId);
  const perRows = await queryNotesTasksRows(env, perDbId);

  // Deals pull their own tasks PLUS the associated company's; a companies row is itself the
  // account, so it has a single source.
  const fetchAttioTasks = async (): Promise<AttioTask[]> =>
    target.kind === "companies"
      ? await listTasks(env, objSlug, dealId, members, "Account")
      : [
          ...await listTasks(env, env.ATTIO_DEALS_OBJECT, dealId, members, "Deal"),
          ...(row.companyRecordId ? await listTasks(env, env.ATTIO_COMPANIES_OBJECT, row.companyRecordId, members, "Account") : []),
        ];

  // --- Per-deal inline table: two-way task reconcile (Attio is canonical). Unchanged behavior. ---
  let attioTasks = await fetchAttioTasks();
  const perOps: TaskTableOps = {
    upsert: (t, r) => upsertTaskRow(env, perDbId, t, r),
    archive: (r) => archiveRow(env, r),
    setLink: (r, id, c) => setTaskRowLink(env, r, id, c, taskSource),
  };
  const r1 = await reconcileTaskTable(env, target.dbId, dealId, attioTasks, perRows, members, perOps, false, objSlug);
  let tasksCreated = r1.tasksCreated;
  if (r1.changedAttio) attioTasks = await fetchAttioTasks();

  // --- Master flat table (Alex target only): same two-way task reconcile + two-way notes. ---
  if (target.masterDbId) {
    const masterDbId = target.masterDbId;
    const masterRows = await queryMasterRows(env, masterDbId, relProp, pageId, dealId);
    const masterOps: TaskTableOps = {
      upsert: (t, r) => upsertMasterTaskRow(env, masterDbId, relProp, pageId, dealId, t, r),
      archive: (r) => archiveRow(env, r),
      setLink: (r, id, c) => setMasterTaskRowLink(env, r, id, c, relProp, pageId, dealId, taskSource),
    };
    const r2 = await reconcileTaskTable(env, masterDbId, dealId, attioTasks, masterRows, members, masterOps, false, objSlug);
    tasksCreated += r2.tasksCreated;
    if (r2.changedAttio) {
      // The master pushed edits/creates/deletes to Attio AFTER the per-deal table already reconciled
      // this run. Re-fetch canonical Attio and mirror it back into the per-deal table (Attio->Notion
      // only) so a master-side change lands in BOTH tables in this single invocation — no second
      // sync / Attio-echo webhook needed.
      attioTasks = await fetchAttioTasks();
      const perRowsAgain = await queryNotesTasksRows(env, perDbId);
      await reconcileTaskTable(env, target.dbId, dealId, attioTasks, perRowsAgain, members, perOps, true, objSlug);
    }
    // Two-way notes between the per-deal table and the master table (Attio gets the blob below).
    const nres = await reconcileNotes(env, masterDbId, relProp, perDbId, pageId, dealId, perRows.noteRows, masterRows);
    // A note authored in the master table becomes a new per-deal note -> re-read so the Attio blob includes it.
    if (nres.createdPerDeal > 0) perRows.noteRows = (await queryNotesTasksRows(env, perDbId)).noteRows;
  }

  // Next Task Due = earliest deadline among the deal's OPEN tasks (or clear if none).
  const upcoming = attioTasks
    .filter((t) => !t.completed && t.deadline)
    .map((t) => t.deadline as string)
    .sort();
  await setNextTaskDue(env, pageId, upcoming[0] ?? null);

  // Notes -> Attio: stamp each note's Created once, then push the concatenated blob (hash-guarded).
  for (const n of perRows.noteRows) if (!n.hasCreated) await setNoteCreated(env, n.rowId, n.created);
  const noteText = perRows.noteRows
    .filter((n) => n.text.trim())
    .sort((a, b) => (a.created || "").localeCompare(b.created || ""))
    .map((n) => `(${fmtDate(n.created)}) ${n.text}`)
    .join("\n\n");
  const h = hash(noteText);
  const prev = await env.SYNC_STATE.get(`note_hash:${target.dbId}:${dealId}`);
  let notesPushed = false;
  if (prev !== h) {
    await upsertStrategyNote(env, dealId, noteText, target.noteTitle, objSlug);
    await kvPut(env, `note_hash:${target.dbId}:${dealId}`, h);
    notesPushed = true;
  }

  return { pageId, openTasks: attioTasks.filter((t) => !t.completed).length, notesPushed, tasksCreated };
}

// Table-specific writers so the task reconcile can drive either the per-deal inline table or the
// master flat table without knowing their column layouts.
interface TaskTableOps {
  upsert(task: AttioTask, existingRowId?: string): Promise<void>;
  archive(rowId: string): Promise<void>;
  setLink(rowId: string, taskId: string, completed: boolean): Promise<void>;
}

interface TaskRowsInput {
  linkedTaskRows: Record<string, LinkedTaskRow>;
  newTaskRows: { rowId: string; content: string; due: string | null; assignees: string[]; completed: boolean }[];
  dupTaskRowIds: string[];
}

/**
 * Two-way task reconcile for ONE table against the canonical Attio task set. Attio is the source
 * of truth; each table keeps its own last-synced snapshot (`taskstate:<stateNs>:<dealId>`) so
 * Notion-side edits can be distinguished from Attio-side edits. Extracted so the per-deal inline
 * table and the master flat table run the identical, proven merge. Returns whether it mutated Attio
 * (the caller re-fetches so the next table sees canonical state).
 */
async function reconcileTaskTable(
  env: Env,
  stateNs: string,
  dealId: string,
  attioTasks: AttioTask[],
  rows: TaskRowsInput,
  members: Record<string, string>,
  ops: TaskTableOps,
  mirrorOnly = false, // mirror mode: Attio -> Notion only (no create/update/delete of Attio tasks)
  objSlug?: string, // Attio object a new task links to; undefined = the deals object
): Promise<{ tasksCreated: number; changedAttio: boolean }> {
  let changedAttio = false;

  // Heal duplicate task rows (two rows pointing at the same Attio task, from a race).
  for (const rowId of rows.dupTaskRowIds) {
    try { await ops.archive(rowId); } catch (err) { console.error("dedup row", rowId, err); }
  }

  const nameToMemberId: Record<string, string> = {};
  for (const [id, name] of Object.entries(members)) if (name) nameToMemberId[name] = id;
  const memberIdsOf = (names: string[]) => names.map((n) => nameToMemberId[n]).filter(Boolean) as string[];
  const dueISO = (d: string | null) => (d ? new Date(d).toISOString() : null);
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

  const prevState: Record<string, string> = JSON.parse((await env.SYNC_STATE.get(`taskstate:${stateNs}:${dealId}`)) || "{}");
  const nextState: Record<string, string> = {};
  const handled = new Set<string>();

  // "Row vanished" normally means the user deleted it, and we answer by deleting the Attio task.
  // But a table that has NO linked rows at all while the snapshot expected some was almost
  // certainly rebuilt or re-created (deal page re-created, table replaced, query scoped wrong) —
  // not hand-emptied. Deleting every Attio task on that inference destroys real data, so in that
  // case mirror Attio back into the table instead and let a human empty it deliberately.
  const tableLooksReset =
    Object.keys(prevState).length > 0 &&
    Object.keys(rows.linkedTaskRows).length === 0 &&
    attioTasks.length > 0;
  if (tableLooksReset) {
    console.warn(
      "TASK_TABLE_RESET", stateNs, dealId,
      `snapshot expected ${Object.keys(prevState).length} linked rows, found 0 —`,
      "skipping Attio deletes and re-mirroring instead",
    );
  }

  // Notion -> Attio: brand-new Task rows (no Attio link) -> create the task, link the row.
  // Skipped in mirror mode (that pass only reflects canonical Attio state back into the table).
  let tasksCreated = 0;
  if (!mirrorOnly) for (const nt of rows.newTaskRows) {
    try {
      const taskId = await createDealTask(env, dealId, { content: nt.content, deadlineISO: dueISO(nt.due), completed: nt.completed, assigneeMemberIds: memberIdsOf(nt.assignees) }, objSlug ?? env.ATTIO_DEALS_OBJECT);
      if (taskId) {
        await ops.setLink(nt.rowId, taskId, nt.completed);
        nextState[taskId] = taskSnap(nt);
        handled.add(taskId);
        tasksCreated++;
        changedAttio = true;
      }
    } catch (err) { console.error("createDealTask", dealId, err); }
  }

  const attioById: Record<string, AttioTask> = {};
  for (const t of attioTasks) if (t.id) attioById[t.id] = t;

  // Two-way task reconcile across every id seen on either side or previously synced.
  const allIds = new Set<string>([...Object.keys(attioById), ...Object.keys(rows.linkedTaskRows), ...Object.keys(prevState)]);
  for (const taskId of allIds) {
    if (handled.has(taskId)) continue;
    const a = attioById[taskId];
    const n = rows.linkedTaskRows[taskId];
    const s = prevState[taskId];
    if (a && n) {
      const aFields = { content: a.content, completed: a.completed, due: day(a.deadline), assignees: a.assignees };
      const aSnap = taskSnap(aFields);
      const nSnap = taskSnap(n);
      // Skip only if the editable fields AND the date columns (Created/Completed) all match —
      // otherwise a Notion-created task (row made with just the link) never gets its dates.
      const datesMatch = n.createdDay === day(a.created) && n.completedDay === day(a.completedAt);
      if (aSnap === nSnap && datesMatch) { nextState[taskId] = aSnap; continue; }
      const notionEditedEditable = s !== undefined && editSnap(n) !== editPart(s);
      const attioUnchanged = s !== undefined && aSnap === s;
      if (!mirrorOnly && notionEditedEditable && attioUnchanged) {
        // Notion changed status/due/assignee while Attio stayed put -> push those to Attio.
        await updateAttioTask(env, taskId, { completed: n.completed, deadlineISO: dueISO(n.due), assigneeMemberIds: memberIdsOf(n.assignees) });
        changedAttio = true;
        // Content is Attio-owned: normalize the row (reverts any Notion text edit, keeps editable).
        const canonical = { content: a.content, completed: n.completed, due: n.due, assignees: n.assignees };
        const completedAt = canonical.completed ? (a.completedAt ?? new Date().toISOString()) : null;
        await ops.upsert({ id: taskId, content: canonical.content, deadline: canonical.due, created: a.created, completed: canonical.completed, completedAt, assignees: canonical.assignees, source: a.source }, n.rowId);
        nextState[taskId] = taskSnap(canonical);
      } else {
        // Attio wins (Attio changed, both changed, or only Notion text changed).
        await ops.upsert(a, n.rowId);
        nextState[taskId] = aSnap;
      }
    } else if (a && !n) {
      if (!mirrorOnly && s !== undefined && !tableLooksReset) {
        // Previously synced and the Notion row is now gone -> user deleted it -> delete in Attio.
        try { await deleteAttioTask(env, taskId); changedAttio = true; } catch (err) { console.error("deleteAttioTask", taskId, err); }
      } else {
        // New Attio task (or mirror pass) -> create/refresh its Notion row.
        await ops.upsert(a);
        nextState[taskId] = taskSnap({ content: a.content, completed: a.completed, due: day(a.deadline), assignees: a.assignees });
      }
    } else if (!a && n) {
      // Attio task gone -> Attio-side delete -> archive the Notion row.
      await ops.archive(n.rowId);
    }
    // neither present -> stale state entry, dropped by not copying to nextState.
  }
  await kvPut(env, `taskstate:${stateNs}:${dealId}`, JSON.stringify(nextState));
  return { tasksCreated, changedAttio };
}

/**
 * Two-way NOTE sync between a deal's per-deal inline table and its rows in the master flat table.
 * Notes have no per-note Attio object (only the concatenated strategy blob), so identity is a
 * synthetic Row Key = the per-deal note's Notion page id, stamped on the master twin. Conflicts
 * resolve by Notion's own `last_edited_time` (newer side wins) — no reliance on best-effort KV.
 */
async function reconcileNotes(
  env: Env,
  masterDbId: string,
  relProp: string,
  perDbId: string,
  dealPageId: string,
  dealId: string,
  perNoteRows: { rowId: string; text: string; created: string; lastEdited: string }[],
  masterRows: MasterRows,
): Promise<{ createdPerDeal: number }> {
  let createdPerDeal = 0;
  const norm = (s: string) => (s || "").trim();
  const masterByKey = new Map<string, { rowId: string; text: string; lastEdited: string }>();
  for (const m of masterRows.noteRows) masterByKey.set(m.rowKey, m);
  const perById = new Map<string, { rowId: string; text: string; created: string; lastEdited: string }>();
  for (const p of perNoteRows) perById.set(p.rowId, p);

  // 1) Notes authored in the master table (no Row Key yet) -> create the per-deal twin, then stamp
  //    the master row (Row Key = new per-deal row id, + relation/deal id/Type).
  for (const mn of masterRows.newNoteRows) {
    if (!norm(mn.text)) continue;
    try {
      const perId = await createNoteRow(env, perDbId, mn.text);
      await upsertMasterNoteRow(env, masterDbId, relProp, dealPageId, dealId, { rowKey: perId, text: mn.text }, mn.rowId);
      createdPerDeal++;
      masterByKey.set(perId, { rowId: mn.rowId, text: mn.text, lastEdited: mn.lastEdited });
      perById.set(perId, { rowId: perId, text: mn.text, created: mn.lastEdited, lastEdited: mn.lastEdited });
    } catch (err) { console.error("reconcileNotes create per-deal", err); }
  }

  // 2) Per-deal notes -> master: create the missing twin, or resolve a text conflict (newer wins).
  for (const p of perNoteRows) {
    const m = masterByKey.get(p.rowId);
    if (!m) {
      if (norm(p.text)) await upsertMasterNoteRow(env, masterDbId, relProp, dealPageId, dealId, { rowKey: p.rowId, text: p.text, createdISO: p.created });
    } else if (norm(p.text) !== norm(m.text)) {
      if (p.lastEdited >= m.lastEdited) await setRowItemText(env, m.rowId, p.text); // per-deal newer -> update master
      else await setRowItemText(env, p.rowId, m.text); // master newer -> update per-deal
    }
  }

  // 3) Master note whose per-deal twin was deleted -> archive the master row.
  for (const [key, m] of masterByKey) {
    if (!perById.has(key)) { try { await archiveRow(env, m.rowId); } catch (err) { console.error("reconcileNotes archive", err); } }
  }

  return { createdPerDeal };
}

/**
 * Cron safety-net: rotating full sync (rows + tasks) of a small batch per run, so the
 * whole list stays eventually-consistent even if some webhooks are missed. Bounded to
 * stay under the Workers free-plan subrequest cap; real-time edits go through the webhook.
 */
/**
 * Hourly safety-net reconcile. reconcileDeals is the ONLY code that removes rows, and it otherwise
 * runs solely on a list-entry webhook or a manual /sync — so a dropped webhook (or a row resurrected
 * out of band) used to persist indefinitely. cronRefresh only re-syncs deals already in the list.
 */
export async function cronReconcileIfDue(env: Env, minIntervalMs = 55 * 60 * 1000): Promise<SyncSummary[]> {
  const key = "last_reconcile_at";
  const last = parseInt((await env.SYNC_STATE.get(key)) || "0", 10) || 0;
  if (Date.now() - last < minIntervalMs) return [];
  await kvPut(env, key, String(Date.now()));
  const out: SyncSummary[] = [];
  for (const target of getTargets(env)) {
    try { out.push(await reconcileDeals(env, target)); }
    catch (err) { console.error("cron reconcile", target.label, err); }
  }
  return out;
}

export async function cronRefresh(env: Env, batchSize = 3): Promise<{ batch: string[] }> {
  const all: string[] = [];
  for (const target of getTargets(env)) {
    try {
      const dealIds = (await getListEntries(env, target.listSlug)).map((e) => e.recordId);
      for (const r of await ruleDeals(env, target)) if (!dealIds.includes(r.dealId)) dealIds.push(r.dealId);
      if (!dealIds.length) continue;
      const cursorKey = `cron_cursor:${target.dbId}`;
      const cursor = parseInt((await env.SYNC_STATE.get(cursorKey)) || "0", 10) || 0;
      const batch = Array.from(
        { length: Math.min(batchSize, dealIds.length) },
        (_, i) => dealIds[(cursor + i) % dealIds.length],
      );
      for (const id of [...new Set(batch)]) {
        try { await syncOneDeal(env, id, target); all.push(id); } catch (err) { console.error("cron syncOneDeal", id, err); }
      }
      await kvPut(env, cursorKey, String((cursor + batchSize) % dealIds.length));
    } catch (err) { console.error("cronRefresh target", target.label, err); }
  }
  return { batch: all };
}

export interface SyncSummary {
  dealsInList: number;
  created: number;
  updated: number;
  removedFromList: string[]; // pages whose deal is no longer in the Attio list
  masterRowsSwept?: number; // master rows archived because their deal left the list
}

/**
 * Phase 1a — Attio (Active Deals list) -> Notion deal rows.
 * Idempotent upsert keyed by the "Attio Deal ID" property.
 * Uses bulk queries to stay under the Workers free-plan subrequest cap (50/request).
 */
export async function reconcileDeals(env: Env, target: SyncTarget): Promise<SyncSummary> {
  const pageOpts: PageOpts = { props: propsFor(target), kind: target.kind, dealType: !!target.dealTypeColumn };
  const members = await getMembers(env);
  const entries = await getListEntries(env, target.listSlug, target.stageEntryAttr);
  const listIds = entries.map((e) => e.recordId);
  // Deals the target takes by Deal Type on top of its list (already fetched in full by the query).
  const extraDeals = (await ruleDeals(env, target)).filter((r) => !listIds.includes(r.dealId));
  const dealIds = [...listIds, ...extraDeals.map((r) => r.dealId)];

  // A companies list needs no deal fetch: the company records ARE the rows, and their stage comes
  // off the list entries. Bulk-fetch them once and shape each as a DealRow.
  const companyIdsForRows = target.kind === "companies" ? [...new Set(dealIds)] : [];
  const rowCompanies = companyIdsForRows.length ? await getCompaniesByIds(env, companyIdsForRows) : {};
  const deals: DealRow[] = target.kind === "companies"
    ? entries.flatMap((e) => {
        const c = rowCompanies[e.recordId];
        if (!c) return [];
        return [{
          dealId: e.recordId, name: c.name, companyRecordId: null, nextSteps: null,
          stage: e.stage, priority: c.priority, ownerMemberId: c.ownerMemberId, dealType: null,
        }];
      })
    : [...await getDealsByIds(env, listIds), ...extraDeals];

  const live = new Set(dealIds);
  // Deals rows show their ASSOCIATED company's meta; a companies row shows its own.
  const companyIds = target.kind === "companies"
    ? companyIdsForRows
    : [...new Set(deals.map((d) => d.companyRecordId).filter(Boolean) as string[])];
  const companies = target.kind === "companies" ? rowCompanies : await getCompaniesByIds(env, companyIds);

  // Group every existing page by deal id so we can heal duplicates as well as orphans.
  const byId = new Map<string, { pageId: string; created: string }[]>();
  for (const p of await listAllDealPages(env, target.dbId)) {
    const g = byId.get(p.attioDealId) ?? [];
    g.push({ pageId: p.pageId, created: p.created });
    byId.set(p.attioDealId, g);
  }

  const summary: SyncSummary = { dealsInList: dealIds.length, created: 0, updated: 0, removedFromList: [] };

  // CIRCUIT BREAKER. Everything below treats "in the Notion DB but not in `live`" as an orphan and
  // archives it. So an Attio list query that comes back empty for any reason other than a genuinely
  // empty list — transient error swallowed upstream, pagination regression, wrong slug — would
  // archive EVERY row in this database and wipe its inline tables. A real list going to zero is
  // indistinguishable from that failure, so refuse the destructive path and let a human confirm.
  if (entries.length === 0 && byId.size > 0) {
    console.error("EMPTY_LIST_GUARD", target.label, "list returned 0 entries but", byId.size, "Notion rows exist — refusing to archive");
    return summary;
  }

  for (const d of deals) {
    const meta = target.kind === "companies" ? companies[d.dealId] : (d.companyRecordId ? companies[d.companyRecordId] : undefined);
    const fields: DealPageFields = {
      deal: d.name,
      company: meta?.name ?? null,
      companyRecordId: d.companyRecordId,
      companyDomains: meta?.domains.join(", ") || null,
      accountStatus: meta?.accountStatus ?? null,
      nextSteps: d.nextSteps,
      stage: d.stage,
      priority: d.priority,
      owner: d.ownerMemberId ? members[d.ownerMemberId] ?? MEMBER_FALLBACK[d.ownerMemberId] ?? null : null,
      attioDealId: d.dealId,
      lastInteraction: meta?.lastInteraction ?? null,
      dealType: d.dealType,
    };

    const group = (byId.get(d.dealId) ?? []).sort((a, b) => a.created.localeCompare(b.created));
    if (group.length) {
      await updateDealPage(env, group[0].pageId, fields, pageOpts);
      await kvPut(env, `page:${target.dbId}:${d.dealId}`, group[0].pageId);
      summary.updated++;
      for (const extra of group.slice(1)) await archivePage(env, extra.pageId); // heal duplicates
    } else {
      await createDealPage(env, target.dbId, fields, pageOpts);
      summary.created++;
    }
    byId.delete(d.dealId);
  }

  // Anything still in byId is an orphan (deal left the list) -> archive + clear cached state.
  // Master rows are matched by deal id as well as relation (see queryMasterRows), so rows still
  // pointing at a superseded page id get cleaned up instead of surviving as invisible orphans.
  for (const [attioId, group] of byId) {
    if (live.has(attioId)) continue;
    for (const p of group) await purgeDealFromTarget(env, target, attioId, p.pageId);
    summary.removedFromList.push(attioId);
  }

  // Sweep the master table for rows whose deal is no longer in the list. The loop above only
  // reaches deals that still have a live page, so rows that outlived their page (page re-created
  // or deleted by hand) would otherwise linger forever — and, because they still resolve to the
  // deal, keep re-triggering a sync for it through the Notion webhook.
  if (target.masterDbId) {
    const stray = (await listMasterRowDealIds(env, target.masterDbId)).filter((r) => !live.has(r.dealId));
    for (const r of stray) {
      try { await archiveRow(env, r.rowId); } catch (err) { console.error("archive stray master row", r.rowId, err); }
    }
    if (stray.length) {
      const dealIdsSwept = [...new Set(stray.map((r) => r.dealId))];
      for (const d of dealIdsSwept) await purgeDealState(env, target, d);
      summary.masterRowsSwept = stray.length;
      console.log("MASTER_SWEEP", target.label, stray.length, "rows for", dealIdsSwept.join(","));
    }
  }

  return summary;
}
