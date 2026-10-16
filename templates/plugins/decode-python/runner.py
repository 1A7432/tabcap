"""tabcap decode plugin runner (protocol tabcap-decode/1, docs/04 §28).

Reads one JSON request per line on stdin, calls plugin.decode(flow) and
answers one JSON line on stdout. `flow` mirrors the mitmproxy addon shape:
flow.request.url / method / headers / content, flow.response.headers /
content / status_code (bytes for content; flow.response is None when tabcap
asks about a request body). decode() returns bytes / str, or None; a body
assigned to flow.response.content (or .text) the mitmproxy way counts too.
Your print() output goes to stderr, which tabcap drops.
"""

import base64
import json
import sys

import plugin


class Headers(dict):
    """Case-insensitive lookup; repeated headers joined with ", " (mitmproxy style); get_all() lists them."""

    def __init__(self, raw):
        super().__init__({k.lower(): (", ".join(v) if isinstance(v, list) else v) for k, v in (raw or {}).items()})
        self._all = {k.lower(): (v if isinstance(v, list) else [v]) for k, v in (raw or {}).items()}

    def __getitem__(self, k):
        return super().__getitem__(k.lower())

    def get(self, k, default=None):
        return super().get(k.lower(), default)

    def get_all(self, k):
        return list(self._all.get(k.lower(), []))


class Message:
    def __init__(self, headers, content):
        self.headers = Headers(headers)
        self.content = content

    @property
    def text(self):
        return None if self.content is None else self.content.decode("utf-8", "replace")

    @text.setter
    def text(self, value):
        self.content = value.encode("utf-8")


class Flow:
    def __init__(self, msg, body):
        req = msg.get("request") or {}
        self.direction = msg.get("direction")
        self.request = Message(req.get("headers"), body if self.direction == "request" else None)
        self.request.url = self.request.pretty_url = req.get("url", "")
        self.request.method = req.get("method", "")
        self.request.id = req.get("id")
        self.response = None
        if self.direction == "response":
            resp = msg.get("response") or {}
            self.response = Message(resp.get("headers"), body)
            self.response.status_code = resp.get("status")


def guess_mime(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return "application/octet-stream"
    try:
        json.loads(text)
        return "application/json"
    except ValueError:
        return "text/plain"


def answer(msg):
    body = base64.b64decode((msg.get("body") or {}).get("data", ""))
    flow = Flow(msg, body)
    out = plugin.decode(flow)
    if out is None:
        side = flow.response if flow.direction == "response" else flow.request
        out = side.content if side.content != body else None
    if out is None:
        return {"id": msg["id"], "ok": False, "error": "plugin.decode returned None"}
    data = out.encode("utf-8") if isinstance(out, str) else bytes(out)
    mime = getattr(plugin, "MIME", None) or guess_mime(data)
    return {"id": msg["id"], "ok": True, "mime": mime, "body": {"encoding": "base64", "data": base64.b64encode(data).decode("ascii")}}


def main():
    out, sys.stdout = sys.stdout, sys.stderr  # stray prints must not corrupt the protocol
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        try:
            reply = answer(msg)
        except Exception as e:  # one bad body must not end the process
            reply = {"id": msg.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        out.write(json.dumps(reply) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
