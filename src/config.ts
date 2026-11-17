// Bindings & env available to the Worker.
export interface Env {
  // Secrets (set via `wrangler secret put`)
  ATTIO_API_KEY: string;
  NOTION_TOKEN: string;
  ATTIO_WEBHOOK_SECRET?: string;
  ATTIO_WEBHOOK_TOKEN?: string; // shared secret in the webhook URL (?token=...)
  NOTION_WEBHOOK_SECRET?: string;
  MANUAL_SYNC_TOKEN?: string;
  SLACK_WEBHOOK_URL?: string; // Slack incoming webhook for "Alex added a note/task" alerts

  // Vars (wrangler.jsonc)
  ATTIO_LIST_SLUG: string;
  NOTION_DATABASE_ID: string;
  ATTIO_DEALS_OBJECT: string;
  ATTIO_COMPANIES_OBJECT: string;

  // KV: deal<->page id map + content hashes
  SYNC_STATE: KVNamespace;
}

// Best-effort KV writes. KV is a cache/optimization layer (page ids, dedup state, locks) —
// never correctness-critical — so a failed write (e.g. the free plan's 1,000/day cap) must
// degrade gracefully, not crash a sync. Reads are unaffected by the write cap.
export async function kvPut(env: Env, key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
  try { await env.SYNC_STATE.put(key, value, opts); } catch (e) { console.error("kvPut skipped", key, String(e).slice(0, 60)); }
}
export async function kvDelete(env: Env, key: string): Promise<void> {
  try { await env.SYNC_STATE.delete(key); } catch { /* ignore */ }
}

// Which Attio object a list hangs off. Everything else about a target is object-agnostic;
// this decides how a row is fetched, where its tasks/notes live, and the record URL shape.
export type AttioKind = "deals" | "companies";

// A list->database sync target. Targets over the `deals` object share the deal-row schema,
// Notes & Tasks tables, and two-way logic — only the source Attio list and destination Notion
// database differ. A `companies` target reuses the same engine (see kind).
export interface SyncTarget {
  label: string;
  kind?: AttioKind; // defaults to "deals" — omitting it leaves existing behavior untouched
  listSlug: string;
  listId: string; // for routing list-entry webhooks
  dbId: string; // destination Notion database (the per-record rows + inline Notes & Tasks tables)
  noteTitle: string; // Attio strategy-note title — distinct per list so overlapping records don't clobber
  // Optional "master" database: ONE flat table for the whole list where every row is a single
  // task or note across all records, with the record as a relation column. When set, syncOneDeal
  // also mirrors each record's tasks+notes into it (two-way). See scripts/setup-master-db.mjs.
  masterDbId?: string;
  masterRelationProp?: string; // master's relation column name; defaults to "Deal"
  // The list-ENTRY attribute that supplies this target's stage. Deals carry `stage` on the record
  // itself; the Partnerships list keeps it on the entry, so it comes from the list query instead.
  stageEntryAttr?: string;
  props?: Partial<Record<keyof typeof NOTION_PROPS, string>>; // per-target Notion column names
  // Deals that belong to this target WITHOUT being on its Attio list: every deal with this Deal
  // Type, except Closed Won ones (see isClosedWon). The list still wins — a listed deal stays
  // whatever its type or stage. Deals targets only.
  alsoIncludeDealType?: string;
  dealTypeColumn?: boolean; // write the deal's Deal Type into a "Deal Type" select column
}

