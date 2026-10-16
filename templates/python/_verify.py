# ---------------------------------------------------------------- verify: replay the chain against a base URL
# verify_expected.json (next to this file) lists the chain's steps in recording
# order: the function to call, the recorded argument values, the arguments
# taken from an earlier step's reply, and what the recording answered. Each
# step is compared the way `tabcap replay check` compares: status, selected
# headers (when recorded), body (JSON per path, text / binary by sha256).
# Optional hook: todo_inputs.py next to this file with
#   def fill(function: str, args: dict[str, Any]) -> dict[str, Any]
# returns values for TODO parameters (what the page computes); without it the
# recorded values are used. Secrets are never written: an argument recorded as
# <secret:NAME> is read from the environment variable TABCAP_SECRET_<NAME>
# (letters upper-cased, everything else "_").

import base64 as _base64
import hashlib as _hashlib
import importlib.util as _importlib_util
import os as _os
import re as _re
import sys as _sys
from urllib.parse import urljoin as _urljoin
from urllib.parse import urlsplit as _urlsplit

_HERE = Path(__file__).resolve().parent
_IDENT_KEY = _re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*", _re.ASCII)
_PATH_TOKEN = _re.compile(r'\.([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]', _re.ASCII)
_SECRET_REF = _re.compile(r"^<secret:([^<>]+)>$")


def _flatten(value: Any, path: str = "$", out: dict[str, Any] | None = None) -> dict[str, Any]:
    """Path -> leaf, the same paths as tabcap (`$.a[0]`, `$["odd key"]`); empty containers are leaves."""
    out = {} if out is None else out
    if isinstance(value, list):
        if not value:
            out[path] = []
        for i, v in enumerate(value):
            _flatten(v, f"{path}[{i}]", out)
    elif isinstance(value, dict):
        if not value:
            out[path] = {}
        for k, v in value.items():
            key = f"{path}.{k}" if _IDENT_KEY.fullmatch(k) else f"{path}[{json.dumps(k, ensure_ascii=False)}]"
            _flatten(v, key, out)
    else:
        out[path] = value
    return out


