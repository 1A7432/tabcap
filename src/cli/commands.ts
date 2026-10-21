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
import { MCP_HOSTS } from "../mcp/hosts.ts";
import { GUIDE_IDS } from "./guides.ts";

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
  /** A bool flag this value sets when given (for `--no-x` spellings: false). */
  value?: boolean;
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
/**
 * Output flags every command takes (0.5-C, owner 10-16): the generic
 * post-filters on the envelope's `data` and the output-budget bypass. The CLI
 * takes them out of argv before the command's own parser runs
 * (src/cli/main.ts), so they are listed once (`sharedFlags` in the schema, the
 * help index footer) rather than per command.
 */
export const OUTPUT_FLAGS: readonly FlagSpec[] = [
  { flag: "--select", key: "select", kind: "string", help: "keep only this part of data: a JSON path (docs/04 §43; $ optional): names, [n], [*], .*, [\"quoted name\"] (e.g. requests[*].url)", metavar: "path" },
  { flag: "--grep", key: "grep", kind: "string", help: "keep array elements whose JSON matches this regex (u flag, ≤ 256 chars); long text fields: matching lines with line numbers", metavar: "regex" },
  { flag: "--context", key: "context", kind: "number", help: "with --grep on text: lines around each match (max 20)", default: 0, metavar: "n" },
  { flag: "--max-matches", key: "maxMatches", kind: "number", help: "with --grep: keep at most this many matches (max 1000)", default: 50, metavar: "n" },
  { flag: "--fields", key: "fields", kind: "string", help: "project each array element to these keys", metavar: "a,b,c" },
  { flag: "--full", key: "full", kind: "bool", help: "print data whole even above TABCAP_OUTPUT_LIMIT (default 16384 bytes; above it data becomes {summary, file, bytes, truncated})" },
];
/** Commands that do not take an output flag: `screenshot --full` was renamed `--full-page` in 0.4 and stays an unknown option. */
export const OUTPUT_FLAGS_NOT_ON: Readonly<Record<string, readonly string[]>> = {
  "--full": ["screenshot"],
  // 0.5-F: these commands search inside themselves (lines with ancestors / line numbers), so their own
  // --grep / --context / --max-matches win over the generic post-filter.
  "--grep": ["snapshot", "net body"],
  "--context": ["snapshot", "net body", "net grep"],
  "--max-matches": ["snapshot", "net body", "net grep"],
};

/** 0.6-E: live outputs show sensitive values as <redacted:name> (docs/04 §8.3); the human may ask for them. */
const REVEAL: FlagSpec = {
  flag: "--reveal",
  key: "reveal",
  kind: "bool",
  help: "print sensitive header values, cookie values and sensitive-named query / body fields as recorded instead of <redacted:name> (only when the human asks; store secrets stay <secret:…>)",
};

/** 0.7.3: offline analyze / recon show recorded values as <redacted:<hash>> unless the human asks for them. */
const REVEAL_ANALYZE: FlagSpec = {
  flag: "--reveal",
  key: "reveal",
  kind: "bool",
  help: "print recorded cookie / authorization / set-cookie / sensitive-named parameter values instead of <redacted:…> (only when the human asks)",
};

const NO_WAIT: FlagSpec = {
  flag: "--no-wait",
  key: "noWait",
  kind: "bool",
  help: "return right after the action: skip the post-action wait (a navigation it starts, then 100 ms without DOM changes; 3 s at most, longer under emulate throttling)",
};
/** Flags of the interactive commands (docs/08 §5): post-action wait control and the fresh snapshot. */
/** `trace status` / `trace stop` (0.7-C): the observe mode's full counters, not only the compact `decode` block. */
const DECODE_VERBOSE: FlagSpec = {
  flag: "--verbose",
  key: "verbose",
  kind: "bool",
  help: "with --decode on: the counters behind the compact decode block too (armed, held, settling, rows.attributed, unattributedKept, evidenceHits, recovered, walks, sinks, drops by reason)",
};
const INTERACT: FlagSpec[] = [NO_WAIT, { flag: "--snapshot", key: "snapshot", kind: "bool", help: "also return a fresh snapshot (as `tabcap snapshot`) taken after the action and its wait" }];

