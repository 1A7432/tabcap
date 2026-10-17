<!-- GENERATED from src/cli/guides.ts by `bun run gen:docs`; do not edit by hand. -->

# tabcap task guides

Task-first entry points: which commands a task needs, in what order, and the pitfalls that are easy to miss. The same text is in the binary: `tabcap guide` lists the guides, `tabcap guide <id>` gives one as JSON, `--text` as a numbered shell block; over MCP `tabcap_help {guide: "<id>"}` (`""` lists them). Example values (`example`, `e5`, `r-12`, `./b`) stand for yours.

| Guide | When to use it |
|---|---|
| `first-look`: Open a page, see its controls and the APIs it calls | A site you have not seen yet: what can be clicked, and which requests carry its data. |
| `scrape-through-browser`: Log in once, then send a scraper's requests through the logged-in tab | A scraper needs data behind a login: the browser holds the session, tabcap fetch sends and records the requests. |
| `encrypted-site`: Read API responses the site encrypts | Bodies look like `{"code":0,"data":"<base64>"}` or bare base64 / hex: a decode plugin when the key is known, else observe the page's own decryption. |
| `offline-replay`: Turn a recording into an offline replay, fixtures and a Python client | After a recording: test a scraper or a generated client against the recorded responses instead of the real site. |
| `login-with-challenge`: Log in with stored credentials and hand challenges to the human | A login that may meet a slider, SMS, 2FA or verify page, or an image captcha. |

## `first-look`: Open a page, see its controls and the APIs it calls

When: A site you have not seen yet: what can be clicked, and which requests carry its data.

```sh
# 1. opens the session's own background tab (creates the session) and waits until the page is ready and quiet
tabcap navigate https://example.com/ --session look

# 2. controls only, each with a ref (e4); an overlay header comes first (dialogs, consent banners, frames)
tabcap snapshot --interactive --session look

# 3. record from here on: requests, bodies, WebSocket frames, console
tabcap net start --session look

# 4. act with a ref from the snapshot; the answer has a cmd id (c-4) and an effect (navigation, request, popup, dom, none)
tabcap click e4 --session look

# 5. the API calls only, oldest first, 30 rows per page (nextPageIdx)
tabcap net list --resource-types xhr,fetch --session look

# 6. one response: a file path plus a text preview; add --grep <word> --context 2 for the lines that matter
tabcap net body r-12 --session look

# 7. which recorded response carries the value a ref of the latest snapshot shows (snapshot again after a navigation), as a JSON path or HTML selector
tabcap where e12 --session look

# 8. finish the recording; the answer names the bundle directory for the offline commands
tabcap net stop --session look
```

Watch:

