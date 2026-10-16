/**
 * "Send to a worker": an instruction (dictated or typed) leaves as a headless,
 * detached, one-shot task in AGENDA_WORKER_CWD (the project folder by default).
 * The worker is a Claude Code compatible CLI (`claude -p`):
 *
 * - `claude` : AGENDA_WORKER_CMD, `claude` (looked up in the PATH) by default;
 * - `cheap`  : the same launcher on a cheaper model (`--model`), see
 *   `cheapSetup` for the OpenCode Go and Haiku cases.
 *
 * No conversation, no complex tracking: an identifier returned right away, one
 * log file per task, and a running/done status read back from that file and
 * from the pid, never from an in-memory queue, which would not survive a
 * restart of the agenda service while a worker is still running.
 *
 * The service often runs with a restricted PATH (systemd unit): a bare command
 * name is resolved here against the process PATH, an absolute path is taken as
 * is. `spawn` never goes through a shell.
 */

import { spawn } from 'node:child_process'
import {
  mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync
} from 'node:fs'
import { resolve, dirname, delimiter, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publish } from './bus.js'

const here = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.AGENDA_DATA_DIR || resolve(here, '../data')
const LOG_DIR = process.env.AGENDA_WORKERS_DIR || resolve(DATA_DIR, 'workers')
mkdirSync(LOG_DIR, { recursive: true })

// The folder where the worker works. The project itself by default; point it at
// the folder holding the code or the notes it is supposed to act on.
const CWD = process.env.AGENDA_WORKER_CWD || resolve(here, '..')

// A worker is not a background agent: it is a gesture from the phone, it has to
// hand back. Beyond this bound the process is killed and the task is marked
// "abandoned" instead of counting the minutes in silence.
const TIMEOUT_MS = Number(process.env.AGENDA_WORKER_TIMEOUT_MS || 12 * 60 * 1000)
// One turn more than the number of expected gestures: beyond that, the model
// re-reads instead of acting. With no bound, the CLI has already run 24 min on a
// simple documentation task, without ever handing back.
const MAX_TURNS = Number(process.env.AGENDA_WORKER_MAX_TURNS || 30)

/**
 * The framing of the headless session. The worker shares the executor's
 * doctrine, but with a constraint the global one lacks: decide fast, without
 * exploration, and hand back. `--append-system-prompt` adds it to the session
 * system prompt, without touching the global one.
 */
export const WORKER_RULES = [
  'You are a one-shot worker launched from the user phone: it expects a finished action, not an exploration.',
  'Decide fast. Do not read more files than necessary, do not inspect the environment beyond the task, do not re-read what you have already read.',
  'Only open the knowledge base (kb_route, kb_search) if the task really is about a foundational question: it slows down an execution task.',
  'When it is done and verified, you stop: you write a short sentence, you check the task if it was given to you, and you hand back.'
].join(' ')

/** The options passed to the launcher: those of `claude -p`, in headless mode. */
export const workerArgs = prompt => [
  '-p', prompt,
  '--dangerously-skip-permissions',
  '--max-turns', String(MAX_TURNS),
  '--append-system-prompt', WORKER_RULES
]

/**
 * The cheap worker: the same Claude Code, on a cheaper model.
 *
 * With an OpenCode Go key, Claude Code is pointed at OpenCode Go (its
 * Anthropic-compatible endpoint) and every model it uses becomes the cheap one.
 * OpenCode Go only accepts the x-api-key header, which Claude Code sends from
 * ANTHROPIC_API_KEY: every inherited CLAUDE* and ANTHROPIC* variable is dropped
 * first, because an inherited claude.ai token would make it answer 401.
 * Without that key, it stays on Anthropic with Haiku and the normal environment.
 */
function cheapSetup () {
  const key = process.env.OPENCODE_GO_API_KEY
  if (!key) return { model: process.env.AGENDA_WORKER_CHEAP_MODEL || 'claude-haiku-5-5', env: process.env }
  const model = process.env.AGENDA_WORKER_CHEAP_MODEL || 'deepseek-v4.1-flash'
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k)))
  return {
    model,
    env: {
      ...env,
      ANTHROPIC_BASE_URL: 'https://opencode.ai/zen/go',
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    }
  }
}

const BIN = process.env.AGENDA_WORKER_CMD || 'claude'
const WORKERS = {
  claude: {
    label: 'Claude Code',
    bin: BIN,
    args: workerArgs,
    env: () => process.env
  },
  cheap: {
    label: 'Claude Code · cheap model',
    bin: BIN,
    args: prompt => [...workerArgs(prompt), '--model', cheapSetup().model],
    env: () => cheapSetup().env
  }
}

/** The real path of a launcher: as is if it contains a folder, otherwise looked up in the PATH. */
export function findLauncher (bin) {
  if (!bin) return null
  if (isAbsolute(bin) || bin.includes('/')) return existsSync(bin) ? resolve(bin) : null
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const p = resolve(dir, bin)
    if (existsSync(p)) return p
  }
  return null
}

export function availableWorkers () {
  return Object.entries(WORKERS).map(([id, w]) => ({ id, label: w.label }))
}

