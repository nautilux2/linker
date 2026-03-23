"""
linker_mcp — bridge for Claude Code instances

Modes
  python3 -m linker_mcp          MCP stdio server (used by Claude Code)
  python3 -m linker_mcp host     Start HTTP host interactively
  python3 -m linker_mcp _daemon  Internal: daemonised host (do not call directly)
"""

import sys, json, os, threading, subprocess
from datetime import datetime
from urllib.parse import parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError
from http.server import HTTPServer, BaseHTTPRequestHandler

CONFIG      = os.path.expanduser("~/.linker")
HOST_PID    = os.path.expanduser("~/.linker_host_pid")
SCAN_PORTS  = range(7700, 7711)
DEFAULT_PORT = 7700

# ── Utilities ─────────────────────────────────────────────────────────────────

def _now():   return datetime.now().strftime("%H:%M:%S")
def _die(m):  print(m, file=sys.stderr); sys.exit(1)

def _load_cfg():
    if os.path.exists(CONFIG):
        return json.load(open(CONFIG))
    return None

def _save_cfg(url, name):
    json.dump({"url": url, "name": name}, open(CONFIG, "w"))

def _api(method, path, data=None, params=None, url=None):
    cfg = _load_cfg()
    if cfg is None:
        raise RuntimeError("not_configured")
    base = (url or cfg["url"]).rstrip("/")
    target = base + path
    if params:
        target += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    try:
        if method == "GET":
            req = Request(target)
        else:
            raw = json.dumps(data or {}).encode()
            req = Request(target, data=raw, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except URLError as e:
        raise RuntimeError(f"connection_error: {e}")

def _heartbeat():
    cfg = _load_cfg()
    if not cfg: return
    try:
        raw = json.dumps({"name": cfg["name"]}).encode()
        req = Request(cfg["url"].rstrip("/") + "/heartbeat", data=raw,
                      headers={"Content-Type": "application/json"})
        urlopen(req, timeout=2)
    except: pass

# ── Discovery ─────────────────────────────────────────────────────────────────

def _scan():
    """Return list of found hosts [{url, instances}]."""
    found = []
    for port in SCAN_PORTS:
        url = f"http://localhost:{port}"
        try:
            with urlopen(Request(f"{url}/ping"), timeout=0.4) as r:
                data = json.loads(r.read())
                if "instances" in data:
                    found.append({"url": url, "instances": data["instances"]})
        except: pass
    return found

# ── HTTP host server ──────────────────────────────────────────────────────────

_state = {
    "messages":  [],
    "questions": [],
    "context":   {},
    "instances": {},
}
_lock = threading.Lock()

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def _reply(self, code, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(raw))
        self.end_headers()
        self.wfile.write(raw)

    def _ok(self, data=None): self._reply(200, data if data is not None else {"ok": True})

    def do_GET(self):
        p, _, q = self.path.partition("?")
        qs = parse_qs(q)
        g  = lambda k: qs.get(k, [None])[0]

        if p == "/ping":
            with _lock: self._ok({"instances": list(_state["instances"])})
        elif p == "/recv":
            fw = g("for")
            with _lock:
                out = [m for m in _state["messages"]
                       if not m["read"] and (fw is None or m["to"] in (fw, "*"))]
                for m in out: m["read"] = True
            self._ok(out)
        elif p == "/pending":
            with _lock: self._ok([q for q in _state["questions"] if q["answer"] is None])
        elif p == "/get":
            key = g("key")
            with _lock:
                self._ok(_state["context"].get(key) if key else dict(_state["context"]))
        elif p == "/log":
            with _lock:
                self._ok({"messages":  _state["messages"][-30:],
                           "questions": _state["questions"][-30:],
                           "context":   _state["context"],
                           "instances": _state["instances"]})
        elif p == "/who":
            with _lock: self._ok(dict(_state["instances"]))
        else:
            self._reply(404, {"error": "unknown"})

    def do_POST(self):
        p, b = self.path, self._body()
        if p == "/heartbeat":
            with _lock: _state["instances"][b.get("name","?")] = {"last_seen": _now()}
            self._ok()
        elif p == "/send":
            with _lock:
                msg = {"id": len(_state["messages"]), "from": b.get("from","?"),
                       "to": b.get("to","*"), "content": b["content"],
                       "ts": _now(), "read": False}
                _state["messages"].append(msg)
            self._ok({"id": msg["id"]})
        elif p == "/ask":
            with _lock:
                q = {"id": len(_state["questions"]), "question": b["question"],
                     "asker": b.get("from","?"), "answer": None,
                     "ts": _now(), "answered_ts": None}
                _state["questions"].append(q)
            self._ok({"id": q["id"]})
        elif p == "/answer":
            qid = b.get("id")
            with _lock:
                if qid is None or qid >= len(_state["questions"]):
                    return self._reply(404, {"error": "not found"})
                q = _state["questions"][qid]
                q["answer"], q["answered_ts"] = b["answer"], _now()
            self._ok()
        elif p == "/set":
            with _lock:
                _state["context"][b["key"]] = {"value": b["value"], "updated": _now()}
            self._ok()
        else:
            self._reply(404, {"error": "unknown"})

def _run_host(port):
    HTTPServer.allow_reuse_address = True
    srv = HTTPServer(("0.0.0.0", port), _Handler)
    srv.serve_forever()

# ── MCP server ────────────────────────────────────────────────────────────────

_TOOLS_SETUP = [
    {
        "name": "connect",
        "description": (
            "CALL THIS FIRST. Sets up or checks your linker connection.\n"
            "- action='scan'  → find active hosts on this machine\n"
            "- action='join'  → connect to a host (requires url and name)\n"
            "- action='host'  → start a new host on this machine (requires name)\n"
            "- action='status'→ check current connection state"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["scan", "join", "host", "status"]},
                "url":    {"type": "string", "description": "Host URL (for join)"},
                "name":   {"type": "string", "description": "Your instance name"},
                "port":   {"type": "integer", "description": "Port for host mode (default 7700)"}
            },
            "required": ["action"]
        }
    }
]

