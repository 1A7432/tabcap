<!-- GENERATED from src/cli/commands.ts by `bun run gen:docs`; do not edit by hand. -->

# tabcap command reference

Every command prints one JSON envelope on stdout: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","next"}}`. Browser commands also take `--session <name>` (else `$TABCAP_SESSION`, else `default`) and most take `--timeout <ms>` (default 30000; `wait` / `net wait` 10000); they are left out below. `tabcap <command> --help` prints the same as one section here; `tabcap schema --json` is the machine-readable form.

## Output flags (every command)

The CLI applies these to the envelope's `data` after the command ran, in this order: select, grep, fields, then the output budget. The envelope then also carries `filter: {select, grep, fields, matches, total, capped}` (and `selected` with `--select`). Above `TABCAP_OUTPUT_LIMIT` bytes (default 16384; `0` turns it off) `data` becomes `{summary, file, bytes, truncated: true}`: the whole `data` is in `file` (the recording's `exports/<command>-<seq>.json`, else `<cache>/outputs/<stamp>-<command>.json`). `net list`, `console list` and `snapshot` page or cut on their own and are exempt.

| Option | Default | Meaning |
|---|---|---|
| `--select <path>` |  | keep only this part of data: a JSON path (docs/04 §43; $ optional): names, [n], [*], .*, ["quoted name"] (e.g. requests[*].url) |
| `--grep <regex>` |  | keep array elements whose JSON matches this regex (u flag, ≤ 256 chars); long text fields: matching lines with line numbers (not on snapshot, net body) |
| `--context <n>` | `0` | with --grep on text: lines around each match (max 20) (not on snapshot, net body, net grep) |
| `--max-matches <n>` | `50` | with --grep: keep at most this many matches (max 1000) (not on snapshot, net body, net grep) |
| `--fields <a,b,c>` |  | project each array element to these keys |
| `--full` |  | print data whole even above TABCAP_OUTPUT_LIMIT (default 16384 bytes; above it data becomes {summary, file, bytes, truncated}) (not on screenshot) |

## Start here

### `tabcap guide`

task recipes, start here: no id lists them (id, title, when to use it); with an id, the commands in order with why, the pitfalls (implicit state too) and the references to read. Guides: first-look, scrape-through-browser, encrypted-site, offline-replay, login-with-challenge

```
tabcap guide [<id>] [--text]
```

Example: `tabcap guide scrape-through-browser --text`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print the list, or the guide's steps as a numbered shell block with `# why` comments, instead of JSON |

## Setup and lifecycle

### `tabcap setup`

download Chrome for Testing (Stable) into the cache and record it in config.json

```
tabcap setup [--executable-path path] [--platform platform]
```

Example: `tabcap setup`

| Option | Default | Meaning |
|---|---|---|
| `--executable-path <path>` |  | use this Chrome for Testing binary instead of downloading |
| `--platform <platform>` |  | mac-arm64 \| mac-x64 \| linux64 \| win64 (default: this machine) |

### `tabcap update`

update tabcap itself: one request to the npm registry, only when run. An npm install runs `npm install -g tabcap@<latest>` with the npm that owns it, a Homebrew install `brew upgrade tabcap` with its brew (then restart a running daemon); a release package or source build is never replaced, the answer gives the release page. $TABCAP_NPM_REGISTRY overrides the registry URL, $TABCAP_NPM the npm executable, $TABCAP_BREW the brew executable

```
tabcap update [--check]
```

Example: `tabcap update --check`

| Option | Default | Meaning |
|---|---|---|
| `--check` |  | only compare the running version with the latest release; run nothing |

### `tabcap daemon start`

start the background daemon

```
tabcap daemon start
```

Example: `tabcap daemon start`

### `tabcap daemon stop`

stop the daemon (closes the browser, finishes recordings)

```
tabcap daemon stop
```

Example: `tabcap daemon stop`

### `tabcap daemon status`

daemon and browser status, open recordings

```
tabcap daemon status
```

Example: `tabcap daemon status`

### `tabcap browser start`

launch the dedicated Chrome for Testing (own profile, CDP over a pipe); the answer gives the full command line (args), the custom args in it (extraArgs, dropArgs) and warnings naming switches that weaken the browser's isolation

```
tabcap browser start [--proxy mode] [--webdriver mode] [--foreground] [--executable-path path] [--chrome-arg switch]... [--drop-chrome-arg switch]...
```

Example: `tabcap browser start --proxy none --chrome-arg=--lang=en-US`

| Option | Default | Meaning |
|---|---|---|
| `--proxy <mode>` |  | system (default) \| none (block everything but 127.0.0.1/localhost) \| <url> (scheme://host:port, loopback goes through the proxy too; no user:pass@: a proxy with a password goes into the store with `tabcap proxy add`) |
| `--webdriver <mode>` |  | hidden (default: navigator.webdriver reads false, a launch switch, no page script) \| visible (Chrome's own value); default from config.json webdriver |
| `--foreground` |  | open new tabs as the active tab of the window (still never steals the macOS foreground) |
| `--executable-path <path>` |  | Chrome for Testing binary (else $TABCAP_CHROME, config.json, cache) |
| `--chrome-arg <switch>` |  | add a Chrome switch (--name or --name=value; write --chrome-arg=--name=value or --chrome-arg --name=value), after config.json chrome.args: list switches (--enable-features, --disable-features, the blink pair, --load-extension) merge into tabcap's own, others replace tabcap's switch of the same name; refused: --user-data-dir, --remote-debugging-pipe, proxy switches unless --proxy system (repeatable) |
| `--drop-chrome-arg <switch>` |  | remove one of tabcap's default switches (--name removes it, --disable-features=A,B removes those items), after config.json chrome.dropArgs; drops that match nothing are listed in dropArgsUnmatched; --user-data-dir and --remote-debugging-pipe / -port cannot be dropped, proxy switches only with --proxy system (repeatable) |

### `tabcap browser stop`

close the browser (recordings are finished first)

```
tabcap browser stop
```

Example: `tabcap browser stop`

### `tabcap browser status`

browser status

```
tabcap browser status
```

Example: `tabcap browser status`

### `tabcap mcp`

serve tabcap as MCP tools over stdin / stdout (JSON-RPC 2.0, one message per line, logs on stderr, exits when stdin closes): a core set of browser and net tools plus tabcap_run / tabcap_help for every other command; `waiting` comes back at once, tabcap_handoff_wait waits for the human

```
tabcap mcp [--print-config host] [--all-tools]
```

Example: `tabcap mcp --print-config claude-code`

| Option | Default | Meaning |
|---|---|---|
| `--print-config <host>` |  | print where and how to register tabcap mcp in one host instead of serving: claude-code \| cursor \| codex \| gemini-cli \| windsurf \| claude-desktop |
| `--all-tools` |  | one tool per command with its full help (about 99 tools, ~88 KB of definitions in the model's context) instead of the core set |

## Sites, sessions and tabs

### `tabcap site add`

add a site and its account to the local store (state.db, 0600): the password is typed at a prompt (recommended: by the human) or piped with --password-stdin (an agent the user handed it to), never passed as an argument; afterwards only the references are used

```
tabcap site add <name> --url <entry> --user <username> [--domains a,b] [--notes text] [--password-stdin]
```

Example: `tabcap site add example --url https://example.com/login --user alice`

| Option | Default | Meaning |
|---|---|---|
| `--url <entry>` |  | entry URL of the site (required) |
| `--user <username>` |  | account username (not a secret: shown in listings) (required) |
| `--domains <a,b>` |  | comma list of the site's domains (default: the entry URL's host); subdomains count, a leading dot is dropped |
| `--notes <text>` |  | free-text note |
| `--password-stdin` |  | read the password from stdin (else an interactive prompt; never an argument) |

### `tabcap site list`

stored sites: name, entry URL, domains, usernames and the secret references to use (never secret values)

```
tabcap site list
```

Example: `tabcap site list`

### `tabcap site remove`

delete a site with its accounts and guard counters from the store

```
tabcap site remove <name>
```

Example: `tabcap site remove example`

### `tabcap session start`

create a session (navigate also creates it); --site binds a stored site → entryUrl, the secret references, account and proxy (names only)

```
tabcap session start <name> [--site site] [--account user|auto]
```

Example: `tabcap session start example --site example`

| Option | Default | Meaning |
|---|---|---|
| `--site <site>` |  | bind a stored site: its account is used by fill --secret and recorded in the bundle manifest |
| `--account <user\|auto>` |  | which of the site's accounts (default: its first); auto = pick by config.json pool.strategy (fixed / round-robin / lru); every account session gets its own browser context (through the account's proxy when it is bound to one) |

### `tabcap session stop`

close the session's own tabs (never tabs it did not open) and finish its recording

```
tabcap session stop <name>
```

Example: `tabcap session stop example`

### `tabcap session list`

list sessions

```
tabcap session list
```

Example: `tabcap session list`

### `tabcap session export`

hand the logged-in tab's session to a script: its cookies, the authentication headers the page sent (sensitive or page-set headers of the latest recorded request to the origin's host; needs net start) and its localStorage / sessionStorage (values over 64 KB skipped), written to a 0600 file; prints the path, counts and header names, never a value

