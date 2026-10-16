# CLAUDE.md

Guidance for AI coding agents working in this repository.

## What this is

A week to-do list (an outliner of days) driven by an in-process LLM agent, plus a
markdown knowledge base. One Node process serves the API, the agent, the
knowledge base and the built React PWA. Two stdio MCP servers expose the tasks
(read-only + one natural-language write path) and the knowledge base
(read-write) to any MCP client.

## Architecture

```
browser (PWA, React + Vite)
   |  HTTPS via reverse proxy, token cookie
   v
server/index.js (Express 5) ---- SSE /api/events (refresh, chat steps)
   |-- server/tasks.js, db.js        SQLite (better-sqlite3), data/todo.db
   |-- server/agent/*                the agent: LLM client, tool loop, memory, night jobs
   |-- server/kb/*                   markdown notes in data/kb, FTS5 index in data/kb.db
   |-- server/gcal.js                read-only Google Calendar mirror (secret iCal URLs)
   |-- server/voice.js, vision.js    speech-to-text, image description
   '-- server/worker.js              detached headless Claude Code runs
mcp/agenda.js  -> reads data/todo.db directly, writes only via POST /api/chat
mcp/kb.js      -> reuses server/kb/* and server/agent/tools-kb.js
```

The agent is not a separate service: `server/agent/loop.js` calls the model and
runs its tools directly against SQLite in the same process.

## Directory map

- `server/index.js`: Express app, auth, every HTTP route, startup sequence.
- `server/env.js`: loads `.env` (or `AGENDA_ENV_FILE`); imported first everywhere.
- `server/db.js`: schema and additive migrations (`addCol`), `today()` and date helpers.
- `server/tasks.js`: task tree, groups, moves, trash, rules, states. The core.
- `server/schedule.js`: French/English time parsing, time slots, overlaps, gaps.
- `server/history.js`: single undo/redo stack fed by SQLite triggers on `tasks`.
- `server/agent/`: `llm.js` (single OpenAI-compatible client), `loop.js` (tool loop,
  max turns, memory review pass), `prompt.js`, `tools*.js` (tool defs + handlers),
  `memory.js` (rules and facts), `review.js` (deterministic nightly tidy-up),
  `night.js` / `night-actions.js` (nightly detectors and gestures), `jobs.js`
  (per-conversation chat queue), `interventions.js`, `vision.js`.
- `server/kb/`: `store.js` (files, frontmatter, path safety), `index.js` (FTS5,
  links), `graph.js`, `router.js` (LLM ranking of search candidates),
  `weaving.js` (thesis/counter/use_for fields + "See also" links),
  `projects.js` (filing notes into `projects/<name>/`), `triggers.js`.
- `mcp/`: the two MCP servers.
- `scripts/`: tests, benchmarks and KB maintenance (see below).
- `web/`: React 19 + Vite front end (`src/App.jsx` shell, `Outliner.jsx`, `Chat.jsx`,
  `Kb.jsx`, `local.js` optimistic updates, `api.js`).
- `examples/kb/`: example notes and trigger files showing the KB format.

## Run, build, test

```bash
npm ci && npm run build          # server deps + web/dist
cp .env.example .env             # set AGENDA_TOKEN at least
npm start                        # http://127.0.0.1:8137/?t=<AGENDA_TOKEN>
cd web && npm run dev            # front dev server on :5174, proxies /api to :8137
npm test                         # KB trigger index on a throwaway copy of examples/kb
npm run test:gcal                # Google Calendar mirror end to end (network, no key)
node scripts/bench-model.mjs     # does a model call the right tools? (needs LLM key)
```

Tests and benchmarks create throwaway databases (`AGENDA_DB`, `AGENDA_KB` in a
temp dir); never point them at real data. When testing the HTTP server, start it
and query it from the same Node process or the same shell invocation.

## Invariants (do not break)

- **Local time, never UTC.** Days are computed on the process clock (`today()` in
  `db.js`, `TZ` env). Never use `toISOString().slice(0, 10)` for a day.
- **One LLM client.** Every model call goes through `server/agent/llm.js`
  (`streamChat`, `ask`, `llmHeaders`). Vision has its own model, same endpoint style.
- **A child never lives on another day than its parent.** `checkTree()` repairs at
  startup and runs inside `reorganize`; moving a task always re-parents it.
- **Nothing is deleted for good.** `deleteTask` snapshots the subtree into `trash`
  before the `ON DELETE CASCADE`; restore keeps original ids.
- **One gesture, one undo.** Screen writes carry `x-gesture`; agent turns are one
  gesture; machine jobs (night, calendar sync) record nothing.
- **Machine moves never touch calendar rows** (`source = 'gcal'` or `'call'`) nor
  rows the user re-placed in the last 40 hours. Checked tasks never move day.
- **No automatic job rewrites the text of a line.** Only an explicit user request.
- **Tool refusals are explicit** (`NOTHING ADDED`, `NOTHING DELETED`...) and become
  `ok: false` in `runTool`; tool results are injected as data, never instructions.
- **The KB is files first.** `data/kb/*.md` is the source of truth; `kb.db` is a
  rebuildable view. Paths are resolved under the KB root; `..`, absolute paths and
  NUL bytes are rejected.
- **Text sent to the model is written with care**: the model mimics the style of its
  prompt (accents, tone, no em dash). Keep prompts in one language.
- **The screen never waits.** The front applies each gesture locally (`local.js`)
  and does not reload on success; `local.js` must stay faithful to the server's
  tree order.
- Express 5: no `app.get('*')`; use a final middleware. Watch disconnects with
  `res.on('close')`, never `req.on('close')`.
- SQLite in WAL: back up with `better-sqlite3`'s `.backup()`, never `cp`.

## Conventions

- ES modules, no build step on the server, no TypeScript, no lint config.
- Few dependencies on purpose (express, better-sqlite3, ical.js, MCP SDK, zod);
  small parsers (frontmatter, wiki links, markdown) are hand-written.
- Schema changes are additive: `CREATE TABLE IF NOT EXISTS` and `addCol`.
- Every UI action must also exist as an agent tool (chat/UI parity).
- New env vars go in `.env.example` with a comment and a safe default.

## Background jobs

- In process (`server/clock.js`): calendar sync every 15 minutes, daily purge of
  old gesture rows.
- External cron, once a night: `POST /api/night` (tidy-up, nightly gestures,
  detectors, KB weaving of new notes). See SETUP.md.
