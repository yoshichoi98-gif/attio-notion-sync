// Verify Attio REST notes API: list (by parent) / create / delete. node scripts/test-notes.mjs
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const H = { Authorization: `Bearer ${env.ATTIO_API_KEY}`, "Content-Type": "application/json" };
const DEAL = "00000000-0000-0000-0000-000000000024"; // Riverside
const api = async (m, p, b) => {
  const r = await fetch(`https://api.attio.com${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j, t };
};

const list = await api("GET", `/v2/notes?parent_object=deals&parent_record_id=${DEAL}&limit=50`);
console.log("[list] status", list.status, "count", list.j?.data?.length);
for (const n of list.j?.data ?? []) console.log("   -", n?.id?.note_id, "| title:", JSON.stringify(n?.title));

const create = await api("POST", "/v2/notes", { data: { parent_object: "deals", parent_record_id: DEAL, title: "ZZ temp test note", format: "plaintext", content: "hello from REST test\nsecond line" } });
console.log("\n[create] status", create.status, "note_id", create.j?.data?.id?.note_id, create.status >= 400 ? create.t.slice(0, 300) : "");

const newId = create.j?.data?.id?.note_id;
if (newId) {
  const del = await api("DELETE", `/v2/notes/${newId}`);
  console.log("[delete] status", del.status);
}
