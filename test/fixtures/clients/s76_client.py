"""s76 client (docs/05 s76): a scraper with a hard-coded base URL.

Usage: s76_client.py <https base> <mode> [--print-ca-path] [--plain <http base>]

Sends the mode's request sequence with requests (httpx for the first two in
mode httpx). Prints "<status> <sha256 of the body>" per response on stdout;
non-2xx answers do not stop it. A response carrying x-tabcap-record-error
is printed on stderr and ends the run with exit code 3. It reads no tabcap
variable: the proxy and CA come from the standard environment variables.
"""

import hashlib
import os
import sys

import httpx
import requests

USER = "s76"
PASSWORD = "s76-range-password"


def show(status, headers, body):
    err = headers.get("x-tabcap-record-error")
    if err is not None:
        print(f"{status} x-tabcap-record-error: {err}", file=sys.stderr)
        sys.exit(3)
    print(status, hashlib.sha256(body).hexdigest(), flush=True)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    base, mode = args[0], args[1]
    if "--print-ca-path" in sys.argv:
        print("CA", os.environ.get("SSL_CERT_FILE", ""), file=sys.stderr, flush=True)
    if mode == "plain":
        r = requests.get(base + "/s76/plain")
        show(r.status_code, r.headers, r.content)
        return
    login = ("POST", "/s76/login", {"form": {"user": USER, "password": PASSWORD}})
    l1 = ("GET", "/s76/list?page=1", {})
    i1 = ("POST", "/s76/item", {"json": {"id": 1}})
    l2 = ("GET", "/s76/list?page=2", {})
    i2 = ("POST", "/s76/item", {"json": {"id": 2}})
    js = ("GET", "/s76/static.js", {})
    seq = [login, l1, i1, l2, i2]
    if mode == "reorder":
        seq = [login, i1, l2, i2, l1]
    elif mode == "extra":
        seq = seq + [("GET", "/s76/list?page=3", {})]
    elif mode == "missing":
        seq = [login, l1, l2, i2]
    elif mode == "changed":
        seq = [login, l1, i1, ("GET", "/s76/list?page=9", {}), i2]
    elif mode == "noise":
        noisy = []
        for i, x in enumerate(seq):
            if i > 0:
                noisy.append(js)
            noisy.append(x)
        seq = noisy
    elif mode not in ("normal", "httpx"):
        sys.exit(f"unknown mode {mode}")

    session = requests.Session()
    token = None
    with httpx.Client() as hx:
        for n, (method, path, kw) in enumerate(seq):
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            if mode == "httpx" and n < 2:
                r = hx.request(method, base + path, headers=headers, data=kw.get("form"), json=kw.get("json"))
                status, rh, body = r.status_code, r.headers, r.content
            else:
                r = session.request(method, base + path, headers=headers, data=kw.get("form"), json=kw.get("json"))
                status, rh, body = r.status_code, r.headers, r.content
            show(status, rh, body)
            if path == "/s76/login" and status == 200:
                token = r.json()["token"]


if __name__ == "__main__":
    main()