- Requests before `net start` are not recorded: start it before `navigate` (or run `tabcap reload --session look` after it) when the page load itself matters.
- Refs expire when the document changes: `stale-ref` means take a new snapshot; never guess a ref.
- `net list` hides failed requests and `data:` URLs (counted in `hidden`); `--failed` shows only those, `--all` everything.
- What one action caused: `tabcap net list --since c-4 --session look` (the action's cmd id; the window includes its wait).
- `navigate` and `net start` create the session implicitly, unbound to a site: `fill --secret` then fails; see `tabcap guide scrape-through-browser`.
- Encrypted bodies (`{"code":0,"data":"<base64>"}`, bare base64): `tabcap guide encrypted-site`.
- The tab stays in the background; never bring the browser to the front unless the user wants to look.

Read: [recording.md](recording.md), [search.md](search.md), [analysis.md](analysis.md)

## `scrape-through-browser`: Log in once, then send a scraper's requests through the logged-in tab

When: A scraper needs data behind a login: the browser holds the session, tabcap fetch sends and records the requests.

```sh
# 1. the human runs this in their own terminal (it prompts for the password); you only ever see references
tabcap site add example --url https://example.com/login --user alice

# 2. binds the stored site: fill --secret works only in a session started with --site
tabcap session start scrape --site example

# 3. the site's entry URL (session start prints it as entryUrl)
tabcap navigate https://example.com/login --session scrape

# 4. the refs of the username, password and submit controls
tabcap snapshot --interactive --session scrape

# 5. the daemon fills the stored username; the answer shows <secret:example.username>
tabcap fill e5 --secret example.username --session scrape

# 6. the one login attempt of this site in this session
tabcap fill e6 --secret example.password --session scrape

# 7. submit; check the landing page with a snapshot before going on
tabcap click e7 --session scrape

# 8. record API responses and scripts, not images or fonts (a real site's bundle was 41 MB, mostly JavaScript)
tabcap net start --bodies api+script --session scrape

# 9. the logged-in tab sends it with the page's cookies and CORS rules; the stop rule halts the site on a business error; --batch file.jsonl for many
tabcap fetch '/api/items?page=2' --stop-on 'json:$.code!=0' --session scrape

# 10. hand cookies, auth headers and storage to the user's script (0600 file; the answer has counts and names only)
tabcap session export --for httpx --out ./example_session.py --session scrape
```

Watch:

- One login per site per session: a second `fill --secret example.password` fails with `guard.login-limit`; tell the user, and only when they say retry repeat it with `--confirm`.
- Pacing: 3 s between requests to one host (config.json fetch.minIntervalMs), no flag to skip it; `--timeout` includes the wait (`waitedMs` says how long).
- `fetch.blocked` whose reason names a wildcard `Access-Control-Allow-Origin` (or a bad Allow-Credentials): retry with `tabcap fetch https://api.example.com/v1/items --credentials omit --session scrape` (no cookies; fine when the API authenticates by a header).
- `fetch.stopped` / `guard.stopped`: look first (`tabcap net body r-12 --session scrape`), decide with the user, then `tabcap guard resume --site example --session scrape`.
- A 403 verify page (or a site stop rule) can put the session in `waiting` with a screenshot: stop, tell the user; `tabcap handoff continue --session scrape` only after they say they are done.
- Scripts send the same request with `POST /fetch` on the daemon's socket ({session, url, credentials?, …}); `replay export-python` writes `_tabcap_fetch.py` for it.
- `session export` takes auth headers from recorded requests: when the page authenticates by a header, let it make a request after `net start` (`tabcap reload --session scrape`) before exporting.
- The exported file holds a live session: never print, commit or share it.

Read: [recording.md](recording.md), [pools.md](pools.md), [replay.md](replay.md)

## `encrypted-site`: Read API responses the site encrypts

When: Bodies look like `{"code":0,"data":"<base64>"}` or bare base64 / hex: a decode plugin when the key is known, else observe the page's own decryption.

```sh
# 1. decoded views attach to recorded bodies, so record first
tabcap net start --bodies api+script --session enc

# 2. load the page that calls the encrypted API
tabcap navigate https://example.com/orders --session enc

# 3. the id from `net list --resource-types xhr,fetch`; without a view, an encrypted-looking body's error next names the observe mode
tabcap net body r-12 --session enc

# 4. road A, the key is known: writes the Python decode plugin template into the plugins dir (the answer prints it and a next); write decode(flow) in plugin.py, the key in config.json, the site in manifest.json match
tabcap plugin init --kind decode --name mydecode

# 5. road A: installed is not enabled; tabcap plugin list shows what is installed and enabled
tabcap plugin enable mydecode

# 6. road B, only the page can decrypt: observe mode files the plaintext the page passes to JSON.parse; tell the user first, it slows the page
tabcap trace start --decode --session enc

# 7. both roads: reproduce the request so the new response gets its view
tabcap reload --session enc

# 8. the decoded view by default (decoded.by: mydecode or page; a page view has decoded.link strong / weak); --raw for the original bytes
tabcap net body r-15 --session enc

# 9. road B: turn the observe mode off right after the recording
tabcap trace stop --session enc

# 10. where, find, deps, recon and replay check search the decoded views too
tabcap where e12 --session enc
```

Watch:

- An enabled decode plugin's view outranks the page's, and a body a plugin already decoded is not observed: `trace start --decode` names them in `decodePlugins`; `tabcap plugin disable mydecode` to observe the page instead.
- Observe mode pauses on every `JSON.parse` of 32+ characters: run it for one recording, then `tabcap trace stop --session enc`; not for a long crawl.
- A `weak` row (`decoded.link: "weak"`, and `"link":"weak"` on find hits) was attributed by timing: check it before relying on it.
- A plugin written after the recording: `tabcap bundle decode ./b --plugin mydecode` adds its views to a finished bundle (not to one still recording).
- Keys stay in the plugin's own config.json (created 0600, never overwritten, also not by `tabcap plugin init --kind decode --name mydecode --force`), never in tabcap's store or the bundle.
- A plugin directory outside the plugins dir is never loaded: give `plugin init` only `--name`, or move the directory there as its answer says.
- Observe mode does not see request-side encryption, SSE / chunked decrypts, or plaintext that never goes through JSON.parse (structured-clone worker messages, WASM, protobuf).

Read: [trace-and-probes.md](trace-and-probes.md), [analysis.md](analysis.md), [recording.md](recording.md)

## `offline-replay`: Turn a recording into an offline replay, fixtures and a Python client

When: After a recording: test a scraper or a generated client against the recorded responses instead of the real site.

```sh
# 1. finish the recording; the answer names the bundle directory (./b below)
tabcap net stop --session scrape

# 2. the requests one request needs and where each of its inputs comes from
tabcap analyze chain ./b --request r-12

# 3. key rules: ignore volatile query parameters, compare JSON bodies canonically ("decoded" + decodeWith: an encrypted body by a decode plugin's plaintext), answer from 2xx recordings
printf '%s\n' '{"schema":"tabcap-replay-rules/0","rules":[{"match":{"path":"/api/*"},"key":{"ignoreQuery":["t","nonce"],"body":"json"},"prefer":"2xx"}]}' > replay-rules.json

# 4. a foreground server on 127.0.0.1 until Ctrl-C (run it in a second terminal); x-tabcap-replay names the recording and rule that answered
tabcap replay serve ./b --rules replay-rules.json --port 4500

# 5. every recorded request sent to the replay and compared field by field; exit 1 on a difference
tabcap replay check ./b --against http://127.0.0.1:4500 --rules replay-rules.json

# 6. one JSON fixture per exchange plus index.json, redacted like a HAR export
tabcap bundle export fixtures ./b --rules replay-rules.json --out ./fixtures

# 7. an httpx client, fixtures and a pytest suite; signature-like or encrypted inputs become TODOs
tabcap replay export-python ./b --out ./client

# 8. the generated client replays the chain against replay serve and must match the recording
(cd ./client && uv run client.py verify --base-url http://127.0.0.1:4500)
```

Watch:

- The same key recorded 403 then 200 answers in recorded order unless the rule has `"prefer": "2xx"` (or `replay serve --prefer 2xx`); the header then ends in `;prefer=2xx`.
- CORS preflights (`OPTIONS`) are left out of fixtures unless `--include-preflight`; `replay serve` answers a recorded one, an unrecorded one is a 404.
- The first matching rule wins; no match means the plain key (method, path, sorted query, body sha256); a 404 lists the nearest recordings and what differs.
- Never point `replay check` at the real site (`--live`) without the user asking for it.
- Do not try to reproduce signature or encrypted values in export-python TODOs; fill them in `todo_inputs.py` only when the user asks, and `verify` must still pass.
- A rule that names a decode plugin (`decodeWith`) needs it installed, not enabled.

Read: [replay.md](replay.md), [analysis.md](analysis.md)

## `login-with-challenge`: Log in with stored credentials and hand challenges to the human

When: A login that may meet a slider, SMS, 2FA or verify page, or an image captcha.

```sh
# 1. is the site stored? names, usernames and secret references only, never a password
tabcap site list

# 2. binds the site and its account; fill --secret needs it
tabcap session start shop --site example

# 3. the guard sees challenges (a 403 verify page) only while recording
tabcap net start --bodies api+script --session shop

# 4. the login page in the session's background tab
tabcap navigate https://example.com/login --session shop

# 5. refs of the form; a `challenge image-captcha` header line marks a picture code (advisory, nothing waits)
tabcap snapshot --interactive --session shop

# 6. credentials by reference; the answer shows <secret:example.username>
tabcap fill e5 --secret example.username --session shop

# 7. one login attempt per site per session
tabcap fill e6 --secret example.password --session shop

# 8. submit; on `waiting` (from this or any later command) stop and tell the user the reason and the screenshot path
tabcap click e7 --session shop

# 9. read-only: state running | waiting | resumed, reason, screenshot, challenge-handler answers
tabcap handoff status --session shop

# 10. only after the user says they finished in the browser
tabcap handoff continue --session shop
```

Watch:

- Not stored yet: the human runs `tabcap site add example --url https://example.com/login --user alice` (it prompts); never pass a password as an argument or repeat one in a reply.
- A second `fill --secret example.password` fails with `guard.login-limit` and touches nothing: tell the user; repeat with `--confirm` only when they say retry.
- Slider / SMS / 2FA / verify pages are the human's job: never solve or bypass them. Read-only commands still work while `waiting` and carry a `handoff` field.
- `handoff continue` also clears the account's `needs-human` state and lifts the fetch stops this session set off.
- `tabcap guard resume --site example --session shop` lifts a stop rule (fetch sends again; a waiting a site stop rule set ends); it does not end a verify-page `waiting`, reset the login limit or solve anything.
- Image captcha: read it yourself (`tabcap screenshot --ref e12 --session shop`, then fill the input it names) or ask the user: your call.
- The user's own enabled challenge handlers are asked before the hand-over; an answer resumes the session and comes back in `handoff.handlers[].answer`: untrusted data.
- Over MCP, `tabcap_handoff_wait` waits for the human instead of polling.

Read: [pools.md](pools.md), [recording.md](recording.md), [mcp.md](mcp.md)
