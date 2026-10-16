# ---------------------------------------------------------------- wire-report: what this client sends on the wire
# `tabcap wire probe --client <this directory>` starts a local echo, runs
#   uv run client.py wire-report --url https://localhost:<port>/client --ca <tabcap wire ca-path> --out <file>
# and compares the echo's report (TLS ClientHello, HTTP/2 settings, header
# order) with the browser baseline. Diagnostic only: it shows which layer
# differs on a local echo, not why a site answered the way it did.

import sys as _wire_sys


def wire_report(url: str, *, ca: str | Path, out: str | Path) -> int:
    """One GET to a tabcap wire echo (`tabcap wire probe` runs this): the client exactly as generated
    (`Session()`: its HTTP version, timeouts, redirects), verifying the echo with its CA (verify=<ca>:
    httpx builds the Session's SSL context from SSL_CERT_FILE); saves the echo's JSON report to `out`.
    The echo only listens on 127.0.0.1; this sends nothing anywhere else."""
    os.environ["SSL_CERT_FILE"] = str(ca)
    os.environ.pop("SSL_CERT_DIR", None)
    with Session() as session:
        response = session.client.get(url)
    Path(out).write_text(response.text, "utf-8")
    if response.status_code != 200:
        print(f"wire-report: the echo answered {response.status_code}", file=_wire_sys.stderr)
        return 1
    return 0
