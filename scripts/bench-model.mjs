#!/usr/bin/env node
/**
 * The benchmark for the agenda's models.
 *
 * It replays the REAL system prompt and the REAL tools on a throwaway database
 * (`AGENDA_DB` points into a temporary folder: the user's database is never
 * touched, no tool is executed). It measures the two non-negotiable
 * requirements of a candidate model: calling the expected tool on a real
 * request, and giving back a reply whose characters arrive intact.
 *
 * Usage: node scripts/bench-model.mjs [model ...]
 * With no argument it measures the model in service, the one of `llm.js`.
 *
 * Example: AGENDA_MODEL=claude-sonnet-5-5 node scripts/bench-model.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-agenda-'))
process.env.AGENDA_DB = path.join(tmp, 'bench.db')
process.env.TZ = process.env.TZ || 'Europe/Paris'

const { systemPrompt } = await import(path.join(HERE, 'server/agent/prompt.js'))
const { toolSchemas } = await import(path.join(HERE, 'server/agent/tools.js'))
const { streamChat, MODEL } = await import(path.join(HERE, 'server/agent/llm.js'))
const { createTask } = await import(path.join(HERE, 'server/tasks.js'))

/* Two lines in place: the reading tools have something to return, and a move
   has a real identifier to aim at. */
const day = new Date().toISOString().slice(0, 10)
createTask({ content: 'call the accountant', day })
createTask({ content: 'buy bread', day })

/* What the user really says, and the tool a usable model must call. */
const CASES = [
  { said: 'I need to buy tomatoes and bread', expected: /^add_/ },
  { said: 'what do I have today?', expected: /^(list_|search_)/ },
  { said: 'move task 2 to Thursday', expected: /^(move_|search_|list_)/ },
  { said: 'I finished task 1', expected: /^(check|update_)/ },
  { said: 'remember that groceries are on Saturday', expected: /^(add_rule|remember)/ },
  { said: 'file "see the dentist" in the week', expected: /^(add_|park)/ }
]

const REPETITIONS = Number(process.env.BENCH_REPETITIONS || 2)
const models = process.argv.slice(2)
if (!models.length) models.push(MODEL)

const report = []
for (const model of models) {
  let good = 0
  let total = 0
  let intact = 0
  let texts = 0
  let errors = 0
  const misses = []
  const t0 = Date.now()

  for (let round = 0; round < REPETITIONS; round++) {
    for (const testCase of CASES) {
      total++
      let r
      try {
        r = await streamChat({
          messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: testCase.said }],
          tools: toolSchemas,
          reasoning: 'low'
        })
      } catch (e) {
        errors++
        misses.push(`${testCase.said} -> error ${e.message}`)
        continue
      }
      const names = r.toolCalls.map(c => c.name)
      if (names.some(n => testCase.expected.test(n))) good++
      else misses.push(`${testCase.said} -> ${names.join(', ') || `no tool (${JSON.stringify(r.content.slice(0, 40))})`}`)
      // A turn with nothing but tool calls has no text to judge: only count the
      // turns where the model really wrote something.
      if (r.content) {
        texts++
        // The reply must come back with its characters intact (no replacement
        // character): that is what catches a model that mangles the encoding.
        if (!r.content.includes('\uFFFD')) intact++
      }
    }
  }

  for (const r of misses.slice(0, 6)) console.log(`  miss : ${r}`)
  report.push({ model, good, total, intact, texts, errors, s: ((Date.now() - t0) / 1000).toFixed(0) })
}

console.log('')
for (const b of report) {
  const chars = b.texts ? `${b.intact}/${b.texts}` : 'no text to judge'
  console.log(`${b.model.padEnd(26)} expected tools ${b.good}/${b.total}   intact replies ${chars}   errors ${b.errors}   ${b.s}s`)
}

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
