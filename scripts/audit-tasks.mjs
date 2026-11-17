// Audit task consistency between Notion and Attio across both deal databases.
// For each deal: every Attio task (linked to the deal or its company) should have a Notion
// row, and every Notion Task row should map to a real Attio task. Reports any mismatch.
// Read-only. Paced to avoid Notion's WAF burst block. Reads creds from ../.dev.vars.
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const KEY = env.ATTIO_API_KEY, NT = env.NOTION_TOKEN;
const MAIN = [
  { db: "00000000000000000000000000000021", label: "Active Deals" },
  { db: "00000000-0000-0000-0000-000000000022", label: "[Alex] Active Deals" },
  { db: "00000000-0000-0000-0000-000000000023", label: "Partnerships", object: "companies" },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attio = async (p) => (await fetch(`https://api.attio.com${p}`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
const notion = async (p, init) => (await fetch(`https://api.notion.com/v1${p}`, { headers: { Authorization: `Bearer ${NT}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, ...init })).json();

async function attioTaskIds(object, recordId) {
  const d = await attio(`/v2/tasks?linked_object=${object}&linked_record_id=${recordId}&limit=50`);
  return (d?.data ?? []).map((t) => t?.id?.task_id).filter(Boolean);
}

const issues = [];
let auditedDeals = 0, totalNotionTasks = 0, totalAttioTasks = 0;

for (const { db, label, object = "deals" } of MAIN) {
  const titleProp = object === "companies" ? "Company" : "Deal";
  // all deal pages in this DB
  const pages = [];
  let cursor;
  do {
    const d = await notion(`/databases/${db}/query`, { method: "POST", body: JSON.stringify({ start_cursor: cursor, page_size: 100 }) });
    for (const p of d.results) {
      const dealId = p.properties?.["Attio Deal ID"]?.rich_text?.[0]?.plain_text;
      const deal = (p.properties?.[titleProp]?.title ?? []).map((t) => t.plain_text).join("");
      const companyCell = p.properties?.["Associated Company"]?.rich_text?.[0];
      const companyUrl = companyCell?.href || companyCell?.text?.link?.url || "";
      const cm = companyUrl.match(/company\/([0-9a-f-]{36})/);
      if (dealId) pages.push({ pageId: p.id, dealId, deal, companyId: object === "companies" ? dealId : (cm ? cm[1] : null) });
    }
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);

  for (const pg of pages) {
    auditedDeals++;
    // Notion side: Task rows in the Notes & Tasks table
    const blocks = await notion(`/blocks/${pg.pageId}/children?page_size=100`);
    const ndb = blocks.results?.find((b) => b.type === "child_database" && b.child_database?.title === "Notes & Tasks");
    const linked = new Map(); // taskId -> count
    let unlinked = 0;
    if (ndb) {
      let c;
      do {
        const q = await notion(`/databases/${ndb.id}/query`, { method: "POST", body: JSON.stringify({ start_cursor: c, page_size: 100 }) });
        for (const r of q.results) {
          if (r.properties?.Type?.select?.name !== "Task") continue;
          const lk = r.properties?.Link?.rich_text?.[0];
          const url = lk?.href || lk?.text?.link?.url || "";
          const m = url.match(/id=([0-9a-fA-F-]{36})/);
          const content = (r.properties?.Item?.title ?? []).map((t) => t.plain_text).join("").trim();
          if (m) linked.set(m[1], (linked.get(m[1]) ?? 0) + 1);
          else if (content) unlinked++;
        }
        c = q.has_more ? q.next_cursor : undefined;
      } while (c);
    }
    // Attio side: tasks linked to the deal + its company
    const aIds = new Set(object === "companies"
      ? await attioTaskIds("companies", pg.dealId)
      : [...(await attioTaskIds("deals", pg.dealId)), ...(pg.companyId ? await attioTaskIds("companies", pg.companyId) : [])]);
    const nIds = new Set(linked.keys());
    totalNotionTasks += nIds.size; totalAttioTasks += aIds.size;

    const missingInNotion = [...aIds].filter((x) => !nIds.has(x));      // in Attio, no Notion row
    const orphanInNotion = [...nIds].filter((x) => !aIds.has(x));       // Notion row -> dead Attio task
    const dups = [...linked.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    if (missingInNotion.length || orphanInNotion.length || unlinked || dups.length) {
      issues.push({ label, deal: pg.deal, dealId: pg.dealId, missingInNotion, orphanInNotion, unlinkedRows: unlinked, dupRows: dups });
    }
    await sleep(500);
  }
}

console.log(`\nAudited ${auditedDeals} deal tables | Notion task rows: ${totalNotionTasks} | Attio tasks: ${totalAttioTasks}`);
if (!issues.length) {
  console.log("✅ CONSISTENT — every Notion task maps to an Attio task and vice versa.");
} else {
  console.log(`⚠️  ${issues.length} deal(s) with discrepancies:`);
  for (const i of issues) {
    console.log(`\n• [${i.label}] ${i.deal} (${i.dealId})`);
    if (i.missingInNotion.length) console.log(`    in Attio, missing in Notion: ${i.missingInNotion.length} -> ${i.missingInNotion.join(", ")}`);
    if (i.orphanInNotion.length) console.log(`    Notion row -> non-existent Attio task: ${i.orphanInNotion.length} -> ${i.orphanInNotion.join(", ")}`);
    if (i.unlinkedRows) console.log(`    Notion Task rows with no Attio link: ${i.unlinkedRows}`);
    if (i.dupRows.length) console.log(`    duplicate Notion rows for same task: ${i.dupRows.join(", ")}`);
  }
}