export const COMMANDS: CommandSpec[] = [
  {
    path: ["guide"],
    pos: ["id"],
    optional: 1,
    flags: [{ flag: "--text", key: "text", kind: "bool", help: "print the list, or the guide's steps as a numbered shell block with `# why` comments, instead of JSON" }],
    summary: `task recipes, start here: no id lists them (id, title, when to use it); with an id, the commands in order with why, the pitfalls (implicit state too) and the references to read. Guides: ${GUIDE_IDS.join(", ")}`,
    example: "tabcap guide scrape-through-browser --text",
  },
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
  {
    path: ["update"],
    pos: [],
    flags: [{ flag: "--check", key: "check", kind: "bool", help: "only compare the running version with the latest release; run nothing" }],
    summary:
      "update tabcap itself: one request to the npm registry, only when run. An npm install runs `npm install -g tabcap@<latest>` with the npm that owns it, a Homebrew install `brew upgrade tabcap` with its brew (then restart a running daemon); a release package or source build is never replaced, the answer gives the release page. $TABCAP_NPM_REGISTRY overrides the registry URL, $TABCAP_NPM the npm executable, $TABCAP_BREW the brew executable",
    example: "tabcap update --check",
  },
  { path: ["daemon", "start"], pos: [], flags: [], summary: "start the background daemon", example: "tabcap daemon start" },
  { path: ["daemon", "stop"], pos: [], flags: [], summary: "stop the daemon (closes the browser, finishes recordings)", example: "tabcap daemon stop" },
  { path: ["daemon", "status"], pos: [], flags: [], summary: "daemon and browser status, open recordings", example: "tabcap daemon status" },
  {
    path: ["status"],
    pos: [],
    flags: [{ flag: "--text", key: "text", kind: "bool", help: "print one screen (a line per session, then the conflicts) instead of JSON" }],
    summary: "everything at once: daemon, browser, sessions (site, recording, waiting, trace, fetch stops), plugins, and conflicts with the next command",
    example: "tabcap status --text",
    action: "status",
  },
  { path: ["daemon", "run"], pos: [], flags: [], summary: "run the daemon in the foreground (used by `daemon start`)", example: "tabcap daemon run", internal: true },
  {
    path: ["browser", "start"],
    pos: [],
    flags: [
      { flag: "--proxy", key: "proxy", kind: "string", help: "system (default) | none (block everything but 127.0.0.1/localhost) | <url> (scheme://host:port, loopback goes through the proxy too; no user:pass@: a proxy with a password goes into the store with `tabcap proxy add`)", metavar: "mode" },
      { flag: "--webdriver", key: "webdriver", kind: "string", help: "hidden (default: navigator.webdriver reads false, a launch switch, no page script) | visible (Chrome's own value); default from config.json webdriver", metavar: "mode" },
      { flag: "--foreground", key: "foreground", kind: "bool", help: "open new tabs as the active tab of the window (still never steals the macOS foreground)" },
      { flag: "--executable-path", key: "executablePath", kind: "string", help: "Chrome for Testing binary (else $TABCAP_CHROME, config.json, cache)", metavar: "path" },
      {
        flag: "--chrome-arg",
        key: "chromeArg",
        kind: "string",
        repeat: true,
        help: "add a Chrome switch (--name or --name=value; write --chrome-arg=--name=value or --chrome-arg --name=value), after config.json chrome.args: list switches (--enable-features, --disable-features, the blink pair, --load-extension) merge into tabcap's own, others replace tabcap's switch of the same name; refused: --user-data-dir, --remote-debugging-pipe, proxy switches unless --proxy system",
        metavar: "switch",
      },
      {
        flag: "--drop-chrome-arg",
        key: "dropChromeArg",
        kind: "string",
        repeat: true,
        help: "remove one of tabcap's default switches (--name removes it, --disable-features=A,B removes those items), after config.json chrome.dropArgs; drops that match nothing are listed in dropArgsUnmatched; --user-data-dir and --remote-debugging-pipe / -port cannot be dropped, proxy switches only with --proxy system",
        metavar: "switch",
      },
    ],
    summary:
      "launch the dedicated Chrome for Testing (own profile, CDP over a pipe); the answer gives the full command line (args), the custom args in it (extraArgs, dropArgs) and warnings naming switches that weaken the browser's isolation",
    example: "tabcap browser start --proxy none --chrome-arg=--lang=en-US",
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
      { flag: "--domains", key: "domains", kind: "string", help: "comma list of the site's domains (default: the entry URL's host); subdomains count, a leading dot is dropped", metavar: "a,b" },
      { flag: "--notes", key: "notes", kind: "string", help: "free-text note", metavar: "text" },
      { flag: "--password-stdin", key: "passwordStdin", kind: "bool", help: "read the password from stdin (else an interactive prompt; never an argument)" },
    ],
    summary: "add a site and its account to the local store (state.db, 0600): the password is typed at a prompt (recommended: by the human) or piped with --password-stdin (an agent the user handed it to), never passed as an argument; afterwards only the references are used",
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
      { flag: "--bypass", key: "bypass", kind: "string", help: "Chrome proxy bypass list for the account's browser context (default \"<-loopback>\": loopback goes through the proxy)", metavar: "list" },
    ],
    summary: "add a proxy to the local store (state.db, 0600) for the account pool: the password is typed at a prompt (recommended: by the human) or piped with --password-stdin, never passed as an argument, and never shown in tabcap output",
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
    summary: "add another account to a stored site (the password is typed at a prompt, recommended: by the human, or piped with --password-stdin; never an argument, never shown); a duplicate <site>.<user> is refused",
    example: "tabcap account add example --user bob --password-stdin",
  },
  { path: ["account", "remove"], pos: ["account"], flags: [], summary: "delete a stored account with its saved cookies and counters; refused while a session uses it", example: "tabcap account remove example.bob" },
  {
    path: ["account", "bind"],
    pos: ["account"],
    flags: [{ flag: "--proxy", key: "proxy", kind: "string", help: "a proxy name: the account's browser context goes out through it; system / none: its context has no proxy of its own (the browser's network and proxy flags)", required: true, metavar: "name|system|none" }],
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
        help: "which of the site's accounts (default: its first); auto = pick by config.json pool.strategy (fixed / round-robin / lru); every account session gets its own browser context (through the account's proxy when it is bound to one)",
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
    path: ["session", "export"],
    pos: [],
    flags: [
      ...TT,
      { flag: "--for", key: "for", kind: "string", help: "requests (JSON, schema tabcap-session-export/0) | httpx (a Python module <file>.py with cookies, headers, storage and client()) | playwright (storageState: cookies and localStorage only)", required: true, metavar: "requests|httpx|playwright" },
      { flag: "--out", key: "out", kind: "string", help: "file to write, mode 0600 (new directories 0700); --for httpx adds .py when missing", required: true, metavar: "file" },
      {
        flag: "--origin",
        key: "origin",
        kind: "string",
        help: "export this origin instead of the tab's page, e.g. the API origin a single-page app calls (a URL, or a host: the scheme its recorded requests used, else https): the headers of the latest recorded request to it from any tab, its cookies next to the page's. Without it, when the page's origin got no auth-looking header, the recorded host with the most of them gives the headers (source.headers.auto)",
        metavar: "url|host",
      },
    ],
    summary:
      "hand the logged-in tab's session to a script: its cookies, the authentication headers the page sent (sensitive or page-set headers of the latest recorded request to the origin's host; needs net start) and its localStorage / sessionStorage (values over 64 KB skipped), written to a 0600 file; prints the path, counts and header names, never a value",
    example: "tabcap session export --for httpx --out ./example_session.py",
    action: "session.export",
    localPaths: ["out"],
  },
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
  { path: ["tab", "close"], pos: ["tab"], flags: [SESSION], summary: "close one of the session's tabs; closing the current tab switches to the most recently current owned tab (else the last opened), answered as current (null when none is left)", example: "tabcap tab close t2", action: "tab.close" },
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
      { flag: "--max-chars", key: "maxChars", kind: "number", help: "truncate the tree text (the note says so and how to get more)", default: 12000, metavar: "n" },
      { flag: "--file-path", key: "filePath", kind: "string", help: "write the tree text to this file and return its path instead of the tree", metavar: "path" },
      { flag: "--frames", key: "frames", kind: "bool", help: "also expand every child frame (iframes, frameset frames, cross-origin too); their refs carry the frame path, e.g. f2/f1/e7; --max-chars applies per frame" },
      { flag: "--frame", key: "frame", kind: "string", help: "expand only this frame and the frames inside it (the root document is listed in the header only)", metavar: "f2/f1" },
      {
        flag: "--grep",
        key: "grep",
        kind: "string",
        help: "only the lines whose role, name, value, states or description match this regex (JavaScript, u flag, at most 256 chars), each with its ancestor lines; refs are the full snapshot's",
        metavar: "regex",
      },
      { flag: "--css", key: "css", kind: "string", help: "only the lines of the elements this CSS selector matches in each shown document (read in an isolated world), with ancestors; elements without a line print as `(no accessible node) <tag#id.class> [e12]` with a DOM-backed ref that click / fill / hover / upload / html / screenshot --ref take", metavar: "selector" },
      { flag: "--xpath", key: "xpath", kind: "string", help: "as --css, with an XPath 1.0 expression", metavar: "expr" },
      { flag: "--ref", key: "ref", kind: "string", help: "only the subtree under this element (its own frame for a frame ref)", metavar: "e12" },
      { flag: "--depth", key: "depth", kind: "number", help: "with --ref: levels below the element (default: all); hidden deeper lines are counted", metavar: "n" },
      { flag: "--context", key: "context", kind: "number", help: "with --grep / --css / --xpath: also this many sibling lines before and after each match (max 20)", default: 0, metavar: "n" },
      { flag: "--max-matches", key: "maxMatches", kind: "number", help: "with --grep / --css / --xpath: matches shown over all documents (max 1000); search.matches counts them all", default: 50, metavar: "n" },
    ],
    summary:
      "accessibility tree as indented text, one element per line: role \"name\" [ref] flags (e.g. `- button \"Save\" [e12] disabled`); refs are for click / fill and expire when the document changes; starts with the overlay header (overlays / detected / frames, counts toward --max-chars); child frames are header lines until --frames / --frame",
    example: "tabcap snapshot --interactive",
    action: "snapshot",
    localPaths: ["filePath"],
  },
  {
    path: ["outline"],
    pos: [],
    flags: [...TT, { flag: "--max-chars", key: "maxChars", kind: "number", help: "truncate the outline text", default: 6000, metavar: "n" }],
    summary:
      "page map head: tab line, overlays (dialogs, masks, iframe layers, timeout prompts, consent banners, with close-button refs; also inside frames), detected (adapters, with confidence), frames (path, url, same-origin / cross-origin, depth, title), popups; read-only, never closes anything",
    example: "tabcap outline",
    action: "outline",
  },
  { path: ["find"], pos: ["text..."], flags: TT, summary: "search the accessibility tree (name, value, description) of the page and every child frame; up to 20 hits with refs (frame hits carry `frame` and frame-path refs), clickable ones first", example: "tabcap find Add to cart", action: "find" },
  {
    path: ["html"],
    pos: ["ref"],
    optional: 1,
    flags: [
      ...TT,
      { flag: "--css", key: "css", kind: "string", help: "the first element this CSS selector matches in the root document, instead of a ref (`matched` counts all)", metavar: "selector" },
      { flag: "--inner", key: "inner", kind: "bool", help: "innerHTML instead of outerHTML" },
      { flag: "--text", key: "textContent", kind: "bool", help: "textContent instead of markup" },
      { flag: "--attrs", key: "attrs", kind: "bool", help: "only the element's attributes, as an object" },
      { flag: "--max-chars", key: "maxChars", kind: "number", help: "cut the markup / text (each attribute value with --attrs); `truncated` and `chars` (the whole length) say so", default: 4000, metavar: "n" },
    ],
    summary: "one element's markup: outerHTML (default), --inner, --text or --attrs, by ref (frame refs too) or --css; read in an isolated world, read-only, secret-scrubbed",
    example: "tabcap html e12 --inner",
    action: "html",
  },
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
    flags: [
      SESSION,
      {
        flag: "--bodies",
        key: "bodies",
        kind: "string",
        help: "which response bodies to store: all | api (document, xhr, fetch, websocket, eventsource, other) | api+script (api and scripts) | none; images, fonts, stylesheets and media are metadata only unless all. Default: config.json record.bodies, else all",
        metavar: "mode",
      },
    ],
    summary: "record the session's traffic (requests with bodies, WebSocket frames, console) into a bundle under ~/.local/share/tabcap/bundles/; encrypted API responses: add `trace start --decode` for the plaintext the page parses",
    example: "tabcap net start --bodies api+script",
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
      { flag: "--page-size", key: "pageSize", kind: "number", help: "requests per page (max 1000); 0 returns every match", default: 30, metavar: "n" },
      { flag: "--page-idx", key: "pageIdx", kind: "number", help: "page to return, 0-based; nextPageIdx names the next one", default: 0, metavar: "n" },
      { flag: "--kind", key: "kind", kind: "string", help: "http (requests) | ws (WebSocket frames: id, direction, opcode, bytes, ts)", default: "http", metavar: "http|ws" },
      REVEAL,
    ],
    summary:
      "recorded requests, oldest first: id, method, url (cut at 255 chars; net show has it whole), status, mime, bytes, outcome, cmd; always total / matched / shown / hidden {failed, data} (failed and data: are hidden unless asked for); 30 per page unless --page-size (0: everything) (--kind ws: WebSocket frames r-12:34)",
    example: "tabcap net list --resource-types xhr,fetch --status 2xx",
    action: "net.list",
  },
  {
    path: ["net", "body"],
    pos: ["id"],
    optional: 1,
    flags: [
      SESSION,
      { flag: "--out", key: "out", kind: "string", help: "copy the body to this file", metavar: "path" },
      { flag: "--url", key: "url", kind: "string", help: "instead of an id: the last recorded request for this URL (e.g. a script URL from `trace list`)", metavar: "url" },
      { flag: "--grep", key: "grep", kind: "string", help: "lines of the decoded body matching this regex (JavaScript, u flag, at most 256 chars): {line, col, text, before, after} per match", metavar: "regex" },
      { flag: "--lines", key: "lines", kind: "string", help: "this 1-based inclusive line range (at most 500 lines per call)", metavar: "a-b" },
      { flag: "--at", key: "at", kind: "string", help: "the lines around this 1-based raw-body position, as `trace list` and console stacks print it (mapped into the pretty text with --pretty)", metavar: "line:col" },
      { flag: "--context", key: "context", kind: "number", help: "lines before and after each match (--grep, default 3) or the position (--at, default 5)", metavar: "n" },
      { flag: "--max-matches", key: "maxMatches", kind: "number", help: "with --grep: matches shown (max 1000); total counts them all", default: 50, metavar: "n" },
      { flag: "--file", key: "file", kind: "bool", help: "write the whole decoded body (charset-decoded, secret-scrubbed; with --pretty line-broken) to exports/bodies/<id>.<ext> of the open recording (else <cache>/outputs/bodies/), 0600, and answer {id, url, mime, bytes, lines, pretty, file, scrubbed}: for `rg` / grep on the path; not with --grep / --lines / --at / --out" },
      { flag: "--pretty", key: "pretty", kind: "bool", help: "JavaScript / JSON bodies up to 8 MB: break minified JS into lines (newlines only, never inside strings, templates, regexes, comments), re-indent JSON; line numbers then refer to the pretty text" },
      { flag: "--decoded", key: "decoded", kind: "bool", help: "the plaintext view of the body — a decode plugin's, else the page view of `trace start --decode` (the default when the request has one; an error when it has none); the answer says view: \"decoded\"" },
      { flag: "--raw", key: "raw", kind: "bool", help: "the original body even when a decoded view exists (view: \"raw\")" },
      REVEAL,
    ],
    summary:
      "a response body (r-12) or WebSocket frame payload (r-12:34) as a file path + a text preview of up to 10000 chars (never the whole body inline); a body with a decoded view (decode plugin, or the page view of `trace start --decode`) shows the view (--raw: the original); --grep / --lines / --at read only the lines needed (long lines as a 500-char window), --pretty breaks minified code first; --file writes the whole decoded, scrubbed body to a file for your own tools (rg / grep)",
    example: "tabcap net body r-12 --grep 'sign|token' --pretty",
    action: "net.body",
    localPaths: ["out"],
  },
  {
    path: ["net", "show"],
    pos: ["id"],
    flags: [SESSION, REVEAL],
    summary:
      "one request in full: method, url, status, request / response headers, postData (over 2 KB: path + first 2 KB), body path, timing, initiator, nav, tab, outcome; r-12:34 shows a WebSocket frame; sensitive headers, cookie values and query / body fields read <redacted:name> unless --reveal",
    example: "tabcap net show r-12",
    action: "net.show",
  },
  {
    path: ["net", "grep"],
    pos: ["regex"],
    flags: [
      SESSION,
      { flag: "--resource-types", key: "types", kind: "string", help: "comma list: script,xhr,fetch,document …", metavar: "script,xhr" },
      { flag: "--max-matches", key: "maxMatches", kind: "number", help: "matches shown per request (max 200); count has them all", default: 20, metavar: "n" },
      { flag: "--context", key: "context", kind: "number", help: "lines before and after each match (max 20)", default: 1, metavar: "n" },
      { flag: "--pretty", key: "pretty", kind: "bool", help: "search JavaScript / JSON bodies as `net body --pretty` prints them (line numbers then refer to the pretty text)" },
    ],
    summary:
      "raw-text regex search over every recorded response body of the session (decoded, secret-scrubbed): per request {id, url, resourceType, count, matches}; at most 50 requests (more: n), bodies over 8 MB listed under skipped. Not `analyze find`, which follows values through decode chains",
    example: "tabcap net grep 'x-sign|signature' --resource-types script",
    action: "net.grep",
  },
  {
    path: ["console", "list"],
    pos: [],
    flags: [
      SESSION,
      TAB,
      { flag: "--types", key: "types", kind: "string", help: "comma list of message types: log, debug, info, error, warn, dir, table, trace, assert, count, timeEnd, verbose …", metavar: "error,warn" },
      { flag: "--level", key: "level", kind: "string", help: "debug | log | info | warn | error: that level and more severe (log = info)", metavar: "level" },
      { flag: "--page-size", key: "pageSize", kind: "number", help: "messages per page (max 1000); 0 returns every buffered message", default: 30, metavar: "n" },
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
    path: ["fetch"],
    pos: ["url"],
    optional: 1,
    localPaths: ["out"],
    flags: [
      SESSION,
      { flag: "--timeout", key: "timeoutMs", kind: "number", help: "give up after this many ms, the wait for the host's turn included (max 600000); with --batch: per request", default: 30000, metavar: "ms" },
      TAB,
      { flag: "--method", key: "method", kind: "string", help: "HTTP method", default: "GET", metavar: "M" },
      { flag: "--header", key: "header", kind: "string", repeat: true, help: "request header (name:value)", metavar: "k:v" },
      { flag: "--body", key: "body", kind: "string", help: "request body text, or @<file> to read it from a file", metavar: "text|@file" },
      { flag: "--json", key: "json", kind: "string", help: "JSON request body (checked; content-type application/json unless --header sets one), or @<file>", metavar: "text|@file" },
      { flag: "--form", key: "form", kind: "string", repeat: true, help: "form field of an application/x-www-form-urlencoded body", metavar: "k=v" },
      {
        flag: "--credentials",
        key: "credentials",
        kind: "string",
        help: "the page fetch()'s credentials option: include (cookies on every origin) | same-origin | omit (no cookies; for an API that answers Access-Control-Allow-Origin: * and authenticates by a header); with --batch: for lines without their own",
        default: "include",
        metavar: "include|same-origin|omit",
      },
      {
        flag: "--stop-on",
        key: "stopOn",
        kind: "string",
        repeat: true,
        help: "stop rule, on top of config.json fetch.stopOn: empty-body | status>=<n> | status=<n> | json:<$.path>=<v> | json:<$.path>!=<v> | text:<regex>; when one fires the site's fetches are refused until `tabcap guard resume --site`",
        metavar: "rule",
      },
      {
        flag: "--end-on",
        key: "endOn",
        kind: "string",
        repeat: true,
        help: "end rule (the --stop-on syntax), on top of config.json sites.<s>.guard.endOn: the list has ended (e.g. json:$.code=203); checked before every stop rule, a match answers ok with end {rule, detail} and stops nothing",
        metavar: "rule",
      },
      { flag: "--out", key: "out", kind: "string", help: "write the body (text secret-scrubbed) to this file instead of inline / bodyFile", metavar: "file" },
      { flag: "--raw", key: "rawBody", kind: "bool", help: "the body as base64 inline (bodyBase64, up to 16 MB; text secret-scrubbed) instead of inline text / bodyFile" },
      {
        flag: "--batch",
        key: "batch",
        kind: "string",
        help: "JSON lines file, one request per line {url, method?, headers?, body?|json?|form?, credentials?, tab?, timeoutMs?, stopOn?, endOn?}: sent in order under the same limits, one envelope printed per line",
        metavar: "file.jsonl",
      },
      REVEAL,
    ],
    summary:
      "send via the logged-in tab; the session's tab sends the request (the page's own fetch with its cookies, in a tabcap isolated world) and it is recorded (needs net start): fetchId c-N:f-K on the request event, per-host pacing (config.json fetch.minIntervalMs, default 3000 ms between requests), stop rules → {id, fetchId, status, statusText, mime, bytes, headers, body (text ≤ 8 KB) | bodyFile, timing, waitedMs}",
    example: "tabcap fetch '/api/list?page=2' --stop-on 'json:$.code!=0'",
    action: "fetch",
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
        help: "what the input is: ref (a snapshot ref; its visible text is looked up) or text (the value as typed). Default: e<n> (or a frame ref f<n>/e<m>) is a ref while the session's tab has a current snapshot, anything else text",
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
  {
    path: ["recon"],
    pos: [],
    flags: [...T, { flag: "--text", key: "text", kind: "bool", help: "print the Markdown dossier instead of the JSON envelope" }, REVEAL],
    summary:
      "recon dossier v0 of the session's recording and current page: tech stack (adapter detect results, header / session-cookie hints), data channels (method, path template, type, body class) with the share of the page's visible text found in recorded responses, cookie classification (origin, lifetime, flags, role, requiredBy from analyze deps), protection identification (guard detections, response signals; identification only). Writes exports/dossier.json (schema tabcap-dossier/0) and exports/dossier.md into the bundle; sends no request",
    example: "tabcap recon --text",
    action: "recon",
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
    path: ["handoff", "wait"],
    pos: [],
    flags: [
      SESSION,
      { flag: "--timeout", key: "timeoutMs", kind: "number", help: "give up after this many ms with error waiting (100 to 600000)", default: 60000, metavar: "ms" },
      { flag: "--until-url", key: "untilUrl", kind: "string", help: "end the handoff once the handoff tab's URL contains this (and did not when the handoff began)", metavar: "s" },
      { flag: "--until-text", key: "untilText", kind: "string", help: "… once the tab shows this text (seen absent first)", metavar: "text" },
      { flag: "--until-selector", key: "untilSelector", kind: "string", help: "… once a CSS selector matches in the tab (seen absent first)", metavar: "css" },
      { flag: "--until-cookie", key: "untilCookie", kind: "string", help: "… once a cookie of this name is set for the tab's URL (absent when the handoff began; only the name is compared)", metavar: "name" },
    ],
    summary:
      "wait until a waiting session goes on: the human continued, or (verify-page / human-takeover) one --until-* condition became true that was not when the handoff began, which ends it like handoff continue → state, by (human | condition | plugin:<n> | guard-resume), condition",
    example: "tabcap handoff wait --until-url /dashboard --timeout 120000",
    action: "handoff.wait",
  },
  {
    path: ["guard", "resume"],
    pos: [],
    flags: [SESSION, { flag: "--site", key: "site", kind: "string", help: "the store site (or host) a stop rule stopped", required: true, metavar: "site" }],
    summary:
      "resume a site after a stop rule fired: `tabcap fetch` sends to it again, and a session a site rule (config.json sites.<s>.guard) put into waiting goes on (decide first: look at the stopped response)",
    example: "tabcap guard resume --site example",
    action: "guard.resume",
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
      { flag: "--decode", key: "decode", kind: "bool", help: "observe mode instead of signal tracing (no signal breakpoints; not with --apis): every JSON.parse of a string of 32+ chars pauses, and a plaintext tied to a response that looks like ciphertext is filed as a decoded view by \"page\" (evidence.link strong / weak; config.json trace.weakRows false counts weak ones as drops.weak instead); turn it off after the recording (config.json trace.decode sets the default; TextDecoder / SubtleCrypto pauses are evidence only)" },
      { flag: "--no-decode", key: "decode", kind: "bool", help: "start without the observe mode, whatever config.json says", value: false },
    ],
    summary:
      "trace mode for the session (every tab, frame and worker, now and later): records which page scripts read which browser signals (navigator, screen, time zone, canvas, WebGL …) via debugger breakpoints into `signal` events; changes no page state, but scripts run slower and the timing is observable; --decode is the observe mode instead (in-page decoding): JSON.parse breakpoints file the plaintext the page parses, never a CryptoKey",
    example: "tabcap trace start --decode",
    action: "trace.start",
    localPaths: ["apis"],
  },
  {
    path: ["trace", "stop"],
    pos: [],
    flags: [SESSION, DECODE_VERBOSE],
    summary: "end trace mode: breakpoints removed, debugger off, open documents written to the recording; with --decode on, the parses still pending are decided first and `decode` counts them (decidedAtStop)",
    example: "tabcap trace stop",
    action: "trace.stop",
  },
  {
    path: ["trace", "status"],
    pos: [],
    flags: [SESSION, DECODE_VERBOSE],
    summary: "trace mode state: on | paused (handoff) | off, active APIs, names skipped in this browser, per-document read counts; with --decode on, `decode` {on, weakRows, rows {strong, weak, unattributed}, pending, dropped}",
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
      REVEAL,
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
  {
    path: ["plugin", "list"],
    pos: [],
    flags: [],
    summary: "challenge handlers and decode plugins installed under ~/.config/tabcap/plugins/ (none ship with tabcap): name, kind, hooks / match, enabled, errors",
    example: "tabcap plugin list",
  },
  {
    path: ["plugin", "enable"],
    pos: ["name"],
    flags: [],
    summary: "opt a plugin in: a challenge handler is asked before a challenge goes to the human; a decode plugin decodes matching bodies of recordings started from now on",
    example: "tabcap plugin enable my-handler",
  },
  { path: ["plugin", "disable"], pos: ["name"], flags: [], summary: "stop using this handler or decode plugin", example: "tabcap plugin disable my-handler" },
  {
    path: ["plugin", "init"],
    pos: ["dir"],
    optional: 1,
    flags: [
      { flag: "--kind", key: "kind", kind: "string", help: "the template: decode (the Python decode runner; no other kind has one)", required: true, metavar: "decode" },
      { flag: "--name", key: "name", kind: "string", help: "plugin name, set in manifest.json (default: the directory's name); alone, the plugin goes to ~/.config/tabcap/plugins/<name>/", metavar: "name" },
      { flag: "--force", key: "force", kind: "bool", help: "write into a non-empty directory: the template files are rewritten, config.json never, other files are left alone" },
    ],
    summary:
      "write the decode plugin template (manifest.json with the name, plugin.py, runner.py, pyproject.toml, config.example.json, and config.json from the example when absent) into <dir> or ~/.config/tabcap/plugins/<name>/; refuses a non-empty directory without --force. The answer lists the files and the next steps (edit plugin.py, config.json and the manifest's match, then `plugin enable`); plugins load only from the plugins directory",
    example: "tabcap plugin init --kind decode --name my-decode",
  },
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
      { flag: "--rules", key: "rules", kind: "string", help: "replay rules file: drop each rule's ignoreQuery parameters from the entry URLs (nothing else changes)", metavar: "file" },
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
  {
    path: ["bundle", "info"],
    pos: ["bundle"],
    flags: [
      { flag: "--usage", key: "usage", kind: "bool", help: "account-usage report (tabcap-usage/0): logins per account, per host requests / intervals / bursts / statuses / empty bodies / business errors, guard stops, 10-minute windows; counts and names only" },
      { flag: "--text", key: "text", kind: "bool", help: "with --usage: one-screen table for a run log" },
      { flag: "--business-code", key: "businessCode", kind: "string", repeat: true, help: "with --usage: JSON bodies whose <$.path> is not this value count as business errors (e.g. $.code=0)", metavar: "$.path=ok" },
      { flag: "--actor", key: "actor", kind: "string", help: "with --usage: only the rows of one actor: page (the page's own requests), fetch (sent by tabcap fetch), evaluate (during tabcap evaluate), other", metavar: "page|fetch|evaluate|other" },
      { flag: "--all-hosts", key: "allHosts", kind: "bool", help: "with --usage: also list loopback hosts (127.0.0.1, localhost, ::1), left out by default with a one-line skipped summary" },
    ],
    summary: "bundle summary: counts, event kinds, finished or not, issues; --usage for the account-usage report",
    example: "tabcap bundle info ./b --usage --text --business-code '$.code=0'",
  },
  {
    path: ["bundle", "decode"],
    pos: ["bundle"],
    flags: [{ flag: "--plugin", key: "plugin", kind: "string", help: "only this decode plugin (installed; naming it is the opt-in, it need not be enabled); default: every enabled decode plugin", metavar: "name" }],
    summary:
      "run decode plugins over a finished bundle: plaintext views of matching request / response bodies are appended to the bundle's decoded.jsonl sidecar (events.jsonl never changes) and read as request.decoded / response.decoded by net body / find / where / deps / recon / replay check; a body a plugin declines (decode() returned None: not its body) gets no view and is counted as declined, and a decline hides that plugin's earlier failure on the body (superseded); CORS preflights and empty bodies are never offered; a re-run appends only new or changed views",
    example: "tabcap bundle decode ./b --plugin xor-decode",
  },
  {
    path: ["bundle", "export", "fixtures"],
    pos: ["bundle"],
    flags: [
      { flag: "--out", key: "out", kind: "string", help: "output directory (must be missing or empty)", required: true, metavar: "dir" },
      { flag: "--rules", key: "rules", kind: "string", help: "replay rules file (schema tabcap-replay-rules/0, docs/04 §31); default: config.json sites.<bundle site>.replay, then replay", metavar: "file" },
      { flag: "--format", key: "format", kind: "string", help: "json (fixtures/<n>-<method>-<path>.json + index.json), or the name of a fixture plugin that writes its own files", default: "json", metavar: "json|plugin" },
      { flag: "--no-redact", key: "noRedact", kind: "bool", help: "skip redaction (default: redacted like HAR export, with a per-export salt)" },
      { flag: "--include-preflight", key: "includePreflight", kind: "bool", help: "also export CORS preflights (OPTIONS); default: skipped with reason preflight" },
    ],
    summary:
      "one fixture per recorded exchange: {key {method, path, query, body} as the replay rules read it, request {headers, body}, response {status, headers, body | bodyFile, decoded?}, meta {request, rule, recordedAt}}; --format <plugin> hands each fixture to a fixture plugin (tabcap-fixture/1) that returns the files to write",
    example: "tabcap bundle export fixtures ./b --rules replay-rules.json --out ./fixtures",
  },
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
    // A list of bundle directories (the MCP tool takes an array), not words joined with spaces.
    restList: true,
    flags: [
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON" },
      { flag: "--save", key: "save", kind: "bool", help: "append the result as a finding event to the first bundle" },
      REVEAL_ANALYZE,
    ],
    summary: "compare recordings of the same action: which parameters are constant, per session, timestamps or varying; values print as <redacted:…> unless --reveal",
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
      REVEAL_ANALYZE,
    ],
    summary:
      "value-flow dependency graph: for every request input (query, body leaves, x-* / authorization headers, cookies) its source in earlier events (set-cookie, response body path, recorded fill / type, earlier request, constant, timestamp), else caller-input (paging, periods, search terms the caller picks) / computed-in-page / unrecorded; exact matches only (a header also without its Bearer / Basic / Token / JWT prefix or quotes), never guessed; request URLs print sensitive query values as <redacted:…> unless --reveal",
    example: "tabcap analyze deps ./b --request r-12",
  },
  {
    path: ["analyze", "chain"],
    pos: ["bundle"],
    flags: [
      { flag: "--request", key: "request", kind: "string", help: "target request (default: the data-bearing xhr / fetch / document request that started last)", metavar: "r-N" },
      { flag: "--session", key: "bundleSession", kind: "string", help: "pick the default target among requests of this session name", metavar: "name" },
      { flag: "--text", key: "text", kind: "bool", help: "print a text report instead of JSON (the envelope's data is schema tabcap-chain/0)" },
      REVEAL_ANALYZE,
    ],
    summary: "the requests needed to reproduce one request, from the deps graph, in recording order: what each step provides to later ones and what it still needs from the caller (computed-in-page, unrecorded, user input; caller-input values listed apart under inputs); step URLs print sensitive query values as <redacted:…> unless --reveal",
    example: "tabcap analyze chain ./b --request r-12",
  },
  {
    path: ["analyze", "recon"],
    pos: ["bundle"],
    flags: [{ flag: "--text", key: "text", kind: "bool", help: "print the Markdown dossier instead of the JSON envelope" }, REVEAL_ANALYZE],
    summary:
      "the recon dossier offline (as `tabcap recon`), with the bundle's last recorded document standing in for the page (its HTML text, no adapter detection); page / guard URLs and stack header values print as <redacted:…> unless --reveal; writes exports/dossier.json and exports/dossier.md",
    example: "tabcap analyze recon ./b --text",
  },
  {
    path: ["analyze", "shape"],
    pos: ["bundle"],
    flags: [
      { flag: "--request", key: "request", kind: "string", help: "only this exchange (its endpoint, shaped from this request alone)", metavar: "r-N" },
      { flag: "--template", key: "template", kind: "string", help: "only this endpoint: method + path template as listed (key)", metavar: "'GET /path'" },
      { flag: "--text", key: "text", kind: "bool", help: "print one line per field instead of JSON (the envelope's data is schema tabcap-shape/0)" },
      { flag: "--write", key: "write", kind: "bool", help: "also store the result as exports/shape.json in the bundle" },
      { flag: "--types", key: "types", kind: "string", help: "only exchanges of these resource types, or all; default: xhr, fetch, document and any response with a JSON content type", metavar: "xhr,fetch|all" },
      REVEAL_ANALYZE,
    ],
    summary:
      "response and request shape per endpoint (method + path template, all its exchanges): a type tree of the decoded JSON bodies (kinds, unions, formats date / datetime / int / float / id / url / email, presence counts, optional, ≤ 8 enum literals of non-sensitive fields) plus query names and request body fields; values never print (enum literals only under non-sensitive names), so --reveal changes nothing",
    example: "tabcap analyze shape ./b --template 'GET /api/list' --text",
  },
  {
    path: ["analyze", "schema-diff"],
    pos: ["old", "new"],
    flags: [
      { flag: "--template", key: "template", kind: "string", help: "only this endpoint (method + path template)", metavar: "'GET /path'" },
      { flag: "--text", key: "text", kind: "bool", help: "print one line per change instead of JSON (the envelope's data is schema tabcap-schema-diff/0)" },
      { flag: "--write", key: "write", kind: "bool", help: "also store each bundle's shape as its exports/shape.json" },
      { flag: "--types", key: "types", kind: "string", help: "only exchanges of these resource types on both sides, or all; default as analyze shape (diffing a HAR import: pass the --types it was exported with)", metavar: "xhr,fetch|all" },
    ],
    summary:
      "schema drift between two recordings: per endpoint the fields added, removed, changed type, changed optionality or enum, and endpoints only in one bundle; verdict same / drift / new / gone; exits 1 when any endpoint drifted (for cron)",
    example: "tabcap analyze schema-diff ./yesterday ./today --text",
  },
  {
    path: ["replay", "serve"],
    pos: ["bundle"],
    flags: [
      { flag: "--port", key: "port", kind: "number", help: "port to listen on (0: any free port)", default: 4500, metavar: "port" },
      { flag: "--host", key: "host", kind: "string", help: "loopback address only: 127.0.0.1, ::1 or localhost", default: "127.0.0.1", metavar: "host" },
      { flag: "--strict", key: "strict", kind: "string", help: "also match these request headers", metavar: "h1,h2" },
      { flag: "--match-cookies", key: "matchCookies", kind: "bool", help: "also match the cookie header" },
      { flag: "--rules", key: "rules", kind: "string", help: "replay rules file (schema tabcap-replay-rules/0, docs/04 §31); default: config.json sites.<bundle site>.replay, then replay", metavar: "file" },
      { flag: "--prefer", key: "prefer", kind: "string", help: "which recordings of one key answer, for every key (overrides the rules' prefer): recorded (all, cycling in recorded order), 2xx (only the 2xx ones; all when there are none), latest (the last one)", metavar: "recorded|2xx|latest" },
      { flag: "--json", key: "json", kind: "bool", help: "print {port, bundle, routes} as one JSON envelope (else text, one log line per request on stderr)" },
      { flag: "--once", key: "once", kind: "number", help: "stop after this many seconds (tests)", metavar: "seconds" },
    ],
    summary:
      "serve a bundle's recorded responses on a loopback port until Ctrl-C: match = method + path + sorted query + body sha256, or as the replay rules say (ignored query names / body fields, form / JSON / decoded bodies); repeated matches cycle in recorded order, or only over the 2xx / the latest one with --prefer (header x-tabcap-replay: r-N;n=k[;rule=id][;prefer=p]); no match → 404 with the nearest recordings and what differs",
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
      { flag: "--request", key: "request", kind: "string", help: "chain target, as analyze chain --request (default: the data-bearing xhr / fetch / document request that started last among the exported ones); implies --chain", metavar: "r-N" },
      { flag: "--chain", key: "chain", kind: "bool", help: "use the deps graph and the chain to the data-bearing request that started last (the analyze chain default): computed-in-page inputs become TODO parameters, caller-input ones parameters defaulting to the recorded value, values from earlier responses become arguments, plus verify() and verify_expected.json (default when the graph links any request to an earlier response)" },
      { flag: "--no-chain", key: "noChain", kind: "bool", help: "0.3 behaviour: per-request heuristics only, no verify()" },
      {
        flag: "--browser-headers",
        key: "browserHeaders",
        kind: "bool",
        help: "send every recorded request header (user-agent, accept-language, sec-ch-ua*, sec-fetch-* …); default: only content-type, authorization, a non-default accept, a cross-origin referer and headers the browser does not add itself (custom x-* …)",
      },
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
      { flag: "--rules", key: "rules", kind: "string", help: "replay rules file (schema tabcap-replay-rules/0, docs/04 §31); default: config.json sites.<bundle site>.replay, then replay", metavar: "file" },
      { flag: "--prefer", key: "prefer", kind: "string", help: "as replay serve --prefer: check only the recordings that answer each key; the others are listed in notPreferred and not sent", metavar: "recorded|2xx|latest" },
      { flag: "--text", key: "text", kind: "bool", help: "print one line per request that is not the same, then the totals, instead of JSON" },
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
  {
    path: ["wire", "probe"],
    pos: [],
    flags: [
      SESSION,
      { flag: "--timeout", key: "timeoutMs", kind: "number", help: "command timeout in ms (the first run of the client installs its packages with uv)", default: 300000, metavar: "ms" },
      { flag: "--client", key: "client", kind: "string", help: "directory of a client from `tabcap replay export-python`", required: true, metavar: "dir" },
      { flag: "--port", key: "port", kind: "number", help: "echo port on 127.0.0.1 (0: any free port)", default: 0, metavar: "port" },
      { flag: "--samples", key: "samples", kind: "number", help: "samples when the baseline has to be captured", default: 3, metavar: "n" },
      { flag: "--text", key: "text", kind: "bool", help: "print a table instead of JSON (the envelope's data is schema tabcap-wire/0)" },
    ],
    summary:
      "compare the generated Python client with the browser baseline on the local echo: `uv run client.py wire-report` sends one GET to 127.0.0.1, then per layer (tls, h2, headers) same / differs / missing with the differing fields, and the checks against the profile; diagnostic only (says which layer differs, not why a site refused anything); with a recording open, one finding per differing layer",
    example: "tabcap wire probe --client ./client --text",
    action: "wire.probe",
    localPaths: ["client"],
  },
  {
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
    path: ["mcp"],
    pos: [],
    flags: [
      {
        flag: "--print-config",
        key: "printConfig",
        kind: "string",
        help: `print where and how to register tabcap mcp in one host instead of serving: ${MCP_HOSTS.join(" | ")}`,
        metavar: "host",
      },
      {
        flag: "--all-tools",
        key: "allTools",
        kind: "bool",
        help: "one tool per command with its full help (about 95 tools, ~84 KB of definitions in the model's context) instead of the core set",
      },
    ],
    summary: "serve tabcap as MCP tools over stdin / stdout (JSON-RPC 2.0, one message per line, logs on stderr, exits when stdin closes): a core set of browser and net tools plus tabcap_run / tabcap_help for every other command; `waiting` comes back at once, tabcap_handoff_wait waits for the human",
    example: "tabcap mcp --print-config claude-code",
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

const BUNDLE_PATHS = ["bundle export har", "bundle import har", "bundle redact", "bundle info", "bundle decode", "bundle export fixtures"];
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

/**
 * Command groups of the help index and the generated reference
 * (scripts/gen-docs.ts): id (for `tabcap help <id>`), title, members.
 * `last`: the group comes after the leftover "Other" group, at the very end
 * (0.6-E: the optional diagnostics, which the MCP core set and SKILL.md leave out).
 */
export const COMMAND_GROUPS: ReadonlyArray<{ id: string; title: string; test: (c: CommandSpec) => boolean; last?: true }> = [
  // 0.7-A: task guides first, the entry point for an agent that does not know the commands yet.
  { id: "start", title: "Start here", test: (c) => c.path[0] === "guide" },
  { id: "lifecycle", title: "Setup and lifecycle", test: (c) => ["setup", "update", "daemon", "browser", "mcp"].includes(c.path[0] ?? "") },
  { id: "sessions", title: "Sites, sessions and tabs", test: (c) => ["site", "session", "tab"].includes(c.path[0] ?? "") },
  { id: "page", title: "Navigation and page reading", test: (c) => ["navigate", "go", "reload", "snapshot", "outline", "find", "wait"].includes(c.path[0] ?? "") },
  { id: "input", title: "Input", test: (c) => ["click", "hover", "fill", "type", "press-key", "upload", "dialog"].includes(c.path[0] ?? "") },
  { id: "tools", title: "Page tools", test: (c) => ["evaluate", "screenshot", "resize", "emulate", "console"].includes(c.path[0] ?? "") },
  { id: "network", title: "Network recording", test: (c) => c.path[0] === "net" || c.path[0] === "where" || c.path[0] === "recon" || c.path[0] === "fetch" },
  { id: "handoff", title: "Handoff and challenge handlers", test: (c) => ["handoff", "plugin", "guard"].includes(c.path[0] ?? "") },
  { id: "offline", title: "Offline: bundles, analysis, replay", test: (c) => ["bundle", "analyze", "replay", "schema"].includes(c.path[0] ?? "") },
  { id: "diagnostics", title: "Diagnostics (optional)", test: (c) => ["trace", "fingerprint", "wire"].includes(c.path[0] ?? ""), last: true },
];

/** The id of the group that collects commands no group claims. */
export const OTHER_GROUP = "other";

/** Current commands by group, in registry order; leftovers go to an "Other" group after the regular groups, before the `last` ones. */
export function groupedCommands(): { id: string; title: string; commands: CommandSpec[]; last: boolean }[] {
  const cmds = currentCommands();
  const used = new Set<CommandSpec>();
  const all = COMMAND_GROUPS.map((g) => {
    const mine = cmds.filter((c) => g.test(c) && !used.has(c));
    for (const c of mine) used.add(c);
    return { id: g.id, title: g.title, commands: mine, last: g.last === true };
  });
  const rest = cmds.filter((c) => !used.has(c));
  const other = rest.length > 0 ? [{ id: OTHER_GROUP, title: "Other", commands: rest, last: false }] : [];
  return [...all.filter((g) => !g.last), ...other, ...all.filter((g) => g.last)];
}

export const INDEX_SUMMARY_CHARS = 56;

/** A summary for the index: without parentheses, its first clause (before `;`, `: ` or `. `), cut at 56 characters on a word boundary. */
export function indexSummary(summary: string): string {
  const plain = summary.replace(/\s*\([^()]*\)/g, "").replace(/\s*\([^()]*\)/g, "");
  const clause = (plain.split(/;|: |\. /)[0] ?? plain).trim();
  if (clause.length <= INDEX_SUMMARY_CHARS) return clause;
  const cut = clause.slice(0, INDEX_SUMMARY_CHARS - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:→/|-]+$/, "")}…`;
}

/** `tabcap --help`: the index, one line per command (≤ 8 KB; test/unit/context-budget.test.ts). */
export function helpAll(): string {
  const lines = [
    "tabcap — a dedicated browser for AI agents: background tabs, refs, network capture.",
    "Every command prints one JSON envelope: {ok:true,data} or {ok:false,error:{code,message,next}}.",
  ];
  const groups = groupedCommands();
  for (const g of groups) {
    lines.push("", `${g.title} [${g.id}]:`);
    for (const c of g.commands) lines.push(`  ${c.path.join(" ")}  ${indexSummary(c.summary)}`);
  }
  lines.push(
    "",
    "Output flags (every command): --select <path> --grep <regex> [--context n] [--max-matches n] --fields a,b --full",
    "  data over TABCAP_OUTPUT_LIMIT (16384 bytes) becomes {summary, file, bytes, truncated}: read `file`, or filter.",
    "",
    "Start: tabcap setup && tabcap daemon start && tabcap browser start, then tabcap guide (task recipes) or navigate → snapshot --interactive → click / fill",
    "More:  tabcap help <command> (= tabcap <command> --help) · tabcap help <group>, e.g. tabcap help network · tabcap schema --json",
  );
  return lines.join("\n");
}

/** Characters of a summary in a group listing (`tabcap help <group>`); the whole one is in `tabcap help <command>`. */
export const GROUP_SUMMARY_CHARS = 160;

/**
 * A summary for a group listing: its first top-level clause (a `; ` or `. `
 * outside parentheses ends it), cut at 160 characters on a word boundary.
 */
export function groupSummary(summary: string): string {
  let depth = 0;
  let end = summary.length;
  for (let i = 0; i < summary.length - 1; i++) {
    const ch = summary[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ";" || ch === ".") && summary[i + 1] === " ") {
      end = i;
      break;
    }
  }
  const clause = summary.slice(0, end).trim();
  if (clause.length <= GROUP_SUMMARY_CHARS) return clause;
  const cut = clause.slice(0, GROUP_SUMMARY_CHARS - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:→/|(-]+$/, "")}…`;
}

