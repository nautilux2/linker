#!/usr/bin/env python3
"""linker — group bridge for Claude Code instances

Setup:
  1. One machine:  python3 linker.py host [--port 7700]
  2. Each machine: python3 linker.py join http://HOST:PORT --as NAME
  3. Each machine: python3 linker.py install
  4. Restart Claude Code → tools appear automatically

CLI:  send | recv | ask | answer | pending | set | get | who | log
"""

import sys, json, os, threading
from datetime import datetime
from urllib.parse import parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError
from http.server import HTTPServer, BaseHTTPRequestHandler

CONFIG_FILE = os.path.expanduser("~/.linker")

# ── Shared helpers ────────────────────────────────────────────────────────────

def _now(): return datetime.now().strftime("%H:%M:%S")
def _die(msg): print(msg, file=sys.stderr); sys.exit(1)

def _load_config():
    if not os.path.exists(CONFIG_FILE):
        _die("Not connected. Run: python3 linker.py join <url> --as NAME")
    return json.load(open(CONFIG_FILE))

def _api(method, path, data=None, params=None):
    cfg = _load_config()
    url = cfg["url"].rstrip("/") + path
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    try:
        if method == "GET":
            req = Request(url)
        else:
            raw = json.dumps(data or {}).encode()
            req = Request(url, data=raw, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except URLError as e:
        _die(f"Connection error: {e}")

def _flag(args, flag, default=None):
    return args[args.index(flag) + 1] if flag in args else default

def _print(data, empty="(none)"):
    if isinstance(data, list):
        if not data: print(empty); return
        for item in data: print(json.dumps(item, ensure_ascii=False))
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False))

# ── Host state ────────────────────────────────────────────────────────────────

_state = {
    "messages":  [],  # {id, from, to, content, ts, read}
    "questions": [],  # {id, question, asker, answer, ts, answered_ts}
    "context":   {},  # key → {value, updated}
    "instances": {},  # name → {last_seen}
}
_lock = threading.Lock()

# ── HTTP server (host mode) ───────────────────────────────────────────────────

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

    def _ok(self, data=None):
        self._reply(200, data if data is not None else {"ok": True})

    def do_GET(self):
        p, _, q = self.path.partition("?")
        qs = parse_qs(q)
        get = lambda k: qs.get(k, [None])[0]

        if p == "/ping":
            with _lock: self._ok({"instances": list(_state["instances"])})

        elif p == "/recv":
            for_who = get("for")
            with _lock:
                out = [m for m in _state["messages"]
                       if not m["read"] and (for_who is None or m["to"] in (for_who, "*"))]
                for m in out: m["read"] = True
            self._ok(out)

        elif p == "/pending":
            with _lock:
                self._ok([q for q in _state["questions"] if q["answer"] is None])

        elif p == "/get":
            key = get("key")
            with _lock:
                self._ok(_state["context"].get(key) if key else dict(_state["context"]))

        elif p == "/log":
            with _lock:
                self._ok({
                    "messages":  _state["messages"][-30:],
                    "questions": _state["questions"][-30:],
                    "context":   _state["context"],
                    "instances": _state["instances"],
                })

        elif p == "/who":
            with _lock: self._ok(dict(_state["instances"]))

        else:
            self._reply(404, {"error": "unknown route"})

    def do_POST(self):
        p, b = self.path, self._body()

        if p == "/heartbeat":
            with _lock: _state["instances"][b.get("name", "?")] = {"last_seen": _now()}
            self._ok()

        elif p == "/send":
            with _lock:
                msg = {"id": len(_state["messages"]), "from": b.get("from", "?"),
                       "to": b.get("to", "*"), "content": b["content"],
                       "ts": _now(), "read": False}
                _state["messages"].append(msg)
            self._ok({"id": msg["id"]})

        elif p == "/ask":
            with _lock:
                q = {"id": len(_state["questions"]), "question": b["question"],
                     "asker": b.get("from", "?"), "answer": None,
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
            self._reply(404, {"error": "unknown route"})

# ── MCP stdio server ──────────────────────────────────────────────────────────

_MCP_TOOLS = [
    {
        "name": "send",
        "description": "Send a message to another Claude Code instance. Omit 'to' to broadcast.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Message content"},
                "to":      {"type": "string", "description": "Recipient instance name (optional)"}
            },
            "required": ["content"]
        }
    },
    {
        "name": "recv",
        "description": "Receive unread messages addressed to this instance.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "ask",
        "description": "Post a question for other Claude Code instances to answer. Returns a question ID.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question to ask"}
            },
            "required": ["question"]
        }
    },
    {
        "name": "answer",
        "description": "Answer a pending question by its ID.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id":     {"type": "integer", "description": "Question ID from pending"},
                "answer": {"type": "string",  "description": "Your answer"}
            },
            "required": ["id", "answer"]
        }
    },
    {
        "name": "pending",
        "description": "List all unanswered questions waiting for a response.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "set",
        "description": "Store a value in the shared context, readable by all instances.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key":   {"type": "string", "description": "Context key"},
                "value": {"type": "string", "description": "Value to store"}
            },
            "required": ["key", "value"]
        }
    },
    {
        "name": "get",
        "description": "Read shared context. Omit key to get everything.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Context key (optional)"}
            }
        }
    },
    {
        "name": "who",
        "description": "List all Claude Code instances connected to this session.",
        "inputSchema": {"type": "object", "properties": {}}
    },
    {
        "name": "log",
        "description": "Show recent messages, questions, context, and connected instances.",
        "inputSchema": {"type": "object", "properties": {}}
    },
]

