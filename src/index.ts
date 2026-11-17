import type { AttioKind, Env, SyncTarget } from "./config";
import { getTargets, kvPut, masterRelProp, objectSlug, ALEX_NOTION_ID } from "./config";
import { reconcileDeals, syncOneDeal, cronRefresh, cronReconcileIfDue, matchesDealTypeRule } from "./sync";
import { getTaskRecordIds, getListDealIdsCached, getRecordName, getDealRow } from "./attio";
import { findDealPage, pageDealAndDb, notesDbToDeal, readRowSummary, masterRowToDeal } from "./notion";

// Slack alert when Alex creates a new Note/Task row in the [Alex & Yoshi] deals DB.
// Fires once per row (deduped) the first time it has a Type + text, regardless of which
// event (create vs the property-set that follows) carries the content.
async function notifyAlex(env: Env, ev: any, hit: { dealId: string; target: SyncTarget }): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;
  const norm = (s?: string) => (s ?? "").replace(/-/g, "").toLowerCase();
  if (norm(hit.target.dbId) !== norm(env.NOTION_DATABASE_ID)) return; // only the [Alex & Yoshi] table
  const rowId: string | undefined = ev?.entity?.id;
  if (!rowId) return;
  if (await env.SYNC_STATE.get(`notified:${rowId}`)) return; // already alerted for this row
  const row = await readRowSummary(env, rowId);
  if (!row || (row.type !== "Note" && row.type !== "Task") || !row.item) return; // wait for content
  // Works for whichever object the target is over, so widening the gate above can't break it.
  let dealName = (await getRecordName(env, objectSlug(env, hit.target), hit.dealId)) ?? "a deal";
  const pageId = await findDealPage(env, hit.target.dbId, hit.dealId);
  const url = pageId ? `https://www.notion.so/${pageId.replace(/-/g, "")}` : "";
  const text = `📝 *Alex added a ${row.type} on ${dealName}*\n"${row.item}"${url ? `\n<${url}|Open in Notion>` : ""}`;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    await kvPut(env, `notified:${rowId}`, "1");
  } catch (e) { console.error("slack notify", e); }
}

// Verify Notion's HMAC-SHA256 signature (secret = the verification token Notion sent).
async function verifyNotionSig(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return header === `sha256=${hex}`;
}

/**
 * Which sync targets a record belongs to: already has a page (cheap KV hit) or is in the list.
 * `kind` narrows the search to targets over that Attio object — a company id can never belong to
 * a deals target, so without it every company event would pointlessly query every deals list.
 * Membership uses the CACHED list: a false negative here only means "no sync this event", and
 * syncOneDealCore re-confirms uncached before it ever removes anything.
 */
async function targetsForDeal(env: Env, dealId: string, kind?: AttioKind): Promise<SyncTarget[]> {
  const out: SyncTarget[] = [];
  for (const t of getTargets(env)) {
    if (kind && (t.kind ?? "deals") !== kind) continue;
    if (await findDealPage(env, t.dbId, dealId)) { out.push(t); continue; }
    const ids = await getListDealIdsCached(env, t.listSlug);
    if (ids.includes(dealId)) { out.push(t); continue; }
    // Off-list deals the target takes by Deal Type. Read live (not cached) so the event that sets a
    // deal's type is the one that brings it in.
    if (t.alsoIncludeDealType && (t.kind ?? "deals") === "deals") {
      try { if (matchesDealTypeRule(t, await getDealRow(env, dealId))) out.push(t); }
      catch { /* not a deal record (e.g. a company id on /sync-deal) */ }
    }
  }
  return out;
}

async function syncDealEverywhere(env: Env, dealId: string, kind?: AttioKind): Promise<void> {
  for (const t of await targetsForDeal(env, dealId, kind)) {
    try { await syncOneDeal(env, dealId, t); } catch (err) { console.error("syncOneDeal", dealId, t.label, err); }
  }
}