/** One command of a group listing: its usage without the common flags, then its short summary. */
function groupLine(c: CommandSpec): string {
  return `  ${usageOf(c, COMMON_FLAGS)}\n      ${groupSummary(c.summary)}`;
}

/**
 * `tabcap help <group>` (an index group id or a command word, e.g. `network`,
 * `net`): one entry per command — usage without the common flags, then the
 * short summary; options and the example only in `tabcap help <command>`
 * (0.7-C: `help network` was 13 KB of option tables). Null: no such group.
 */
export function helpTopic(word: string): string | null {
  const g = groupedCommands().find((x) => x.id === word);
  const cmds = g?.commands ?? COMMANDS.filter((c) => c.path[0] === word && c.path.length > 1 && c.internal !== true);
  if (cmds.length === 0) return null;
  const title = g === undefined ? `${TOOL_NAME} ${word} — subcommands:` : `${g.title} — ${cmds.length} command(s):`;
  const first = cmds[0]?.path.join(" ") ?? word;
  return [title, ...cmds.map(groupLine), "", `Options and an example: ${TOOL_NAME} help <command>, e.g. ${TOOL_NAME} help ${first}. Every browser command also takes --session <name>; most take --timeout <ms>.`].join("\n");
}

/** Short list of a command group (`tabcap replay --help`): its subcommands, or null when `group` is no group. */
export function helpGroup(group: string): string | null {
  return COMMANDS.some((c) => c.path[0] === group && c.path.length > 1 && c.internal !== true) ? helpTopic(group) : null;
}

