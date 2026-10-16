<!-- GENERATED from src/cli/commands.ts by `bun run gen:docs`; do not edit by hand. -->

# tabcap command reference

Every command prints one JSON envelope on stdout: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","next"}}`. Browser commands also take `--session <name>` (else `$TABCAP_SESSION`, else `default`) and most take `--timeout <ms>` (default 30000; `wait` / `net wait` 10000); they are left out below. `tabcap <command> --help` prints the same as one section here; `tabcap schema --json` is the machine-readable form.

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

launch the dedicated Chrome for Testing (own profile, CDP over a pipe)

```
tabcap browser start [--proxy mode] [--foreground] [--executable-path path]
```

Example: `tabcap browser start --proxy none`

| Option | Default | Meaning |
|---|---|---|
| `--proxy <mode>` |  | system (default) \| none (block everything but 127.0.0.1/localhost) \| <url> |
| `--foreground` |  | open new tabs as the active tab of the window (still never steals the macOS foreground) |
| `--executable-path <path>` |  | Chrome for Testing binary (else $TABCAP_CHROME, config.json, cache) |

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
| `--domains <a,b>` |  | comma list of the site's domains (default: the entry URL's host) |
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
| `--account <user\|auto>` |  | which of the site's accounts (default: its first); auto = pick by config.json pool.strategy (fixed / round-robin / lru); an account bound to a proxy gets its own browser context through it |

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

open a new tab in the session, load a URL and make it the current tab (same as navigate --new-tab)

```
tabcap tab new <url> [--session name] [--timeout ms] [--background] [--no-wait]
```

Example: `tabcap tab new http://127.0.0.1:8080/`

| Option | Default | Meaning |
|---|---|---|
| `--background` |  | open in the background even when the browser was started with --foreground (background is the default otherwise) |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |

### `tabcap tab close`

close one of the session's tabs

```
tabcap tab close <tab> [--session name]
```

Example: `tabcap tab close t2`

## Navigation and page reading

### `tabcap navigate`

load a URL in the session's tab (opens a background tab if needed), wait until ready and the DOM is quiet → tab, url, title, readyState, nav

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

history back / forward, waits until ready and the DOM is quiet

```
tabcap go back|forward [--session name] [--timeout ms] [--tab t2] [--no-wait]
```

Example: `tabcap go back`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--no-wait` |  | return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling) |

### `tabcap reload`

reload the current tab, waits until ready and the DOM is quiet

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
tabcap snapshot [--session name] [--timeout ms] [--tab t2] [--interactive] [--verbose] [--max-chars n] [--file-path path] [--frames] [--frame f2/f1]
```

Example: `tabcap snapshot --interactive`

| Option | Default | Meaning |
|---|---|---|
| `--tab <t2>` |  | act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab |
| `--interactive` |  | only controls (buttons, links, inputs …) and their ancestors |
| `--verbose` |  | the full tree: keep unnamed wrappers and text that repeats its parent's name, add descriptions and capability flags (focusable, expandable …) |
| `--max-chars <n>` | `60000` | truncate the tree text |
| `--file-path <path>` |  | write the tree text to this file and return its path instead of the tree |
| `--frames` |  | also expand every child frame (iframes, frameset frames, cross-origin too); their refs carry the frame path, e.g. f2/f1/e7; --max-chars applies per frame |
| `--frame <f2/f1>` |  | expand only this frame and the frames inside it (the root document is listed in the header only) |

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

search the accessibility tree (name, value, description); up to 20 hits with refs, clickable ones first

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
| `--page-size <n>` | `100` | messages per page (max 1000); 0 returns every buffered message |
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

record the session's traffic (requests with bodies, WebSocket frames, console) into a bundle under ~/.local/share/tabcap/bundles/

```
tabcap net start [--session name]
```

Example: `tabcap net start`

### `tabcap net stop`

finish the recording (bundle manifest gets `finished`)

```
tabcap net stop [--session name]
```

Example: `tabcap net stop`

### `tabcap net list`

recorded requests, oldest first: id, method, url (cut at 255 chars; net show has it whole), status, mime, size, outcome, cmd; always total / matched / shown / hidden {failed, data} (failed and data: are hidden unless asked for); 100 per page unless --page-size (0: everything) (--kind ws: WebSocket frames r-12:34)