```
tabcap session export [--session name] [--timeout ms] [--tab t2] --for <requests|httpx|playwright> --out <file> [--origin url|host]
```

Example: `tabcap session export --for httpx --out ./example_session.py`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--for <requests\|httpx\|playwright>` |  | requests (JSON, schema tabcap-session-export/0) \| httpx (a Python module <file>.py with cookies, headers, storage and client()) \| playwright (storageState: cookies and localStorage only) (required) |
| `--out <file>` |  | file to write, mode 0600 (new directories 0700); --for httpx adds .py when missing (required) |
| `--origin <url\|host>` |  | export this origin instead of the tab's page, e.g. the API origin a single-page app calls (a URL, or a host: the scheme its recorded requests used, else https): the headers of the latest recorded request to it from any tab, its cookies next to the page's. Without it, when the page's origin got no auth-looking header, the recorded host with the most of them gives the headers (source.headers.auto) |

### `tabcap tab list`

list the session's tabs (never other tabs): tab id, url, title, owned, popup opener, current

```
tabcap tab list [--session name]
```

Example: `tabcap tab list`

### `tabcap tab select`

make one of the session's tabs (e.g. a popup) its current tab for later commands; never brings it to the front unless --bring-to-front

```
tabcap tab select <tab> [--session name] [--bring-to-front]
```

Example: `tabcap tab select t2`

| Option | Default | Meaning |
|---|---|---|
| `--bring-to-front` |  | also bring the tab and Chrome to the front (focus ladder level 3: Page.bringToFront takes the macOS foreground; only when the human is to look at it) |

### `tabcap tab new`

open a new tab in the session, load a URL and make it the current tab (same as navigate --new-tab; the answer has status too)

```
tabcap tab new <url> [--session name] [--timeout ms] [--background] [--no-wait]
```

Example: `tabcap tab new http://127.0.0.1:8080/`

| Option | Default | Meaning |
|---|---|---|
| `--background` |  | open in the background even when the browser was started with --foreground (background is the default otherwise) |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |

### `tabcap tab close`

close one of the session's tabs; closing the current tab switches to the most recently current owned tab (else the last opened), answered as current (null when none is left)

```
tabcap tab close <tab> [--session name]
```

Example: `tabcap tab close t2`

## Navigation and page reading

### `tabcap navigate`

load a URL in the session's tab (opens a background tab if needed), wait until ready and the DOM is quiet → tab, url, title, readyState, nav, status (the HTTP status of the main document the tab shows, the last hop of a redirect; null for about:blank and error pages)

```
tabcap navigate <url> [--session name] [--timeout ms] [--tab t2] [--new-tab] [--no-wait]
```

Example: `tabcap navigate http://127.0.0.1:8080/ --session example`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--new-tab` |  | open a new background tab (it becomes the session's current tab) |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |

### `tabcap go`

history back / forward, waits until ready and the DOM is quiet; the answer has status of the document it lands on

```
tabcap go back|forward [--session name] [--timeout ms] [--tab t2] [--no-wait]
```

Example: `tabcap go back`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |

### `tabcap reload`

reload the current tab, waits until ready and the DOM is quiet; the answer has status of the reloaded document

```
tabcap reload [--session name] [--timeout ms] [--tab t2] [--ignore-cache] [--no-wait]
```

Example: `tabcap reload --ignore-cache`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--ignore-cache` |  | reload without the HTTP cache (like Shift+reload) |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |

### `tabcap snapshot`

accessibility tree as indented text, one element per line: role "name" [ref] flags (e.g. `- button "Save" [e12] disabled`); refs are for click / fill and expire when the document changes; starts with the overlay header (overlays / detected / frames, counts toward --max-chars); child frames are header lines until --frames / --frame

```
tabcap snapshot [--session name] [--timeout ms] [--tab t2] [--interactive] [--verbose] [--max-chars n] [--file-path path] [--frames] [--frame f2/f1] [--grep regex] [--css selector] [--xpath expr] [--ref e12] [--depth n] [--context n] [--max-matches n]
```

Example: `tabcap snapshot --interactive`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--interactive` |  | only controls (buttons, links, inputs …) and their ancestors |
| `--verbose` |  | the full tree: keep unnamed wrappers and text that repeats its parent's name, add descriptions and capability flags (focusable, expandable …) |
| `--max-chars <n>` | `12000` | truncate the tree text (the note says so and how to get more) |
| `--file-path <path>` |  | write the tree text to this file and return its path instead of the tree |
| `--frames` |  | also expand every child frame (iframes, frameset frames, cross-origin too); their refs carry the frame path, e.g. f2/f1/e7; --max-chars applies per frame |
| `--frame <f2/f1>` |  | expand only this frame and the frames inside it (the root document is listed in the header only) |
| `--grep <regex>` |  | only the lines whose role, name, value, states or description match this regex (JavaScript, u flag, at most 256 chars), each with its ancestor lines; refs are the full snapshot's |
| `--css <selector>` |  | only the lines of the elements this CSS selector matches in each shown document (read in an isolated world), with ancestors; elements without a line print as `(no accessible node) <tag#id.class> [e12]` with a DOM-backed ref that click / fill / hover / upload / html / screenshot --ref take |
| `--xpath <expr>` |  | as --css, with an XPath 1.0 expression |
| `--ref <e12>` |  | only the subtree under this element (its own frame for a frame ref) |
| `--depth <n>` |  | with --ref: levels below the element (default: all); hidden deeper lines are counted |
| `--context <n>` | `0` | with --grep / --css / --xpath: also this many sibling lines before and after each match (max 20) |
| `--max-matches <n>` | `50` | with --grep / --css / --xpath: matches shown over all documents (max 1000); search.matches counts them all |

### `tabcap outline`

page map head: tab line, overlays (dialogs, masks, iframe layers, timeout prompts, consent banners, with close-button refs; also inside frames), detected (adapters, with confidence), frames (path, url, same-origin / cross-origin, depth, title), popups; read-only, never closes anything

```
tabcap outline [--session name] [--timeout ms] [--tab t2] [--max-chars n]
```

Example: `tabcap outline`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--max-chars <n>` | `6000` | truncate the outline text |

### `tabcap find`

search the accessibility tree (name, value, description) of the page and every child frame; up to 20 hits with refs (frame hits carry `frame` and frame-path refs), clickable ones first

```
tabcap find <text> [--session name] [--timeout ms] [--tab t2]
```

Example: `tabcap find Add to cart`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |

### `tabcap wait`

wait for one condition on the current tab; returns what matched, or error timeout naming what is still outstanding

```
tabcap wait [--session name] [--timeout ms] [--tab t2] [--text text]... [--selector css] [--url s] [--idle [ms]] [--fn js]
```

Example: `tabcap wait --text 'Order placed' --text 'Payment failed' --timeout 20000`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--text <text>` |  | visible text appears in the page or any of its frames (polled every 100 ms); repeat it to wait for any of several texts (repeatable) |
| `--selector <css>` |  | a CSS selector matches an element (polled) |
| `--url <s>` |  | the tab's URL contains this substring (navigation events) |
| `--idle [ms]` | `500` | no request in flight for N ms |
| `--fn <js>` |  | a JavaScript expression becomes truthy (polled; promises are awaited) |

## Input

### `tabcap click`

click an element by ref (default: DOM el.click(), eventShape incomplete), then wait for a navigation it starts and for the DOM to settle; fails with `covered` when an overlay is in front (its close-button refs are in the error; tabcap never closes it)

```
tabcap click <ref> [--session name] [--timeout ms] [--tab t2] [--trusted] [--dbl-click] [--no-wait] [--snapshot]
```

Example: `tabcap click e12`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--trusted` |  | trusted input via focus emulation: mouse path to the target, press, 50–140 ms, release (all events isTrusted); a tab not confirmed painted falls back to the DOM click (degraded: not-painted); fails honestly if not delivered, never retries |
| `--dbl-click` |  | double click (DOM: two clicks and a dblclick event; --trusted: two presses, Chrome fires dblclick) |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |
| `--snapshot` |  | also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait |

### `tabcap hover`

move the mouse over an element by ref (trusted input via focus emulation: a mouse path ending on its centre; menus and tooltips open as for a real pointer); needs a painted tab

```
tabcap hover <ref> [--session name] [--timeout ms] [--tab t2] [--no-wait] [--snapshot]
```

Example: `tabcap hover e4`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |
| `--snapshot` |  | also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait |

### `tabcap fill`

set a text field's value, React-safe (password values are masked everywhere); --secret fills from the store, one password fill per site per session (guard.login-limit)

```
tabcap fill <ref> [<text>] [--session name] [--timeout ms] [--tab t2] [--trusted] [--secret site.field] [--confirm] [--no-wait] [--snapshot]
```

Example: `tabcap fill e7 --secret example.password`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--trusted` |  | focus emulation + Input.insertText |
| `--secret <site.field>` |  | fill a stored value instead of text: <site>.password or <site>.username (the daemon fills it; output shows <secret:…>) |
| `--confirm` |  | allow a second --secret password fill in this session (only after the human said so) |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |
| `--snapshot` |  | also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait |

### `tabcap type`

type into the element that has focus now (focus it first with click or fill). Default / --insert: one insertText, no key events (eventShape insert); --trusted: per-key events

```
tabcap type <text> [--session name] [--timeout ms] [--tab t2] [--trusted] [--delay ms] [--insert] [--submit-key key] [--no-wait] [--snapshot]
```

Example: `tabcap type hello --submit-key Enter`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--trusted` |  | one key event pair per character (keydown … keyup), insertText for characters without a US-layout key (eventShape keys) |
| `--delay <ms>` | `0` | with --trusted: ms between two characters |
| `--insert` |  | one Input.insertText for the whole text, no key events (the default; eventShape insert) |
| `--submit-key <key>` |  | press this key after typing, e.g. Enter or Tab |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |
| `--snapshot` |  | also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait |

### `tabcap press-key`

press a key or a combination on the focused element: Enter, Tab, Escape, ArrowDown, a, Shift+Tab, Control+a, Control+Shift+R … (modifiers: Control, Shift, Alt, Meta)

```
tabcap press-key <key> [--session name] [--timeout ms] [--tab t2] [--no-wait] [--snapshot]
```

Example: `tabcap press-key Enter`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |
| `--snapshot` |  | also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait |

### `tabcap upload`

put local files into a file input by ref (DOM.setFileInputFiles); for an element that opens a file chooser instead, it is clicked and the chooser answered

```
tabcap upload <ref> <files>... [--session name] [--timeout ms] [--tab t2] [--snapshot]
```

Example: `tabcap upload e9 ./photo.png`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--snapshot` |  | also return a fresh snapshot taken after the upload |

### `tabcap dialog`

status | accept | dismiss the JavaScript dialog blocking the tab (while one is open other commands fail with code dialog)

```
tabcap dialog status|accept|dismiss [--session name] [--timeout ms] [--tab t2] [--text text]
```

Example: `tabcap dialog accept`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--text <text>`, `--prompt-text <text>` |  | answer for a prompt() dialog |

## Page tools

### `tabcap evaluate`

run JavaScript in the page (an expression, or --function with --args) and return a JSON value (truncated at 60000 chars)

```
tabcap evaluate [<expression>] [--session name] [--timeout ms] [--tab t2] [--await] [--function js] [--args json]
```

Example: `tabcap evaluate 'document.title'`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--await` |  | await a returned promise |
| `--function <js>` |  | a function declaration to call instead of an expression, e.g. '(a, b) => a + b' or 'el => el.innerText' (promises are awaited) |
| `--args <json>` |  | with --function: JSON array of arguments; {"ref":"e12"} passes that element |

### `tabcap screenshot`

save an image of the tab, the full page or one element (works on background tabs) → path, width, height (never the image itself)

```
tabcap screenshot [--session name] [--timeout ms] [--tab t2] [--file-path path] [--full-page] [--format png|jpeg|webp] [--quality 0-100] [--ref e12]
```

Example: `tabcap screenshot --full-page`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--file-path <path>` |  | image path (default under ~/.local/share/tabcap/shots/) |
| `--full-page` |  | the whole page, not just the viewport (not with --ref) |
| `--format <png\|jpeg\|webp>` | `png` | png \| jpeg \| webp |
| `--quality <0-100>` |  | jpeg / webp quality 0–100 (ignored for png) |
| `--ref <e12>` |  | only this element (a ref from snapshot) |

### `tabcap resize`

resize the tab's window so the page gets this content size in CSS px (other tabs in the same window change too)

```
tabcap resize <width> <height> [--session name] [--timeout ms] [--tab t2]
```

Example: `tabcap resize 1280 800`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |

### `tabcap emulate`

emulate a device on the tab: viewport, user agent, colour scheme, network and CPU throttling, geolocation. Each call replaces all earlier settings of the tab: a setting left out is cleared

```
tabcap emulate [--session name] [--timeout ms] [--tab t2] [--viewport WxHxDPR] [--user-agent ua] [--color-scheme dark|light|auto] [--network-conditions preset] [--cpu-throttling-rate n] [--geolocation lat,lon]
```

Example: `tabcap emulate --viewport 390x844x3,mobile,touch`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--viewport <WxHxDPR>` |  | <width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape] |
| `--user-agent <ua>` |  | user agent string; empty clears the override |
| `--color-scheme <dark\|light\|auto>` |  | dark \| light \| auto (auto: the default) |
| `--network-conditions <preset>` |  | Offline \| Slow 3G \| Fast 3G \| Slow 4G \| Fast 4G |
| `--cpu-throttling-rate <n>` |  | CPU slowdown factor 1–20 (1: off) |
| `--geolocation <lat,lon>` |  | <latitude>,<longitude> |

### `tabcap permission grant`

grant permissions (Chrome's names: geolocation, notifications, camera, clipboard-read, push ...) for the current tab's origin (or --origin) only, until browser stop. Sessions share the default browser context (the answer says shared); a session start --site session has its own. A hidden tab's geolocation request keeps waiting (the answer's note says how). direct mode only → tab, origin, setting, names, context, shared

```
tabcap permission grant <names>... [--session name] [--timeout ms] [--tab t2] [--origin url]
```

Example: `tabcap permission grant geolocation notifications`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--origin <url>` |  | set it for this URL's origin (path, query and fragment dropped) instead of the current tab's; http(s) only |

### `tabcap permission deny`

deny permissions (the page's request fails at once, no prompt) for the current tab's origin (or --origin) only, until browser stop. Sessions share the default browser context (the answer says shared); a session start --site session has its own. A hidden tab's geolocation request keeps waiting (the answer's note says how). direct mode only → tab, origin, setting, names, context, shared

```
tabcap permission deny <names>... [--session name] [--timeout ms] [--tab t2] [--origin url]
```

Example: `tabcap permission deny geolocation notifications`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--origin <url>` |  | set it for this URL's origin (path, query and fragment dropped) instead of the current tab's; http(s) only |

### `tabcap permission reset`

set permissions back to undecided (prompt) for the current tab's origin (or --origin) only, until browser stop. Sessions share the default browser context (the answer says shared); a session start --site session has its own. A hidden tab's geolocation request keeps waiting (the answer's note says how). direct mode only → tab, origin, setting, names, context, shared

```
tabcap permission reset <names>... [--session name] [--timeout ms] [--tab t2] [--origin url]
```

Example: `tabcap permission reset geolocation notifications`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--origin <url>` |  | set it for this URL's origin (path, query and fragment dropped) instead of the current tab's; http(s) only |

### `tabcap console list`

the tab's console, oldest first (last 500 messages, kept even when not recording): msgid, type, level, source, text (4 KB max), url:line:col

```
tabcap console list [--session name] [--tab t2] [--types error,warn] [--level level] [--page-size n] [--page-idx n] [--limit n] [--include-stack-traces] [--clear]
```

Example: `tabcap console list --types error,warn`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--types <error,warn>` |  | comma list of message types: log, debug, info, error, warn, dir, table, trace, assert, count, timeEnd, verbose … |
| `--level <level>` |  | debug \| log \| info \| warn \| error: that level and more severe (log = info) |
| `--page-size <n>` | `30` | messages per page (max 1000); 0 returns every buffered message |
| `--page-idx <n>` | `0` | page to return, 0-based; nextPageIdx names the next one |
| `--limit <n>` |  | only the last N messages (instead of paging) |
| `--include-stack-traces` |  | include each message's stack trace when there is one |
| `--clear` |  | empty the tab's buffer after reading |

### `tabcap console show`

one console message by msgid (from console list): text, arguments, location, stack trace

```
tabcap console show <msgid> [--session name] [--tab t2]
```

Example: `tabcap console show 3`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |

## Network recording

### `tabcap net start`

record the session's traffic (requests with bodies, WebSocket frames, console) into a bundle under ~/.local/share/tabcap/bundles/; encrypted API responses: add `trace start --decode` for the plaintext the page parses

```
tabcap net start [--session name] [--bodies mode]
```

Example: `tabcap net start --bodies api+script`

| Option | Default | Meaning |
|---|---|---|
| `--bodies <mode>` |  | which response bodies to store: all \| api (document, xhr, fetch, websocket, eventsource, other) \| api+script (api and scripts) \| none; images, fonts, stylesheets and media are metadata only unless all. Default: config.json record.bodies, else all |

### `tabcap net stop`

finish the recording (bundle manifest gets `finished`)

```
tabcap net stop [--session name]
```

Example: `tabcap net stop`

### `tabcap net list`

recorded requests, oldest first: id, method, url (cut at 255 chars; net show has it whole), status, mime, bytes, outcome, cmd; always total / matched / shown / hidden {failed, data} (failed and data: are hidden unless asked for); 30 per page unless --page-size (0: everything) (--kind ws: WebSocket frames r-12:34)

```
tabcap net list [--session name] [--filter s] [--host s] [--status code] [--method M] [--resource-types xhr,fetch] [--tab t2] [--since c-12] [--failed] [--no-failed] [--all] [--page-size n] [--page-idx n] [--kind http|ws] [--reveal]
```

Example: `tabcap net list --resource-types xhr,fetch --status 2xx`

| Option | Default | Meaning |
|---|---|---|
| `--filter <s>` |  | URL substring |
| `--host <s>` |  | host[:port] substring |
| `--status <code>` |  | status code or class: 200 \| 2xx \| 3xx \| 4xx \| 5xx |
| `--method <M>` |  | only this HTTP method |
| `--resource-types <xhr,fetch>` |  | comma list: xhr,fetch,document,script … |
| `--tab <t2>` |  | only requests of this tab |
| `--since <c-12>` |  | only requests finished after this command started (the `cmd` id commands return while recording) |
| `--failed` |  | only failed requests (hidden by default) |
| `--no-failed` |  | hide failed requests (the default) |
| `--all` |  | also failed requests and data: URLs |
| `--page-size <n>` | `30` | requests per page (max 1000); 0 returns every match |
| `--page-idx <n>` | `0` | page to return, 0-based; nextPageIdx names the next one |
| `--kind <http\|ws>` | `http` | http (requests) \| ws (WebSocket frames: id, direction, opcode, bytes, ts) |
| `--reveal` |  | print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>) |