/** Levenshtein distance (insert / delete / substitute, each 1). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

export const SUGGEST_MAX = 3;

/**
 * The commands closest to what was typed (0.7-C: an unknown command names
 * these instead of the whole list). A candidate qualifies when its first word
 * is the typed first word, one of the two is a prefix of the other (3+
 * characters), or the typed words (as many as the candidate has) are within
 * edit distance max(1, ⌊length / 4⌋) of it. Ranked by that edit distance,
 * then registry order; at most `max`. `among`: the candidate paths (default:
 * every current command).
 */
export function closestCommands(words: readonly string[], max: number = SUGGEST_MAX, among: readonly (readonly string[])[] = currentCommands().map((c) => c.path)): string[] {
  const first = words[0] ?? "";
  if (first === "" || max <= 0) return [];
  const scored: { path: string; d: number; i: number }[] = [];
  among.forEach((path, i) => {
    const want = path.join(" ");
    const typed = words.slice(0, path.length).join(" ");
    const d = editDistance(typed, want);
    const head = path[0] ?? "";
    const related = head === first || (Math.min(first.length, head.length) >= 3 && (head.startsWith(first) || first.startsWith(head)));
    if (related || d <= Math.max(1, Math.floor(want.length / 4))) scored.push({ path: want, d, i });
  });
  return scored
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, max)
    .map((x) => `${TOOL_NAME} ${x.path}`);
}

/** The `next` of an unknown command: the closest commands, then where the groups are listed. */
export function unknownCommandNext(words: readonly string[], among?: readonly (readonly string[])[]): string {
  const near = closestCommands(words, SUGGEST_MAX, among);
  const groups = `\`${TOOL_NAME} --help\` lists the command groups; \`${TOOL_NAME} help <command>\` shows one command.`;
  return near.length === 0 ? `No command is close to that. ${groups}` : `Did you mean: ${near.join(" | ")}? ${groups}`;
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
  /** Output flags every command takes (OUTPUT_FLAGS), except the commands in `notOn`. */
  sharedFlags: (SchemaFlag & { notOn: string[] })[];
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
    sharedFlags: OUTPUT_FLAGS.map((f) => ({ ...schemaFlag(f), notOn: [...(OUTPUT_FLAGS_NOT_ON[f.flag] ?? [])] })),
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
    else if (spec.kind === "bool") args[spec.key] = spec.value ?? true;
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