```
tabcap net list [--session name] [--filter s] [--host s] [--status code] [--method M] [--resource-types xhr,fetch] [--tab t2] [--since c-12] [--failed] [--no-failed] [--all] [--page-size n] [--page-idx n] [--kind http|ws]
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
| `--page-size <n>` | `100` | requests per page (max 1000); 0 returns every match |
| `--page-idx <n>` | `0` | page to return, 0-based; nextPageIdx names the next one |
| `--kind <http\|ws>` | `http` | http (requests) \| ws (WebSocket frames: id, direction, opcode, size, ts) |

### `tabcap net body`

a response body (r-12) or WebSocket frame payload (r-12:34) as a file path + a text preview of up to 10000 chars (never the whole body inline)

```
tabcap net body <id> [--session name] [--out path]
```

Example: `tabcap net body r-12`

| Option | Default | Meaning |
|---|---|---|
| `--out <path>` |  | copy the body to this file |

### `tabcap net show`

one request in full: method, url, status, request / response headers, postData (over 2 KB: path + first 2 KB), body path, timing, initiator, nav, tab, outcome; r-12:34 shows a WebSocket frame

```
tabcap net show <id> [--session name]
```

Example: `tabcap net show r-12`

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
tabcap recon [--session name] [--timeout ms] [--text]
```

Example: `tabcap recon --text`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print the Markdown dossier instead of the JSON envelope |

## Trace mode (signal reads)

### `tabcap trace start`

trace mode for the session (every tab, frame and worker, now and later): records which page scripts read which browser signals (navigator, screen, time zone, canvas, WebGL …) via debugger breakpoints into `signal` events; read-only, changes nothing in the page, but scripts run slower and the timing is observable

```
tabcap trace start [--session name] [--apis file] [--stack n] [--first-n n] [--max-hits n]
```

Example: `tabcap trace start`

| Option | Default | Meaning |
|---|---|---|
| `--apis <file>` |  | signal list file: a JSON array of API names in IDL form (else ~/.config/tabcap/signals.json, else the built-in list) |
| `--stack <n>` | `8` | stack frames kept per signal event |
| `--first-n <n>` | `20` | signal events with a stack per (api, caller); later ones only count |
| `--max-hits <n>` | `500` | reads of one API in one document before its breakpoint is removed (the event gets truncated: true) |

### `tabcap trace stop`

end trace mode: breakpoints removed, debugger off, open documents written to the recording

```
tabcap trace stop [--session name]
```

Example: `tabcap trace stop`

### `tabcap trace status`

trace mode state: on | paused (handoff) | off, active APIs, names skipped in this browser, per-document read counts

```
tabcap trace status [--session name]
```

Example: `tabcap trace status`

### `tabcap trace list`

API × script table of the signal reads in the session's recording (open documents included): read counts, caller line:col (1-based), documents, truncated, value recorded

```
tabcap trace list [--session name] [--api name] [--script url] [--text]
```

Example: `tabcap trace list --api Navigator.prototype.userAgent`

| Option | Default | Meaning |
|---|---|---|
| `--api <name>` |  | only this API (exact name, e.g. Navigator.prototype.userAgent) |
| `--script <url>` |  | only scripts whose URL contains this text |
| `--text` |  | print a text report instead of JSON |

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

### `tabcap plugin list`

challenge handlers installed under ~/.config/tabcap/plugins/ (none ship with tabcap): name, hooks, enabled, errors

```
tabcap plugin list
```

Example: `tabcap plugin list`

### `tabcap plugin enable`

let the guard ask this handler before handing a challenge to the human

```
tabcap plugin enable <name>
```

Example: `tabcap plugin enable my-handler`

### `tabcap plugin disable`

stop asking this handler

```
tabcap plugin disable <name>
```

Example: `tabcap plugin disable my-handler`

## Offline: bundles, analysis, replay

### `tabcap bundle export har`

export a bundle as HAR 1.2 (redacted by default)

```
tabcap bundle export har <bundle> [--out file] [--tab t1] [--types xhr,fetch] [--embed-events] [--no-redact]
```

