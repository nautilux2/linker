#!/usr/bin/env node
'use strict'

/**
 * linker OpenAI adapter
 *
 * Wraps linker hub tools in OpenAI function-calling format so any OpenAI-API-based
 * agent (Codex CLI, GPT-4 agent loops, LangChain, etc.) can participate in
 * cross-instance coordination.
 *
 * ── Standalone server ────────────────────────────────────────────────────────
 *   node adapters/openai.js [--port 7720] [--name NAME]
 *
 *   GET  /tools        → OpenAI tool definitions array
 *   POST /call         → { name, arguments } → { result }
 *
 * ── As a module ──────────────────────────────────────────────────────────────
 *   const { tools, execute } = require('./adapters/openai')
 *
 *   tools   — OpenAI-format tool definitions (include in your API request)
 *   execute(name, args) — Promise<string>  (call after model returns tool_calls)
 *
 * ── Agent loop example ───────────────────────────────────────────────────────
 *   const OpenAI = require('openai')
 *   const linker = require('./adapters/openai')
 *
 *   const messages = [{ role: 'user', content: '...' }]
 *   const client = new OpenAI()
 *
 *   while (true) {
 *     const res = await client.chat.completions.create({
 *       model: 'gpt-4o', messages, tools: linker.tools, tool_choice: 'auto'
 *     })
 *     const msg = res.choices[0].message
 *     messages.push(msg)
 *     if (!msg.tool_calls) break
 *     for (const tc of msg.tool_calls) {
 *       const result = await linker.execute(tc.function.name, JSON.parse(tc.function.arguments))
 *       messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
 *     }
 *   }
 */

const http = require('http')
const fs   = require('fs')
const os   = require('os')
const path = require('path')

const CONFIG = path.join(os.homedir(), '.linker')

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
  if (!cfg) throw new Error('Not configured. Run: linker-mcp join <url> --name NAME')
  return request(method, cfg.url, pathname, data, params)
}

// ── Tool definitions in OpenAI function-calling format ────────────────────────
// Tool names are prefixed with "linker_" to avoid collisions with other tools
// in the same agent loop. The execute() function strips the prefix.

const tools = [
  {
    type: 'function',
    function: {
      name: 'linker_send',
      description: 'Send a message to another AI instance. Omit "to" to broadcast to all.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Message content' },
          to:      { type: 'string', description: 'Recipient instance name (optional — omit to broadcast)' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_recv',
      description: 'Read unread messages addressed to this instance.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_ask',
      description: 'Post a question for other AI instances to answer. Returns a question id.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_answer',
      description: 'Answer a pending question by id.',
      parameters: {
        type: 'object',
        properties: {
          id:     { type: 'integer', description: 'Question ID from linker_pending' },
          answer: { type: 'string',  description: 'Your answer' }
        },
        required: ['id', 'answer']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_pending',
      description: 'List all unanswered questions from other instances.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_set',
      description: 'Store a value in the shared context, readable by all instances.',
      parameters: {
        type: 'object',
        properties: {
          key:   { type: 'string', description: 'Context key' },
          value: { type: 'string', description: 'Value to store' }
        },
        required: ['key', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_get',
      description: 'Read shared context. Omit key to get all.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Context key (optional)' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_who',
      description: 'List all connected AI instances and their agent types.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'linker_log',
      description: 'Show recent messages, questions, and shared context.',
      parameters: { type: 'object', properties: {} }
    }
  },
]

// ── Tool execution ────────────────────────────────────────────────────────────

async function execute(name, args) {
  const cfg = loadCfg()
  if (!cfg) throw new Error('Not configured. Join a linker host first.')
  const tool = name.startsWith('linker_') ? name.slice(7) : name

  switch (tool) {
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
    default:     throw new Error(`Unknown linker tool: ${name}`)
  }
}

// ── Standalone HTTP server ────────────────────────────────────────────────────

function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => {
      const body = JSON.stringify(data)
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/tools') {
        return send(200, tools)
      }
      if (req.method === 'POST' && req.url === '/call') {
        let body
        try { body = JSON.parse(raw) } catch { return send(400, { error: 'invalid JSON' }) }
        const { name, arguments: args = {} } = body
        if (!name) return send(400, { error: '"name" required' })
        try {
          const result = await execute(name, args)
          return send(200, { result })
        } catch(e) {
          return send(500, { error: e.message })
        }
      }
      send(404, { error: 'not found' })
    })
  })
  server.listen(port, '127.0.0.1')
  return server
}

// ── Entry ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const flag = (f, def) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : def }
  const port = parseInt(flag('--port', '7720'))
  const name = flag('--name', null)

  if (name) {
    const cfg = loadCfg()
    if (!cfg) { console.error('No hub configured. Run: linker-mcp join <url> --name ' + name); process.exit(1) }
    cfg.name = name
    fs.writeFileSync(CONFIG, JSON.stringify(cfg))
  }

  if (!loadCfg()) {
    console.error('Not connected to a linker host.\nRun: linker-mcp join <url> --name NAME')
    process.exit(1)
  }

  startServer(port)
  const cfg = loadCfg()
  console.log(`Linker OpenAI adapter  (${cfg.name} @ ${cfg.url})`)
  console.log(`Listening on http://localhost:${port}`)
  console.log()
  console.log(`  GET  /tools  → OpenAI tool definitions`)
  console.log(`  POST /call   → { "name": "linker_send", "arguments": {...} } → { "result": "..." }`)
  console.log()
  console.log(`In your agent loop:`)
  console.log(`  const tools = await fetch('http://localhost:${port}/tools').then(r => r.json())`)
  console.log(`  // include tools[] in your OpenAI API request`)
  console.log(`  // for each tool_call: POST /call with { name, arguments }`)
}

if (require.main === module) main()
else module.exports = { tools, execute, main }