const metaPath = id => resolve(LOG_DIR, `${id}.json`)
const logPath = id => resolve(LOG_DIR, `${id}.log`)

function readMeta (id) {
  try { return JSON.parse(readFileSync(metaPath(id), 'utf8')) } catch { return null }
}
function writeMeta (id, meta) {
  try { writeFileSync(metaPath(id), JSON.stringify(meta)) } catch (e) { console.error('worker meta:', e.message) }
}

/** Is the pid still there? Signal 0 kills nothing, it only tests access. */
function alive (pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * The worker prompt. Without a goal, it is the instruction alone. With a goal,
 * the task IS the command: it is named by its identifier (the one of the to-do
 * item, the worker must be able to update it), the instruction becomes a
 * detail, and the task update is asked only "when it is done AND verified": a
 * line updated wrongly is worse than a line not updated.
 */
export function buildWorkerPrompt ({ text, goal }) {
  if (!goal) {
    return `Do this: ${text}. No questions, no plan, no confirmation: execute in this turn, then stop and hand back.`
  }
  const p = [`Goal #${goal.id}: ${goal.text}.`]
  if (text) p.push(`Instruction: ${text}.`)
  p.push('Do it now, in this turn.')
  p.push('No questions, no plan, no confirmation before acting.')
  p.push(`Once done AND verified, check task #${goal.id} in the agenda (MCP agenda, tool agenda_message) by writing what was done in the note, then stop and hand back.`)
  return p.join(' ')
}

/**
 * Starts the task and hands back right away. The process leaves detached
 * (`detached: true` + `unref()`): it survives the phone being closed and a
 * restart of the agenda service, in its own process group.
 */
export function startWorker ({ instruction, worker, goal = null }) {
  const def = WORKERS[worker]
  if (!def) throw new Error('unknown worker')
  const bin = findLauncher(def.bin)
  if (!bin) throw new Error(`${def.label} not found (${def.bin}): install it or set AGENDA_WORKER_CMD`)
  const text = String(instruction || '').trim()
  if (!text && !goal) throw new Error('nothing to send')

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const prompt = buildWorkerPrompt({ text, goal })
  const lp = logPath(id)

  const title = [
    goal ? `Goal #${goal.id}: ${goal.text}` : null,
    text ? `Instruction: ${text}` : null
  ].filter(Boolean).join('\n')
  writeFileSync(lp, `${new Date().toISOString()} · ${def.label}\n${title}\n\n--- output ---\n\n`)
  const startedAt = Date.now()
  const header = { worker, label: def.label, instruction: text, goalId: goal?.id ?? null, goal: goal?.text ?? null }
  writeMeta(id, { id, ...header, startedAt })

  const fd = openSync(lp, 'a')
  let child
  try {
    child = spawn(bin, def.args(prompt), {
      cwd: CWD,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: def.env()
    })
  } finally {
    closeSync(fd)
  }

  const meta = code => ({ id, ...header, startedAt, pid: child.pid, ...code })
  writeMeta(id, meta({}))

  // The bound: past TIMEOUT_MS, we kill the process group and note it. A worker
  // that never hands back must not stay invisible.
  let timer = null
  const armTimeout = () => {
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      writeMeta(id, meta({ timedOut: true }))
      publish('refresh', { reason: 'worker' })
    }, TIMEOUT_MS)
    timer.unref?.()
  }
  armTimeout()

  child.on('exit', code => {
    if (timer) clearTimeout(timer)
    const previous = readMeta(id)
    writeMeta(id, meta({ finishedAt: Date.now(), code, timedOut: previous?.timedOut === true }))
    publish('refresh', { reason: 'worker' })
  })
  child.on('error', e => {
    if (timer) clearTimeout(timer)
    writeMeta(id, meta({ finishedAt: Date.now(), error: e.message }))
    publish('refresh', { reason: 'worker' })
  })
  child.unref()

  return { id, worker, label: def.label, goalId: header.goalId, goal: header.goal }
}

export function workerStatus (id) {
  const meta = readMeta(id)
  if (!meta) return null
  let log = ''
  try { log = readFileSync(logPath(id), 'utf8') } catch {}

  // The bound survives a restart of the service: the in-memory timer disappears
  // with the process, but re-reading the status recreates the constraint.
  // Without that, a worker started before a restart could run forever.
  const running = meta.finishedAt === undefined && alive(meta.pid)
  const overdue = running && Date.now() - meta.startedAt > TIMEOUT_MS
  if (overdue) {
    try { process.kill(-meta.pid, 'SIGTERM') } catch {}
    meta.timedOut = true
    writeMeta(id, meta)
  }
  // The process may have finished while the agenda server was stopped: the
  // 'exit' event is then lost, and we fall back on the pid.
  const finished = meta.finishedAt !== undefined || !alive(meta.pid)
  return {
    id: meta.id,
    worker: meta.worker,
    label: meta.label,
    instruction: meta.instruction,
    goalId: meta.goalId ?? null,
    goal: meta.goal ?? null,
    startedAt: meta.startedAt,
    status: !finished ? 'running' : (meta.timedOut ? 'abandoned' : 'done'),
    timedOut: meta.timedOut === true,
    log: log.length > 6000 ? log.slice(-6000) : log
  }
}