Example: `tabcap bundle export har ~/.local/share/tabcap/bundles/default-… --types xhr,fetch`

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` |  | HAR file (default <bundle>/exports/har-<time>.har) |
| `--tab <t1>` |  | only this tab |
| `--types <xhr,fetch>` |  | only these resource types |
| `--embed-events` |  | also embed every event as log._events (lossless round trip) |
| `--no-redact` |  | skip redaction (default: redacted with a per-export salt) |

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

bundle summary: counts, event kinds, finished or not, issues

```
tabcap bundle info <bundle>
```

Example: `tabcap bundle info ./b`

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

compare recordings of the same action: which parameters are constant, per session, timestamps or varying

```
tabcap analyze diff <bundle1> <bundle2> [<bundles>] [--text] [--save]
```

Example: `tabcap analyze diff ./b1 ./b2`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print a text report instead of JSON |
| `--save` |  | append the result as a finding event to the first bundle |

### `tabcap analyze deps`

value-flow dependency graph: for every request input (query, body leaves, x-* / authorization headers, cookies) its source in earlier events (set-cookie, response body path, recorded fill / type, earlier request, constant, timestamp), else computed-in-page / unrecorded; exact matches only, never guessed

```
tabcap analyze deps <bundle> [--session name] [--request r-N] [--text] [--write-findings]
```

Example: `tabcap analyze deps ./b --request r-12`

| Option | Default | Meaning |
|---|---|---|
| `--session <name>` |  | only requests recorded under this session name |
| `--request <r-N>` |  | only this request (sources are still searched in the whole bundle) |
| `--text` |  | print a text report instead of JSON (the envelope's data is schema tabcap-deps/0) |
| `--write-findings` |  | append finding events (tool deps) to the bundle (finished bundles only); default: the bundle is only read |

### `tabcap analyze chain`

the requests needed to reproduce one request, from the deps graph, in recording order: what each step provides to later ones and what it still needs from the caller (computed-in-page, unrecorded, user input)

```
tabcap analyze chain <bundle> [--request r-N] [--session name] [--text]
```

Example: `tabcap analyze chain ./b --request r-12`

| Option | Default | Meaning |
|---|---|---|
| `--request <r-N>` |  | target request (default: the last data-bearing xhr / fetch / document request) |
| `--session <name>` |  | pick the default target among requests of this session name |
| `--text` |  | print a text report instead of JSON (the envelope's data is schema tabcap-chain/0) |

### `tabcap analyze recon`

the recon dossier offline (as `tabcap recon`), with the bundle's last recorded document standing in for the page (its HTML text, no adapter detection); writes exports/dossier.json and exports/dossier.md

```
tabcap analyze recon <bundle> [--text]
```

Example: `tabcap analyze recon ./b --text`

| Option | Default | Meaning |
|---|---|---|
| `--text` |  | print the Markdown dossier instead of the JSON envelope |

### `tabcap replay serve`

serve a bundle's recorded responses on a loopback port until Ctrl-C: match = method + path + sorted query + body sha256; repeated matches cycle in recorded order (header x-tabcap-replay: r-N;n=k); no match → 404 with the nearest recordings and what differs

```
tabcap replay serve <bundle> [--port port] [--host host] [--strict h1,h2] [--match-cookies] [--json] [--once seconds]
```

Example: `tabcap replay serve ./b --port 4500`

| Option | Default | Meaning |
|---|---|---|
| `--port <port>` | `4500` | port to listen on (0: any free port) |
| `--host <host>` | `127.0.0.1` | loopback address only: 127.0.0.1, ::1 or localhost |
| `--strict <h1,h2>` |  | also match these request headers |
| `--match-cookies` |  | also match the cookie header |
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
tabcap replay export-python <bundle> --out <dir> [--include glob,glob] [--exclude glob,glob] [--chain] [--no-chain] [--proxy-env file]
```

Example: `tabcap replay export-python ./b -o ./client`

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>`, `-o <dir>` |  | directory for the generated package (required) |
| `--include <glob,glob>` |  | only paths matching these globs (* within a segment, ** across) |
| `--exclude <glob,glob>` |  | leave out paths matching these globs |
| `--chain` |  | use the deps graph and the chain to the last data-bearing request: computed-in-page inputs become TODO parameters, values from earlier responses become arguments, plus verify() and verify_expected.json (default when the graph links any request to an earlier response) |
| `--no-chain` |  | 0.3 behaviour: per-request heuristics only, no verify() |
| `--proxy-env <file>` |  | also write TABCAP_PROXY_URL (the bundle account's proxy, with its credentials) to this file, mode 0600; never printed. The generated client reads TABCAP_PROXY_URL |

### `tabcap replay check`

send every recorded request again and compare status, headers and body field by field with the recording; exit 1 on any difference

```
tabcap replay check <bundle> [--against url] [--live] [--rate n] [--site site] [--filter glob,glob] [--headers h1,h2] [--with-cookies] [--json]
```

Example: `tabcap replay check ./b --against http://127.0.0.1:4500`

| Option | Default | Meaning |
|---|---|---|
| `--against <url>` | `http://127.0.0.1:4500` | target origin; non-loopback needs --live |
| `--live` |  | allow a non-loopback target: needs a stored site (--site or the bundle's), paced and counted per site; goes out through the account's proxy when it is bound to one |
| `--rate <n>` |  | live requests per second (default 0.5) |
| `--site <site>` |  | stored site whose guard counters a live check uses |
| `--filter <glob,glob>` |  | only paths matching these globs |
| `--headers <h1,h2>` | `content-type,location` | response headers to compare when recorded |
| `--with-cookies` |  | also send the recorded cookie header |
| `--json` |  | print one JSON envelope instead of the table |

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
| `--bypass <list>` |  | Chrome proxy bypass list for the account's browser context, e.g. "<-loopback>" to send loopback through the proxy too |

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
| `--proxy <name\|system\|none>` |  | a proxy name: the account gets its own browser context through it; system / none: the browser's own context and proxy flags (required) |

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