def _same(a: Any, b: Any) -> bool:
    """JSON leaf equality: numbers by value (1 == 1.0), everything else by type and value (true != 1)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def _json_at(doc: Any, path: str) -> Any:
    """The value at a tabcap JSON path (`$.a[0]["b c"]`); KeyError when absent."""
    if not path.startswith("$"):
        raise KeyError(path)
    pos, cur = 1, doc
    while pos < len(path):
        m = _PATH_TOKEN.match(path, pos)
        if m is None:
            raise KeyError(path)
        name, index, quoted = m.group(1), m.group(2), m.group(3)
        if index is not None:
            if not isinstance(cur, list) or int(index) >= len(cur):
                raise KeyError(path)
            cur = cur[int(index)]
        else:
            key = name if name is not None else json.loads(quoted)
            if not isinstance(cur, dict) or key not in cur:
                raise KeyError(path)
            cur = cur[key]
        pos = m.end()
    return cur


def _as_text(v: Any) -> str:
    """A JSON value as the page would put it into a URL or header (JavaScript String())."""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return json.dumps(v)


def _secret_env(name: str) -> str:
    return "TABCAP_SECRET_" + _re.sub(r"[^A-Za-z0-9]", "_", name).upper()


def _norm_header(name: str, value: str, url: str) -> str:
    if name == "location":
        target = _urlsplit(_urljoin(url, value))
        base = _urlsplit(url)
        if (target.scheme, target.netloc) == (base.scheme, base.netloc):
            return target.path + (f"?{target.query}" if target.query else "") + (f"#{target.fragment}" if target.fragment else "")
        return target.geturl()
    if name == "content-type":
        return _re.sub(r"\s*;\s*", ";", value.strip().lower())
    return value.strip()


def _load_hook() -> Any:
    path = _HERE / "todo_inputs.py"
    if not path.exists():
        return None
    spec = _importlib_util.spec_from_file_location("todo_inputs", path)
    if spec is None or spec.loader is None:
        return None
    mod = _importlib_util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, "fill", None)


def _compare(expect: dict[str, Any], resp: httpx.Response, method: str) -> tuple[list[str], list[str]]:
    """Differences and notes, the way `tabcap replay check` compares."""
    diffs: list[str] = []
    notes: list[str] = []
    if resp.status_code != expect["status"]:
        diffs.append(f"status {expect['status']} -> {resp.status_code}")
    url = str(resp.request.url)
    for name, rec in expect["headers"].items():
        got = resp.headers.get(name)
        if got is None or _norm_header(name, got, url) != rec:
            diffs.append(f"{name}: {rec} -> {got if got is not None else '(absent)'}")
    body = expect["body"]
    kind = body["kind"]
    if kind == "json":
        try:
            got_doc = json.loads(resp.content.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            diffs.append(f"body: the recording is JSON, the answer is not ({len(resp.content)} bytes)")
            return diffs, notes
        got = _flatten(got_doc)
        rec = {p: v for p, v in body["fields"]}
        missing = [p for p in rec if p not in got]
        changed = [p for p in rec if p in got and not _same(rec[p], got[p])]
        extra = [p for p in got if p not in rec]
        if missing or changed or extra:
            shown = [f"{p} missing" for p in missing] + [f"{p} changed" for p in changed] + [f"{p} extra" for p in extra]
            diffs.append(f"body {len(shown)} field(s): {', '.join(shown[:3])}{', …' if len(shown) > 3 else ''}")
    elif kind in ("text", "binary"):
        got_sha = _hashlib.sha256(resp.content).hexdigest()
        if got_sha != body["sha256"]:
            diffs.append(f"body {kind} {body['size']} -> {len(resp.content)} bytes, sha256 differs")
    elif kind == "empty":
        if resp.content and method.upper() != "HEAD":
            diffs.append(f"body: recorded empty, got {len(resp.content)} bytes")
    else:
        notes.append(f"body not compared ({body.get('reason', 'not recorded')})")
    return diffs, notes


def _arg_value(v: Any) -> Any:
    if isinstance(v, dict) and set(v) == {"$bytes_b64"}:
        return _base64.b64decode(v["$bytes_b64"])
    return v


def _run_step(step: dict[str, Any], session: Session, base_url: str, replies: dict[str, httpx.Response], hook: Any) -> tuple[str, str, str]:
    """(result, status, detail) of one step."""
    if step.get("skip"):
        return "fail", "-", f"not replayable here: {step['skip']}"
    fn = globals().get(step["function"])
    if not callable(fn):
        return "fail", "-", f"no function {step['function']} in client.py"
    args = {k: _arg_value(v) for k, v in step["args"].items()}
    notes: list[str] = []
    for k, d in step["derived"].items():
        src = replies.get(d["from"])
        if src is None:
            return "fail", "-", f"{k}: step {d['from']} gave no reply"
        try:
            v = _json_at(src.json(), d["path"])
        except (KeyError, ValueError) as e:
            return "fail", "-", f"{k}: the reply of {d['from']} has no {d['path']} ({e})"
        args[k] = _as_text(v) if d["as"] == "text" else v
    if hook is not None:
        filled = hook(step["function"], dict(args)) or {}
        args.update(filled)
        if filled:
            notes.append(f"todo_inputs.fill: {', '.join(sorted(filled))}")
    for k, v in list(args.items()):
        m = _SECRET_REF.match(v) if isinstance(v, str) else None
        if m is not None:
            env = _secret_env(m.group(1))
            if env not in _os.environ:
                return "fail", "-", f"secret {k} not given: set {env}"
            args[k] = _os.environ[env]
    try:
        reply = fn(session, base_url=base_url, **args)
    except NotImplementedError as e:
        return "fail", "-", str(e)
    except httpx.HTTPError as e:
        return "error", "-", f"{type(e).__name__}: {e}"
    replies[step["request"]] = reply.response
    diffs, more = _compare(step["expect"], reply.response, step["method"])
    status = f"{step['expect']['status']}->{reply.response.status_code}"
    return ("fail" if diffs else "pass"), status, "; ".join(diffs + notes + more)


def verify(base_url: str | None = None, *, expected: str | Path | None = None, storage_state: str | Path | None = None) -> int:
    """Replay the chain against `base_url` (e.g. `tabcap replay serve`), print a per-step table; 0 when every step passes."""
    if not base_url:
        print("verify needs a base URL: uv run client.py verify --base-url http://127.0.0.1:4500 (or TABCAP_REPLAY)", file=_sys.stderr)
        return 2
    spec = json.loads(Path(expected or (_HERE / "verify_expected.json")).read_text("utf-8"))
    hook = _load_hook()
    replies: dict[str, httpx.Response] = {}
    rows: list[list[str]] = []
    session = Session.from_storage_state(storage_state) if storage_state else Session()
    try:
        for i, step in enumerate(spec["steps"], 1):
            result, status, detail = _run_step(step, session, base_url.rstrip("/"), replies, hook)
            rows.append([str(i), step["request"], step.get("function") or "-", status, result, detail])
    finally:
        session.close()
    head = ["step", "request", "function", "status", "result"]
    widths = [max(len(head[c]), *(len(r[c]) for r in rows)) if rows else len(head[c]) for c in range(5)]
    print("  ".join(h.ljust(w) for h, w in zip(head, widths)).rstrip())
    for r in rows:
        print(("  ".join(c.ljust(w) for c, w in zip(r[:5], widths)) + (f"  {r[5]}" if r[5] else "")).rstrip())
    failed = sum(1 for r in rows if r[4] != "pass")
    print(f"verify: {len(rows)} step(s), {len(rows) - failed} pass, {failed} fail (target {spec['target']}, bundle {spec['bundle']})")
    return 0 if failed == 0 else 1
