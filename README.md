# agenda-knowledge-base

A week to-do list that an LLM agent keeps in order, with a markdown knowledge
base next to it. Self-hosted, single Node process, SQLite, installable as a PWA
on a phone. Two MCP servers let Claude Code (or any MCP client) read your week,
talk to the agent, and read or write your notes.

## Why it exists

Most to-do apps are good at storing lines and bad at the part that costs time:
deciding where each line goes, and doing it again every evening. This project
moves that part to an agent:

- **Days arrange themselves.** Unfinished tasks are moved to the right day at
  night, following rules the agent has learned (groceries go to Saturday, not to
  tomorrow).
- **A dictated sentence lands on the right day.** "Dentist on Tuesday at 9:30,
  and I need to buy bread" becomes two lines, in the right groups, with a time
  slot.
- **An oversized task gets split.** Large tasks are decomposed, and projects
  that keep moving get a five-minute first step.
- **Every correction becomes memory.** When you move something back or correct
  the agent, it records a rule (which drives the arrangement) or a fact (which
  shapes its tone and decisions), so the same correction is not needed twice.

Everything else is deliberately minimal: an outliner of days, with groups,
checkboxes, notes, time slots and keyboard shortcuts.

## Features

- Week and day views of an outliner (groups, sub-tasks, notes, markdown, drag
  and drop with mouse or finger, multi-select, copy/paste of subtrees).
- Chat with the agent (docked, floating or full screen on phones); the agent
  works server side, so you can send a message and lock your phone.
- About 60 agent tools: add/move/reorganize in one transaction, undo, trash and
  restore, waiting-for / parked / paused / archived states, rules with health
  stats, "why did this move", load check, time slots, attachments, KB access.
- Night routine (one cron call): deterministic tidy-up, small reversible
  gestures, detectors whose findings appear as a discreet badge on the task
  (the agent never starts a conversation by itself).
- Single undo/redo stack (Ctrl+Z / Ctrl+Y) covering both your gestures and the
  agent's turns, recorded by SQLite triggers.
- Read-only Google Calendar mirror through secret iCal URLs (no OAuth app).
- Voice dictation (Mistral Voxtral) and image description (any vision model on
  an OpenAI-compatible endpoint); attachments and link previews.
- Markdown knowledge base with `[[wiki links]]`, full-text search, link graph,
  an LLM router that ranks notes for a question, and "weaving" that writes a
  thesis and qualified links into each note.
- "Send to a worker": hand a task to a headless Claude Code run on the server.
- PWA: installable, works on phone and desktop, dark and light themes.

## Architecture

```
  phone / desktop (PWA)                       your server
 +------------------------+   HTTPS    +---------------------------+
 | React + Vite           | ---------> | reverse proxy             |
 |  day / week / inbox    |            | (Caddy, nginx, Traefik)   |
 |  knowledge base        |            +-------------+-------------+
 |  chat with the agent   |                          | http 127.0.0.1:8137
 +-----------^------------+            +-------------v-------------+
             |   SSE /api/events       | Node (Express 5)          |
             +-------------------------+  server/index.js          |
               agent steps, refresh    |                           |
                                       |  tasks  -> SQLite todo.db |
   Claude Code / MCP client            |  agent  -> LLM API (any   |
 +------------------------+  stdio     |            OpenAI-compat) |
 | mcp/agenda.js (read +  |----------->|  kb     -> data/kb/*.md   |
 |   agenda_message)      |  HTTP chat |            + kb.db (FTS5) |
 | mcp/kb.js (read/write) |            |  gcal   -> iCal URLs      |
 +------------------------+            +---------------------------+
                                           ^ cron: POST /api/night
```

The agent is not a separate service: it is code in the same process that calls
the model and runs its tools directly on SQLite. No sub-process, no extra server.

## Tech stack

- Node.js 22+, ES modules, no build step on the server.
- Express 5, better-sqlite3 (WAL), ical.js, `@modelcontextprotocol/sdk`, zod.
- React 19 + Vite for the front end, a minimal service worker for the PWA.
- Any OpenAI-compatible chat completions API with tool calling.

## The knowledge base

A folder of real markdown files (`data/kb/` by default) is the source of truth;
the SQLite FTS5 index (`data/kb.db`) is a view rebuilt from the files at
startup. Any tool that can read a folder can use the base without an API.

A note is markdown with a small frontmatter:

```markdown
---
title: The two-minute rule
tags: [procrastination, habits]
thesis: "Any chore under two minutes is done now, never written down."
counter: "The usual reflex is to capture everything first."
use_for: "Open when the list fills up with tiny chores."
exception: "During a focus block, capture instead of doing."
---

Body text, with links like [[knowledge/weekly-review|weekly review]].
```