_TOOLS_MAIN = [
    {
        "name": "send",
        "description": "Send a message to another instance. Omit 'to' to broadcast.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string"},
                "to":      {"type": "string", "description": "Recipient name (optional)"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "recv",
        "description": "Read unread messages sent to this instance.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "ask",
        "description": "Post a question for other instances to answer. Returns a question id.",
        "inputSchema": {
            "type": "object",
            "properties": {"question": {"type": "string"}},
            "required": ["question"]
        }
    },
    {
        "name": "answer",
        "description": "Answer a pending question by its id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id":     {"type": "integer"},
                "answer": {"type": "string"}
            },
            "required": ["id", "answer"]
        }
    },
    {
        "name": "pending",
        "description": "List unanswered questions from other instances.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "set",
        "description": "Store a value in shared context, readable by all instances.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key":   {"type": "string"},
                "value": {"type": "string"}
            },
            "required": ["key", "value"]
        }
    },
    {
        "name": "get",
        "description": "Read shared context. Omit key to get all.",
        "inputSchema": {
            "type": "object",
            "properties": {"key": {"type": "string", "description": "Optional"}}
        }
    },
    {
        "name": "who",
        "description": "List all connected instances.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "log",
        "description": "Show recent messages, questions, and shared context.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "connect",
        "description": "Manage connection: scan/join/host/status.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["scan", "join", "host", "status"]},
                "url":    {"type": "string"},
                "name":   {"type": "string"},
                "port":   {"type": "integer"}
            },
            "required": ["action"]
        }
    },
]

