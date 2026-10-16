// Command table: one entry per CLI command. It drives parsing, `--help`,
// `tabcap schema --json`, the generated command tables in README.md,
// README.zh-CN.md and skills/tabcap/references/commands.md (`bun run gen:docs`),
// and the mapping to daemon actions, so the CLI stays a thin shell (docs/08 §2)
// with one source of truth.
//
// Names follow the Chrome DevTools MCP tool surface (docs/08 §5, owner decision
// 10-15): `press-key`, `tab list` / `tab select`, `console list` / `console show`,
// `--page-size` / `--page-idx`, `--file-path` … The 0.3 aliases of the old
// names were removed in 0.4 (owner, 2026-10-16: no compatibility kept).

import { TabcapError } from "../shared/envelope.ts";
import { TOOL_NAME, TOOL_VERSION } from "../bundle/manifest.ts";

/** `optnum`: a flag whose number value may be omitted (`--idle` or `--idle 800`). */
export type FlagKind = "string" | "bool" | "number" | "optnum";
export type FlagSpec = {
  flag: string;
  key: string;
  kind: FlagKind;
  help: string;
  /** Value used when the flag is absent (for `optnum`: when given without a number). */
  default?: string | number;
  /** Placeholder shown in usage lines (default `v`, or `ms` for timeouts). */
  metavar?: string;
  /** Second spelling of the same flag (e.g. `-o` / `--out`). */
  alias?: string;
  /** The command fails without it. */
  required?: boolean;
  /** May be given more than once; the value is then a list of strings. */
  repeat?: boolean;
};

export type CommandSpec = {
  path: string[];
  /** Positional argument keys; a trailing "..." on the last one joins the rest with spaces. */
  pos: string[];
  /** Positionals that may be omitted. */
  optional?: number;
  /** Allowed values of a positional, by key. */
  choices?: Record<string, string[]>;
  flags: FlagSpec[];
  summary: string;
  example: string;
  /** Daemon action; absent for commands the CLI runs itself. */
  action?: string;
  /** Plumbing, not for users or agents: listed in the schema, left out of the docs. */
  internal?: boolean;
  /** Never echo argument values in errors (a stray positional may be a password). */
  quiet?: boolean;
  /** Arguments always sent with this command (e.g. `tab new` = navigate in a new tab). */
  fixed?: Record<string, string | number | boolean>;
  /** The trailing variadic positional is kept as a list (file paths), not joined with spaces. */
  restList?: boolean;
  /** Argument keys holding local file paths: the CLI resolves them against its own working directory. */
  localPaths?: string[];
};

const SESSION: FlagSpec = { flag: "--session", key: "session", kind: "string", help: "session name; else $TABCAP_SESSION", default: "default", metavar: "name" };
const TIMEOUT: FlagSpec = { flag: "--timeout", key: "timeoutMs", kind: "number", help: "command timeout in ms", default: 30000, metavar: "ms" };
const T = [SESSION, TIMEOUT];
const TAB: FlagSpec = { flag: "--tab", key: "tab", kind: "string", help: "act on this tab of the session (e.g. a popup from `tabcap tab list`) instead of its current tab", metavar: "t2" };
/** Session, timeout and --tab: the flags of commands that act on one tab. */
const TT = [SESSION, TIMEOUT, TAB];
const WAIT_TIMEOUT: FlagSpec = { flag: "--timeout", key: "timeoutMs", kind: "number", help: "give up after this many ms (max 120000)", default: 10000, metavar: "ms" };
/** Flags most browser commands share; the generated docs mention them once instead of per row. */
export const COMMON_FLAGS: readonly string[] = ["--session", "--timeout"];
const COMMON_KEYS: ReadonlySet<string> = new Set(["session", "timeoutMs"]);
/** A shared --session / --timeout (not an offline command's own flag that happens to share the spelling, e.g. analyze deps --session). */
export const isCommonFlag = (f: FlagSpec, skip: readonly string[] = COMMON_FLAGS): boolean => skip.includes(f.flag) && COMMON_KEYS.has(f.key);
const NO_WAIT: FlagSpec = {
  flag: "--no-wait",
  key: "noWait",
  kind: "bool",
  help: "return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling)",
};
/** Flags of the interactive commands (docs/08 §5): post-action wait control and the fresh snapshot. */
const INTERACT: FlagSpec[] = [NO_WAIT, { flag: "--snapshot", key: "snapshot", kind: "bool", help: "also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait" }];