- **Wiki graph.** `[[note]]`, `[[folder/note|label]]` and `[[note#section]]`
  are parsed into a link table; broken links are kept and visible.
- **Weaving** (`server/kb/weaving.js`, nightly or `scripts/weave.mjs`): a TF-IDF
  neighbourhood picks candidates, the model writes `thesis`, `counter`,
  `use_for`, optional `exception`, and a "See also" block where each link says
  why. Only links from the candidate list are accepted.
- **Router** (`kb_route`): full-text search narrows the base to 25 candidates,
  the model ranks them in four levels (answer directly, complement, context,
  seen and discarded). If the model is down, it falls back to search and says so.
- **Triggers** (`server/kb/triggers.js`): an index of words that belong to one
  note only, checked against an anti-corpus of neutral sentences
  (`anti-triggers.txt`) and a list of sentences that must keep finding their note
  (`expected-triggers.txt`). `npm test` runs it on the example base.
- **Folder conventions** (an example, configurable): timeless notes in
  `knowledge/` (they must never talk about your ongoing projects, and writes that
  do are refused), project notes in `projects/<name>/memory/` and
  `projects/<name>/data/`, with a generated `compass.md` per project. See
  `examples/kb/`.

## MCP servers

Two stdio servers, registered separately so that permissions are given per
server:

- `mcp/agenda.js` (`agenda`): reads the task database directly (`list_day`,
  `list_week`, `search_tasks`, `task_detail`, `stats`, `why_moved`) and has one
  write path, `agenda_message`, which sends a natural-language message to the
  app's own agent through `POST /api/chat` and returns its answer. There is no
  direct write tool: the agenda logic lives in one place.
- `mcp/kb.js` (`kb`): `kb_search`, `kb_route`, `kb_read`, `kb_tree`,
  `kb_related`, `kb_write`, `kb_link`, `kb_move`, `kb_delete`.

```bash
claude mcp add --scope user agenda -- node /path/to/agenda-knowledge-base/mcp/agenda.js
claude mcp add --scope user kb -- node /path/to/agenda-knowledge-base/mcp/kb.js
```

Both servers read the project's `.env` themselves (or `AGENDA_ENV_FILE`).

## LLM configuration

All model calls go through one client (`server/agent/llm.js`) speaking the
OpenAI chat completions format with streaming and tool calls. The default
provider is [OpenCode Go](https://opencode.ai) with `deepseek-v4.1-flash`; any
compatible endpoint works:

```bash
AGENDA_LLM_URL=https://openrouter.ai/api/v1
AGENDA_LLM_API_KEY=...
AGENDA_MODEL=some/model-with-tool-calling
AGENDA_REASONING=low            # reasoning_effort, empty to omit
AGENDA_MODEL_FALLBACK=...       # optional, used once on 404/410
AGENDA_VISION_MODEL=...         # image descriptions (OpenAI image_url format)
```

Before switching models, run `node scripts/bench-model.mjs`: it replays the
real system prompt and tools on a throwaway database and checks that the model
calls the expected tools and answers in the expected language.

## Quick start (local)

Requirements: Node.js 22 or later, a C/C++ toolchain only if no prebuilt
`better-sqlite3` binary exists for your platform.

```bash
git clone https://github.com/geoany/agenda-knowledge-base.git
cd agenda-knowledge-base
npm ci
npm run build                 # installs and builds the web front into web/dist
cp .env.example .env          # set AGENDA_TOKEN, and an LLM key for the agent
npm start
```

Open `http://127.0.0.1:8137/?t=<AGENDA_TOKEN>` once; the token is then kept by
the browser. The data directory (`./data`) is created on first run. To start
with the example notes: `mkdir -p data/kb && cp -r examples/kb/* data/kb/`.

For front-end work, `cd web && npm run dev` serves the UI on port 5174 and
proxies `/api` to the running server.

Putting it online on your own server and domain: see [SETUP.md](SETUP.md).

## Project layout

```
server/
  index.js          Express app, auth, routes, startup
  env.js            .env loader (imported first)
  db.js             SQLite schema and date helpers
  tasks.js          task tree, groups, moves, trash, rules, states
  schedule.js       time parsing, slots, overlaps
  history.js        undo/redo through SQLite triggers
  gcal.js           Google Calendar mirror
  voice.js          speech to text
  worker.js         headless Claude Code runs
  attachments.js    uploads, images, link cards
  agent/            LLM client, tool loop, prompt, tools, memory, night jobs
  kb/               knowledge base: store, index, graph, router, weaving, triggers
mcp/
  agenda.js         MCP server: tasks (read) + agenda_message
  kb.js             MCP server: knowledge base (read/write)
scripts/            tests, benchmarks, KB maintenance
web/                React + Vite PWA
examples/kb/        example notes and trigger files
```

## License

MIT, see [LICENSE](LICENSE).