def _handle_connect(args):
    action = args.get("action", "status")

    if action == "status":
        cfg = _load_cfg()
        if cfg is None:
            return "Not connected. Use action='scan' to find hosts, or action='host' to start one."
        try:
            r = _api("GET", "/ping")
            instances = r.get("instances", [])
            others = [i for i in instances if i != cfg["name"]]
            msg = (f"Connected to {cfg['url']} as '{cfg['name']}'\n"
                   f"Active instances: {instances}")
            if others:
                msg += (
                    f"\n\n--- COORDINATION ACTIVE ({len(others)} other instance(s): {others}) ---"
                    "\nYou MUST follow these rules while other instances are present:"
                    "\n  1. Call recv now to read any pending messages."
                    "\n  2. Call pending now and answer any questions you can."
                    "\n  3. Call get (no key) to load shared context before starting work."
                    "\n  4. Before reading large files or dirs, call get — another instance may have the answer."
                    "\n  5. When you discover facts/decisions, call set(key, value) to share them."
                    "\n  6. When you finish a task, call send to broadcast a summary."
                    "\n  7. When you need input another instance likely has, call ask instead of guessing."
                    "\n  8. Check pending again after completing each task."
                )
            return msg
        except RuntimeError as e:
            return f"Configured but host unreachable ({cfg['url']}): {e}"

    elif action == "scan":
        found = _scan()
        if not found:
            return ("No active hosts found on ports 7700–7710.\n"
                    "Options:\n"
                    "  1. Start a host here:  connect(action='host', name='YOUR_NAME')\n"
                    "  2. Enter a remote URL: connect(action='join', url='http://HOST:PORT', name='YOUR_NAME')")
        lines = ["Found hosts:"]
        for h in found:
            lines.append(f"  {h['url']}  (instances: {h['instances']})")
        lines.append("\nTo join: connect(action='join', url='<url>', name='YOUR_NAME')")
        return "\n".join(lines)

    elif action == "join":
        url  = args.get("url")
        name = args.get("name")
        if not url or not name:
            return "Required: url and name. Example: connect(action='join', url='http://localhost:7700', name='alice')"
        try:
            with urlopen(Request(url.rstrip("/") + "/ping"), timeout=3): pass
        except Exception as e:
            return f"Cannot reach {url}: {e}"
        _save_cfg(url, name)
        _heartbeat()
        return f"Joined {url} as '{name}'. All tools are now active."

    elif action == "host":
        name = args.get("name")
        port = int(args.get("port", DEFAULT_PORT))
        if not name:
            return "Required: name. Example: connect(action='host', name='alice')"
        # Check if port is already in use (maybe already running)
        existing = _scan()
        for h in existing:
            if str(port) in h["url"]:
                _save_cfg(h["url"], name)
                _heartbeat()
                return f"Host already running at {h['url']}. Joined as '{name}'."
        # Spawn daemon
        daemon_cmd = [sys.executable, "-m", "linker_mcp", "_daemon", str(port)]
        proc = subprocess.Popen(
            daemon_cmd,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            start_new_session=True
        )
        open(HOST_PID, "w").write(str(proc.pid))
        # Wait for it to come up
        import time
        url = f"http://localhost:{port}"
        for _ in range(20):
            time.sleep(0.2)
            try:
                with urlopen(Request(f"{url}/ping"), timeout=0.5): pass
                break
            except: pass
        else:
            return f"Host started (pid {proc.pid}) but did not respond on port {port}. Check manually."
        _save_cfg(url, name)
        _heartbeat()
        return (f"Host started on {url} (pid {proc.pid}).\n"
                f"Joined as '{name}'.\n"
                f"Others can join with: connect(action='join', url='{url}', name='<their_name>')")

    return f"Unknown action: {action}"


