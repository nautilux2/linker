#!/usr/bin/env node
'use strict'

const http     = require('http')
const fs       = require('fs')
const os       = require('os')
const path     = require('path')
const { spawn } = require('child_process')
const readline  = require('readline')

const CONFIG      = path.join(os.homedir(), '.linker')
const PID_FILE    = path.join(os.homedir(), '.linker_host_pid')
const RULES_FILE  = path.join(__dirname, 'rules', 'AGENT.md')
const SCAN_PORTS  = Array.from({ length: 11 }, (_, i) => 7700 + i)
const DEFAULT_PORT = 7700

// Detected at MCP initialize time; included in heartbeats so the hub knows
// which AI tool each instance is.
let _agentType = 'unknown'
let _agentTool = 'unknown'

// ── Config ────────────────────────────────────────────────────────────────────

const loadCfg = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) } catch { return null } }
const saveCfg = (url, name) => fs.writeFileSync(CONFIG, JSON.stringify({ url, name }))
const now     = () => new Date().toTimeString().slice(0, 8)

// ── HTTP client ───────────────────────────────────────────────────────────────

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

const api = (method, pathname, data, params) => {
  const cfg = loadCfg()
  if (!cfg) throw new Error('not_configured')
  return request(method, cfg.url, pathname, data, params)
}

// ── Discovery ─────────────────────────────────────────────────────────────────

function scan() {
  const found = []
  return Promise.all(SCAN_PORTS.map(port => new Promise(resolve => {
    const req = http.request({ hostname: 'localhost', port, path: '/ping', method: 'GET' }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks))
          if (Array.isArray(d.instances)) found.push({ url: `http://localhost:${port}`, instances: d.instances })
        } catch {}
        resolve()
      })
    })
    req.on('error', () => resolve())
    req.setTimeout(400, () => { req.destroy(); resolve() })
    req.end()
  }))).then(() => found)
}

// ── HTTP Host ─────────────────────────────────────────────────────────────────

const state = { messages: [], questions: [], context: {}, instances: {} }

function startHost(port) {
  const server = http.createServer((req, res) => {
    const send = (code, data) => {
      const body = JSON.stringify(data ?? { ok: true })
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      const [p, q] = req.url.split('?')
      const qs = new URLSearchParams(q || '')
      const b  = raw ? JSON.parse(raw) : {}

      if (req.method === 'GET') {
        if      (p === '/ping')    send(200, { instances: Object.keys(state.instances) })
        else if (p === '/who')     send(200, state.instances)
        else if (p === '/pending') send(200, state.questions.filter(q => q.answer === null))
        else if (p === '/get') {
          const key = qs.get('key')
          send(200, key ? (state.context[key] ?? {}) : state.context)
        }
        else if (p === '/recv') {
          const fw = qs.get('for')
          const msgs = state.messages.filter(m => !m.read && (!fw || [fw, '*'].includes(m.to)))
          msgs.forEach(m => m.read = true)
          send(200, msgs)
        }
        else if (p === '/log') {
          send(200, { messages: state.messages.slice(-30), questions: state.questions.slice(-30),
                      context: state.context, instances: state.instances })
        }
        else if (p === '/tools.openai') {
          send(200, TOOLS_MAIN.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema }
          })))
        }
        else send(404, { error: 'unknown' })
      }

      else if (req.method === 'POST') {
        if (p === '/heartbeat') {
          state.instances[b.name || '?'] = {
            last_seen:    now(),
            agent_type:   b.agent_type   || null,
            tool:         b.tool         || null,
            capabilities: b.capabilities || [],
          }
          send(200)
        }
        else if (p === '/send') {
          const msg = { id: state.messages.length, from: b.from || '?', to: b.to || '*',
                        content: b.content, ts: now(), read: false }
          state.messages.push(msg)
          send(200, { id: msg.id })
        }
        else if (p === '/ask') {
          const q = { id: state.questions.length, question: b.question, asker: b.from || '?',
                      answer: null, ts: now(), answered_ts: null }
          state.questions.push(q)
          send(200, { id: q.id })
        }
        else if (p === '/answer') {
          const q = state.questions[b.id]
          if (!q) return send(404, { error: 'not found' })
          q.answer = b.answer
          q.answered_ts = now()
          send(200)
        }
        else if (p === '/set') {
          state.context[b.key] = { value: b.value, updated: now() }
          send(200)
        }
        else send(404, { error: 'unknown' })
      }
    })
  })
  server.listen(port, '0.0.0.0')
  return server
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS_SETUP = [{
  name: 'connect',
  description: [
    'CALL THIS FIRST. Sets up your linker connection.',
    '  action="scan"   → find active hosts on this machine',
    '  action="join"   → connect to a host (requires url, name)',
    '  action="host"   → start a host here (requires name)',
    '  action="status" → check current connection state'
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action:     { type: 'string', enum: ['scan', 'join', 'host', 'status'] },
      url:        { type: 'string',  description: 'Host URL (for join)' },
      name:       { type: 'string',  description: 'Your instance name' },
      port:       { type: 'integer', description: 'Port for host mode (default 7700)' },
      agent_type: { type: 'string',  description: 'AI type: claude, cursor, codex, aider, etc.' }
    },
    required: ['action']
  }
}]

