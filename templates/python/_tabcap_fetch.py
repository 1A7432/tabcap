"""Route an existing scraper's requests through the tabcap browser (tabcap 0.6-A).

Each call is `POST /fetch` on the running tabcap daemon: the request is sent by the
session's logged-in tab (its cookies, its CORS rules), recorded into the session's
bundle (`tabcap net start` first), paced per host (config.json `fetch`, default 3 s
between requests) and checked against stop rules. Unix socket on macOS / Linux,
loopback TCP + the daemon's bearer token on Windows (both read from daemon.json).

    from _tabcap_fetch import TabcapFetch, Stopped
    tc = TabcapFetch(session="example")
    status, headers, body = tc.fetch("https://example.test/api/list?page=2", stop_on=["json:$.code!=0"])
"""
import base64
import json
import os
import sys
from pathlib import Path

import httpx


class Stopped(Exception):
    """A stop rule fired (fetch.stopped) or the site is stopped (guard.stopped): `tabcap guard resume --site <s>`."""


def _config_dir() -> Path:
    home = os.environ.get("TABCAP_HOME")
    if home:
        return Path(home) / "config"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "tabcap" / "config"
    xdg = os.environ.get("XDG_CONFIG_HOME") if sys.platform.startswith("linux") else None
    return (Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".config") / "tabcap"


class TabcapFetch:
    def __init__(self, session: str = "default", tab: str | None = None, timeout_s: float = 660.0):
        info = json.loads((_config_dir() / "daemon.json").read_text("utf-8"))
        self.session, self.tab = session, tab
        if info.get("listener") == "tcp":
            self.client = httpx.Client(base_url=f"http://{info['host']}:{info['port']}", headers={"authorization": f"Bearer {info['token']}"}, timeout=timeout_s)
        else:
            self.client = httpx.Client(base_url="http://localhost", transport=httpx.HTTPTransport(uds=info["socket"]), timeout=timeout_s)

    def fetch(self, url, method="GET", headers=None, body=None, json_body=None, form=None, stop_on=None, timeout_ms=None):
        """-> (status, headers, bytes). Raises Stopped on fetch.stopped / guard.stopped, RuntimeError on other errors."""
        req = {"session": self.session, "url": url, "method": method, "headers": headers or {}, "rawBody": True}
        for key, value in (("tab", self.tab), ("body", body), ("form", form), ("stopOn", stop_on), ("timeoutMs", timeout_ms)):
            if value is not None:
                req[key] = value
        if json_body is not None:
            req["json"] = json_body
        env = self.client.post("/fetch", json=req).json()
        if not env.get("ok"):
            err = env.get("error") or {}
            if err.get("code") in ("fetch.stopped", "guard.stopped"):
                raise Stopped(f"{err.get('code')}: {err.get('message')}")
            raise RuntimeError(f"{err.get('code')}: {err.get('message')} ({err.get('next')})")
        data = env["data"]
        if "bodyBase64" in data:
            content = base64.b64decode(data["bodyBase64"])
        elif "bodyFile" in data:
            content = Path(data["bodyFile"]).read_bytes()
        else:
            content = data.get("body", "").encode("utf-8")
        return data["status"], data.get("headers", {}), content
