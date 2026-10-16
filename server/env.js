/**
 * Loads the project's environment file, before any other module.
 *
 * Imported FIRST by server/index.js and by both MCP servers: the modules that
 * follow (db.js, kb/store.js...) read process.env when they are evaluated. An
 * MCP client starts these servers without the service's environment, hence this
 * explicit loading.
 *
 * File: AGENDA_ENV_FILE, otherwise <project>/.env. If missing, nothing is loaded.
 * A variable already set in the environment (systemd, shell) is never
 * overwritten by the file.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const ENV_FILE = process.env.AGENDA_ENV_FILE || resolve(PROJECT_DIR, '.env')

if (existsSync(ENV_FILE)) {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!m || process.env[m[1]] !== undefined) continue
      let v = m[2]
      const q = v[0]
      if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1)
      else v = v.replace(/\s+#.*$/, '')
      process.env[m[1]] = v
    }
  } catch (e) {
    console.error(`env: cannot read ${ENV_FILE} (${e.message})`)
  }
}