### `tabcap net body`

a response body (r-12) or WebSocket frame payload (r-12:34) as a file path + a text preview of up to 10000 chars (never the whole body inline); a body with a decoded view (decode plugin, or the page view of `trace start --decode`) shows the view (--raw: the original); --grep / --lines / --at read only the lines needed (long lines as a 500-char window), --pretty breaks minified code first; --file writes the whole decoded, scrubbed body to a file for your own tools (rg / grep)

```
tabcap net body [<id>] [--session name] [--out path] [--url url] [--grep regex] [--lines a-b] [--at line:col] [--context n] [--max-matches n] [--file] [--pretty] [--decoded] [--raw] [--reveal]
```

Example: `tabcap net body r-12 --grep 'sign|token' --pretty`

| Option | Default | Meaning |
|---|---|---|
| `--out <path>` |  | copy the body to this file |
| `--url <url>` |  | instead of an id: the last recorded request for this URL (e.g. a script URL from `trace list`) |
| `--grep <regex>` |  | lines of the decoded body matching this regex (JavaScript, u flag, at most 256 chars): {line, col, text, before, after} per match |
| `--lines <a-b>` |  | this 1-based inclusive line range (at most 500 lines per call) |
| `--at <line:col>` |  | the lines around this 1-based raw-body position, as `trace list` and console stacks print it (mapped into the pretty text with --pretty) |
| `--context <n>` |  | lines before and after each match (--grep, default 3) or the position (--at, default 5) |
| `--max-matches <n>` | `50` | with --grep: matches shown (max 1000); total counts them all |
| `--file` |  | write the whole decoded body (charset-decoded, secret-scrubbed; with --pretty line-broken) to exports/bodies/<id>.<ext> of the open recording (else <cache>/outputs/bodies/), 0600, and answer {id, url, mime, bytes, lines, pretty, file, scrubbed}: for `rg` / grep on the path; not with --grep / --lines / --at / --out |
| `--pretty` |  | JavaScript / JSON bodies up to 8 MB: break minified JS into lines (newlines only, never inside strings, templates, regexes, comments), re-indent JSON; line numbers then refer to the pretty text |
| `--decoded` |  | the plaintext view of the body — a decode plugin's, else the page view of `trace start --decode` (the default when the request has one; an error when it has none); the answer says view: "decoded" |
| `--raw` |  | the original body even when a decoded view exists (view: "raw") |
| `--reveal` |  | print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>) |

### `tabcap net show`

one request in full: method, url, status, request / response headers, postData (over 2 KB: path + first 2 KB), body path, timing, initiator, nav, tab, outcome; r-12:34 shows a WebSocket frame; sensitive headers, cookie values and query / body fields read <redacted:name> unless --reveal

```
tabcap net show <id> [--session name] [--reveal]
```

Example: `tabcap net show r-12`

| Option | Default | Meaning |
|---|---|---|
| `--reveal` |  | print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>) |

### `tabcap net grep`

raw-text regex search over every recorded response body of the session (decoded, secret-scrubbed): per request {id, url, resourceType, count, matches}; at most 50 requests (more: n), bodies over 8 MB listed under skipped. Not `analyze find`, which follows values through decode chains

```
tabcap net grep <regex> [--session name] [--resource-types script,xhr] [--max-matches n] [--context n] [--pretty]
```

Example: `tabcap net grep 'x-sign|signature' --resource-types script`

| Option | Default | Meaning |
|---|---|---|
| `--resource-types <script,xhr>` |  | comma list: script,xhr,fetch,document … |
| `--max-matches <n>` | `20` | matches shown per request (max 200); count has them all |
| `--context <n>` | `1` | lines before and after each match (max 20) |
| `--pretty` |  | search JavaScript / JSON bodies as `net body --pretty` prints them (line numbers then refer to the pretty text) |

### `tabcap net wait`

wait until a matching request finished with its body stored (needs net start). Counts requests since the start of the last action command (navigate, tab new, click, hover, fill, type, press-key, upload, go, reload, evaluate) → id, status, body path

```
tabcap net wait [--session name] [--timeout ms] --url <s> [--method M] [--tab t2] [--since c-12|start] [--fresh]
```

Example: `tabcap net wait --url /api/search --method POST`

| Option | Default | Meaning |
|---|---|---|
| `--url <s>` |  | URL substring of the request (required) |
| `--method <M>` |  | only this HTTP method |
| `--tab <t2>` |  | only requests of this tab |
| `--since <c-12\|start>` |  | look back to this command's start (c-12), or `start` for the whole recording |
| `--fresh` |  | only requests finishing after the wait begins |

### `tabcap fetch`

send via the logged-in tab; the session's tab sends the request (the page's own fetch with its cookies, in a tabcap isolated world) and it is recorded (needs net start): fetchId c-N:f-K on the request event, per-host pacing (config.json fetch.minIntervalMs, default 3000 ms between requests), stop rules → {id, fetchId, status, statusText, mime, bytes, headers, body (text ≤ 8 KB) | bodyFile, timing, waitedMs}

```
tabcap fetch [<url>] [--session name] [--timeout ms] [--tab t2] [--method M] [--header k:v]... [--body text|@file] [--json text|@file] [--form k=v]... [--credentials include|same-origin|omit] [--stop-on rule]... [--end-on rule]... [--out file] [--raw] [--batch file.jsonl] [--reveal]
```