/** Any stage ending in "Closed Won". Such deals drop out of an alsoIncludeDealType rule. */
export function isClosedWon(stage: string | null): boolean {
  return !!stage && /closed won$/i.test(stage.trim());
}
export function getTargets(env: Env): SyncTarget[] {
  return [
    { label: "Active Deals", listSlug: env.ATTIO_LIST_SLUG, listId: "00000000-0000-0000-0000-000000000038", dbId: env.NOTION_DATABASE_ID, noteTitle: STRATEGY_NOTE_TITLE },
    { label: "Alex Active Deals", listSlug: "alex_active_deals", listId: "00000000-0000-0000-0000-000000000040", dbId: "00000000-0000-0000-0000-000000000022", noteTitle: "📝 Strategy Notes — [Alex] (synced from Notion)", masterDbId: MASTER_DB_ID || undefined, alsoIncludeDealType: "Expansion/Upsell", dealTypeColumn: true },
    {
      label: "Partnerships",
      kind: "companies",
      listSlug: "partnerships",
      listId: "00000000-0000-0000-0000-000000000041",
      dbId: PARTNERSHIPS_DB_ID,
      noteTitle: "📝 Strategy Notes — Partnerships (synced from Notion)",
      masterDbId: PARTNERSHIPS_MASTER_DB_ID || undefined,
      masterRelationProp: "Company",
      stageEntryAttr: "prospecting",
      // Only the labels that differ from NOTION_PROPS. `attioDealId` deliberately keeps its name
      // on every target — webhook routing resolves a page back to an Attio record by that
      // property before it knows the target, so a per-target name would be circular.
      props: { deal: "Company", stage: "Prospecting", owner: "Account Owner" },
    },
  ];
}

/** The Attio object slug for a target's records. */
export function objectSlug(env: Env, target: SyncTarget): string {
  return target.kind === "companies" ? env.ATTIO_COMPANIES_OBJECT : env.ATTIO_DEALS_OBJECT;
}
/** Notion column names for a target: the defaults, with any per-target overrides applied. */
export function propsFor(target: SyncTarget): Record<keyof typeof NOTION_PROPS, string> {
  return { ...NOTION_PROPS, ...(target.props ?? {}) };
}
/** The master table's relation column name for a target. */
export function masterRelProp(target: SyncTarget): string {
  return target.masterRelationProp ?? "Deal";
}

// The [Alex] master "All Notes & Tasks" flat table. Created by scripts/setup-master-db.mjs;
// paste the returned database id here to switch the master-table mirror on.
export const MASTER_DB_ID = "00000000-0000-0000-0000-000000000046";

// The Partnerships pair (companies list). Created by scripts/setup-partnerships-db.mjs.
export const PARTNERSHIPS_DB_ID = "00000000-0000-0000-0000-000000000023";
export const PARTNERSHIPS_MASTER_DB_ID = "00000000-0000-0000-0000-000000000047";

// Notion property names in the "Active Deals" database.
export const NOTION_PROPS = {
  deal: "Deal", // title
  company: "Associated Company", // rich_text
  nextSteps: "Next Steps Notes", // rich_text
  stage: "Deal Stage", // select
  owner: "Deal Owner", // select
  attioDealId: "Attio Deal ID", // rich_text — sync matching key (added during setup)
  attioLink: "Attio Link", // rich_text — clickable "Open" link to the deal record in Attio
  companyDomains: "Company Domains", // rich_text — domains of the associated company
  priority: "Priority", // select — deal priority
  accountStatus: "Account Status", // select — associated company's account status
  nextTaskDue: "Next Task Due", // date — earliest deadline among the deal's open tasks
  lastInteraction: "Last Interaction", // date — company's last interaction (email/meeting/call)
  dealType: "Deal Type", // select — deal `deal_type_1`; only on targets with dealTypeColumn
} as const;

// Fallback map for workspace member id -> display name.
// The sync also fetches members live; this is just a safety net.
export const MEMBER_FALLBACK: Record<string, string> = {
  "00000000-0000-0000-0000-000000000048": "Alex Morgan",
  "00000000-0000-0000-0000-000000000036": "Yoshi Choi",
  "00000000-0000-0000-0000-000000000049": "Sam Lee",
};

// Notion person id for Alex — used to notify Slack only on HIS new notes/tasks.
export const ALEX_NOTION_ID = "00000000-0000-0000-0000-000000000050";

// One canonical strategy-notes title on each deal (Phase 2, two-way notes).
export const STRATEGY_NOTE_TITLE = "📝 Strategy Notes (synced from Notion)";

// Heading that fences the auto-synced tasks table inside a deal page (Phase 1b).
// The Phase-2 strategy-note sync captures only content ABOVE this heading.
export const TASKS_HEADING = "📋 Tasks (from Attio)";
