#!/usr/bin/env node
/**
 * The benchmark for the headless workers.
 *
 * It replays the REAL prompt and the REAL rules of the "Send to a worker"
 * button (imported from server/worker.js, so the bench cannot drift away from
 * the real behaviour) on short, verifiable tasks, and measures what matters for
 * that button: wall-clock time and the fact that the task is DONE.
 *
 * Why: the worker is a gesture from the phone. A model that takes twelve
 * minutes to file three lines is not a worker, it is a background agent. The
 * measure is taken on disk (does the requested file exist, with the right
 * content), not on the text of the reply: a model that says "it is done"
 * without doing anything must lose.
 *
 * Each run happens in its own temporary folder: none of the user's files is
 * touched, and two runs do not step on each other. The test tasks have no
 * identifier: they do not touch the agenda.
 *
 * Usage:
 *   node scripts/bench-worker.mjs                        # default model of the CLI
 *   node scripts/bench-worker.mjs sonnet haiku           # one pass per model (--model)
 *   AGENDA_WORKER_CMD=/path/to/launcher node scripts/bench-worker.mjs
 *   AGENDA_WORKER_TIMEOUT_MS=180000 node scripts/bench-worker.mjs ...
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { workerArgs, buildWorkerPrompt, findLauncher } = await import(path.join(HERE, 'server/worker.js'))

const LAUNCHER = findLauncher(process.env.AGENDA_WORKER_CMD || 'claude')
if (!LAUNCHER) {
  console.error('Launcher not found: install Claude Code or set AGENDA_WORKER_CMD.')
  process.exit(1)
}
const MAX_TURNS = process.env.AGENDA_WORKER_MAX_TURNS || '30'
const TIMEOUT = Number(process.env.AGENDA_WORKER_TIMEOUT_MS || 6 * 60 * 1000)

// What the bench measures: the candidate models, passed to the launcher with
// --model. With no argument, a single pass with the launcher's default model.
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['(default)']

/**
 * Two short tasks, verifiable on disk. The first asks for no reading at all: it
 * is the time floor (the model only has to write a file). The second asks for a
 * minimal read and a write: that is where a model that explores blows up the
 * time.
 */
const TASKS = [
  {
    name: 'simple write',
    instruction: 'In the current folder, create the file result.txt containing exactly the word ok (nothing else).',
    verify: dir => {
      const f = path.join(dir, 'result.txt')
      if (!existsSync(f)) return { ok: false, what: 'result.txt missing' }
      const c = readFileSync(f, 'utf8').trim()
      return { ok: c === 'ok', what: c === 'ok' ? 'ok' : `unexpected content ("${c.slice(0, 40)}")` }
    }
  },
  {
    name: 'read then write',
    instruction: 'In the current folder there is input.txt. Read it and write its value, unchanged, into output.txt.',
    prepare: dir => writeFileSync(path.join(dir, 'input.txt'), 'value-42\n'),
    verify: dir => {
      const f = path.join(dir, 'output.txt')
      if (!existsSync(f)) return { ok: false, what: 'output.txt missing' }
      const c = readFileSync(f, 'utf8').trim()
      return { ok: c === 'value-42', what: c === 'value-42' ? 'ok' : `unexpected content ("${c.slice(0, 40)}")` }
    }
  }
]

function run (model, task, dir) {
  const prompt = `${buildWorkerPrompt({ text: task.instruction, goal: null })} The working folder is the current folder.`
  const args = [...(model === '(default)' ? [] : ['--model', model]), ...workerArgs(prompt)]
  const start = Date.now()
  return new Promise(resolve => {
    const child = spawn(LAUNCHER, args, {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    let output = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
    }, TIMEOUT)
    const capture = d => { output = (output + d.toString()).slice(-4000) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ ms: Date.now() - start, code: null, killed, output, error: e.message })
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve({ ms: Date.now() - start, code, killed, output })
    })
  })
}

const sec = ms => (ms / 1000).toFixed(0).padStart(5) + 's'

console.log(`Worker bench · timeout ${TIMEOUT / 1000}s · max-turns ${MAX_TURNS} · launcher ${LAUNCHER}`)
console.log(`Models: ${MODELS.join(', ')}\n`)

const results = []
for (const model of MODELS) {
  for (const task of TASKS) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-worker-'))
    if (task.prepare) task.prepare(dir)
    process.stdout.write(`· ${model} · ${task.name} … `)
    const r = await run(model, task, dir)
    const v = task.verify(dir)
    results.push({ model, task: task.name, ms: r.ms, ok: v.ok && !r.killed, what: r.killed ? 'timed out, killed' : v.what, code: r.code })
    console.log(`${sec(r.ms)} ${v.ok && !r.killed ? 'OK' : 'FAIL'} (${r.killed ? 'killed' : v.what}${r.code != null ? `, code ${r.code}` : ''})`)
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n--- report ---')
for (const model of MODELS) {
  const own = results.filter(r => r.model === model)
  const passed = own.filter(r => r.ok)
  const average = own.length ? Math.round(own.reduce((a, r) => a + r.ms, 0) / own.length / 1000) : 0
  const worst = own.length ? Math.round(Math.max(...own.map(r => r.ms)) / 1000) : 0
  console.log(`${model.padEnd(24)} ${passed.length}/${own.length} passed · average ${average}s · worst ${worst}s`)
}