export const COMMANDS: CommandSpec[] = [
  {
    path: ["setup"],
    pos: [],
    flags: [
      { flag: "--executable-path", key: "executablePath", kind: "string", help: "use this Chrome for Testing binary instead of downloading", metavar: "path" },
      { flag: "--platform", key: "platform", kind: "string", help: "mac-arm64 | mac-x64 | linux64 | win64 (default: this machine)", metavar: "platform" },
    ],
    summary: "download Chrome for Testing (Stable) into the cache and record it in config.json",
    example: "tabcap setup",
  },
  { path: ["daemon", "start"], pos: [], flags: [], summary: "start the background daemon", example: "tabcap daemon start" },
  { path: ["daemon", "stop"], pos: [], flags: [], summary: "stop the daemon (closes the browser, finishes recordings)", example: "tabcap daemon stop" },
  { path: ["daemon", "status"], pos: [], flags: [], summary: "daemon and browser status, open recordings", example: "tabcap daemon status" },
  { path: ["daemon", "run"], pos: [], flags: [], summary: "run the daemon in the foreground (used by `daemon start`)", example: "tabcap daemon run", internal: true },
  {
    path: ["browser", "start"],
    pos: [],
    flags: [
      { flag: "--proxy", key: "proxy", kind: "string", help: "system (default) | none (block everything but 127.0.0.1/localhost) | <url>", metavar: "mode" },
      { flag: "--foreground", key: "foreground", kind: "bool", help: "open new tabs as the active tab of the window (still never steals the macOS foreground)" },
      { flag: "--executable-path", key: "executablePath", kind: "string", help: "Chrome for Testing binary (else $TABCAP_CHROME, config.json, cache)", metavar: "path" },
    ],
    summary: "launch the dedicated Chrome for Testing (own profile, CDP over a pipe)",
    example: "tabcap browser start --proxy none",
    action: "browser.start",
  },
  { path: ["browser", "stop"], pos: [], flags: [], summary: "close the browser (recordings are finished first)", example: "tabcap browser stop", action: "browser.stop" },
  { path: ["browser", "status"], pos: [], flags: [], summary: "browser status", example: "tabcap browser status", action: "browser.status" },
  {
    path: ["site", "add"],
    pos: ["name"],
    quiet: true,
    flags: [
      { flag: "--url", key: "url", kind: "string", help: "entry URL of the site", required: true, metavar: "entry" },
      { flag: "--user", key: "user", kind: "string", help: "account username (not a secret: shown in listings)", required: true, metavar: "username" },
      { flag: "--domains", key: "domains", kind: "string", help: "comma list of the site's domains (default: the entry URL's host)", metavar: "a,b" },
      { flag: "--notes", key: "notes", kind: "string", help: "free-text note", metavar: "text" },
      { flag: "--password-stdin", key: "passwordStdin", kind: "bool", help: "read the password from stdin (else an interactive prompt; never an argument)" },
    ],
    summary: "add a site and its account to the local store (state.db, 0600); for the human, not the AI: the password is typed at a prompt or piped, never passed as an argument",
    example: "tabcap site add example --url https://example.com/login --user alice",
  },
  { path: ["site", "list"], pos: [], flags: [], summary: "stored sites: name, entry URL, domains, usernames and the secret references to use (never secret values)", example: "tabcap site list" },
  { path: ["site", "remove"], pos: ["name"], flags: [], summary: "delete a site with its accounts and guard counters from the store", example: "tabcap site remove example" },
  {
    path: ["proxy", "add"],
    pos: ["name"],
    quiet: true,
    flags: [
      { flag: "--url", key: "url", kind: "string", help: "scheme://host:port (http, https, socks4, socks5); never credentials", required: true, metavar: "scheme://host:port" },
      { flag: "--user", key: "user", kind: "string", help: "proxy username (not a secret: shown in listings); SOCKS with a username is refused (Chrome offers no-auth SOCKS only)", metavar: "username" },
      { flag: "--password-stdin", key: "passwordStdin", kind: "bool", help: "read the proxy password from stdin (else an interactive prompt when --user is given; never an argument)" },
      { flag: "--bypass", key: "bypass", kind: "string", help: "Chrome proxy bypass list for the account's browser context, e.g. \"<-loopback>\" to send loopback through the proxy too", metavar: "list" },
    ],
    summary: "add a proxy to the local store (state.db, 0600) for the account pool; for the human: the password is typed at a prompt or piped, never passed as an argument, and never shown in tabcap output",
    example: "tabcap proxy add p1 --url http://127.0.0.1:8080 --user pool1 --password-stdin",
  },
  { path: ["proxy", "list"], pos: [], flags: [], summary: "stored proxies: name, scheme, host:port, user, hasAuth, bypass, state, last check (never the password)", example: "tabcap proxy list" },
  { path: ["proxy", "remove"], pos: ["name"], flags: [], summary: "delete a proxy no account is bound to", example: "tabcap proxy remove p1" },
  {
    path: ["proxy", "check"],
    pos: ["name"],
    flags: [{ flag: "--url", key: "url", kind: "string", help: "address to fetch through the proxy (else config.json pool.health.url; with neither nothing is contacted and the state is unchecked)", metavar: "url" }],
    summary: "one health check through the proxy: unknown → up on success; 3 failures in a row → down (rechecked after 1 / 5 / 15 min)",
    example: "tabcap proxy check p1 --url http://127.0.0.1:8080/",
  },
  {
    path: ["proxy", "set-state"],
    pos: ["name", "state"],
    choices: { state: ["active", "disabled"] },
    flags: [],
    summary: "disable a proxy by hand (skipped by allocation and rotation, never checked) or set it active again (back to unknown until the next check)",
    example: "tabcap proxy set-state p1 disabled",
  },
  {
    path: ["account", "add"],
    pos: ["site"],
    quiet: true,
    flags: [
      { flag: "--user", key: "user", kind: "string", help: "account username (not a secret: shown in listings)", required: true, metavar: "username" },
      { flag: "--password-stdin", key: "passwordStdin", kind: "bool", help: "read the password from stdin (else an interactive prompt; never an argument)" },
      { flag: "--totp-stdin", key: "totpStdin", kind: "bool", help: "also store a TOTP seed: needs --password-stdin, stdin is two lines (password, then seed)" },
    ],
    summary: "add another account to a stored site (for the human, not the AI: the password is typed at a prompt or piped, never an argument, never shown); a duplicate <site>.<user> is refused",
    example: "tabcap account add example --user bob --password-stdin",
  },
  { path: ["account", "remove"], pos: ["account"], flags: [], summary: "delete a stored account with its saved cookies and counters; refused while a session uses it", example: "tabcap account remove example.bob" },
  {
    path: ["account", "bind"],
    pos: ["account"],
    flags: [{ flag: "--proxy", key: "proxy", kind: "string", help: "a proxy name: the account gets its own browser context through it; system / none: the browser's own context and proxy flags", required: true, metavar: "name|system|none" }],
    summary: "bind a stored account (<site>.<user>) to a proxy, or to the browser's own network (system / none)",
    example: "tabcap account bind example.alice --proxy p1",
  },
  {
    path: ["account", "list"],
    pos: [],
    flags: [{ flag: "--site", key: "site", kind: "string", help: "only this site's accounts", metavar: "site" }],
    summary: "stored accounts: state (active / cooling / needs-human / disabled), coolUntil, proxy, lastUsedAt (never passwords)",
    example: "tabcap account list --site example",
  },
  {
    path: ["account", "set-state"],
    pos: ["account", "state"],
    choices: { state: ["active", "disabled"] },
    flags: [],
    summary: "set an account active (also clears cooling and needs-human) or disabled (never allocated)",
    example: "tabcap account set-state example.alice disabled",
  },
  {
    path: ["session", "start"],
    pos: ["name"],
    flags: [
      { flag: "--site", key: "site", kind: "string", help: "bind a stored site: its account is used by fill --secret and recorded in the bundle manifest", metavar: "site" },
      {
        flag: "--account",
        key: "account",
        kind: "string",
        help: "which of the site's accounts (default: its first); auto = pick by config.json pool.strategy (fixed / round-robin / lru); an account bound to a proxy gets its own browser context through it",
        metavar: "user|auto",
      },
    ],
    summary: "create a session (navigate also creates it); --site binds a stored site → entryUrl, the secret references, account and proxy (names only)",
    example: "tabcap session start example --site example",
    action: "session.start",
  },
  { path: ["session", "stop"], pos: ["name"], flags: [], summary: "close the session's own tabs (never tabs it did not open) and finish its recording", example: "tabcap session stop example", action: "session.stop" },
  { path: ["session", "list"], pos: [], flags: [], summary: "list sessions", example: "tabcap session list", action: "session.list" },
  {
    path: ["navigate"],
    pos: ["url"],
    flags: [...TT, { flag: "--new-tab", key: "newTab", kind: "bool", help: "open a new background tab (it becomes the session's current tab)" }, NO_WAIT],
    summary: "load a URL in the session's tab (opens a background tab if needed), wait until ready and the DOM is quiet → tab, url, title, readyState, nav",
    example: "tabcap navigate http://127.0.0.1:8080/ --session example",
    action: "navigate",
  },
  { path: ["tab", "list"], pos: [], flags: [SESSION], summary: "list the session's tabs (never other tabs): tab id, url, title, owned, popup opener, current", example: "tabcap tab list", action: "tabs" },
  {
    path: ["tab", "select"],
    pos: ["tab"],
    flags: [
      SESSION,
      {
        flag: "--bring-to-front",
        key: "bringToFront",
        kind: "bool",
        help: "also bring the tab and Chrome to the front (focus ladder level 3: Page.bringToFront takes the macOS foreground; only when the human is to look at it)",
      },
    ],
    summary: "make one of the session's tabs (e.g. a popup) its current tab for later commands; never brings it to the front unless --bring-to-front",
    example: "tabcap tab select t2",
    action: "tab.use",
  },
  {
    path: ["tab", "new"],
    pos: ["url"],
    flags: [...T, { flag: "--background", key: "background", kind: "bool", help: "open in the background even when the browser was started with --foreground (background is the default otherwise)" }, NO_WAIT],
    summary: "open a new tab in the session, load a URL and make it the current tab (same as navigate --new-tab)",
    example: "tabcap tab new http://127.0.0.1:8080/",
    action: "navigate",
    fixed: { newTab: true },
  },
  { path: ["tab", "close"], pos: ["tab"], flags: [SESSION], summary: "close one of the session's tabs", example: "tabcap tab close t2", action: "tab.close" },
  { path: ["go"], pos: ["direction"], choices: { direction: ["back", "forward"] }, flags: [...TT, NO_WAIT], summary: "history back / forward, waits until ready and the DOM is quiet", example: "tabcap go back", action: "go" },
  {
    path: ["reload"],
    pos: [],
    flags: [...TT, { flag: "--ignore-cache", key: "ignoreCache", kind: "bool", help: "reload without the HTTP cache (like Shift+reload)" }, NO_WAIT],
    summary: "reload the current tab, waits until ready and the DOM is quiet",
    example: "tabcap reload --ignore-cache",
    action: "reload",
  },
  {
    path: ["snapshot"],
    pos: [],
    flags: [
      ...TT,
      { flag: "--interactive", key: "interactive", kind: "bool", help: "only controls (buttons, links, inputs …) and their ancestors" },
      { flag: "--verbose", key: "verbose", kind: "bool", help: "the full tree: keep unnamed wrappers and text that repeats its parent's name, add descriptions and capability flags (focusable, expandable …)" },
      { flag: "--max-chars", key: "maxChars", kind: "number", help: "truncate the tree text", default: 60000, metavar: "n" },
      { flag: "--file-path", key: "filePath", kind: "string", help: "write the tree text to this file and return its path instead of the tree", metavar: "path" },
    ],
    summary:
      "accessibility tree as indented text, one element per line: role \"name\" [ref] flags (e.g. `- button \"Save\" [e12] disabled`); refs are for click / fill and expire when the document changes; starts with the overlay header (overlays / detected, counts toward --max-chars)",
    example: "tabcap snapshot --interactive",
    action: "snapshot",
    localPaths: ["filePath"],
  },
  {
    path: ["outline"],
    pos: [],
    flags: [...TT, { flag: "--max-chars", key: "maxChars", kind: "number", help: "truncate the outline text", default: 6000, metavar: "n" }],
    summary:
      "page map head: tab line, overlays (dialogs, masks, iframe layers, timeout prompts, consent banners, with close-button refs), detected (adapters, with confidence), popups; read-only, never closes anything",
    example: "tabcap outline",
    action: "outline",
  },
  { path: ["find"], pos: ["text..."], flags: TT, summary: "search the accessibility tree (name, value, description); up to 20 hits with refs, clickable ones first", example: "tabcap find Add to cart", action: "find" },
  {
    path: ["click"],
    pos: ["ref"],
    flags: [
      ...TT,
      {
        flag: "--trusted",
        key: "trusted",
        kind: "bool",
        help: "trusted input via focus emulation: mouse path to the target, press, 50–140 ms, release (all events isTrusted); a tab not confirmed painted falls back to the DOM click (degraded: not-painted); fails honestly if not delivered, never retries",
      },
      { flag: "--dbl-click", key: "dblClick", kind: "bool", help: "double click (DOM: two clicks and a dblclick event; --trusted: two presses, Chrome fires dblclick)" },
      ...INTERACT,
    ],
    summary:
      "click an element by ref (default: DOM el.click(), eventShape incomplete), then wait for a navigation it starts and for the DOM to settle; fails with `covered` when an overlay is in front (its close-button refs are in the error; tabcap never closes it)",
    example: "tabcap click e12",
    action: "click",
  },
  {
    path: ["hover"],
    pos: ["ref"],
    flags: [...TT, ...INTERACT],
    summary: "move the mouse over an element by ref (trusted input via focus emulation: a mouse path ending on its centre; menus and tooltips open as for a real pointer); needs a painted tab",
    example: "tabcap hover e4",
    action: "hover",
  },
  {
    path: ["fill"],
    pos: ["ref", "text..."],
    optional: 1,
    flags: [
      ...TT,
      { flag: "--trusted", key: "trusted", kind: "bool", help: "focus emulation + Input.insertText" },
      { flag: "--secret", key: "secret", kind: "string", help: "fill a stored value instead of text: <site>.password or <site>.username (the daemon fills it; output shows <secret:…>)", metavar: "site.field" },
      { flag: "--confirm", key: "confirm", kind: "bool", help: "allow a second --secret password fill in this session (only after the human said so)" },
      ...INTERACT,
    ],
    summary: "set a text field's value, React-safe (password values are masked everywhere); --secret fills from the store, one password fill per site per session (guard.login-limit)",
    example: "tabcap fill e7 --secret example.password",
    action: "fill",
  },
  {
    path: ["type"],
    pos: ["text..."],
    flags: [
      ...TT,
      { flag: "--trusted", key: "trusted", kind: "bool", help: "one key event pair per character (keydown … keyup), insertText for characters without a US-layout key (eventShape keys)" },
      { flag: "--delay", key: "delay", kind: "number", help: "with --trusted: ms between two characters", default: 0, metavar: "ms" },
      { flag: "--insert", key: "insert", kind: "bool", help: "one Input.insertText for the whole text, no key events (the default; eventShape insert)" },
      { flag: "--submit-key", key: "submitKey", kind: "string", help: "press this key after typing, e.g. Enter or Tab", metavar: "key" },
      ...INTERACT,
    ],
    summary: "type into the element that has focus now (focus it first with click or fill). Default / --insert: one insertText, no key events (eventShape insert); --trusted: per-key events",
    example: "tabcap type hello --submit-key Enter",
    action: "type",
  },
  {
    path: ["press-key"],
    pos: ["key"],
    flags: [...TT, ...INTERACT],
    summary: "press a key or a combination on the focused element: Enter, Tab, Escape, ArrowDown, a, Shift+Tab, Control+a, Control+Shift+R … (modifiers: Control, Shift, Alt, Meta)",
    example: "tabcap press-key Enter",
    action: "press",
  },
  {
    path: ["upload"],
    pos: ["ref", "files..."],
    restList: true,
    localPaths: ["files"],
    flags: [...TT, { flag: "--snapshot", key: "snapshot", kind: "bool", help: "also return a fresh snapshot taken after the upload" }],
    summary: "put local files into a file input by ref (DOM.setFileInputFiles); for an element that opens a file chooser instead, it is clicked and the chooser answered",
    example: "tabcap upload e9 ./photo.png",
    action: "upload",
  },
  {
    path: ["evaluate"],
    pos: ["expression..."],
    optional: 1,
    flags: [
      ...TT,
      { flag: "--await", key: "await", kind: "bool", help: "await a returned promise" },
      { flag: "--function", key: "function", kind: "string", help: "a function declaration to call instead of an expression, e.g. '(a, b) => a + b' or 'el => el.innerText' (promises are awaited)", metavar: "js" },
      { flag: "--args", key: "args", kind: "string", help: "with --function: JSON array of arguments; {\"ref\":\"e12\"} passes that element", metavar: "json" },
    ],
    summary: "run JavaScript in the page (an expression, or --function with --args) and return a JSON value (truncated at 60000 chars)",
    example: "tabcap evaluate 'document.title'",
    action: "evaluate",
  },
  {
    path: ["screenshot"],
    pos: [],
    flags: [
      ...TT,
      { flag: "--file-path", key: "filePath", kind: "string", help: "image path (default under ~/.local/share/tabcap/shots/)", metavar: "path" },
      { flag: "--full-page", key: "fullPage", kind: "bool", help: "the whole page, not just the viewport (not with --ref)" },
      { flag: "--format", key: "format", kind: "string", help: "png | jpeg | webp", default: "png", metavar: "png|jpeg|webp" },
      { flag: "--quality", key: "quality", kind: "number", help: "jpeg / webp quality 0–100 (ignored for png)", metavar: "0-100" },
      { flag: "--ref", key: "ref", kind: "string", help: "only this element (a ref from snapshot)", metavar: "e12" },
    ],
    summary: "save an image of the tab, the full page or one element (works on background tabs) → path, width, height (never the image itself)",
    example: "tabcap screenshot --full-page",
    action: "screenshot",
    localPaths: ["filePath"],
  },
  {
    path: ["resize"],
    pos: ["width", "height"],
    flags: TT,
    summary: "resize the tab's window so the page gets this content size in CSS px (other tabs in the same window change too)",
    example: "tabcap resize 1280 800",
    action: "resize",
  },
  {
    path: ["emulate"],
    pos: [],
    flags: [
      ...TT,
      { flag: "--viewport", key: "viewport", kind: "string", help: "<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]", metavar: "WxHxDPR" },
      { flag: "--user-agent", key: "userAgent", kind: "string", help: "user agent string; empty clears the override", metavar: "ua" },
      { flag: "--color-scheme", key: "colorScheme", kind: "string", help: "dark | light | auto (auto: the default)", metavar: "dark|light|auto" },
      { flag: "--network-conditions", key: "networkConditions", kind: "string", help: "Offline | Slow 3G | Fast 3G | Slow 4G | Fast 4G", metavar: "preset" },
      { flag: "--cpu-throttling-rate", key: "cpuThrottlingRate", kind: "number", help: "CPU slowdown factor 1–20 (1: off)", metavar: "n" },
      { flag: "--geolocation", key: "geolocation", kind: "string", help: "<latitude>,<longitude>", metavar: "lat,lon" },
    ],
    summary:
      "emulate a device on the tab: viewport, user agent, colour scheme, network and CPU throttling, geolocation. Each call replaces all earlier settings of the tab: a setting left out is cleared",
    example: "tabcap emulate --viewport 390x844x3,mobile,touch",
    action: "emulate",
  },
  {
    path: ["dialog"],
    pos: ["op"],
    choices: { op: ["status", "accept", "dismiss"] },
    flags: [...TT, { flag: "--text", alias: "--prompt-text", key: "text", kind: "string", help: "answer for a prompt() dialog", metavar: "text" }],
    summary: "status | accept | dismiss the JavaScript dialog blocking the tab (while one is open other commands fail with code dialog)",
    example: "tabcap dialog accept",
    action: "dialog",
  },
  {
    path: ["net", "start"],
    pos: [],
    flags: [SESSION],
    summary: "record the session's traffic (requests with bodies, WebSocket frames, console) into a bundle under ~/.local/share/tabcap/bundles/",
    example: "tabcap net start",
    action: "net.start",
  },
  { path: ["net", "stop"], pos: [], flags: [SESSION], summary: "finish the recording (bundle manifest gets `finished`)", example: "tabcap net stop", action: "net.stop" },
  {
    path: ["net", "list"],
    pos: [],
    flags: [
      SESSION,
      { flag: "--filter", key: "filter", kind: "string", help: "URL substring", metavar: "s" },
      { flag: "--host", key: "host", kind: "string", help: "host[:port] substring", metavar: "s" },
      { flag: "--status", key: "status", kind: "string", help: "status code or class: 200 | 2xx | 3xx | 4xx | 5xx", metavar: "code" },
      { flag: "--method", key: "method", kind: "string", help: "only this HTTP method", metavar: "M" },
      { flag: "--resource-types", key: "types", kind: "string", help: "comma list: xhr,fetch,document,script …", metavar: "xhr,fetch" },
      { flag: "--tab", key: "tab", kind: "string", help: "only requests of this tab", metavar: "t2" },
      { flag: "--since", key: "since", kind: "string", help: "only requests finished after this command started (the `cmd` id commands return while recording)", metavar: "c-12" },
      { flag: "--failed", key: "failed", kind: "bool", help: "only failed requests (hidden by default)" },
      { flag: "--no-failed", key: "noFailed", kind: "bool", help: "hide failed requests (the default)" },
      { flag: "--all", key: "all", kind: "bool", help: "also failed requests and data: URLs" },
      { flag: "--page-size", key: "pageSize", kind: "number", help: "requests per page (max 1000); 0 returns every match", default: 100, metavar: "n" },
      { flag: "--page-idx", key: "pageIdx", kind: "number", help: "page to return, 0-based; nextPageIdx names the next one", default: 0, metavar: "n" },
      { flag: "--kind", key: "kind", kind: "string", help: "http (requests) | ws (WebSocket frames: id, direction, opcode, size, ts)", default: "http", metavar: "http|ws" },
    ],
    summary:
      "recorded requests, oldest first: id, method, url (cut at 255 chars; net show has it whole), status, mime, size, outcome, cmd; always total / matched / shown / hidden {failed, data} (failed and data: are hidden unless asked for); 100 per page unless --page-size (0: everything) (--kind ws: WebSocket frames r-12:34)",
    example: "tabcap net list --resource-types xhr,fetch --status 2xx",
    action: "net.list",
  },
  {
    path: ["net", "body"],
    pos: ["id"],
    flags: [SESSION, { flag: "--out", key: "out", kind: "string", help: "copy the body to this file", metavar: "path" }],
    summary: "a response body (r-12) or WebSocket frame payload (r-12:34) as a file path + a text preview of up to 10000 chars (never the whole body inline)",
    example: "tabcap net body r-12",
    action: "net.body",
    localPaths: ["out"],
  },
  {
    path: ["net", "show"],
    pos: ["id"],
    flags: [SESSION],
    summary: "one request in full: method, url, status, request / response headers, postData (over 2 KB: path + first 2 KB), body path, timing, initiator, nav, tab, outcome; r-12:34 shows a WebSocket frame",
    example: "tabcap net show r-12",
    action: "net.show",
  },
  {
    path: ["console", "list"],
    pos: [],
    flags: [
      SESSION,
      TAB,
      { flag: "--types", key: "types", kind: "string", help: "comma list of message types: log, debug, info, error, warn, dir, table, trace, assert, count, timeEnd, verbose …", metavar: "error,warn" },
      { flag: "--level", key: "level", kind: "string", help: "debug | log | info | warn | error: that level and more severe (log = info)", metavar: "level" },
      { flag: "--page-size", key: "pageSize", kind: "number", help: "messages per page (max 1000); 0 returns every buffered message", default: 100, metavar: "n" },
      { flag: "--page-idx", key: "pageIdx", kind: "number", help: "page to return, 0-based; nextPageIdx names the next one", default: 0, metavar: "n" },
      { flag: "--limit", key: "limit", kind: "number", help: "only the last N messages (instead of paging)", metavar: "n" },
      { flag: "--include-stack-traces", key: "includeStackTraces", kind: "bool", help: "include each message's stack trace when there is one" },
      { flag: "--clear", key: "clear", kind: "bool", help: "empty the tab's buffer after reading" },
    ],
    summary: "the tab's console, oldest first (last 500 messages, kept even when not recording): msgid, type, level, source, text (4 KB max), url:line:col",
    example: "tabcap console list --types error,warn",
    action: "console.list",
  },
  {
    path: ["console", "show"],
    pos: ["msgid"],
    flags: [SESSION, TAB],
    summary: "one console message by msgid (from console list): text, arguments, location, stack trace",
    example: "tabcap console show 3",
    action: "console.show",
  },
  {
    path: ["wait"],
    pos: [],
    flags: [
      SESSION,
      WAIT_TIMEOUT,
      TAB,
      { flag: "--text", key: "text", kind: "string", help: "visible text appears in the page or any of its frames (polled every 100 ms); repeat it to wait for any of several texts", metavar: "text", repeat: true },
      { flag: "--selector", key: "selector", kind: "string", help: "a CSS selector matches an element (polled)", metavar: "css" },
      { flag: "--url", key: "url", kind: "string", help: "the tab's URL contains this substring (navigation events)", metavar: "s" },
      { flag: "--idle", key: "idle", kind: "optnum", help: "no request in flight for N ms", default: 500 },
      { flag: "--fn", key: "fn", kind: "string", help: "a JavaScript expression becomes truthy (polled; promises are awaited)", metavar: "js" },
    ],
    summary: "wait for one condition on the current tab; returns what matched, or error timeout naming what is still outstanding",
    example: "tabcap wait --text 'Order placed' --text 'Payment failed' --timeout 20000",
    action: "wait",
  },
  {
    path: ["net", "wait"],
    pos: [],
    flags: [
      SESSION,
      WAIT_TIMEOUT,
      { flag: "--url", key: "url", kind: "string", help: "URL substring of the request", required: true, metavar: "s" },
      { flag: "--method", key: "method", kind: "string", help: "only this HTTP method", metavar: "M" },
      { flag: "--tab", key: "tab", kind: "string", help: "only requests of this tab", metavar: "t2" },
      { flag: "--since", key: "since", kind: "string", help: "look back to this command's start (c-12), or `start` for the whole recording", metavar: "c-12|start" },
      { flag: "--fresh", key: "fresh", kind: "bool", help: "only requests finishing after the wait begins" },
    ],
    summary: "wait until a matching request finished with its body stored (needs net start). Counts requests since the start of the last action command (navigate, tab new, click, hover, fill, type, press-key, upload, go, reload, evaluate) → id, status, body path",
    example: "tabcap net wait --url /api/search --method POST",
    action: "net.wait",
  },
  {
    path: ["where"],
    pos: ["query..."],
    flags: [
      ...T,
      {
        flag: "--as",
        key: "as",
        kind: "string",
        help: "what the input is: ref (a snapshot ref; its visible text is looked up) or text (the value as typed). Default: e<n> is a ref while the session's tab has a current snapshot, anything else text",
        metavar: "ref|text",
      },
      { flag: "--top", key: "top", kind: "number", help: "candidates to return (1-100)", default: 5, metavar: "n" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON (the envelope's data is schema tabcap-where/0)" },
      { flag: "--write-findings", key: "writeFindings", kind: "bool", help: "append finding events (tool where; 实测 for exact matches, 推断 for normalized ones) to the session's bundle; default: the bundle is only read" },
    ],
    summary:
      "which recorded response carries a value the page shows (a snapshot ref's visible text, or a text): JSON paths through analyze find's decode chain, then HTML text nodes (selectors), matched exactly or after normalisation (thousands / decimal separators, accounting negatives, full-width, nbsp, YYYY-MM dates, dotted codes, DR / CR); searches only the session's recording and sends no request",
    example: "tabcap where e12",
    action: "where",
  },
  { path: ["handoff", "status"], pos: [], flags: [SESSION], summary: "is the session handed to the human? state running | waiting | resumed, reason, screenshot, handler answers", example: "tabcap handoff status", action: "handoff.status" },
  {
    path: ["handoff", "continue"],
    pos: [],
    flags: [SESSION],
    summary: "end a waiting state after the human finished in the browser (run it only when they say so)",
    example: "tabcap handoff continue",
    action: "handoff.continue",
  },
  {
    path: ["trace", "start"],
    pos: [],
    flags: [
      SESSION,
      { flag: "--apis", key: "apis", kind: "string", help: "signal list file: a JSON array of API names in IDL form (else ~/.config/tabcap/signals.json, else the built-in list)", metavar: "file" },
      { flag: "--stack", key: "stack", kind: "number", help: "stack frames kept per signal event", default: 8, metavar: "n" },
      { flag: "--first-n", key: "firstN", kind: "number", help: "signal events with a stack per (api, caller); later ones only count", default: 20, metavar: "n" },
      { flag: "--max-hits", key: "maxHits", kind: "number", help: "reads of one API in one document before its breakpoint is removed (the event gets truncated: true)", default: 500, metavar: "n" },
    ],
    summary:
      "trace mode for the session (every tab, frame and worker, now and later): records which page scripts read which browser signals (navigator, screen, time zone, canvas, WebGL …) via debugger breakpoints into `signal` events; read-only, changes nothing in the page, but scripts run slower and the timing is observable",
    example: "tabcap trace start",
    action: "trace.start",
    localPaths: ["apis"],
  },
  { path: ["trace", "stop"], pos: [], flags: [SESSION], summary: "end trace mode: breakpoints removed, debugger off, open documents written to the recording", example: "tabcap trace stop", action: "trace.stop" },
  {
    path: ["trace", "status"],
    pos: [],
    flags: [SESSION],
    summary: "trace mode state: on | paused (handoff) | off, active APIs, names skipped in this browser, per-document read counts",
    example: "tabcap trace status",
    action: "trace.status",
  },
  {
    path: ["trace", "list"],
    pos: [],
    flags: [
      SESSION,
      { flag: "--api", key: "api", kind: "string", help: "only this API (exact name, e.g. Navigator.prototype.userAgent)", metavar: "name" },
      { flag: "--script", key: "script", kind: "string", help: "only scripts whose URL contains this text", metavar: "url" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON" },
    ],
    summary: "API × script table of the signal reads in the session's recording (open documents included): read counts, caller line:col (1-based), documents, truncated, value recorded",
    example: "tabcap trace list --api Navigator.prototype.userAgent",
    action: "trace.list",
  },
  {
    path: ["fingerprint", "probe"],
    pos: [],
    flags: [
      ...T,
      { flag: "--ref", key: "ref", kind: "string", help: "add this reference (saved with `fingerprint serve`) as a second column with a verdict per field: same / differs / missing (this browser lacks a field the reference has) / extra (this browser has a field the reference lacks)", metavar: "name" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text table instead of JSON" },
    ],
    summary:
      "the values this browser presents for a fixed signal list (navigator, UA client hints, screen, time zone, canvas / audio hashes, WebGL, voices, fonts, permissions, media queries): the probe page in a new background tab, closed afterwards; while recording, a `state` env event in the bundle. Read-only",
    example: "tabcap fingerprint probe --ref daily --text",
    action: "fingerprint.probe",
  },
  { path: ["plugin", "list"], pos: [], flags: [], summary: "challenge handlers installed under ~/.config/tabcap/plugins/ (none ship with tabcap): name, hooks, enabled, errors", example: "tabcap plugin list" },
  { path: ["plugin", "enable"], pos: ["name"], flags: [], summary: "let the guard ask this handler before handing a challenge to the human", example: "tabcap plugin enable my-handler" },
  { path: ["plugin", "disable"], pos: ["name"], flags: [], summary: "stop asking this handler", example: "tabcap plugin disable my-handler" },
  // Offline commands: no daemon. Parsed by src/cli/main.ts (bundle), src/cli/analyze.ts and src/cli/replay.ts.
  {
    path: ["bundle", "export", "har"],
    pos: ["bundle"],
    flags: [
      { flag: "--out", key: "out", kind: "string", help: "HAR file (default <bundle>/exports/har-<time>.har)", metavar: "file" },
      { flag: "--tab", key: "tab", kind: "string", help: "only this tab", metavar: "t1" },
      { flag: "--types", key: "types", kind: "string", help: "only these resource types", metavar: "xhr,fetch" },
      { flag: "--embed-events", key: "embedEvents", kind: "bool", help: "also embed every event as log._events (lossless round trip)" },
      { flag: "--no-redact", key: "noRedact", kind: "bool", help: "skip redaction (default: redacted with a per-export salt)" },
    ],
    summary: "export a bundle as HAR 1.2 (redacted by default)",
    example: "tabcap bundle export har ~/.local/share/tabcap/bundles/default-… --types xhr,fetch",
  },
  {
    path: ["bundle", "import", "har"],
    pos: ["file"],
    flags: [{ flag: "-o", alias: "--out", key: "out", kind: "string", help: "new bundle directory", metavar: "bundle", required: true }],
    summary: "import a HAR (DevTools, Charles, mitmproxy …) as a bundle, so analyze works on it",
    example: "tabcap bundle import har site.har -o ./site-bundle",
  },
  { path: ["bundle", "redact"], pos: ["in", "out"], flags: [], summary: "write a redacted copy of a bundle (the original is never changed)", example: "tabcap bundle redact ./b ./b-redacted" },
  { path: ["bundle", "info"], pos: ["bundle"], flags: [], summary: "bundle summary: counts, event kinds, finished or not, issues", example: "tabcap bundle info ./b" },
  {
    path: ["analyze", "find"],
    pos: ["bundle", "text..."],
    flags: [
      { flag: "--ignore-case", key: "ignoreCase", kind: "bool", help: "case-insensitive match" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON" },
      { flag: "--save", key: "save", kind: "bool", help: "append the result as a finding event (finished bundles only)" },
    ],
    summary: "which request / WebSocket frame / console line carries this text, through a bounded decode chain (base64, gzip / br, urldecode, JSON, html entities …); 0 hits come with hints",
    example: "tabcap analyze find ./b 'Order placed'",
  },
  {
    path: ["analyze", "diff"],
    pos: ["bundle1", "bundle2", "bundles..."],
    optional: 1,
    flags: [
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON" },
      { flag: "--save", key: "save", kind: "bool", help: "append the result as a finding event to the first bundle" },
    ],
    summary: "compare recordings of the same action: which parameters are constant, per session, timestamps or varying",
    example: "tabcap analyze diff ./b1 ./b2",
  },
  {
    path: ["analyze", "deps"],
    pos: ["bundle"],
    flags: [
      { flag: "--session", key: "bundleSession", kind: "string", help: "only requests recorded under this session name", metavar: "name" },
      { flag: "--request", key: "request", kind: "string", help: "only this request (sources are still searched in the whole bundle)", metavar: "r-N" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON (the envelope's data is schema tabcap-deps/0)" },
      { flag: "--write-findings", key: "writeFindings", kind: "bool", help: "append finding events (tool deps) to the bundle (finished bundles only); default: the bundle is only read" },
    ],
    summary:
      "value-flow dependency graph: for every request input (query, body leaves, x-* / authorization headers, cookies) its source in earlier events (set-cookie, response body path, recorded fill / type, earlier request, constant, timestamp), else computed-in-page / unrecorded; exact matches only, never guessed",
    example: "tabcap analyze deps ./b --request r-12",
  },
  {
    path: ["analyze", "chain"],
    pos: ["bundle"],
    flags: [
      { flag: "--request", key: "request", kind: "string", help: "target request (default: the last data-bearing xhr / fetch / document request)", metavar: "r-N" },
      { flag: "--session", key: "bundleSession", kind: "string", help: "pick the default target among requests of this session name", metavar: "name" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON (the envelope's data is schema tabcap-chain/0)" },
    ],
    summary: "the requests needed to reproduce one request, from the deps graph, in recording order: what each step provides to later ones and what it still needs from the caller (computed-in-page, unrecorded, user input)",
    example: "tabcap analyze chain ./b --request r-12",
  },
  {
    path: ["replay", "serve"],
    pos: ["bundle"],
    flags: [
      { flag: "--port", key: "port", kind: "number", help: "port to listen on (0: any free port)", default: 4500, metavar: "port" },
      { flag: "--host", key: "host", kind: "string", help: "loopback address only: 127.0.0.1, ::1 or localhost", default: "127.0.0.1", metavar: "host" },
      { flag: "--strict", key: "strict", kind: "string", help: "also match these request headers", metavar: "h1,h2" },
      { flag: "--match-cookies", key: "matchCookies", kind: "bool", help: "also match the cookie header" },
      { flag: "--json", key: "json", kind: "bool", help: "print {port, bundle, routes} as one JSON envelope (else text, one log line per request on stderr)" },
      { flag: "--once", key: "once", kind: "number", help: "stop after this many seconds (tests)", metavar: "seconds" },
    ],
    summary:
      "serve a bundle's recorded responses on a loopback port until Ctrl-C: match = method + path + sorted query + body sha256; repeated matches cycle in recorded order (header x-tabcap-replay: r-N;n=k); no match → 404 with the nearest recordings and what differs",
    example: "tabcap replay serve ./b --port 4500",
  },
  {
    path: ["replay", "session"],
    pos: ["bundle"],
    optional: 1,
    flags: [
      { flag: "--out", alias: "-o", key: "out", kind: "string", help: "storageState file to write (0600)", required: true, metavar: "file" },
      { flag: "--site", key: "site", kind: "string", help: "use the store's saved session of this site (saved at session stop / handoff continue) when there is no bundle or it has no cookie snapshot", metavar: "site" },
    ],
    summary:
      "write the recording's cookies (latest state snapshot), or with --site and no bundle the store's saved session, as a Playwright storageState file, mode 0600; it holds live session cookies, values are never printed",
    example: "tabcap replay session ./b -o storage-state.json",
  },
  {
    path: ["replay", "export-python"],
    pos: ["bundle"],
    flags: [
      { flag: "--out", alias: "-o", key: "out", kind: "string", help: "directory for the generated package", required: true, metavar: "dir" },
      { flag: "--include", key: "include", kind: "string", help: "only paths matching these globs (* within a segment, ** across)", metavar: "glob,glob" },
      { flag: "--exclude", key: "exclude", kind: "string", help: "leave out paths matching these globs", metavar: "glob,glob" },
      { flag: "--chain", key: "chain", kind: "bool", help: "use the deps graph and the chain to the last data-bearing request: computed-in-page inputs become TODO parameters, values from earlier responses become arguments, plus verify() and verify_expected.json (default when the graph links any request to an earlier response)" },
      { flag: "--no-chain", key: "noChain", kind: "bool", help: "0.3 behaviour: per-request heuristics only, no verify()" },
      {
        flag: "--proxy-env",
        key: "proxyEnv",
        kind: "string",
        help: "also write TABCAP_PROXY_URL (the bundle account's proxy, with its credentials) to this file, mode 0600; never printed. The generated client reads TABCAP_PROXY_URL",
        metavar: "file",
      },
    ],
    summary:
      "generate an httpx client (one function per request group, TypedDict responses), fixtures and a pytest suite that runs against replay serve; with the chain, computed-in-page inputs are TODO parameters and verify() replays the chain; otherwise signature-like parameters and encrypted bodies become NotImplementedError TODOs",
    example: "tabcap replay export-python ./b -o ./client",
  },
  {
    path: ["replay", "check"],
    pos: ["bundle"],
    flags: [
      { flag: "--against", key: "against", kind: "string", help: "target origin; non-loopback needs --live", default: "http://127.0.0.1:4500", metavar: "url" },
      { flag: "--live", key: "live", kind: "bool", help: "allow a non-loopback target: needs a stored site (--site or the bundle's), paced and counted per site; goes out through the account's proxy when it is bound to one" },
      { flag: "--rate", key: "rate", kind: "number", help: "live requests per second (default 0.5)", metavar: "n" },
      { flag: "--site", key: "site", kind: "string", help: "stored site whose guard counters a live check uses", metavar: "site" },
      { flag: "--filter", key: "filter", kind: "string", help: "only paths matching these globs", metavar: "glob,glob" },
      { flag: "--headers", key: "headers", kind: "string", help: "response headers to compare when recorded", default: "content-type,location", metavar: "h1,h2" },
      { flag: "--with-cookies", key: "withCookies", kind: "bool", help: "also send the recorded cookie header" },
      { flag: "--json", key: "json", kind: "bool", help: "print one JSON envelope instead of the table" },
    ],
    summary: "send every recorded request again and compare status, headers and body field by field with the recording; exit 1 on any difference",
    example: "tabcap replay check ./b --against http://127.0.0.1:4500",
  },
  // Wire level (0.4-W2, docs/07 §6): the local echo, the browser baseline and the probe; 127.0.0.1 only.
  {
    path: ["wire", "serve"],
    pos: [],
    flags: [
      { flag: "--port", key: "port", kind: "number", help: "port on 127.0.0.1 (0: any free port)", default: 0, metavar: "port" },
      { flag: "--capture-dir", key: "captureDir", kind: "string", help: "also write every report with its raw ClientHello and request bytes here", metavar: "dir" },
    ],
    summary:
      "local TLS echo on 127.0.0.1 until Ctrl-C (prints {url, port, caPath} first): answers every request with the wire report of its own connection (TLS ClientHello, JA3 / JA4, HTTP/2 settings and frames, header order) as JSON; trust it with the CA from `tabcap wire ca-path`",
    example: "tabcap wire serve --port 4443",
  },
  { path: ["wire", "version"], pos: [], flags: [], summary: "version, path and sha256 of the native wire component (extracted from the tabcap binary into the cache on first use)", example: "tabcap wire version" },
  { path: ["wire", "ca-path"], pos: [], flags: [], summary: "path of the wire echo's CA certificate (a test CA for 127.0.0.1 only), for clients that verify TLS", example: "tabcap wire ca-path" },
  {
    path: ["wire", "profile"],
    pos: [],
    flags: [
      SESSION,
      { flag: "--timeout", key: "timeoutMs", kind: "number", help: "command timeout in ms", default: 120000, metavar: "ms" },
      { flag: "--samples", key: "samples", kind: "number", help: "navigations and page fetches to capture (2 or more tell a random extension order from a fixed one)", default: 3, metavar: "n" },
      { flag: "--port", key: "port", kind: "number", help: "echo port on 127.0.0.1 (0: any free port)", default: 0, metavar: "port" },
    ],
    summary:
      "capture the browser baseline: a background tab of the session (the Chrome for Testing tabcap launched, its own flags) ignores certificate errors for itself only, navigates to the local echo and runs a page fetch, N times each; writes the wire profile (navigation and fetch header orders, TLS from all samples, CfT version and the launch flags' sha256) to the cache and prints it",
    example: "tabcap wire profile --samples 3",
    action: "wire.profile",
  },
    path: ["fingerprint", "serve"],
    pos: [],
    flags: [
      { flag: "--port", key: "port", kind: "number", help: "port on 127.0.0.1 (0: any free port)", default: 0, metavar: "port" },
      { flag: "--once", key: "once", kind: "bool", help: "exit after the first saved reference" },
      { flag: "--force", key: "force", kind: "bool", help: "let a save replace an existing reference of the same name" },
    ],
    summary:
      "serve the signal probe page on 127.0.0.1 for your own browser: open the printed URL by hand and press Save as reference (written to config/fingerprint/refs/<name>.json, 0600); Ctrl-C to stop",
    example: "tabcap fingerprint serve --once",
  },
  { path: ["fingerprint", "ref", "list"], pos: [], flags: [], summary: "saved references: name, savedAt, userAgent, file", example: "tabcap fingerprint ref list" },
  { path: ["fingerprint", "ref", "show"], pos: ["name"], flags: [], summary: "one saved reference with all its fields", example: "tabcap fingerprint ref show daily" },
  { path: ["fingerprint", "ref", "remove"], pos: ["name"], flags: [], summary: "delete a saved reference", example: "tabcap fingerprint ref remove daily" },
  {
    path: ["fingerprint", "diff"],
    pos: ["bundle"],
    flags: [
      { flag: "--ref", key: "ref", kind: "string", help: "the reference to compare with", required: true, metavar: "name" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text table instead of JSON" },
    ],
    summary: "the last `state` env event of a bundle (from `fingerprint probe`) against a saved reference, offline: the same output as `fingerprint probe --ref`",
    example: "tabcap fingerprint diff ./b --ref daily",
  },
  {
    path: ["schema"],
    pos: [],
    flags: [{ flag: "--json", key: "json", kind: "bool", help: "print the bare schema document (no envelope)" }],
    summary: "this command table as JSON: names, arguments, flags with types and defaults, help, examples",
    example: "tabcap schema --json",
  },
];

/** The spec for an exact command path; throws (a bug) when the table lacks it. */
export function specOf(path: string): CommandSpec {
  const c = COMMANDS.find((x) => x.path.join(" ") === path);
  if (c === undefined) throw new TabcapError("internal", `no command spec for ${path}`, "This is a bug.");
  return c;
}

/** Every spelling of every flag of a command (for the hand-written bundle / analyze parsers). */
export function flagNames(c: CommandSpec): string[] {
  return c.flags.flatMap(spellingsOf);
}

/** Every spelling of one flag: the name and its alias. */
export function spellingsOf(f: FlagSpec): string[] {
  return [f.flag, ...(f.alias === undefined ? [] : [f.alias])];
}

/** Commands for users and agents: everything but plumbing. */
export function currentCommands(): CommandSpec[] {
  return COMMANDS.filter((c) => c.internal !== true);
}

const BUNDLE_PATHS = ["bundle export har", "bundle import har", "bundle redact", "bundle info"];
export const BUNDLE_USAGE: string[] = BUNDLE_PATHS.map((p) => usageOf(specOf(p)));

function posName(c: CommandSpec, p: string): string {
  if (p.endsWith("...")) return `<${p.slice(0, -3)}>`;
  const choices = c.choices?.[p];
  return choices === undefined ? `<${p}>` : choices.join("|");
}

function flagUsage(f: FlagSpec): string {
  if (f.kind === "bool") return `[${f.flag}]`;
  if (f.kind === "optnum") return `[${f.flag} [ms]]`;
  const v = `${f.flag} ${f.metavar ?? (f.key === "timeoutMs" ? "ms" : "v")}`;
  if (f.required === true) return f.metavar === undefined ? v : `${f.flag} <${f.metavar}>`;
  return f.repeat === true ? `[${v}]...` : `[${v}]`;
}

/** One-line usage; `skip` leaves out flags by name (the docs omit the common ones). */
export function usageOf(c: CommandSpec, skip: readonly string[] = []): string {
  const pos = c.pos.map((p, i) => {
    const name = c.restList === true && i === c.pos.length - 1 ? `${posName(c, p)}...` : posName(c, p);
    return c.optional !== undefined && i >= c.pos.length - c.optional ? `[${name}]` : name;
  });
  const flags = c.flags.filter((f) => !isCommonFlag(f, skip)).map(flagUsage);
  return [TOOL_NAME, ...c.path, ...pos, ...flags].join(" ");
}

export function helpAll(): string {
  const shown = COMMANDS;
  const w = Math.max(...shown.map((c) => c.path.join(" ").length));
  const lines = [
    "tabcap — a dedicated browser for AI agents: background tabs, refs, network capture.",
    "Every command prints one JSON envelope: {ok:true,data} or {ok:false,error:{code,message,next}}.",
    "",
    "Commands:",
    ...shown.map((c) => `  ${c.path.join(" ").padEnd(w)}  ${c.summary}\n  ${"".padEnd(w)}  e.g. ${c.example}`),
    "",
    "Start: tabcap setup && tabcap daemon start && tabcap browser start",
    "Then:  tabcap navigate <url> → tabcap snapshot --interactive → tabcap click <ref> / tabcap fill <ref> <text>",
    "More:  tabcap <command> --help (or tabcap <group> --help, e.g. tabcap net --help); tabcap schema --json for tools; tabcap --version",
  ];
  return lines.join("\n");
}

/** Help for a command group (`tabcap net --help`): its subcommands, or null when `group` is no group. */
export function helpGroup(group: string): string | null {
  const subs = COMMANDS.filter((c) => c.path[0] === group && c.path.length > 1 && c.internal !== true);
  if (subs.length === 0) return null;
  return [
    `${TOOL_NAME} ${group} — subcommands:`,
    ...subs.map((c) => `  ${usageOf(c, COMMON_FLAGS)}\n      ${c.summary}`),
    "",
    `More: ${TOOL_NAME} ${group} <subcommand> --help`,
  ].join("\n");
}

function flagHelp(f: FlagSpec): string {
  const base = f.default === undefined ? f.help : `${f.help} [default: ${f.default}]`;
  const repeat = f.repeat === true ? " (repeatable)" : "";
  return base + repeat;
}

export function helpFor(c: CommandSpec): string {
  const lines = [`Usage: ${usageOf(c)}`, "", c.summary, "", `Example: ${c.example}`];
  if (c.flags.length > 0) {
    lines.push("", "Options:");
    for (const f of c.flags) {
      const name = (f.alias === undefined ? f.flag : `${f.flag}, ${f.alias}`) + (f.kind === "bool" ? "" : f.kind === "optnum" ? " [ms]" : ` <${f.metavar ?? "v"}>`);
      lines.push(`  ${name.padEnd(22)} ${flagHelp(f)}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- schema

export const SCHEMA_ID = "tabcap-cli-schema/0";

export type SchemaFlag = {
  flag: string;
  alias: string | null;
  key: string;
  type: "string" | "boolean" | "number";
  /** `--idle` style: the number may be left out, then `default` applies. */
  valueOptional: boolean;
  required: boolean;
  default: string | number | boolean | null;
  help: string;
  /** May be given more than once (the value is a list). */
  repeatable: boolean;
};

export type SchemaCommand = {
  name: string;
  path: string[];
  usage: string;
  summary: string;
  example: string;
  positionals: { name: string; required: boolean; variadic: boolean; choices: string[] | null }[];
  flags: SchemaFlag[];
  /** Needs the running daemon (and usually the browser). */
  daemon: boolean;
  internal: boolean;
};

export type Schema = {
  schema: string;
  tool: string;
  version: string;
  envelope: { ok: string; error: string };
  commands: SchemaCommand[];
};

function schemaFlag(f: FlagSpec): SchemaFlag {
  const type = f.kind === "bool" ? "boolean" : f.kind === "string" ? "string" : "number";
  return {
    flag: f.flag,
    alias: f.alias ?? null,
    key: f.key,
    type,
    valueOptional: f.kind === "optnum",
    required: f.required === true,
    default: f.default ?? (f.kind === "bool" ? false : null),
    help: f.help,
    repeatable: f.repeat === true,
  };
}

/** The registry as a plain, stable JSON document (`tabcap schema --json`). */
export function schema(): Schema {
  return {
    schema: SCHEMA_ID,
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    envelope: { ok: "{ok:true,data}", error: "{ok:false,error:{code,message,next}}" },
    commands: COMMANDS.map((c) => {
      const required = c.pos.length - (c.optional ?? 0);
      return {
        name: c.path.join(" "),
        path: [...c.path],
        usage: usageOf(c),
        summary: c.summary,
        example: c.example,
        positionals: c.pos.map((p, i) => {
          const variadic = p.endsWith("...");
          const name = variadic ? p.slice(0, -3) : p;
          return { name, required: i < required, variadic, choices: c.choices?.[p] ?? null };
        }),
        flags: c.flags.map(schemaFlag),
        daemon: c.action !== undefined,
        internal: c.internal === true,
      };
    }),
  };
}

// ---------------------------------------------------------------- parsing


/** Longest command path that prefixes argv's positionals. */
export function matchCommand(words: readonly string[]): CommandSpec | null {
  let best: CommandSpec | null = null;
  for (const c of COMMANDS) {
    if (c.path.every((p, i) => words[i] === p) && (best === null || c.path.length > best.path.length)) best = c;
  }
  return best;
}

export type ParsedCommand = { args: Record<string, unknown>; session: string | null; help: boolean };

/** Parse argv (after the command path) against the spec. `--` ends options. */
export function parseCommand(c: CommandSpec, argv: readonly string[]): ParsedCommand {
  const usage = `Usage: ${usageOf(c)}`;
  const args: Record<string, unknown> = {};
  const pos: string[] = [];
  let session: string | null = null;
  let help = false;
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (rest || !a.startsWith("--") || a === "--") {
      if (a === "--" && !rest) rest = true;
      else pos.push(a);
      continue;
    }
    if (a === "--help") {
      help = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    const spec = c.flags.find((f) => spellingsOf(f).includes(name));
    if (spec === undefined) throw new TabcapError("usage", `unknown option ${name}`, usage);
    let value: string | undefined;
    if (spec.kind === "bool") {
      if (eq > 0) throw new TabcapError("usage", `${name} takes no value`, usage);
    } else if (spec.kind === "optnum") {
      const next = argv[i + 1];
      if (eq > 0) value = a.slice(eq + 1);
      else if (next !== undefined && /^\d+(\.\d+)?$/.test(next)) value = argv[++i];
      if (value === undefined) {
        args[spec.key] = true;
        continue;
      }
    } else {
      value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new TabcapError("usage", `${name} needs a value`, usage);
    }
    if (spec.key === "session") session = value ?? null;
    else if (spec.kind === "bool") args[spec.key] = true;
    else if (spec.repeat === true) {
      const prev = args[spec.key];
      args[spec.key] = [...(Array.isArray(prev) ? prev : []), value ?? ""];
    }
    else if (spec.kind === "number" || spec.kind === "optnum") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new TabcapError("usage", `${name} must be a number`, usage);
      args[spec.key] = n;
    } else args[spec.key] = value;
  }
  if (help) return { args, session, help };
  for (const [k, v] of Object.entries(c.fixed ?? {})) args[k] = v;
  const required = c.pos.length - (c.optional ?? 0);
  for (let i = 0; i < c.pos.length; i++) {
    const key = c.pos[i] ?? "";
    const last = i === c.pos.length - 1;
    if (key.endsWith("...") && last) {
      if (pos.length > i) args[key.slice(0, -3)] = c.restList === true ? pos.slice(i) : pos.slice(i).join(" ");
      else if (i < required) throw new TabcapError("usage", `missing <${key.slice(0, -3)}>`, usage);
      return { args, session, help };
    }
    const v = pos[i];
    if (v === undefined) {
      if (i < required) throw new TabcapError("usage", `missing <${key}>`, usage);
    } else args[key] = v;
  }
  if (pos.length > c.pos.length) throw new TabcapError("usage", c.quiet === true ? `unexpected argument #${c.pos.length + 1} (value not shown)` : `unexpected argument: ${pos[c.pos.length] ?? ""}`, usage);
  return { args, session, help };
}
