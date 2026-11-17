# Attio ↔ Notion Sync

A live two-way sync between our CRM (Attio) and Notion. Sales reps plan accounts in Notion; the CRM stays the system of record. Deals, tasks and strategy notes stay in step on both sides within seconds.

## Why I built it

Our reps liked working in Notion: account plans, notes, to-do lists. But the CRM was where deals were tracked and reported. Keeping both up to date by hand meant they drifted within days. I built a sync so people could work wherever they preferred and both sides would always match.

## What it syncs

| Direction | What |
|---|---|
| CRM → Notion | One row per deal: name, company, stage, owner, next steps |
| Both ways | Tasks: create, edit, complete or delete on either side |
| Both ways | Strategy notes: the Notion page body ↔ a note on the CRM deal |
| CRM → Slack | An alert when a rep adds a note or task |

It runs several targets from one engine: a team-wide deals board, one rep's personal deals board (which also pulls in their upsell deals and drops them automatically once won), and a partnerships board built from companies rather than deals. There is also a flat "All Notes & Tasks" table across every deal.

## How it works

```
CRM webhook ----\
Notion webhook --+--> Cloudflare Worker --> per-deal sync (about 10 API calls)
Cron sweep -----/                           |
                                            +--> KV: snapshots for change detection
```

Webhooks from both sides handle changes in near real time. A scheduled sweep reconciles everything as a safety net in case a webhook is missed.

## Engineering decisions

- **Three-way change detection.** The Worker stores a snapshot of each task after every sync. Comparing both sides to the snapshot tells it which side changed, so edits are never overwritten by stale data.
- **Per-deal locking.** One edit can fire several triggers within the same second (the Notion webhook, the CRM event it causes, the cron). A per-deal lock collapses them into one run and re-runs once if more edits land mid-sync. This removed duplicate rows and double-created tasks.
- **Guarding against mass deletes.** If a deal's row disappears, its cached snapshots are cleared first. Otherwise the next sync would read an empty table as "the user deleted every task" and delete them in the CRM too.
- **Never act on a cache miss.** A record added seconds ago can look absent from a cached list, so removals are only made against live data.
- **Fits the free tier.** A targeted sync of one deal stays under Cloudflare's per-request limits.

## Stack

TypeScript, Cloudflare Workers (webhooks + cron + KV), Attio REST API, Notion API, Slack.

## Layout

- `src/index.ts`: webhook routes, manual `/sync` trigger, cron entry
- `src/sync.ts`: the sync engine (rows, two-way tasks, two-way notes, locking)
- `src/attio.ts`, `src/notion.ts`: API clients
- `src/config.ts`: targets, property names, constants
- `scripts/`: one-off setup, backfill and end-to-end test scripts

## Running it

Copy `.dev.vars.example` to `.dev.vars`, fill in the tokens, then `npm install && npm run dev`. To deploy, set secrets with `npx wrangler secret put <NAME>` and run `npm run deploy`.

---

Built at Alleviate Health. Company names, people, IDs and URLs in this public copy are placeholders.