def _mcp_dispatch(name, args):
    cfg = _load_config()

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
    def write(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def ok(mid, result):
        write({"jsonrpc": "2.0", "id": mid, "result": result})

    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except: continue

        method = msg.get("method", "")
        mid    = msg.get("id")

        if method == "initialize":
            ok(mid, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "linker", "version": "1.0"}
            })

        elif method == "notifications/initialized":
            pass  # no response for notifications

        elif method == "tools/list":
            ok(mid, {"tools": _MCP_TOOLS})

        elif method == "tools/call":
            name = msg["params"]["name"]
            args = msg["params"].get("arguments", {})
            try:
                result = _mcp_dispatch(name, args)
                ok(mid, {"content": [{"type": "text", "text": result}]})
            except Exception as e:
                ok(mid, {"content": [{"type": "text", "text": str(e)}], "isError": True})

        elif mid is not None:
            write({"jsonrpc": "2.0", "id": mid,
                   "error": {"code": -32601, "message": "Method not found"}})

# ── Install ───────────────────────────────────────────────────────────────────

def run_install(scope):
    script = os.path.abspath(__file__)
    if scope == "project":
        settings_path = os.path.join(os.getcwd(), ".claude", "settings.json")
    else:
        settings_path = os.path.expanduser("~/.claude/settings.json")

    os.makedirs(os.path.dirname(settings_path), exist_ok=True)

    try:
        settings = json.load(open(settings_path)) if os.path.exists(settings_path) else {}
    except Exception:
        settings = {}

    settings.setdefault("mcpServers", {})["linker"] = {
        "command": sys.executable,
        "args": [script, "mcp"]
    }

    json.dump(settings, open(settings_path, "w"), indent=2)
    print(f"Installed → {settings_path}")
    print(f"Script    → {script}")
    print(f"Restart Claude Code to activate.")
    print(f"Then run:   python3 {script} join <url> --as NAME")

# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if not args: print(__doc__); return
    cmd, rest = args[0], args[1:]

    if cmd == "host":
        port = int(_flag(rest, "--port", 7700))
        HTTPServer.allow_reuse_address = True
        srv = HTTPServer(("0.0.0.0", port), _Handler)
        import socket
        try: ip = socket.gethostbyname(socket.gethostname())
        except: ip = "YOUR_IP"
        print(f"Host → http://localhost:{port}  (remote: http://{ip}:{port})")
        print(f"Join → python3 linker.py join http://localhost:{port} --as NAME")
        srv.serve_forever()

    elif cmd == "join":
        if not rest: _die("Usage: join <url> --as NAME")
        url  = rest[0]
        name = _flag(rest, "--as", os.environ.get("USER", "instance"))
        try:
            with urlopen(Request(url.rstrip("/") + "/ping"), timeout=3): pass
        except Exception as e:
            _die(f"Cannot reach {url}: {e}")
        json.dump({"url": url, "name": name}, open(CONFIG_FILE, "w"))
        # register immediately
        try:
            raw = json.dumps({"name": name}).encode()
            req = Request(url.rstrip("/") + "/heartbeat", data=raw,
                          headers={"Content-Type": "application/json"})
            urlopen(req, timeout=3)
        except: pass
        print(f"Joined {url} as '{name}'")

    elif cmd == "install":
        scope = "project" if "--project" in rest else "user"
        run_install(scope)

    elif cmd == "mcp":
        run_mcp()

    elif cmd == "who":
        _print(_api("GET", "/who"), "(none)")

    elif cmd == "send":
        if not rest: _die("Usage: send <message> [--to NAME]")
        cfg  = _load_config()
        to   = _flag(rest, "--to")
        skip = set()
        for i, r in enumerate(rest):
            if r.startswith("--"): skip.update([i, i + 1])
        content = " ".join(r for i, r in enumerate(rest) if i not in skip)
        data = {"content": content, "from": cfg["name"]}
        if to: data["to"] = to
        r = _api("POST", "/send", data)
        print(f"Sent (id={r['id']})")

    elif cmd == "recv":
        cfg = _load_config()
        _print(_api("GET", "/recv", params={"for": cfg["name"]}), "(no new messages)")

    elif cmd == "ask":
        if not rest: _die("Usage: ask <question>")
        cfg = _load_config()
        r = _api("POST", "/ask", {"question": " ".join(rest), "from": cfg["name"]})
        print(f"Question posted (id={r['id']})")

    elif cmd == "answer":
        if len(rest) < 2: _die("Usage: answer <id> <answer>")
        _api("POST", "/answer", {"id": int(rest[0]), "answer": " ".join(rest[1:])})
        print("Answered")

    elif cmd == "pending":
        _print(_api("GET", "/pending"), "(none)")

    elif cmd == "set":
        if len(rest) < 2: _die("Usage: set <key> <value>")
        _api("POST", "/set", {"key": rest[0], "value": " ".join(rest[1:])})
        print(f"Set '{rest[0]}'")

    elif cmd == "get":
        params = {"key": rest[0]} if rest else {}
        _print(_api("GET", "/get", params=params))

    elif cmd == "log":
        _print(_api("GET", "/log"))

    elif cmd == "ping":
        cfg = _load_config()
        _api("POST", "/heartbeat", {"name": cfg["name"]})
        print("Pong")

    else:
        _die(f"Unknown: {cmd}\n"
             "Commands: host join install mcp  |  send recv ask answer pending set get who log ping")

if __name__ == "__main__":
    main()