// Resolve a Notion event to the deal + which target (database) it belongs to.
async function resolveDealTarget(env: Env, ev: any): Promise<{ dealId: string; target: SyncTarget } | null> {
  const targets = getTargets(env);
  const entityId: string | undefined = ev?.entity?.id;
  const parentId: string | undefined = ev?.data?.parent?.id;
  // Notion DB ids compare dashless: env vars may omit dashes while the API returns them.
  const norm = (s?: string) => (s ?? "").replace(/-/g, "").toLowerCase();
  const pick = (mainDbId: string, dealId: string) => {
    const t = targets.find((x) => norm(x.dbId) === norm(mainDbId));
    return t ? { dealId, target: t } : null;
  };
  // Case M: parent is a master flat table -> resolve the row to its deal (relation / Attio Deal ID).
  if (parentId && entityId) {
    const mt = targets.find((t) => t.masterDbId && norm(t.masterDbId) === norm(parentId));
    if (mt) {
      const dealId = await masterRowToDeal(env, entityId, masterRelProp(mt));
      if (dealId) return { dealId, target: mt };
    }
  }
  // Case A: parent is one of the main deal DBs -> entity is a deal page in it.
  if (parentId && targets.some((t) => norm(t.dbId) === norm(parentId)) && entityId) {
    const res = await pageDealAndDb(env, entityId);
    if (res) return pick(res.mainDbId, res.dealId);
  }
  // Case B: parent is a Notes & Tasks inline DB -> resolve to its deal page + main DB.
  if (parentId) {
    const res = await notesDbToDeal(env, parentId);
    if (res) return pick(res.mainDbId, res.dealId);
  }
  // Fallback: entity is itself a page (e.g. a content change on the deal page).
  if (entityId) {
    const res = await pageDealAndDb(env, entityId);
    if (res) return pick(res.mainDbId, res.dealId);
  }
  return null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  // Webhooks + manual trigger + health check.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("attio-notion-sync: ok", { status: 200 });
    }

    // Manual trigger: GET /sync?token=MANUAL_SYNC_TOKEN -> reconcile every target.
    if (request.method === "GET" && url.pathname === "/sync") {
      if (!env.MANUAL_SYNC_TOKEN || url.searchParams.get("token") !== env.MANUAL_SYNC_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        const summary: any[] = [];
        for (const t of getTargets(env)) {
          try { summary.push({ list: t.label, ...(await reconcileDeals(env, t)) }); }
          catch (err) { summary.push({ list: t.label, error: String(err) }); }
        }
        return json({ ok: summary.every((s) => !s.error), summary });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // Manual targeted sync for testing: GET /sync-deal?token=...&deal=<recordId>
    if (request.method === "GET" && url.pathname === "/sync-deal") {
      if (!env.MANUAL_SYNC_TOKEN || url.searchParams.get("token") !== env.MANUAL_SYNC_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      const deal = url.searchParams.get("deal");
      if (!deal) return json({ error: "missing ?deal" }, 400);
      try {
        const results: any[] = [];
        for (const t of await targetsForDeal(env, deal)) results.push({ list: t.label, ...(await syncOneDeal(env, deal, t)) });
        return json({ ok: true, results });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // Attio webhook -> targeted per-deal sync (reconcile only for list membership changes).
    if (request.method === "POST" && url.pathname === "/attio-webhook") {
      if (env.ATTIO_WEBHOOK_TOKEN && url.searchParams.get("token") !== env.ATTIO_WEBHOOK_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      const body: any = await request.json().catch(() => null);
      const events: any[] = body?.events ?? [];
      // recordId -> which Attio object it belongs to, so routing only tests matching targets.
      const dealIds = new Map<string, AttioKind | undefined>();
      const taskIds = new Set<string>();
      const listIds = new Set<string>();
      const COMPANIES_OBJ = "00000000-0000-0000-0000-000000000042";
      for (const e of events) {
        if (e?.event_type === "record.updated" && e?.id?.record_id) {
          const oid = e?.id?.object_id;
          dealIds.set(e.id.record_id, oid === COMPANIES_OBJ ? "companies" : oid ? "deals" : undefined);
        } else if ((e?.event_type === "task.created" || e?.event_type === "task.updated" || e?.event_type === "task.deleted") && e?.id?.task_id) taskIds.add(e.id.task_id);
        else if (typeof e?.event_type === "string" && e.event_type.startsWith("list-entry") && e?.id?.list_id) listIds.add(e.id.list_id);
      }
      console.log("ATTIO_EVENT", events.map((e) => e?.event_type).join(","), "tasks:", taskIds.size, "records:", dealIds.size, "lists:", listIds.size);
      ctx.waitUntil((async () => {
        // A task carries its own linked records, deals AND companies alike.
        for (const tid of taskIds) for (const l of await getTaskRecordIds(env, tid)) {
          if (!dealIds.has(l.recordId)) dealIds.set(l.recordId, l.kind);
        }
        for (const [id, kind] of dealIds) await syncDealEverywhere(env, id, kind);
        for (const lid of listIds) {
          const t = getTargets(env).find((x) => x.listId === lid);
          if (t) { try { await reconcileDeals(env, t); } catch (err) { console.error("reconcile", t.label, err); } }
        }
      })());
      return json({ ok: true });
    }

    // Notion webhook. First registration sends a verification_token to echo back.
    if (request.method === "POST" && url.pathname === "/notion-webhook") {
      const raw = await request.text();
      const body: any = JSON.parse(raw || "{}");
      if (body?.verification_token) {
        console.log("NOTION verification_token:", body.verification_token);
        return json({ ok: true });
      }
      // Authenticate the event (HMAC) when the secret is configured.
      if (env.NOTION_WEBHOOK_SECRET) {
        const ok = await verifyNotionSig(env.NOTION_WEBHOOK_SECRET, raw, request.headers.get("x-notion-signature"));
        if (!ok) return json({ error: "bad signature" }, 401);
      }
      // Loop guard: only act on PERSON-authored edits. Our own sync writes are authored by
      // the integration (bot), so ignoring non-person events stops infinite echo loops.
      const byPerson = (body?.authors ?? []).some((a: any) => a?.type === "person");
      if (!byPerson) return json({ ok: true, ignored: "not person-authored" });

      ctx.waitUntil((async () => {
        try {
          const hit = await resolveDealTarget(env, body);
          if (!hit) { console.log("NOTION_EVENT unresolved", body?.type, "entity:", JSON.stringify(body?.entity), "parent:", JSON.stringify(body?.data?.parent)); return; }
          if ((body?.authors ?? []).some((a: any) => a?.id === ALEX_NOTION_ID)) {
            try { await notifyAlex(env, body, hit); } catch (e) { console.error("notify", e); }
          }
          const r = await syncOneDeal(env, hit.dealId, hit.target);
          console.log("NOTION_EVENT", body?.type, "->", hit.target.label, hit.dealId, "created:", r.tasksCreated, "notesPushed:", r.notesPushed);
        } catch (err) { console.error("notion-webhook", err); }
      })());
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },

  // Safety-net reconcile sweep (cron in wrangler.jsonc) — rotates across all targets.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const rec = await cronReconcileIfDue(env);
      if (rec.length) console.log("cron reconcile", JSON.stringify(rec));
      console.log("cron refresh", await cronRefresh(env));
    })());
  },
};
