#!/usr/bin/env node
'use strict'

/**
 * linker file-watch adapter
 *
 * Syncs linker hub state to ~/.linker/bus/ so file-based AI agents (Aider,
 * shell scripts, GitHub Copilot via file context) can read shared state and
 * optionally execute tool calls via a simple poll protocol.
 *
 * Usage:
 *   node adapters/filewatch.js [--name NAME] [--interval MS]
 *
 * ── State snapshots (written every --interval ms) ────────────────────────────
 *   ~/.linker/bus/context.json   — shared key-value context
 *   ~/.linker/bus/who.json       — connected instances and their agent types
 *   ~/.linker/bus/messages.json  — your unread messages
 *   ~/.linker/bus/pending.json   — unanswered questions from other instances
 *
 * ── Poll-based tool calls (for script agents) ────────────────────────────────
 *   Write a call file to ~/.linker/bus/out/<id>.json:
 *     { "id": "001", "name": "send", "arguments": { "content": "hello", "to": "*" } }
 *   Result appears in ~/.linker/bus/in/<id>.json:
 *     { "id": "001", "result": "Sent (id=3)", "ok": true }
 *   Processed call files are moved to ~/.linker/bus/out/done/
 *
 * ── Aider integration ────────────────────────────────────────────────────────
 *   1. Start this adapter: node adapters/filewatch.js --name aider
 *   2. Start Aider with bus files as read context:
 *        aider --read ~/.linker/bus/context.json \
 *              --read ~/.linker/bus/who.json \
 *              --read ~/.linker/bus/pending.json
 *   3. Aider can send messages via bash tool:
 *        echo '{"id":"1","name":"send","arguments":{"content":"done with auth"}}' \
 *          > ~/.linker/bus/out/1.json
 */

const http = require('http')
const fs   = require('fs')
const os   = require('os')
const path = require('path')

const CONFIG   = path.join(os.homedir(), '.linker')
const BUS_DIR  = path.join(os.homedir(), '.linker', 'bus')
const OUT_DIR  = path.join(BUS_DIR, 'out')
const IN_DIR   = path.join(BUS_DIR, 'in')
const DONE_DIR = path.join(OUT_DIR, 'done')

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return null }
}

function request(method, baseUrl, pathname, data, params) {
  return new Promise((resolve, reject) => {
    let urlStr = baseUrl.replace(/\/$/, '') + pathname
    if (params && Object.keys(params).length) urlStr += '?' + new URLSearchParams(params)
    const u    = new URL(urlStr)
    const body = data ? JSON.stringify(data) : null
    const opts = {
      hostname: u.hostname, port: parseInt(u.port) || 80,
      path: u.pathname + u.search, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
    }
    const req = http.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))) } catch(e) { reject(e) } })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

function api(method, pathname, data, params) {
  const cfg = loadCfg()
  if (!cfg) throw new Error('not_configured')
  return request(method, cfg.url, pathname, data, params)
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
}

// ── Sync hub state to snapshot files ─────────────────────────────────────────

async function syncSnapshots(cfg) {
  const [context, who, messages, pending] = await Promise.all([
    api('GET', '/get'),
    api('GET', '/who'),
    api('GET', '/recv', null, { for: cfg.name }),
    api('GET', '/pending'),
  ])
  writeJson(path.join(BUS_DIR, 'context.json'),  context)
  writeJson(path.join(BUS_DIR, 'who.json'),       who)
  writeJson(path.join(BUS_DIR, 'messages.json'),  messages)
  writeJson(path.join(BUS_DIR, 'pending.json'),   pending)
}

// ── Execute a tool call against the hub ──────────────────────────────────────

async function executeCall(name, args, cfg) {
  switch (name) {
    case 'send': {
      const data = { content: args.content, from: cfg.name }
      if (args.to) data.to = args.to
      const r = await api('POST', '/send', data)
      return `Sent (id=${r.id})`
    }
    case 'recv': {
      const msgs = await api('GET', '/recv', null, { for: cfg.name })
      return msgs.length ? JSON.stringify(msgs, null, 2) : '(no new messages)'
    }
    case 'ask': {
      const r = await api('POST', '/ask', { question: args.question, from: cfg.name })
      return `Question posted (id=${r.id})`
    }
    case 'answer':
      await api('POST', '/answer', { id: args.id, answer: args.answer })
      return 'Answered'
    case 'pending': {
      const items = await api('GET', '/pending')
      return items.length ? JSON.stringify(items, null, 2) : '(no pending questions)'
    }
    case 'set':
      await api('POST', '/set', { key: args.key, value: args.value })
      return `Set '${args.key}'`
    case 'get': {
      const r = await api('GET', '/get', null, args.key ? { key: args.key } : {})
      return JSON.stringify(r, null, 2)
    }
    case 'who':  return JSON.stringify(await api('GET', '/who'), null, 2)
    case 'log':  return JSON.stringify(await api('GET', '/log'), null, 2)
    default:     throw new Error(`Unknown tool: ${name}`)
  }
}

// ── Process pending call files from out/ ─────────────────────────────────────

async function processCalls(cfg) {
  let files
  try {
    files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return
  }

  for (const file of files) {
    const src = path.join(OUT_DIR, file)
    let call
    try { call = JSON.parse(fs.readFileSync(src, 'utf8')) } catch { continue }

    const { id, name, arguments: args = {} } = call
    if (!id || !name) continue

    let result, ok = true
    try {
      result = await executeCall(name, args, cfg)
    } catch(e) {
      result = e.message
      ok = false
    }

    writeJson(path.join(IN_DIR, `${id}.json`), { id, result, ok })

    // Move processed file to done/
    try {
      fs.renameSync(src, path.join(DONE_DIR, file))
    } catch {
      try { fs.unlinkSync(src) } catch {}
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run(interval) {
  const cfg = loadCfg()
  if (!cfg) {
    console.error('Not connected to a linker host.\nRun: linker-mcp join <url> --name NAME')
    process.exit(1)
  }

  for (const dir of [BUS_DIR, OUT_DIR, IN_DIR, DONE_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  console.log(`Linker file-watch adapter  (${cfg.name} @ ${cfg.url})`)
  console.log(`Bus directory: ${BUS_DIR}`)
  console.log()
  console.log(`Snapshots (every ${interval}ms):`)
  console.log(`  ${BUS_DIR}/context.json`)
  console.log(`  ${BUS_DIR}/who.json`)
  console.log(`  ${BUS_DIR}/messages.json`)
  console.log(`  ${BUS_DIR}/pending.json`)
  console.log()
  console.log(`Tool calls: write to ${OUT_DIR}/<id>.json`)
  console.log(`Results:    read from ${IN_DIR}/<id>.json`)
  console.log()
  console.log(`Aider:`)
  console.log(`  aider --read ${BUS_DIR}/context.json --read ${BUS_DIR}/who.json --read ${BUS_DIR}/pending.json`)

  const tick = async () => {
    try { await syncSnapshots(cfg) } catch {}
    await processCalls(cfg)
  }

  await tick()
  setInterval(tick, interval)
}

// ── Entry ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const flag = (f, def) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : def }
  const interval = parseInt(flag('--interval', '2000'))
  const name     = flag('--name', null)

  if (name) {
    const cfg = loadCfg()
    if (!cfg) { console.error('No hub configured. Join first.'); process.exit(1) }
    cfg.name = name
    fs.writeFileSync(CONFIG, JSON.stringify(cfg))
  }

  run(interval).catch(e => { console.error(e.message); process.exit(1) })
}

if (require.main === module) main()
else module.exports = { run, main, BUS_DIR }