Example: `tabcap fetch '/api/list?page=2' --stop-on 'json:$.code!=0'`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--method <M>` | `GET` | HTTP method |
| `--header <k:v>` |  | request header (name:value) (repeatable) |
| `--body <text\|@file>` |  | request body text, or @<file> to read it from a file |
| `--json <text\|@file>` |  | JSON request body (checked; content-type application/json unless --header sets one), or @<file> |
| `--form <k=v>` |  | form field of an application/x-www-form-urlencoded body (repeatable) |
| `--credentials <include\|same-origin\|omit>` | `include` | the page fetch()'s credentials option: include (cookies on every origin) \| same-origin \| omit (no cookies; for an API that answers Access-Control-Allow-Origin: * and authenticates by a header); with --batch: for lines without their own |
| `--stop-on <rule>` |  | stop rule, on top of config.json fetch.stopOn: empty-body \| status>=<n> \| status=<n> \| json:<$.path>=<v> \| json:<$.path>!=<v> \| text:<regex>; when one fires the site's fetches are refused until `tabcap guard resume --site` (repeatable) |
| `--end-on <rule>` |  | end rule (the --stop-on syntax), on top of config.json sites.<s>.guard.endOn: the list has ended (e.g. json:$.code=203); checked before every stop rule, a match answers ok with end {rule, detail} and stops nothing (repeatable) |
| `--out <file>` |  | write the body (text secret-scrubbed) to this file instead of inline / bodyFile |
| `--raw` |  | the body as base64 inline (bodyBase64, up to 16 MB; text secret-scrubbed) instead of inline text / bodyFile |
| `--batch <file.jsonl>` |  | JSON lines file, one request per line {url, method?, headers?, body?\|json?\|form?, credentials?, tab?, timeoutMs?, stopOn?, endOn?}: sent in order under the same limits, one envelope printed per line |
| `--reveal` |  | print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>) |

### `tabcap where`

which recorded response carries a value the page shows (a snapshot ref's visible text, or a text): JSON paths through analyze find's decode chain, then HTML text nodes (selectors), matched exactly or after normalisation (thousands / decimal separators, accounting negatives, full-width, nbsp, YYYY-MM dates, dotted codes, DR / CR); searches only the session's recording and sends no request

```
tabcap where <query> [--session name] [--timeout ms] [--as ref|text] [--top n] [--text] [--write-findings]
```

Example: `tabcap where e12`

| Option | Default | Meaning |
|---|---|---|
| `--as <ref\|text>` |  | what the input is: ref (a snapshot ref; its visible text is looked up) or text (the value as typed). Default: e<n> (or a frame ref f<n>/e<m>) is a ref while the session's tab has a current snapshot, anything else text |
| `--top <n>` | `5` | candidates to return (1-100) |
| `--text` |  | print a text report instead of JSON (the envelope's data is schema tabcap-where/0) |
| `--write-findings` |  | append finding events (tool where; 实测 for exact matches, 推断 for normalized ones) to the session's bundle; default: the bundle is only read |

### `tabcap recon`

recon dossier v0 of the session's recording and current page: tech stack (adapter detect results, header / session-cookie hints), data channels (method, path template, type, body class) with the share of the page's visible text found in recorded responses, cookie classification (origin, lifetime, flags, role, requiredBy from analyze deps), protection identification (guard detections, response signals; identification only). Writes exports/dossier.json (schema tabcap-dossier/0) and exports/dossier.md into the bundle; sends no request

```
tabcap recon [--session name] [--timeout ms] [--text] [--reveal]
```

Example: `tabcap recon --text`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print the Markdown dossier instead of the JSON envelope |
| `--reveal` |  | print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>) |

## Handoff and challenge handlers

### `tabcap handoff status`

is the session handed to the human? state running | waiting | resumed, reason, screenshot, handler answers

```
tabcap handoff status [--session name]
```

Example: `tabcap handoff status`

### `tabcap handoff continue`

end a waiting state after the human finished in the browser (run it only when they say so)

```
tabcap handoff continue [--session name]
```

Example: `tabcap handoff continue`

### `tabcap handoff wait`

wait until a waiting session goes on: the human continued, or (verify-page / human-takeover) one --until-* condition became true that was not when the handoff began, which ends it like handoff continue → state, by (human | condition | plugin:<n> | guard-resume), condition

```
tabcap handoff wait [--session name] [--timeout ms] [--until-url s] [--until-text text] [--until-selector css] [--until-cookie name]
```

Example: `tabcap handoff wait --until-url /dashboard --timeout 120000`

| Option | Default | Meaning |
|---|---|---|
| `--until-url <s>` |  | end the handoff once the handoff tab's URL contains this (and did not when the handoff began) |
| `--until-text <text>` |  | … once the tab shows this text (seen absent first) |
| `--until-selector <css>` |  | … once a CSS selector matches in the tab (seen absent first) |
| `--until-cookie <name>` |  | … once a cookie of this name is set for the tab's URL (absent when the handoff began; only the name is compared) |

### `tabcap guard resume`

resume a site after a stop rule fired: `tabcap fetch` sends to it again, and a session a site rule (config.json sites.<s>.guard) put into waiting goes on (decide first: look at the stopped response)

```
tabcap guard resume [--session name] --site <site>
```

Example: `tabcap guard resume --site example`

| Option | Default | Meaning |
|---|---|---|
| `--site <site>` |  | the store site (or host) a stop rule stopped (required) |

### `tabcap plugin list`

challenge handlers and decode plugins installed under ~/.config/tabcap/plugins/ (none ship with tabcap): name, kind, hooks / match, enabled, errors

```
tabcap plugin list
```

Example: `tabcap plugin list`

### `tabcap plugin enable`

opt a plugin in: a challenge handler is asked before a challenge goes to the human; a decode plugin decodes matching bodies of recordings started from now on

```
tabcap plugin enable <name>
```

Example: `tabcap plugin enable my-handler`

### `tabcap plugin disable`

stop using this handler or decode plugin

```
tabcap plugin disable <name>
```

Example: `tabcap plugin disable my-handler`

### `tabcap plugin init`

write the decode plugin template (manifest.json with the name, plugin.py, runner.py, pyproject.toml, config.example.json, and config.json from the example when absent) into <dir> or ~/.config/tabcap/plugins/<name>/; refuses a non-empty directory without --force. The answer lists the files and the next steps (edit plugin.py, config.json and the manifest's match, then `plugin enable`); plugins load only from the plugins directory

```
tabcap plugin init [<dir>] --kind <decode> [--name name] [--force]
```

Example: `tabcap plugin init --kind decode --name my-decode`

| Option | Default | Meaning |
|---|---|---|
| `--kind <decode>` |  | the template: decode (the Python decode runner; no other kind has one) (required) |
| `--name <name>` |  | plugin name, set in manifest.json (default: the directory's name); alone, the plugin goes to ~/.config/tabcap/plugins/<name>/ |
| `--force` |  | write into a non-empty directory: the template files are rewritten, config.json never, other files are left alone |

## Offline: bundles, analysis, replay

### `tabcap bundle export har`

export a bundle as HAR 1.2 (redacted by default)

```
tabcap bundle export har <bundle> [--out file] [--tab t1] [--types xhr,fetch] [--embed-events] [--no-redact] [--rules file]
```

Example: `tabcap bundle export har ~/.local/share/tabcap/bundles/default-… --types xhr,fetch`

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` |  | HAR file (default <bundle>/exports/har-<time>.har) |
| `--tab <t1>` |  | only this tab |
| `--types <xhr,fetch>` |  | only these resource types |
| `--embed-events` |  | also embed every event as log._events (lossless round trip) |
| `--no-redact` |  | skip redaction (default: redacted with a per-export salt) |
| `--rules <file>` |  | replay rules file: drop each rule's ignoreQuery parameters from the entry URLs (nothing else changes) |

### `tabcap bundle import har`

import a HAR (DevTools, Charles, mitmproxy …) as a bundle, so analyze works on it

```
tabcap bundle import har <file> -o <bundle>
```

Example: `tabcap bundle import har site.har -o ./site-bundle`

| Option | Default | Meaning |
|---|---|---|
| `-o <bundle>`, `--out <bundle>` |  | new bundle directory (required) |

### `tabcap bundle redact`

write a redacted copy of a bundle (the original is never changed)

```
tabcap bundle redact <in> <out>
```

Example: `tabcap bundle redact ./b ./b-redacted`

### `tabcap bundle info`

bundle summary: counts, event kinds, finished or not, issues; --usage for the account-usage report

```
tabcap bundle info <bundle> [--usage] [--text] [--business-code $.path=ok]... [--actor page|fetch|evaluate|other] [--all-hosts]
```

Example: `tabcap bundle info ./b --usage --text --business-code '$.code=0'`

