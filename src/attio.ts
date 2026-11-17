import type { AttioKind, Env } from "./config";
import { MEMBER_FALLBACK, STRATEGY_NOTE_TITLE, kvPut } from "./config";

const BASE = "https://api.attio.com";

// NOTE: Attio response shapes below reflect the documented v2 API. The first deploy
// logs raw payloads (see index.ts /sync) so we can confirm/adjust any field shapes.
async function attio(env: Env, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.ATTIO_API_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Attio ${init?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Helpers to pull the first typed value out of an Attio attribute array.
const first = (v: any) => (Array.isArray(v) ? v[0] : v) ?? null;
export const txt = (v: any) => first(v)?.value ?? null;
export const statusTitle = (v: any) => first(v)?.status?.title ?? first(v)?.value ?? null;
export const selectTitle = (v: any) => first(v)?.option?.title ?? first(v)?.status?.title ?? first(v)?.value ?? null;
export const refRecordId = (v: any) => first(v)?.target_record_id ?? first(v)?.record_id ?? null;
export const actorMemberId = (v: any) =>
  first(v)?.referenced_actor_id ?? first(v)?.workspace_member_id ?? null;

export interface DealRow {
  dealId: string;
  name: string | null;
  companyRecordId: string | null;
  nextSteps: string | null;
  stage: string | null;
  priority: string | null;
  ownerMemberId: string | null;
  dealType: string | null; // deal `deal_type_1` ("New Business" / "Expansion/Upsell"); null on companies rows
}

/** A deal record's values shaped as a DealRow. One parser for every deal fetch path. */
function parseDealRow(dealId: string, v: any): DealRow {
  return {
    dealId,
    name: txt(v?.name),
    companyRecordId: refRecordId(v?.associated_company),
    nextSteps: txt(v?.next_steps),
    stage: statusTitle(v?.stage),
    priority: selectTitle(v?.priority),
    ownerMemberId: actorMemberId(v?.owner),
    dealType: selectTitle(v?.deal_type_1),
  };
}

/** One entry in an Attio list: the record it points at, plus the entry's own attribute values. */
export interface ListEntry {
  recordId: string;
  stage: string | null; // value of the target's stageEntryAttr, when it asked for one
}

/**
 * Entries of an Attio list. `stageEntryAttr` names a list-ENTRY attribute to read off each entry
 * (the Partnerships list keeps its pipeline stage there rather than on the company record), so a
 * caller that already needs list membership gets the stage for free — no extra request.
 */
export async function getListEntries(env: Env, listSlug: string, stageEntryAttr?: string): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  let offset = 0;
  for (;;) {
    const body = JSON.stringify({ limit: 50, offset });
    const data = await attio(env, `/v2/lists/${listSlug}/entries/query`, {
      method: "POST",
      body,
    });
    const entries: any[] = data?.data ?? [];
    for (const e of entries) {
      const rid = e?.parent_record_id ?? e?.parent_record?.record_id;
      if (!rid) continue;
      const raw = stageEntryAttr ? e?.entry_values?.[stageEntryAttr] : null;
      out.push({ recordId: rid, stage: raw ? statusTitle(raw) : null });
    }
    if (entries.length < 50) break;
    offset += 50;
  }
  return out;
}

/** Record IDs of the records currently in the given Attio list. */
export async function getListDealIds(env: Env, listSlug: string): Promise<string[]> {
  return (await getListEntries(env, listSlug)).map((e) => e.recordId);
}

/**
 * List entries with a short KV cache. Every per-record sync checks membership, so the uncached
 * query would run many times a minute. Only safe for the "is in the list" fast path — a NEGATIVE
 * result must be re-confirmed with getListEntries() before acting on it, since a just-added
 * record would otherwise look absent for the life of the cache.
 */
export async function getListEntriesCached(
  env: Env, listSlug: string, stageEntryAttr?: string, ttlSeconds = 60,
): Promise<ListEntry[]> {
  // Key includes the attr: a cached entry set fetched without it has no stage to hand back.
  const key = `listentries:${listSlug}:${stageEntryAttr ?? "-"}`;
  const hit = await env.SYNC_STATE.get(key);
  if (hit) {
    try { return JSON.parse(hit) as ListEntry[]; } catch { /* corrupt cache -> refetch */ }
  }
  const entries = await getListEntries(env, listSlug, stageEntryAttr);
  await kvPut(env, key, JSON.stringify(entries), { expirationTtl: ttlSeconds });
  return entries;
}

export async function getListDealIdsCached(env: Env, listSlug: string, ttlSeconds = 60): Promise<string[]> {
  return (await getListEntriesCached(env, listSlug, undefined, ttlSeconds)).map((e) => e.recordId);
}

export async function getDealRow(env: Env, dealId: string): Promise<DealRow> {
  const data = await attio(
    env,
    `/v2/objects/${env.ATTIO_DEALS_OBJECT}/records/${dealId}`,
  );
  return parseDealRow(dealId, data?.data?.values ?? {});
}

export interface CompanyMeta {
  name: string | null;
  domains: string[];
  accountStatus: string | null;
  lastInteraction: string | null; // ISO timestamp of the company's most recent interaction
  // Only read by `companies` targets, where the company IS the synced record. Deals targets pull
  // priority/owner off the deal itself and ignore these.
  priority: string | null;
  ownerMemberId: string | null; // company `account_owner`
}
function parseCompany(values: any): CompanyMeta {
  return {
    name: txt(values?.name),
    domains: (values?.domains ?? []).map((d: any) => d?.domain ?? d?.value).filter(Boolean),
    accountStatus: selectTitle(values?.account_status),
    lastInteraction: first(values?.last_interaction)?.interacted_at ?? null,
    priority: selectTitle(values?.priority),
    ownerMemberId: actorMemberId(values?.account_owner),
  };
}
export async function getCompanyMeta(env: Env, companyId: string): Promise<CompanyMeta> {
  const data = await attio(env, `/v2/objects/${env.ATTIO_COMPANIES_OBJECT}/records/${companyId}`);
  return parseCompany(data?.data?.values);
}

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Bulk-fetch deal rows by id (one query per 50 ids) — minimizes Worker subrequests. */
export async function getDealsByIds(env: Env, ids: string[]): Promise<DealRow[]> {
  const out: DealRow[] = [];
  for (const ch of chunk(ids, 50)) {
    if (ch.length === 0) continue;
    const data = await attio(env, `/v2/objects/${env.ATTIO_DEALS_OBJECT}/records/query`, {
      method: "POST",
      body: JSON.stringify({ filter: { record_id: { $in: ch } }, limit: 50 }),
    });
    for (const rec of data?.data ?? []) out.push(parseDealRow(rec?.id?.record_id, rec?.values ?? {}));
  }
  return out;
}

/** Every deal whose Deal Type (`deal_type_1`) is the given option, paginated. */
export async function getDealsByType(env: Env, dealType: string): Promise<DealRow[]> {
  const out: DealRow[] = [];
  for (let offset = 0; ; offset += 50) {
    const data = await attio(env, `/v2/objects/${env.ATTIO_DEALS_OBJECT}/records/query`, {
      method: "POST",
      body: JSON.stringify({ filter: { deal_type_1: dealType }, limit: 50, offset }),
    });
    const recs: any[] = data?.data ?? [];
    for (const rec of recs) out.push(parseDealRow(rec?.id?.record_id, rec?.values ?? {}));
    if (recs.length < 50) break;
  }
  return out;
}

/** Bulk-fetch company id -> {name, domains, accountStatus}. */
export async function getCompaniesByIds(env: Env, ids: string[]): Promise<Record<string, CompanyMeta>> {
  const out: Record<string, CompanyMeta> = {};
  for (const ch of chunk(ids, 50)) {
    if (ch.length === 0) continue;
    const data = await attio(env, `/v2/objects/${env.ATTIO_COMPANIES_OBJECT}/records/query`, {
      method: "POST",
      body: JSON.stringify({ filter: { record_id: { $in: ch } }, limit: 50 }),
    });
    for (const rec of data?.data ?? []) {
      const id = rec?.id?.record_id;
      if (id) out[id] = parseCompany(rec?.values);
    }
  }
  return out;
}

export interface AttioTask {
  id: string;
  content: string;
  deadline: string | null;
  created: string | null;
  completed: boolean;
  completedAt: string | null;
  assignees: string[];
  source: "Deal" | "Account";
}

export async function listTasks(
  env: Env,
  object: string,
  recordId: string,
  members: Record<string, string>,
  source: "Deal" | "Account",
): Promise<AttioTask[]> {
  const data = await attio(
    env,
    `/v2/tasks?linked_object=${object}&linked_record_id=${recordId}&limit=50`,
  );
  const tasks: any[] = data?.data ?? [];
  return tasks.map((t) => {
    const assignees: string[] = (Array.isArray(t?.assignees) ? t.assignees : [])
      .map((a: any) => {
        const id = a?.referenced_actor_id ?? a?.workspace_member_id;
        return members[id] ?? MEMBER_FALLBACK[id] ?? null;
      })
      .filter((n: any): n is string => !!n);
    return {
      id: t?.id?.task_id ?? t?.task_id,
      content: (t?.content_plaintext ?? t?.content ?? "").trim(),
      deadline: t?.deadline_at ?? null,
      created: t?.created_at ?? null,
      completed: !!t?.is_completed,
      completedAt: t?.completed_at ?? null,
      assignees,
      source,
    };
  });
}

/**
 * One-way Notion -> Attio: mirror the deal's strategy notes into a single master note,
 * by deleting the existing synced note and recreating it (Attio notes can't be edited
 * in place). Empty content => just remove the note. Caller should hash-guard to avoid churn.
 */
export async function upsertStrategyNote(
  env: Env, dealId: string, content: string, title: string = STRATEGY_NOTE_TITLE,
  object: string = env.ATTIO_DEALS_OBJECT,
): Promise<void> {
  const list = await attio(
    env,
    `/v2/notes?parent_object=${object}&parent_record_id=${dealId}&limit=50`,
  );
  const existing = (list?.data ?? []).find((n: any) => {
    const t = typeof n?.title === "string" ? n.title : n?.title?.plaintext;
    return t === title;
  });
  if (existing?.id?.note_id) {
    await attio(env, `/v2/notes/${existing.id.note_id}`, { method: "DELETE" });
  }
  if (content.trim()) {
    await attio(env, `/v2/notes`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: object,
          parent_record_id: dealId,
          title,
          format: "plaintext",
          content,
        },
      }),
    });
  }
}

