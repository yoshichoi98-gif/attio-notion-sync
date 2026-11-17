// Read-only validation of the Notion side. node scripts/test-notion.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const TOKEN = env.NOTION_TOKEN;
const DB = "00000000000000000000000000000021";
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

async function call(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

console.log("TOKEN present:", !!TOKEN, "len:", TOKEN?.length);

const db = await call("GET", `/databases/${DB}`);
console.log("\n[1] retrieve database:", db.status);
if (db.status === 200) {
  console.log("    title:", db.json?.title?.[0]?.plain_text);
  console.log("    properties:");
  for (const [name, def] of Object.entries(db.json?.properties ?? {})) console.log(`      - ${name} (${def.type})`);
  console.log("    has 'Attio Deal ID'?", !!db.json?.properties?.["Attio Deal ID"]);
} else {
  console.log("    body:", JSON.stringify(db.json));
}

const q = await call("POST", `/databases/${DB}/query`, { page_size: 100 });
console.log("\n[2] query database:", q.status, "rows:", q.json?.results?.length);
const first = q.json?.results?.[0];
if (first) {
  const p = first.properties ?? {};
  const titleProp = Object.values(p).find((x) => x.type === "title");
  console.log("    first row title:", titleProp?.title?.[0]?.plain_text);
  console.log("    first row prop names:", Object.keys(p));
}