| Option | Default | Meaning |
|---|---|---|
| `--usage` |  | account-usage report (tabcap-usage/0): logins per account, per host requests / intervals / bursts / statuses / empty bodies / business errors, guard stops, 10-minute windows; counts and names only |
| `--text` |  | with --usage: one-screen table for a run log |
| `--business-code <$.path=ok>` |  | with --usage: JSON bodies whose <$.path> is not this value count as business errors (e.g. $.code=0) (repeatable) |
| `--actor <page\|fetch\|evaluate\|other>` |  | with --usage: only the rows of one actor: page (the page's own requests), fetch (sent by tabcap fetch), evaluate (during tabcap evaluate), other |
| `--all-hosts` |  | with --usage: also list loopback hosts (127.0.0.1, localhost, ::1), left out by default with a one-line skipped summary |

### `tabcap bundle list`

the recordings in the store's bundle index (each `net start`), newest first: id, dir, site, session, startedAt, finishedAt, bytes on disk, state (recording | finished | unfinished | missing). Recordings have no total size limit; `bundle prune` removes old ones

```
tabcap bundle list [--site name] [--limit n] [--text]
```

Example: `tabcap bundle list --site example --limit 10 --text`

| Option | Default | Meaning |
|---|---|---|
| `--site <name>` |  | only the recordings of this store site |
| `--limit <n>` | `50` | at most this many, newest first (max 1000) |
| `--text` |  | one line per recording (start, state, size, site, session, directory) instead of JSON |

### `tabcap bundle prune`

delete old recordings found through the store's bundle index: --keep N or --older-than <duration>, a dry run that lists them unless --yes; a recording the daemon still has open is never deleted, nor anything that is not a bundle directory; index rows whose directory is gone are forgotten. For the human (not an MCP tool)

```
tabcap bundle prune [--keep n] [--older-than duration] [--site name] [--dry-run] [--yes]
```

Example: `tabcap bundle prune --older-than 30d --yes`

| Option | Default | Meaning |
|---|---|---|
| `--keep <n>` |  | keep the N newest recordings, delete the older ones |
| `--older-than <duration>` |  | delete the recordings started longer ago than this: a whole number with s, m, h, d or w (30d, 12h) |
| `--site <name>` |  | only the recordings of this store site |
| `--dry-run` |  | only list what would be deleted (also the default without --yes) |
| `--yes` |  | delete for real: the directories and their index rows |

### `tabcap bundle decode`

run decode plugins over a finished bundle: plaintext views of matching request / response bodies are appended to the bundle's decoded.jsonl sidecar (events.jsonl never changes) and read as request.decoded / response.decoded by net body / find / where / deps / recon / replay check; a body a plugin declines (decode() returned None: not its body) gets no view and is counted as declined, and a decline hides that plugin's earlier failure on the body (superseded); CORS preflights and empty bodies are never offered; a re-run appends only new or changed views

```
tabcap bundle decode <bundle> [--plugin name]
```

Example: `tabcap bundle decode ./b --plugin xor-decode`

| Option | Default | Meaning |
|---|---|---|
| `--plugin <name>` |  | only this decode plugin (installed; naming it is the opt-in, it need not be enabled); default: every enabled decode plugin |

### `tabcap bundle export fixtures`

one fixture per recorded exchange: {key {method, path, query, body} as the replay rules read it, request {headers, body}, response {status, headers, body | bodyFile, decoded?}, meta {request, rule, recordedAt}}; --format <plugin> hands each fixture to a fixture plugin (tabcap-fixture/1) that returns the files to write

```
tabcap bundle export fixtures <bundle> --out <dir> [--rules file] [--format json|plugin] [--no-redact] [--include-preflight]
```

Example: `tabcap bundle export fixtures ./b --rules replay-rules.json --out ./fixtures`

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>` |  | output directory (must be missing or empty) (required) |
| `--rules <file>` |  | replay rules file (schema tabcap-replay-rules/0, docs/04 §31); default: config.json sites.<bundle site>.replay, then replay |
| `--format <json\|plugin>` | `json` | json (fixtures/<n>-<method>-<path>.json + index.json), or the name of a fixture plugin that writes its own files |
| `--no-redact` |  | skip redaction (default: redacted like HAR export, with a per-export salt) |
| `--include-preflight` |  | also export CORS preflights (OPTIONS); default: skipped with reason preflight |

### `tabcap analyze find`

which request / WebSocket frame / console line carries this text, through a bounded decode chain (base64, gzip / br, urldecode, JSON, html entities …); 0 hits come with hints

```
tabcap analyze find <bundle> <text> [--ignore-case] [--text] [--save]
```

Example: `tabcap analyze find ./b 'Order placed'`

| Option | Default | Meaning |
|---|---|---|
| `--ignore-case` |  | case-insensitive match |
| `--text` |  | print a text report instead of JSON |
| `--save` |  | append the result as a finding event (finished bundles only) |

### `tabcap analyze diff`

compare recordings of the same action: which parameters are constant, per session, timestamps or varying; values print as <redacted:…> unless --reveal

```
tabcap analyze diff <bundle1> <bundle2> [<bundles>...] [--text] [--save] [--reveal]
```

Example: `tabcap analyze diff ./b1 ./b2`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print a text report instead of JSON |
| `--save` |  | append the result as a finding event to the first bundle |
| `--reveal` |  | print recorded cookie / authorization / set-cookie / sensitive-named parameter values instead of <redacted:…> (only when the human asks) |

### `tabcap analyze deps`

value-flow dependency graph: for every request input (query, body leaves, x-* / authorization headers, cookies) its source in earlier events (set-cookie, response body path, recorded fill / type, earlier request, constant, timestamp), else caller-input (paging, periods, search terms the caller picks) / computed-in-page / unrecorded; exact matches only (a header also without its Bearer / Basic / Token / JWT prefix or quotes), never guessed; request URLs print sensitive query values as <redacted:…> unless --reveal

```
tabcap analyze deps <bundle> [--session name] [--request r-N] [--text] [--write-findings] [--reveal]
```

Example: `tabcap analyze deps ./b --request r-12`

| Option | Default | Meaning |
|---|---|---|
| `--session <name>` |  | only requests recorded under this session name |
| `--request <r-N>` |  | only this request (sources are still searched in the whole bundle) |
| `--text` |  | print a text report instead of JSON (the envelope's data is schema tabcap-deps/0) |
| `--write-findings` |  | append finding events (tool deps) to the bundle (finished bundles only); default: the bundle is only read |
| `--reveal` |  | print recorded cookie / authorization / set-cookie / sensitive-named parameter values instead of <redacted:…> (only when the human asks) |

### `tabcap analyze chain`

the requests needed to reproduce one request, from the deps graph, in recording order: what each step provides to later ones and what it still needs from the caller (computed-in-page, unrecorded, user input; caller-input values listed apart under inputs); step URLs print sensitive query values as <redacted:…> unless --reveal

```
tabcap analyze chain <bundle> [--request r-N] [--session name] [--text] [--reveal]
```

Example: `tabcap analyze chain ./b --request r-12`

| Option | Default | Meaning |
|---|---|---|
| `--request <r-N>` |  | target request (default: the data-bearing xhr / fetch / document request that started last) |
| `--session <name>` |  | pick the default target among requests of this session name |
| `--text` |  | print a text report instead of JSON (the envelope's data is schema tabcap-chain/0) |
| `--reveal` |  | print recorded cookie / authorization / set-cookie / sensitive-named parameter values instead of <redacted:…> (only when the human asks) |

### `tabcap analyze recon`

the recon dossier offline (as `tabcap recon`), with the bundle's last recorded document standing in for the page (its HTML text, no adapter detection); page / guard URLs and stack header values print as <redacted:…> unless --reveal; writes exports/dossier.json and exports/dossier.md

```
tabcap analyze recon <bundle> [--text] [--reveal]
```

Example: `tabcap analyze recon ./b --text`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print the Markdown dossier instead of the JSON envelope |
| `--reveal` |  | print recorded cookie / authorization / set-cookie / sensitive-named parameter values instead of <redacted:…> (only when the human asks) |

### `tabcap analyze shape`

response and request shape per endpoint (method + path template, all its exchanges): a type tree of the decoded JSON bodies (kinds, unions, formats date / datetime / int / float / id / url / email, presence counts, optional, ≤ 8 enum literals of non-sensitive fields) plus query names and request body fields; values never print (enum literals only under non-sensitive names), so --reveal changes nothing

```
tabcap analyze shape <bundle> [--request r-N] [--template 'GET /path'] [--text] [--write] [--types xhr,fetch|all] [--reveal]
```

Example: `tabcap analyze shape ./b --template 'GET /api/list' --text`

| Option | Default | Meaning |
|---|---|---|
| `--request <r-N>` |  | only this exchange (its endpoint, shaped from this request alone) |
| `--template <'GET /path'>` |  | only this endpoint: method + path template as listed (key) |
| `--text` |  | print one line per field instead of JSON (the envelope's data is schema tabcap-shape/0) |
| `--write` |  | also store the result as exports/shape.json in the bundle |
| `--types <xhr,fetch\|all>` |  | only exchanges of these resource types, or all; default: xhr, fetch, document and any response with a JSON content type |
| `--reveal` |  | print recorded cookie / authorization / set-cookie / sensitive-named parameter values instead of <redacted:…> (only when the human asks) |

### `tabcap analyze schema-diff`

schema drift between two recordings: per endpoint the fields added, removed, changed type, changed optionality or enum, and endpoints only in one bundle; verdict same / drift / new / gone; exits 1 when any endpoint drifted (for cron)

```
tabcap analyze schema-diff <old> <new> [--template 'GET /path'] [--text] [--write] [--types xhr,fetch|all]
```

Example: `tabcap analyze schema-diff ./yesterday ./today --text`

| Option | Default | Meaning |
|---|---|---|
| `--template <'GET /path'>` |  | only this endpoint (method + path template) |
| `--text` |  | print one line per change instead of JSON (the envelope's data is schema tabcap-schema-diff/0) |
| `--write` |  | also store each bundle's shape as its exports/shape.json |
| `--types <xhr,fetch\|all>` |  | only exchanges of these resource types on both sides, or all; default as analyze shape (diffing a HAR import: pass the --types it was exported with) |

### `tabcap replay serve`

serve a bundle's recorded responses on a loopback port until Ctrl-C: match = method + path + sorted query + body sha256, or as the replay rules say (ignored query names / body fields, form / JSON / decoded bodies); repeated matches cycle in recorded order, or only over the 2xx / the latest one with --prefer (header x-tabcap-replay: r-N;n=k[;rule=id][;prefer=p]); no match → 404 with the nearest recordings and what differs

```
tabcap replay serve <bundle> [--port port] [--host host] [--strict h1,h2] [--match-cookies] [--rules file] [--prefer recorded|2xx|latest] [--json] [--once seconds]
```

Example: `tabcap replay serve ./b --port 4500`

| Option | Default | Meaning |
|---|---|---|
| `--port <port>` | `4500` | port to listen on (0: any free port) |
| `--host <host>` | `127.0.0.1` | loopback address only: 127.0.0.1, ::1 or localhost |
| `--strict <h1,h2>` |  | also match these request headers |
| `--match-cookies` |  | also match the cookie header |
| `--rules <file>` |  | replay rules file (schema tabcap-replay-rules/0, docs/04 §31); default: config.json sites.<bundle site>.replay, then replay |
| `--prefer <recorded\|2xx\|latest>` |  | which recordings of one key answer, for every key (overrides the rules' prefer): recorded (all, cycling in recorded order), 2xx (only the 2xx ones; all when there are none), latest (the last one) |
| `--json` |  | print {port, bundle, routes} as one JSON envelope (else text, one log line per request on stderr) |
| `--once <seconds>` |  | stop after this many seconds (tests) |

### `tabcap replay session`

write the recording's cookies (latest state snapshot), or with --site and no bundle the store's saved session, as a Playwright storageState file, mode 0600; it holds live session cookies, values are never printed

```
tabcap replay session [<bundle>] --out <file> [--site site]
```

Example: `tabcap replay session ./b -o storage-state.json`

| Option | Default | Meaning |
|---|---|---|
| `--out <file>`, `-o <file>` |  | storageState file to write (0600) (required) |
| `--site <site>` |  | use the store's saved session of this site (saved at session stop / handoff continue) when there is no bundle or it has no cookie snapshot |

### `tabcap replay export-python`

generate an httpx client (one function per request group, TypedDict responses), fixtures and a pytest suite that runs against replay serve; with the chain, computed-in-page inputs are TODO parameters and verify() replays the chain; otherwise signature-like parameters and encrypted bodies become NotImplementedError TODOs

```
tabcap replay export-python <bundle> --out <dir> [--include glob,glob] [--exclude glob,glob] [--request r-N] [--chain] [--no-chain] [--browser-headers] [--proxy-env file]
```

Example: `tabcap replay export-python ./b -o ./client`

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>`, `-o <dir>` |  | directory for the generated package (required) |
| `--include <glob,glob>` |  | only paths matching these globs (* within a segment, ** across) |
| `--exclude <glob,glob>` |  | leave out paths matching these globs |
| `--request <r-N>` |  | chain target, as analyze chain --request (default: the data-bearing xhr / fetch / document request that started last among the exported ones); implies --chain |
| `--chain` |  | use the deps graph and the chain to the data-bearing request that started last (the analyze chain default): computed-in-page inputs become TODO parameters, caller-input ones parameters defaulting to the recorded value, values from earlier responses become arguments, plus verify() and verify_expected.json (default when the graph links any request to an earlier response) |
| `--no-chain` |  | 0.3 behaviour: per-request heuristics only, no verify() |
| `--browser-headers` |  | send every recorded request header (user-agent, accept-language, sec-ch-ua*, sec-fetch-* …); default: only content-type, authorization, a non-default accept, a cross-origin referer and headers the browser does not add itself (custom x-* …) |
| `--proxy-env <file>` |  | also write TABCAP_PROXY_URL (the bundle account's proxy, with its credentials) to this file, mode 0600; never printed. The generated client reads TABCAP_PROXY_URL |

### `tabcap replay check`

send every recorded request again and compare status, headers and body field by field with the recording; exit 1 on any difference

```
tabcap replay check <bundle> [--against url] [--live] [--rate n] [--site site] [--filter glob,glob] [--headers h1,h2] [--with-cookies] [--rules file] [--prefer recorded|2xx|latest] [--text]
```

Example: `tabcap replay check ./b --against http://127.0.0.1:4500`

| Option | Default | Meaning |
|---|---|---|
| `--against <url>` | `http://127.0.0.1:4500` | target origin; non-loopback needs --live |
| `--live` |  | allow a non-loopback target: needs a stored site (--site or the bundle's) the host is on, paced (never faster than the site's config.json fetch.minIntervalMs) and counted per site, refused while the daemon has the site's fetches stopped; goes out through the account's proxy when it is bound to one |
| `--rate <n>` |  | live requests per second; default one request per 2 s, and never faster than config.json fetch.minIntervalMs of the site (else the global one; default 3000 ms, so one per 3 s unless set lower): a faster --rate is paced at that floor, with a warning |
| `--site <site>` |  | stored site whose guard counters a live check uses |
| `--filter <glob,glob>` |  | only paths matching these globs |
| `--headers <h1,h2>` | `content-type,location` | response headers to compare when recorded |
| `--with-cookies` |  | also send the recorded cookie header |
| `--rules <file>` |  | replay rules file (schema tabcap-replay-rules/0, docs/04 §31); default: config.json sites.<bundle site>.replay, then replay |
| `--prefer <recorded\|2xx\|latest>` |  | as replay serve --prefer: check only the recordings that answer each key; the others are listed in notPreferred and not sent |
| `--text` |  | print one line per request that is not the same, then the totals, instead of JSON |

### `tabcap schema`

this command table as JSON: names, arguments, flags with types and defaults, help, examples

```
tabcap schema [--json]
```

Example: `tabcap schema --json`

| Option | Default | Meaning |
|---|---|---|
| `--json` |  | print the bare schema document (no envelope) |

## Other

### `tabcap status`

everything at once: daemon, browser, sessions (site, recording, waiting, trace, fetch stops), plugins, and conflicts with the next command

```
tabcap status [--text]
```

Example: `tabcap status --text`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print one screen (a line per session, then the conflicts) instead of JSON |

### `tabcap proxy add`

add a proxy to the local store (state.db, 0600) for the account pool: the password is typed at a prompt (recommended: by the human) or piped with --password-stdin, never passed as an argument, and never shown in tabcap output

```
tabcap proxy add <name> --url <scheme://host:port> [--user username] [--password-stdin] [--bypass list]
```

Example: `tabcap proxy add p1 --url http://127.0.0.1:8080 --user pool1 --password-stdin`

| Option | Default | Meaning |
|---|---|---|
| `--url <scheme://host:port>` |  | scheme://host:port (http, https, socks4, socks5); never credentials (required) |
| `--user <username>` |  | proxy username (not a secret: shown in listings); SOCKS with a username is refused (Chrome offers no-auth SOCKS only) |
| `--password-stdin` |  | read the proxy password from stdin (else an interactive prompt when --user is given; never an argument) |
| `--bypass <list>` |  | Chrome proxy bypass list for the account's browser context (default "<-loopback>": loopback goes through the proxy) |

### `tabcap proxy list`

stored proxies: name, scheme, host:port, user, hasAuth, bypass, state, last check (never the password)

```
tabcap proxy list
```

Example: `tabcap proxy list`

### `tabcap proxy remove`

delete a proxy no account is bound to

```
tabcap proxy remove <name>
```

Example: `tabcap proxy remove p1`

### `tabcap proxy check`

one health check through the proxy: unknown → up on success; 3 failures in a row → down (rechecked after 1 / 5 / 15 min)

```
tabcap proxy check <name> [--url url]
```

Example: `tabcap proxy check p1 --url http://127.0.0.1:8080/`

| Option | Default | Meaning |
|---|---|---|
| `--url <url>` |  | address to fetch through the proxy (else config.json pool.health.url; with neither nothing is contacted and the state is unchecked) |

### `tabcap proxy set-state`

disable a proxy by hand (skipped by allocation and rotation, never checked) or set it active again (back to unknown until the next check)

```
tabcap proxy set-state <name> active|disabled
```

Example: `tabcap proxy set-state p1 disabled`

### `tabcap account add`

add another account to a stored site (the password is typed at a prompt, recommended: by the human, or piped with --password-stdin; never an argument, never shown); a duplicate <site>.<user> is refused

```
tabcap account add <site> --user <username> [--password-stdin] [--totp-stdin]
```

Example: `tabcap account add example --user bob --password-stdin`

| Option | Default | Meaning |
|---|---|---|
| `--user <username>` |  | account username (not a secret: shown in listings) (required) |
| `--password-stdin` |  | read the password from stdin (else an interactive prompt; never an argument) |
| `--totp-stdin` |  | also store a TOTP seed: needs --password-stdin, stdin is two lines (password, then seed) |

### `tabcap account remove`

delete a stored account with its saved cookies and counters; refused while a session uses it

```
tabcap account remove <account>
```

Example: `tabcap account remove example.bob`

### `tabcap account bind`

bind a stored account (<site>.<user>) to a proxy, or to the browser's own network (system / none)

```
tabcap account bind <account> --proxy <name|system|none>
```

Example: `tabcap account bind example.alice --proxy p1`

| Option | Default | Meaning |
|---|---|---|
| `--proxy <name\|system\|none>` |  | a proxy name: the account's browser context goes out through it; system / none: its context has no proxy of its own (the browser's network and proxy flags) (required) |

### `tabcap account list`

stored accounts: state (active / cooling / needs-human / disabled), coolUntil, proxy, lastUsedAt (never passwords)

```
tabcap account list [--site site]
```

Example: `tabcap account list --site example`

| Option | Default | Meaning |
|---|---|---|
| `--site <site>` |  | only this site's accounts |

### `tabcap account set-state`

set an account active (also clears cooling and needs-human) or disabled (never allocated)

```
tabcap account set-state <account> active|disabled
```

Example: `tabcap account set-state example.alice disabled`

### `tabcap html`

one element's markup: outerHTML (default), --inner, --text or --attrs, by ref (frame refs too) or --css; read in an isolated world, read-only, secret-scrubbed

```
tabcap html [<ref>] [--session name] [--timeout ms] [--tab t2] [--css selector] [--inner] [--text] [--attrs] [--max-chars n]
```

Example: `tabcap html e12 --inner`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--css <selector>` |  | the first element this CSS selector matches in the root document, instead of a ref (`matched` counts all) |
| `--inner` |  | innerHTML instead of outerHTML |
| `--text` |  | textContent instead of markup |
| `--attrs` |  | only the element's attributes, as an object |
| `--max-chars <n>` | `4000` | cut the markup / text (each attribute value with --attrs); `truncated` and `chars` (the whole length) say so |

## Diagnostics (optional)

### `tabcap trace start`

trace mode for the session (every tab, frame and worker, now and later): records which page scripts read which browser signals (navigator, screen, time zone, canvas, WebGL …) via debugger breakpoints into `signal` events; changes no page state, but scripts run slower and the timing is observable; --decode is the observe mode instead (in-page decoding): JSON.parse breakpoints file the plaintext the page parses, never a CryptoKey

```
tabcap trace start [--session name] [--apis file] [--stack n] [--first-n n] [--max-hits n] [--decode] [--no-decode]
```

Example: `tabcap trace start --decode`

| Option | Default | Meaning |
|---|---|---|
| `--apis <file>` |  | signal list file: a JSON array of API names in IDL form (else ~/.config/tabcap/signals.json, else the built-in list) |
| `--stack <n>` | `8` | stack frames kept per signal event |
| `--first-n <n>` | `20` | signal events with a stack per (api, caller); later ones only count |
| `--max-hits <n>` | `500` | reads of one API in one document before its breakpoint is removed (the event gets truncated: true) |
| `--decode` |  | observe mode instead of signal tracing (no signal breakpoints; not with --apis): every JSON.parse of a string of 32+ chars pauses, and a plaintext tied to a response that looks like ciphertext is filed as a decoded view by "page" (evidence.link strong / weak; config.json trace.weakRows false counts weak ones as drops.weak instead); turn it off after the recording (config.json trace.decode sets the default; TextDecoder / SubtleCrypto pauses are evidence only) |
| `--no-decode` |  | start without the observe mode, whatever config.json says |

### `tabcap trace stop`

end trace mode: breakpoints removed, debugger off, open documents written to the recording; with --decode on, the parses still pending are decided first and `decode` counts them (decidedAtStop)

```
tabcap trace stop [--session name] [--verbose]
```

Example: `tabcap trace stop`

| Option | Default | Meaning |
|---|---|---|
| `--verbose` |  | with --decode on: the counters behind the compact decode block too (armed, held, settling, rows.attributed, unattributedKept, evidenceHits, recovered, walks, sinks, drops by reason) |

### `tabcap trace status`

trace mode state: on | paused (handoff) | off, active APIs, names skipped in this browser, per-document read counts; with --decode on, `decode` {on, weakRows, rows {strong, weak, unattributed}, pending, dropped}

```
tabcap trace status [--session name] [--verbose]
```

Example: `tabcap trace status`

| Option | Default | Meaning |
|---|---|---|
| `--verbose` |  | with --decode on: the counters behind the compact decode block too (armed, held, settling, rows.attributed, unattributedKept, evidenceHits, recovered, walks, sinks, drops by reason) |

### `tabcap trace list`

API × script table of the signal reads in the session's recording (open documents included): read counts, caller line:col (1-based), documents, truncated, value recorded

```
tabcap trace list [--session name] [--api name] [--script url] [--text] [--reveal]
```

Example: `tabcap trace list --api Navigator.prototype.userAgent`

| Option | Default | Meaning |
|---|---|---|
| `--api <name>` |  | only this API (exact name, e.g. Navigator.prototype.userAgent) |
| `--script <url>` |  | only scripts whose URL contains this text |
| `--text` |  | print a text report instead of JSON |
| `--reveal` |  | print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>) |

### `tabcap fingerprint probe`

the values this browser presents for a fixed signal list (navigator, UA client hints, screen, time zone, canvas / audio hashes, WebGL, voices, fonts, permissions, media queries): the probe page in a new background tab, closed afterwards; while recording, a `state` env event in the bundle. Read-only

```
tabcap fingerprint probe [--session name] [--timeout ms] [--ref name] [--text]
```

Example: `tabcap fingerprint probe --ref daily --text`

| Option | Default | Meaning |
|---|---|---|
| `--ref <name>` |  | add this reference (saved with `fingerprint serve`) as a second column with a verdict per field: same / differs / missing (this browser lacks a field the reference has) / extra (this browser has a field the reference lacks) |
| `--text` |  | print a text table instead of JSON |

### `tabcap wire serve`

local TLS echo on 127.0.0.1 until Ctrl-C (prints {url, port, caPath} first): answers every request with the wire report of its own connection (TLS ClientHello, JA3 / JA4, HTTP/2 settings and frames, header order) as JSON; trust it with the CA from `tabcap wire ca-path`

```
tabcap wire serve [--port port] [--capture-dir dir]
```

Example: `tabcap wire serve --port 4443`

| Option | Default | Meaning |
|---|---|---|
| `--port <port>` | `0` | port on 127.0.0.1 (0: any free port) |
| `--capture-dir <dir>` |  | also write every report with its raw ClientHello and request bytes here |

### `tabcap wire version`

version, path and sha256 of the native wire component (extracted from the tabcap binary into the cache on first use)

```
tabcap wire version
```

Example: `tabcap wire version`

### `tabcap wire ca-path`

path of the wire echo's CA certificate (a test CA for 127.0.0.1 only), for clients that verify TLS

```
tabcap wire ca-path
```

Example: `tabcap wire ca-path`

### `tabcap wire profile`

capture the browser baseline: a background tab of the session (the Chrome for Testing tabcap launched, its own flags) ignores certificate errors for itself only, navigates to the local echo and runs a page fetch, N times each; writes the wire profile (navigation and fetch header orders, TLS from all samples, CfT version and the launch flags' sha256) to the cache and prints it

```
tabcap wire profile [--session name] [--timeout ms] [--samples n] [--port port]
```

Example: `tabcap wire profile --samples 3`

| Option | Default | Meaning |
|---|---|---|
| `--samples <n>` | `3` | navigations and page fetches to capture (2 or more tell a random extension order from a fixed one) |
| `--port <port>` | `0` | echo port on 127.0.0.1 (0: any free port) |

### `tabcap wire probe`

compare the generated Python client with the browser baseline on the local echo: `uv run client.py wire-report` sends one GET to 127.0.0.1, then per layer (tls, h2, headers) same / differs / missing with the differing fields, and the checks against the profile; diagnostic only (says which layer differs, not why a site refused anything); with a recording open, one finding per differing layer

```
tabcap wire probe [--session name] [--timeout ms] --client <dir> [--port port] [--samples n] [--text]
```

Example: `tabcap wire probe --client ./client --text`

| Option | Default | Meaning |
|---|---|---|
| `--client <dir>` |  | directory of a client from `tabcap replay export-python` (required) |
| `--port <port>` | `0` | echo port on 127.0.0.1 (0: any free port) |
| `--samples <n>` | `3` | samples when the baseline has to be captured |
| `--text` |  | print a table instead of JSON (the envelope's data is schema tabcap-wire/0) |

### `tabcap fingerprint serve`

serve the signal probe page on 127.0.0.1 for your own browser: open the printed URL by hand and press Save as reference (written to config/fingerprint/refs/<name>.json, 0600); Ctrl-C to stop

```
tabcap fingerprint serve [--port port] [--once] [--force]
```

Example: `tabcap fingerprint serve --once`

| Option | Default | Meaning |
|---|---|---|
| `--port <port>` | `0` | port on 127.0.0.1 (0: any free port) |
| `--once` |  | exit after the first saved reference |
| `--force` |  | let a save replace an existing reference of the same name |

### `tabcap fingerprint ref list`

saved references: name, savedAt, userAgent, file

```
tabcap fingerprint ref list
```

Example: `tabcap fingerprint ref list`

### `tabcap fingerprint ref show`

one saved reference with all its fields

```
tabcap fingerprint ref show <name>
```

Example: `tabcap fingerprint ref show daily`

### `tabcap fingerprint ref remove`

delete a saved reference

```
tabcap fingerprint ref remove <name>
```

Example: `tabcap fingerprint ref remove daily`

### `tabcap fingerprint diff`

the last `state` env event of a bundle (from `fingerprint probe`) against a saved reference, offline: the same output as `fingerprint probe --ref`

```
tabcap fingerprint diff <bundle> --ref <name> [--text]
```

Example: `tabcap fingerprint diff ./b --ref daily`

| Option | Default | Meaning |
|---|---|---|
| `--ref <name>` |  | the reference to compare with (required) |
| `--text` |  | print a text table instead of JSON |
