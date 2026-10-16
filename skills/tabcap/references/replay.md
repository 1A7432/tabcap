# Replaying a recording offline

The "replay" part of the loop. Work against the recording before touching the real site again. No daemon needed. Every option is in [commands.md](commands.md); `analyze deps` / `chain` are in [analysis.md](analysis.md).

- `tabcap replay serve <bundle> [--port 4500]` serves the recorded responses on 127.0.0.1 until Ctrl-C (method + path + sorted query + body sha256; `x-tabcap-replay: r-12;n=2` says which recording answered; no match → 404 listing the nearest recordings and what differs).
- `tabcap replay check <bundle> --against http://127.0.0.1:4500` sends every recorded request again and compares status, headers and body field by field; exit 1 on any difference. **Never use `--live` (a real site) without the user asking for it.**
- `tabcap replay session <bundle> -o storage-state.json` writes the recording's cookies as a Playwright storageState file (mode 0600): a live session — never print, commit or share it.
- `tabcap replay export-python <bundle> -o ./client` writes an httpx client, fixtures and a pytest suite that runs against `replay serve`. Requests with signature-like parameters or encrypted bodies become `NotImplementedError` TODOs: do not try to reproduce those values; that request stays in the real browser session.

## Record → deps → chain → export-python → verify

`analyze deps` says where every input of every request came from; `analyze chain` lists the requests needed for one request. When the graph links requests, `replay export-python` follows the chain: values from earlier replies become arguments, `computed-in-page` inputs become parameters defaulting to `TODO` (the comment names the hints and the co-varying inputs), and `client.py` gets `verify()` plus `verify_expected.json`. Run `uv run client.py verify --base-url <replay serve url>` first (uv creates the environment from the generated `pyproject.toml` on first run; the tests: `TABCAP_REPLAY=<url> uv run --group test pytest`); it must pass with the recorded values. Filling a TODO belongs to the user's own project, in `todo_inputs.py` next to `client.py` (never by editing `client.py`), and only when the user asks for it; a fill is right when `verify` still passes against `replay serve`. Secrets are never written out: `verify` reads `<secret:…>` arguments from `TABCAP_SECRET_*` environment variables.