def _dispatch(name, args, cfg):
    if name == "connect":
        return _handle_connect(args)

    if cfg is None:
        return "Not connected. Call connect(action='scan') to get started."

    if name == "send":
        data = {"content": args["content"], "from": cfg["name"]}
        if "to" in args: data["to"] = args["to"]
        r = _api("POST", "/send", data)
        return f"Sent (id={r['id']})"

    if name == "recv":
        msgs = _api("GET", "/recv", params={"for": cfg["name"]})
        return json.dumps(msgs, indent=2) if msgs else "(no new messages)"

    if name == "ask":
        r = _api("POST", "/ask", {"question": args["question"], "from": cfg["name"]})
        return f"Question posted (id={r['id']})"

    if name == "answer":
        _api("POST", "/answer", {"id": args["id"], "answer": args["answer"]})
        return "Answered"

    if name == "pending":
        items = _api("GET", "/pending")
        return json.dumps(items, indent=2) if items else "(no pending questions)"

    if name == "set":
        _api("POST", "/set", {"key": args["key"], "value": args["value"]})
        return f"Set '{args['key']}'"

    if name == "get":
        params = {"key": args["key"]} if "key" in args else {}
        return json.dumps(_api("GET", "/get", params=params), indent=2)

    if name == "who":
        return json.dumps(_api("GET", "/who"), indent=2)

    if name == "log":
        return json.dumps(_api("GET", "/log"), indent=2)

    raise ValueError(f"Unknown tool: {name}")


def run_mcp():
    cfg = _load_cfg()
    tools = _TOOLS_MAIN if cfg else _TOOLS_SETUP

    def write(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def ok(mid, result):
        write({"jsonrpc": "2.0", "id": mid, "result": result})

    initialized = False

    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except: continue

        method = msg.get("method", "")
        mid    = msg.get("id")

        if method == "initialize":
            cfg = _load_cfg()  # re-read in case changed
            status = "connected" if cfg else "setup_required"
            if status == "setup_required":
                instructions = (
                    "Linker is not configured. Immediately call connect(action='scan') "
                    "to find active hosts. If none found, offer to start one with "
                    "connect(action='host', name='<name>') or accept a URL from the user."
                )
            else:
                try:
                    r = _api("GET", "/ping")
                    others = [i for i in r.get("instances", []) if i != cfg["name"]]
                except Exception:
                    others = []
                if others:
                    instructions = (
                        f"Linker connected as '{cfg['name']}'. "
                        f"Other active instances: {others}. "
                        "IMPORTANT: Call connect(action='status') now to load coordination rules. "
                        "You must coordinate with other instances: recv for messages, "
                        "pending for questions, get for shared context — before starting work."
                    )
                else:
                    instructions = (
                        f"Linker connected as '{cfg['name']}' (no other instances yet). "
                        "Call who to check if others join later."
                    )
            ok(mid, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "linker",
                    "version": "1.0.0",
                    "status": status,
                    "instructions": instructions,
                }
            })

        elif method == "notifications/initialized":
            initialized = True

        elif method == "tools/list":
            cfg = _load_cfg()
            ok(mid, {"tools": _TOOLS_MAIN if cfg else _TOOLS_SETUP})

        elif method == "tools/call":
            name = msg["params"]["name"]
            args = msg["params"].get("arguments", {})
            cfg  = _load_cfg()
            try:
                result = _dispatch(name, args, cfg)
                ok(mid, {"content": [{"type": "text", "text": result}]})
            except Exception as e:
                ok(mid, {"content": [{"type": "text", "text": str(e)}], "isError": True})

        elif mid is not None:
            write({"jsonrpc": "2.0", "id": mid,
                   "error": {"code": -32601, "message": "Method not found"}})

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    cmd  = args[0] if args else "mcp"

    if cmd == "mcp" or cmd == "":
        run_mcp()

    elif cmd == "host":
        port = int(args[1]) if len(args) > 1 else DEFAULT_PORT
        import socket
        try:    ip = socket.gethostbyname(socket.gethostname())
        except: ip = "YOUR_IP"
        print(f"Linker host → http://localhost:{port}")
        print(f"Remote      → http://{ip}:{port}")
        print(f"Others join → connect(action='join', url='http://localhost:{port}', name='NAME')")
        _run_host(port)

    elif cmd == "_daemon":
        # Daemonised host started by connect(action='host')
        port = int(args[1]) if len(args) > 1 else DEFAULT_PORT
        _run_host(port)

    else:
        _die(f"Usage: python3 -m linker_mcp [mcp|host [PORT]]")


if __name__ == "__main__":
    main()
