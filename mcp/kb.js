#!/usr/bin/env node
/**
 * MCP server "kb": the user's knowledge base, READ-WRITE.
 *
 * It carries no logic of its own: the search, the reading, the writing and the
 * graph live in server/kb/* and the agent's gestures in server/agent/tools-kb.js.
 * This file only exposes them over MCP stdio, exactly as mcp/agenda.js exposes
 * the task base. Duplicating the logic here would make the two paths drift apart
 * at the first fix.
 *
 * Two servers, separated on purpose: this one has the right to write to the KB,
 * the other (mcp/agenda.js) is read-only on the tasks. Permissions are given per
 * server, never per tool.
 *
 * After every write, reindex(): the FTS index and the graph are a VIEW of the
 * files, and a view that lags returns wrong results on the next call.
 *
 * `kb_route` is the only tool of this server that calls a model (see
 * server/kb/router.js). It does not replace the search, it follows it: the
 * search reduces the base to 25 candidates, the router ranks them. Measured on
 * real questions: the search puts the right note on top about one time in four,
 * the router more than one time in two, for about 3 s of latency. When the model
 * does not answer, the tool falls back on the search and SAYS so.
 */
import '../server/env.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readNote, moveNote, deleteNote } from '../server/kb/store.js'
import { reindex } from '../server/kb/index.js'
import { handlers } from '../server/agent/tools-kb.js'

const server = new McpServer({ name: 'kb', version: '1.0.0' }, {
  instructions: "The user's knowledge base: markdown notes with frontmatter, full-text search, a graph of [[wiki]] links. Two kinds of notes: general truths (the knowledge/ folder by default), which never talk about their ongoing projects because they must stay true in six months, and what moves (projects/<name>/ with its generated compass.md, memory/). When the user brings up a question of substance they may have written notes about, do a kb_route or a kb_search BEFORE answering: the base exists to make you deviate from an average answer, not to be consulted after the fact. kb_tree shows how it is filed."
})

const text = s => ({ content: [{ type: 'text', text: String(s) }] })

/* ------------------------------- reading -------------------------- */

server.registerTool('kb_search', {
  description: "Searches the knowledge base. Returns excerpts with the exact path of each note. Call it before kb_read: this is what tells you which note to open.",
  inputSchema: {
    query: z.string().describe('the words to search for'),
    folder: z.string().optional().describe('only search in this top-level folder, for example "knowledge" or "projects"'),
    limit: z.number().optional().describe('how many results, 8 by default')
  }
}, async (args) => text(handlers.kb_search(args)))

server.registerTool('kb_route', {
  description: "Ranks the notes of a topic, from the closest to the farthest, so you know in which order to open them. Call it when you do not know which words to type, or when the question is a whole sentence: the search can count words, it does not read a question. Returns four levels: 1 answer directly, 2 complete or shed light, 3 useful context, 4 seen then set aside. Start with level 1, go down only if the question needs a mechanism or a figure that level 1 does not carry. Slower than a search (about a second), so keep it for questions of substance.",
  inputSchema: {
    question: z.string().describe('the question in plain language, as you would ask it'),
    limit: z.number().optional().describe('how many notes to keep in levels 1 and 2, 12 by default')
  }
}, async (args) => text(await handlers.kb_route(args)))

server.registerTool('kb_read', {
  description: "Reads a whole note, by the path that kb_search or kb_tree gives.",
  inputSchema: { path: z.string().describe('the path of the note in the knowledge base') }
}, async (args) => text(handlers.kb_read(args)))

server.registerTool('kb_tree', {
  description: "The tree of the base: folders, number of notes, notes of the requested folder. Use it when you do not know where something is filed.",
  inputSchema: {
    folder: z.string().optional().describe('one precise folder, otherwise the whole tree'),
    depth: z.number().optional().describe('displayed depth, 2 by default')
  }
}, async (args) => text(handlers.kb_tree(args)))

server.registerTool('kb_related', {
  description: "The neighbours of a note in the graph: the ones it cites, the ones that cite it, its folder siblings. To bounce from one to another without going back through kb_search.",
  inputSchema: {
    path: z.string().describe('the path of the note'),
    limit: z.number().optional().describe('how many neighbours per category, 6 by default')
  }
}, async (args) => text(handlers.kb_related(args)))

/* ------------------------------- writing -------------------------- */

server.registerTool('kb_write', {
  description: "Writes or rewrites a note. The path decides where it lives: file it in a folder that already exists, do not invent one. On an existing path, REPLACES the note: read it again with kb_read before completing it. A note in a folder of general truths (knowledge/ by default) never talks about the user or their ongoing projects (refused otherwise); a new note about a project is filed alone in projects/<name>/.",
  inputSchema: {
    path: z.string().describe('path of the note, for example "knowledge/gardening.md"'),
    content: z.string().describe('the content of the note, in markdown'),
    title: z.string().optional().describe('the readable title of the note, with its accents'),
    tags: z.array(z.string()).optional().describe('a few tags, one word each')
  }
}, async (args) => {
  const out = await handlers.kb_write(args)
  reindex()
  return text(out)
})

server.registerTool('kb_link', {
  description: "Adds a [[wiki]] link between two notes, at the end of the starting note. This is what builds the graph: a note linked to nothing is invisible.",
  inputSchema: {
    from: z.string().describe('path of the note that receives the link'),
    to: z.string().describe('path of the note to point at'),
    why: z.string().optional().describe('one short sentence saying why the two are alike')
  }
}, async (args) => {
  const out = handlers.kb_link(args)
  reindex()
  return text(out)
})

server.registerTool('kb_move', {
  description: "Moves or renames a note, content untouched, missing folders created along the way. Refuses to overwrite an existing note at the destination.",
  inputSchema: {
    from: z.string().describe('the current path of the note'),
    to: z.string().describe('the new path, for example "archives/old-project.md"')
  }
}, async ({ from, to }) => {
  const start = String(from || '').trim()
  let n
  try { n = moveNote(start, String(to || '').trim()) } catch (e) { return text(`NOTHING MOVED. ${e.message}`) }
  if (!n) return text(`No note at "${start}", nothing moved.`)
  reindex()
  return text(`Note "${n.title}" moved to ${n.path}. The [[wiki]] links that cite it by its title follow it, those that cite the old path are broken: check with kb_related.`)
})

server.registerTool('kb_delete', {
  description: "Deletes a note for good, no trash. Read it again first, and prefer kb_move towards \"archives/\" if the content may be useful again.",
  inputSchema: { path: z.string().describe('the path of the note to delete') }
}, async ({ path }) => {
  const target = String(path || '').trim()
  let n
  try { n = readNote(target) } catch (e) { return text(`NOTHING DELETED. ${e.message}`) }
  if (!n) return text(`No note at "${target}", nothing deleted.`)
  deleteNote(n.path)
  reindex()
  return text(`Note "${n.title}" (${n.path}) deleted for good.`)
})

await server.connect(new StdioServerTransport())
