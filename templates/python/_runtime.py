from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generic, NotRequired, TypedDict, TypeVar, cast
from urllib.parse import quote_plus, urlencode

import httpx

T = TypeVar("T")


class Session:
    """Cookies of a recorded session (Playwright storageState file) plus overrides for other session values.

    The client never reads ``http_proxy`` / ``https_proxy`` / ``NO_PROXY``
    (``trust_env=False``): a proxy comes from ``proxy=`` or from
    ``TABCAP_PROXY_URL`` only (``replay export-python --proxy-env`` writes it).
    """

    def __init__(
        self,
        cookies: list[dict[str, Any]] | None = None,
        values: dict[str, str] | None = None,
        timeout: float = 30.0,
        proxy: str | None = None,
    ) -> None:
        self.values: dict[str, str] = dict(values or {})
        # Priority: proxy argument > TABCAP_PROXY_URL > no proxy. The environment's
        # http_proxy / NO_PROXY are deliberately ignored (httpx's NO_PROXY parser
        # chokes on Clash-style "[::1]" and would fail Client construction).
        effective_proxy = proxy if proxy is not None else (os.environ.get("TABCAP_PROXY_URL") or None)
        self.client = httpx.Client(timeout=timeout, follow_redirects=False, http2=True, proxy=effective_proxy, trust_env=False)
        for c in cookies or []:
            if isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("value"), str):
                self.client.cookies.set(c["name"], c["value"], domain=str(c.get("domain", "")), path=str(c.get("path", "/")))

    @classmethod
    def from_storage_state(cls, path: str | Path, values: dict[str, str] | None = None, proxy: str | None = None) -> Session:
        data = json.loads(Path(path).read_text("utf-8"))
        cookies = data.get("cookies", []) if isinstance(data, dict) else []
        return cls(cookies if isinstance(cookies, list) else [], values, proxy=proxy)

    def cookie(self, name: str, default: str) -> str:
        """The stored cookie `name` (any domain), else the recorded value."""
        for c in self.client.cookies.jar:
            if c.name == name and c.value is not None:
                return c.value
        return default

    def value(self, key: str, default: str) -> str:
        """A session value that is not a cookie (`<location>:<name>`), else the recorded value."""
        return self.values.get(key, default)

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> Session:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class Reply(Generic[T]):
    """An httpx response; `.json()` is typed with the shape inferred from the recording."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    @property
    def status(self) -> int:
        return self.response.status_code

    def json(self) -> T:
        return cast(T, self.response.json())


def _ts(kind: str, digits: int = 0) -> str:
    """A timestamp in the recorded format: epoch ms / s (optional fraction) or ISO 8601 UTC."""
    now = time.time()
    if kind == "ms":
        return str(int(now * 1000)) if digits == 0 else f"{now * 1000:.{digits}f}"
    if kind == "s":
        return str(int(now)) if digits == 0 else f"{now:.{digits}f}"
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ts_num(kind: str) -> int:
    now = time.time()
    return int(now * 1000) if kind == "ms" else int(now)


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _form_bytes(pairs: list[tuple[str, str | None]]) -> bytes:
    """application/x-www-form-urlencoded the way browsers serialize URLSearchParams."""
    enc = lambda s: quote_plus(s, safe="*").replace("~", "%7E")  # noqa: E731
    return "&".join(f"{enc(k)}={enc(v)}" for k, v in pairs if v is not None).encode("ascii")


def _send(session: Session, method: str, url: str, params: list[tuple[str, str | None]], headers: list[tuple[str, str | None]], content: bytes | None) -> httpx.Response:
    q = [(k, v) for k, v in params if v is not None]
    h = [(k, v) for k, v in headers if v is not None]
    if "?" in url and q:
        # the URL carries value-less keys as recorded (`?queryList`); httpx would rewrite them to `key=`
        url, q = url + "&" + urlencode(q), []
    return session.client.request(method, url, params=q or None, headers=h, content=content)