const TOOLS_MAIN = [
  { name: 'send',    description: 'Send a message to another instance. Omit "to" to broadcast.',            inputSchema: { type: 'object', properties: { content: { type: 'string' }, to: { type: 'string', description: 'Recipient name (optional)' } }, required: ['content'] } },
  { name: 'recv',    description: 'Read unread messages addressed to this instance.',                        inputSchema: { type: 'object', properties: {} } },
  { name: 'ask',     description: 'Post a question for other instances to answer. Returns a question id.',   inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'answer',  description: 'Answer a pending question by id.',                                        inputSchema: { type: 'object', properties: { id: { type: 'integer' }, answer: { type: 'string' } }, required: ['id', 'answer'] } },
  { name: 'pending', description: 'List unanswered questions from other instances.',                         inputSchema: { type: 'object', properties: {} } },
  { name: 'set',     description: 'Store a value in shared context, readable by all instances.',             inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
  { name: 'get',     description: 'Read shared context. Omit key to get all.',                               inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Optional' } } } },
  { name: 'who',     description: 'List all connected instances.',                                           inputSchema: { type: 'object', properties: {} } },
  { name: 'log',     description: 'Show recent messages, questions, and context.',                           inputSchema: { type: 'object', properties: {} } },
  { name: 'connect', description: 'Manage connection: scan / join / host / status.',                         inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['scan','join','host','status'] }, url: { type: 'string' }, name: { type: 'string' }, port: { type: 'integer' } }, required: ['action'] } },
]

// ── connect handler ───────────────────────────────────────────────────────────

async function handleConnect({ action, url, name, port = DEFAULT_PORT, agent_type }) {
  if (agent_type) { _agentType = agent_type; _agentTool = agent_type }
  if (action === 'status') {
    const cfg = loadCfg()
    if (!cfg) return 'Not connected. Use action="scan" or action="host".'
    try {
      const r      = await request('GET', cfg.url, '/ping')
      const others = r.instances.filter(i => i !== cfg.name)
      let msg = `Connected to ${cfg.url} as '${cfg.name}'\nActive instances: ${JSON.stringify(r.instances)}`
      if (others.length) {
        msg += `\n\n--- COORDINATION ACTIVE (${others.length} other instance(s): ${JSON.stringify(others)}) ---`
        msg += '\nYou MUST follow these rules while other instances are present:'
        msg += '\n  1. Call recv — read any pending messages now.'
        msg += '\n  2. Call pending — answer any open questions you can.'
        msg += '\n  3. Call get (no key) — load shared context before starting work.'
        msg += '\n  4. Before reading large files/dirs, call get — another instance may already have the answer.'
        msg += '\n  5. When you discover facts or decisions, call set(key, value) to share them.'
        msg += '\n  6. When you finish a task, call send to broadcast a summary to all instances.'
        msg += '\n  7. When another instance likely has the answer, call ask instead of guessing.'
        msg += '\n  8. Call pending again after completing each task.'
      }
      return msg
    } catch(e) {
      return `Configured but host unreachable (${loadCfg().url}): ${e.message}`
    }
  }

  if (action === 'scan') {
    const found = await scan()
    if (!found.length) {
      return [
        'No active hosts found on ports 7700–7710.',
        'Options:',
        '  1. Start a host here:   connect(action="host", name="YOUR_NAME")',
        '  2. Enter a remote URL:  connect(action="join", url="http://HOST:PORT", name="YOUR_NAME")'
      ].join('\n')
    }
    const lines = ['Found hosts:']
    found.forEach(h => lines.push(`  ${h.url}  (instances: ${JSON.stringify(h.instances)})`))
    lines.push('\nTo join: connect(action="join", url="<url>", name="YOUR_NAME")')
    return lines.join('\n')
  }

  if (action === 'join') {
    if (!url || !name) return 'Required: url and name.'
    try { await request('GET', url, '/ping') } catch(e) { return `Cannot reach ${url}: ${e.message}` }
    saveCfg(url, name)
    try { await request('POST', url, '/heartbeat', { name, agent_type: _agentType, tool: _agentTool }) } catch {}
    return `Joined ${url} as '${name}'. All tools are now active.`
  }

  if (action === 'host') {
    if (!name) return 'Required: name.'
    const found    = await scan()
    const existing = found.find(h => h.url.includes(`:${port}`))
    if (existing) {
      saveCfg(existing.url, name)
      try { await request('POST', existing.url, '/heartbeat', { name }) } catch {}
      return `Host already running at ${existing.url}. Joined as '${name}'.`
    }
    const child = spawn(process.execPath, [__filename, '_daemon', String(port)], { detached: true, stdio: 'ignore' })
    child.unref()
    try { fs.writeFileSync(PID_FILE, String(child.pid)) } catch {}
    const hostUrl = `http://localhost:${port}`
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200))
      try { await request('GET', hostUrl, '/ping'); break } catch {}
    }
    saveCfg(hostUrl, name)
    try { await request('POST', hostUrl, '/heartbeat', { name, agent_type: _agentType, tool: _agentTool }) } catch {}
    return [
      `Host started on ${hostUrl} (pid ${child.pid}).`,
      `Joined as '${name}'.`,
      `Others join with: connect(action="join", url="${hostUrl}", name="<name>")`
    ].join('\n')
  }

  return `Unknown action: ${action}`
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

