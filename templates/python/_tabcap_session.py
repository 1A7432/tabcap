"""Load a `tabcap session export --for requests` file and build an httpx client from it.

The file holds LIVE session credentials (cookies, authentication headers, web storage):
keep it out of the repository. Needs only the standard library and httpx, not tabcap.

    from _tabcap_session import client, load
    s = load("session.json")
    with client(s) as c:
        print(c.get("/api/data").status_code)
    token = s["storage"]["localStorage"].get("access_token")

The client does not read http_proxy / https_proxy / NO_PROXY (trust_env=False):
pass proxy=... or set TABCAP_PROXY_URL (replay export-python --proxy-env writes it).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

SCHEMA = "tabcap-session-export/0"


def load(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise ValueError(f"{path}: not a {SCHEMA} file (tabcap session export --for requests)")
    return data


def cookie_jar(data: dict[str, Any]) -> httpx.Cookies:
    jar = httpx.Cookies()
    for c in data.get("cookies", []):
        domain = c["domain"]
        if "." not in domain.lstrip("."):  # http.cookiejar matches localhost as "localhost.local"
            domain += ".local"
        jar.set(c["name"], c["value"], domain=domain, path=c.get("path") or "/")
    return jar


def client(data: dict[str, Any], base_url: str | None = None, proxy: str | None = None, **kwargs: Any) -> httpx.Client:
    """httpx.Client with the session's cookies and headers; base_url defaults to the exported origin.

    Proxy priority: ``proxy`` argument > ``TABCAP_PROXY_URL`` > no proxy. The
    environment's http_proxy / NO_PROXY are ignored (trust_env=False).
    """
    effective_proxy = proxy if proxy is not None else (os.environ.get("TABCAP_PROXY_URL") or None)
    return httpx.Client(
        base_url=base_url or data["origin"],
        cookies=cookie_jar(data),
        headers=dict(data.get("headers", {})),
        proxy=effective_proxy,
        trust_env=False,
        **kwargs,
    )