/**
 * Notion -> Attio: create a task linked to a deal. Required by the API: is_completed +
 * assignees (array, may be empty). deadline_at is optional (null = no due date).
 * Returns the new task id (or null on failure).
 */
export async function createDealTask(
  env: Env,
  dealId: string,
  args: { content: string; deadlineISO: string | null; completed: boolean; assigneeMemberIds: string[] },
  object: string = env.ATTIO_DEALS_OBJECT,
): Promise<string | null> {
  const data = await attio(env, `/v2/tasks`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        format: "plaintext",
        content: args.content,
        is_completed: args.completed,
        deadline_at: args.deadlineISO,
        assignees: args.assigneeMemberIds.map((id) => ({
          referenced_actor_type: "workspace-member",
          referenced_actor_id: id,
        })),
        linked_records: [{ target_object: object, target_record_id: dealId }],
      },
    }),
  });
  return data?.data?.id?.task_id ?? null;
}

/** Notion -> Attio: update a task's mutable fields (content is immutable in Attio's API). */
export async function updateAttioTask(
  env: Env,
  taskId: string,
  args: { completed: boolean; deadlineISO: string | null; assigneeMemberIds: string[] },
): Promise<void> {
  await attio(env, `/v2/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        is_completed: args.completed,
        deadline_at: args.deadlineISO,
        assignees: args.assigneeMemberIds.map((id) => ({
          referenced_actor_type: "workspace-member",
          referenced_actor_id: id,
        })),
      },
    }),
  });
}

/** Notion -> Attio: delete a task (when its Notion row is deleted). */
export async function deleteAttioTask(env: Env, taskId: string): Promise<void> {
  await attio(env, `/v2/tasks/${taskId}`, { method: "DELETE" });
}

export const OBJ_DEALS_ID = "00000000-0000-0000-0000-000000000039";
export const OBJ_COMPANIES_ID = "00000000-0000-0000-0000-000000000042";

/** A record a task is linked to, with the kind of object it belongs to (for routing). */
export interface TaskLink {
  recordId: string;
  kind: AttioKind;
}

/**
 * Given a task id, return the linked deal AND company records (for routing task webhooks).
 * Companies matter now that a companies list is synced — a task created on a company used to be
 * dropped here, so it only ever reached Notion via cron. Returning both kinds is safe: a record
 * id is only ever claimed by a target whose list/database actually contains it.
 */
export async function getTaskRecordIds(env: Env, taskId: string): Promise<TaskLink[]> {
  try {
    const data = await attio(env, `/v2/tasks/${taskId}`);
    const lr = data?.data?.linked_records ?? data?.data?.values?.linked_records ?? [];
    const out: TaskLink[] = [];
    for (const r of lr) {
      const oid = r?.target_object_id ?? r?.object_id ?? r?.target_object ?? r?.object;
      const rid = r?.target_record_id ?? r?.record_id;
      if (!rid) continue;
      if (oid === OBJ_DEALS_ID || oid === "deals") out.push({ recordId: rid, kind: "deals" });
      else if (oid === OBJ_COMPANIES_ID || oid === "companies") out.push({ recordId: rid, kind: "companies" });
    }
    return out;
  } catch {
    return [];
  }
}

/** A record's display name, for any object. Used where only a label is needed (Slack alerts). */
export async function getRecordName(env: Env, object: string, recordId: string): Promise<string | null> {
  try {
    const data = await attio(env, `/v2/objects/${object}/records/${recordId}`);
    return txt(data?.data?.values?.name);
  } catch {
    return null;
  }
}

export async function getMembers(env: Env): Promise<Record<string, string>> {
  try {
    const data = await attio(env, `/v2/workspace_members`);
    const out: Record<string, string> = {};
    for (const m of data?.data ?? []) {
      const id = m?.id?.workspace_member_id ?? m?.workspace_member_id;
      const name = [m?.first_name, m?.last_name].filter(Boolean).join(" ") || m?.email_address;
      if (id) out[id] = name;
    }
    return Object.keys(out).length ? out : { ...MEMBER_FALLBACK };
  } catch {
    return { ...MEMBER_FALLBACK };
  }
}