async function dispatch(name, args) {
  if (name === 'connect') return handleConnect(args)

  const cfg = loadCfg()
  if (!cfg) return 'Not connected. Call connect(action="scan") to get started.'

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

// ── MCP stdio server ──────────────────────────────────────────────────────────

async function runMcp() {
  const write = obj => process.stdout.write(JSON.stringify(obj) + '\n')
  const ok    = (id, result) => write({ jsonrpc: '2.0', id, result })

  const rl = readline.createInterface({ input: process.stdin, terminal: false })

  for await (const line of rl) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const { method, id, params = {} } = msg

    if (method === 'initialize') {
      const cname = ((params.clientInfo || {}).name || '').toLowerCase()
      _agentTool = (params.clientInfo || {}).name || 'unknown'
      _agentType = cname.includes('cursor')   ? 'cursor'
                 : cname.includes('windsurf') ? 'windsurf'
                 : cname.includes('continue') ? 'continue'
                 : cname.includes('claude')   ? 'claude'
                 : 'unknown'

      const cfg = loadCfg()
      let instructions, status = cfg ? 'connected' : 'setup_required'
      if (!cfg) {
        instructions = 'Linker not configured. Immediately call connect(action="scan") to find active hosts. If none found, start one with connect(action="host", name="<name>").'
      } else {
        let others = []
        try { const r = await request('GET', cfg.url, '/ping'); others = r.instances.filter(i => i !== cfg.name) } catch {}
        instructions = others.length
          ? `Linker connected as '${cfg.name}'. Other instances: ${JSON.stringify(others)}. IMPORTANT: Call connect(action="status") now to load coordination rules.`
          : `Linker connected as '${cfg.name}'. No other instances yet — call who to check later.`
      }
      ok(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} },
               serverInfo: { name: 'linker', version: '1.0.0', status, instructions } })
    }
    else if (method === 'notifications/initialized') { /* no-op */ }
    else if (method === 'tools/list') {
      ok(id, { tools: loadCfg() ? TOOLS_MAIN : TOOLS_SETUP })
    }
    else if (method === 'tools/call') {
      try {
        const text = await dispatch(params.name, params.arguments || {})
        ok(id, { content: [{ type: 'text', text: String(text) }] })
      } catch(e) {
        ok(id, { content: [{ type: 'text', text: e.message }], isError: true })
      }
    }
    else if (id != null) {
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
    }
  }
}

// ── inject ────────────────────────────────────────────────────────────────────

function runInject(targetDir) {
  let rules
  try {
    rules = fs.readFileSync(RULES_FILE, 'utf8')
  } catch {
    console.error(`rules/AGENT.md not found at ${RULES_FILE}`)
    process.exit(1)
  }

  // Files that accept plain-text coordination rules
  const targets = ['.cursorrules', '.windsurfrules', 'AGENT.md']
  const MARKER  = '<!-- linker-rules -->'
  const section = `\n${MARKER}\n# linker coordination rules (auto-generated)\n${rules}\n`

  for (const file of targets) {
    const dest     = path.join(targetDir, file)
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : ''
    if (existing.includes(MARKER)) {
      console.log(`${file}: already up to date`)
      continue
    }
    fs.writeFileSync(dest, existing + section)
    console.log(`Injected linker rules → ${dest}`)
  }

  // Manual steps for formats we can't auto-patch
  const adapterPath = path.relative(targetDir, path.join(__dirname, 'adapters', 'openai.js'))
  console.log(`
Manual setup for other AI tools:

  Aider:
    aider --read AGENT.md

  Continue (config.json):
    add the contents of AGENT.md to "systemMessage" in ~/.continue/config.json

  OpenAI-based agents (Codex CLI, etc.):
    node ${adapterPath} --name YOUR_NAME
    then fetch tools from http://localhost:7720/tools

  File-based agents (no plugin system):
    node ${path.relative(targetDir, path.join(__dirname, 'adapters', 'filewatch.js'))} --name YOUR_NAME
    then read ~/.linker/bus/{context,who,messages,pending}.json as context
`)
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const [,, cmd = 'mcp', ...args] = process.argv

if      (cmd === 'mcp' || cmd === '')  runMcp()
else if (cmd === 'host')               { startHost(parseInt(args[0]) || DEFAULT_PORT); console.log(`Host → http://localhost:${parseInt(args[0]) || DEFAULT_PORT}`) }
else if (cmd === '_daemon')            startHost(parseInt(args[0]) || DEFAULT_PORT)
else if (cmd === 'inject')             runInject(args[0] || process.cwd())
else if (cmd === 'filewatch')          require('./adapters/filewatch').main()
else if (cmd === 'openai')             require('./adapters/openai').main()
else                                   { console.error('Usage: linker-mcp [mcp|host [PORT]|inject [DIR]|filewatch|openai]'); process.exit(1) }
