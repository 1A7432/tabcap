// Task guides (0.7-A): task-first entry points for agents. Each guide says
// when to use it, the commands in order (copy-pastable, with --session), the
// pitfalls that are easy to miss (implicit state included) and the reference
// files to read next. This registry is the single source of truth for
// `tabcap guide [<id>]`, the MCP `tabcap_help {guide}` argument and the
// generated skills/tabcap/references/guides.md (`bun run gen:docs`).
// test/unit/guides.test.ts parses every `tabcap …` command in `steps` and
// every backticked `tabcap …` span in `watch` with the command registry
// (src/cli/commands.ts), so a guide cannot name a command or flag that does
// not exist.

import { TabcapError } from "../shared/envelope.ts";

export type GuideStep = {
  /** One shell command, copy-pastable; `tabcap …` commands are checked against the registry. */
  cmd: string;
  /** One line: why this step, what to look at in its answer. */
  why: string;
};

export type Guide = {
  id: string;
  title: string;
  /** One line: when to use this guide. */
  when: string;
  /** 5–10 steps in order. */
  steps: GuideStep[];
  /** One-line pitfalls, implicit state included. */
  watch: string[];
  /** Reference files, relative to the skill directory (skills/tabcap/). */
  read: string[];
};

export const GUIDES: readonly Guide[] = [
  {
    id: "first-look",
    title: "Open a page, see its controls and the APIs it calls",
    when: "A site you have not seen yet: what can be clicked, and which requests carry its data.",
    steps: [
      { cmd: "tabcap navigate https://example.com/ --session look", why: "opens the session's own background tab (creates the session) and waits until the page is ready and quiet" },
      { cmd: "tabcap snapshot --interactive --session look", why: "controls only, each with a ref (e4); an overlay header comes first (dialogs, consent banners, frames)" },
      { cmd: "tabcap net start --session look", why: "record from here on: requests, bodies, WebSocket frames, console" },
      { cmd: "tabcap click e4 --session look", why: "act with a ref from the snapshot; the answer has a cmd id (c-4) and an effect (navigation, request, popup, dom, none)" },
      { cmd: "tabcap net list --resource-types xhr,fetch --session look", why: "the API calls only, oldest first, 30 rows per page (nextPageIdx)" },
      { cmd: "tabcap net body r-12 --session look", why: "one response: a file path plus a text preview; add --grep <word> --context 2 for the lines that matter" },
      { cmd: "tabcap where e12 --session look", why: "which recorded response carries the value a ref of the latest snapshot shows (snapshot again after a navigation), as a JSON path or HTML selector" },
      { cmd: "tabcap net stop --session look", why: "finish the recording; the answer names the bundle directory for the offline commands" },
    ],
    watch: [
      "Requests before `net start` are not recorded: start it before `navigate` (or run `tabcap reload --session look` after it) when the page load itself matters.",
      "Refs expire when the document changes: `stale-ref` means take a new snapshot; never guess a ref.",
      "`net list` hides failed requests and `data:` URLs (counted in `hidden`); `--failed` shows only those, `--all` everything.",
      "What one action caused: `tabcap net list --since c-4 --session look` (the action's cmd id; the window includes its wait).",
      "`navigate` and `net start` create the session implicitly, unbound to a site: `fill --secret` then fails; see `tabcap guide scrape-through-browser`.",
      "Encrypted bodies (`{\"code\":0,\"data\":\"<base64>\"}`, bare base64): `tabcap guide encrypted-site`.",
      "The tab stays in the background; never bring the browser to the front unless the user wants to look.",
    ],
    read: ["references/recording.md", "references/search.md", "references/analysis.md"],
  },
  {
    id: "scrape-through-browser",
    title: "Log in once, then send a scraper's requests through the logged-in tab",
    when: "A scraper needs data behind a login: the browser holds the session, tabcap fetch sends and records the requests.",
    steps: [
      { cmd: "tabcap site add example --url https://example.com/login --user alice", why: "the human runs this in their own terminal (it prompts for the password); you only ever see references" },
      { cmd: "tabcap session start scrape --site example", why: "binds the stored site: fill --secret works only in a session started with --site" },
      { cmd: "tabcap navigate https://example.com/login --session scrape", why: "the site's entry URL (session start prints it as entryUrl)" },
      { cmd: "tabcap snapshot --interactive --session scrape", why: "the refs of the username, password and submit controls" },
      { cmd: "tabcap fill e5 --secret example.username --session scrape", why: "the daemon fills the stored username; the answer shows <secret:example.username>" },
      { cmd: "tabcap fill e6 --secret example.password --session scrape", why: "the one login attempt of this site in this session" },
      { cmd: "tabcap click e7 --session scrape", why: "submit; check the landing page with a snapshot before going on" },
      { cmd: "tabcap net start --bodies api+script --session scrape", why: "record API responses and scripts, not images or fonts (a real site's bundle was 41 MB, mostly JavaScript)" },
      {
        cmd: "tabcap fetch '/api/items?page=2' --stop-on 'json:$.code!=0' --session scrape",
        why: "the logged-in tab sends it with the page's cookies and CORS rules; the stop rule halts the site on a business error; --batch file.jsonl for many",
      },
      { cmd: "tabcap session export --for httpx --out ./example_session.py --session scrape", why: "hand cookies, auth headers and storage to the user's script (0600 file; the answer has counts and names only)" },
    ],
    watch: [
      "One login per site per session: a second `fill --secret example.password` fails with `guard.login-limit`; tell the user, and only when they say retry repeat it with `--confirm`.",
      "Pacing: 3 s between requests to one host (config.json fetch.minIntervalMs), no flag to skip it; `--timeout` includes the wait (`waitedMs` says how long).",
      "`fetch.blocked` whose reason names a wildcard `Access-Control-Allow-Origin` (or a bad Allow-Credentials): retry with `tabcap fetch https://api.example.com/v1/items --credentials omit --session scrape` (no cookies; fine when the API authenticates by a header).",
      "`fetch.stopped` / `guard.stopped`: look first (`tabcap net body r-12 --session scrape`), decide with the user, then `tabcap guard resume --site example --session scrape`.",
      "A 403 verify page (or a site stop rule) can put the session in `waiting` with a screenshot: stop, tell the user; `tabcap handoff continue --session scrape` only after they say they are done.",
      "Scripts send the same request with `POST /fetch` on the daemon's socket ({session, url, credentials?, …}); `replay export-python` writes `_tabcap_fetch.py` for it.",
      "`session export` takes auth headers from recorded requests: when the page authenticates by a header, let it make a request after `net start` (`tabcap reload --session scrape`) before exporting.",
      "The exported file holds a live session: never print, commit or share it.",
    ],
    read: ["references/recording.md", "references/pools.md", "references/replay.md"],
  },
  {
    id: "encrypted-site",
    title: "Read API responses the site encrypts",
    when: "Bodies look like `{\"code\":0,\"data\":\"<base64>\"}` or bare base64 / hex: a decode plugin when the key is known, else observe the page's own decryption.",
    steps: [
      {
        cmd: "tabcap plugin init --kind decode --name mydecode",
        why: "road A, the key is known: writes the Python decode plugin template into the plugins dir (the answer prints it and a next); write decode(flow) in plugin.py, the key in config.json, the site in manifest.json match",
      },
      { cmd: "tabcap plugin enable mydecode", why: "road A: installed is not enabled, so enable before recording; tabcap plugin list shows what is installed and enabled" },
      { cmd: "tabcap net start --bodies api+script --session enc", why: "decoded views attach to the bodies recorded from now on" },
      { cmd: "tabcap trace start --decode --session enc", why: "road B, only the page can decrypt: observe mode files the plaintext the page passes to JSON.parse; tell the user first, it slows the page" },
      { cmd: "tabcap navigate https://example.com/orders --session enc", why: "load the page that calls the encrypted API (`tabcap reload --session enc` when it is already open)" },
      { cmd: "tabcap net body r-12 --session enc", why: "the id from `net list --resource-types xhr,fetch`; the decoded view by default (decoded.by: mydecode or page; a page view has decoded.link strong / weak); --raw for the original bytes" },
      { cmd: "tabcap trace stop --session enc", why: "road B: turn the observe mode off right after the recording" },
      { cmd: "tabcap where e12 --session enc", why: "where, find, deps, recon and replay check search the decoded views too" },
    ],
    watch: [
      "An enabled decode plugin's view outranks the page's, and a body a plugin already decoded is not observed: `trace start --decode` names them in `decodePlugins`; `tabcap plugin disable mydecode` to observe the page instead.",
      "Observe mode pauses on every `JSON.parse` of 32+ characters: run it for one recording, then `tabcap trace stop --session enc`; not for a long crawl.",
      "A `weak` row (`decoded.link: \"weak\"`, and `\"link\":\"weak\"` on find hits) was attributed by timing: check it before relying on it.",
      "A body recorded before `plugin enable` keeps no view: the recording applies the plugin from the next body on (`tabcap reload --session enc` to record the response again), and `tabcap bundle decode ./b --plugin mydecode` adds views to the earlier bodies once the bundle is finished (not to one still recording).",
      "Without a view, an encrypted-looking body's `net body` error next names the observe mode (road B).",
      "Keys stay in the plugin's own config.json (created 0600, never overwritten, also not by `tabcap plugin init --kind decode --name mydecode --force`), never in tabcap's store or the bundle.",
      "A plugin directory outside the plugins dir is never loaded: give `plugin init` only `--name`, or move the directory there as its answer says.",
      "Observe mode does not see request-side encryption, SSE / chunked decrypts, or plaintext that never goes through JSON.parse (structured-clone worker messages, WASM, protobuf).",
    ],
    read: ["references/trace-and-probes.md", "references/analysis.md", "references/recording.md"],
  },
  {
    id: "offline-replay",
    title: "Turn a recording into an offline replay, fixtures and a Python client",
    when: "After a recording: test a scraper or a generated client against the recorded responses instead of the real site.",
    steps: [
      { cmd: "tabcap net stop --session scrape", why: "finish the recording; the answer names the bundle directory (./b below)" },
      { cmd: "tabcap analyze chain ./b --request r-12", why: "the requests one request needs and where each of its inputs comes from" },
      {
        cmd: "printf '%s\\n' '{\"schema\":\"tabcap-replay-rules/0\",\"rules\":[{\"match\":{\"path\":\"/api/*\"},\"key\":{\"ignoreQuery\":[\"t\",\"nonce\"],\"body\":\"json\"},\"prefer\":\"2xx\"}]}' > replay-rules.json",
        why: "key rules: ignore volatile query parameters, compare JSON bodies canonically (\"decoded\" + decodeWith: an encrypted body by a decode plugin's plaintext), answer from 2xx recordings",
      },
      { cmd: "tabcap replay serve ./b --rules replay-rules.json --port 4500", why: "a foreground server on 127.0.0.1 until Ctrl-C (run it in a second terminal); x-tabcap-replay names the recording and rule that answered" },
      { cmd: "tabcap replay check ./b --against http://127.0.0.1:4500 --rules replay-rules.json", why: "every recorded request sent to the replay and compared field by field; exit 1 on a difference" },
      { cmd: "tabcap bundle export fixtures ./b --rules replay-rules.json --out ./fixtures", why: "one JSON fixture per exchange plus index.json, redacted like a HAR export" },
      { cmd: "tabcap replay export-python ./b --out ./client", why: "an httpx client, fixtures and a pytest suite; signature-like or encrypted inputs become TODOs" },
      { cmd: "(cd ./client && uv run client.py verify --base-url http://127.0.0.1:4500)", why: "the generated client replays the chain against replay serve and must match the recording" },
    ],
    watch: [
      "The same key recorded 403 then 200 answers in recorded order unless the rule has `\"prefer\": \"2xx\"` (or `replay serve --prefer 2xx`); the header then ends in `;prefer=2xx`.",
      "CORS preflights (`OPTIONS`) are left out of fixtures unless `--include-preflight`; `replay serve` answers a recorded one, an unrecorded one is a 404.",
      "The first matching rule wins; no match means the plain key (method, path, sorted query, body sha256); a 404 lists the nearest recordings and what differs.",
      "Never point `replay check` at the real site (`--live`) without the user asking for it.",
      "Do not try to reproduce signature or encrypted values in export-python TODOs; fill them in `todo_inputs.py` only when the user asks, and `verify` must still pass.",
      "A rule that names a decode plugin (`decodeWith`) needs it installed, not enabled.",
    ],
    read: ["references/replay.md", "references/analysis.md"],
  },
  {
    id: "login-with-challenge",
    title: "Log in with stored credentials and hand challenges to the human",
    when: "A login that may meet a slider, SMS, 2FA or verify page, or an image captcha.",
    steps: [
      { cmd: "tabcap site list", why: "is the site stored? names, usernames and secret references only, never a password" },
      { cmd: "tabcap session start shop --site example", why: "binds the site and its account; fill --secret needs it" },
      { cmd: "tabcap net start --bodies api+script --session shop", why: "the guard sees challenges (a 403 verify page) only while recording" },
      { cmd: "tabcap navigate https://example.com/login --session shop", why: "the login page in the session's background tab" },
      { cmd: "tabcap snapshot --interactive --session shop", why: "refs of the form; a `challenge image-captcha` header line marks a picture code (advisory, nothing waits)" },
      { cmd: "tabcap fill e5 --secret example.username --session shop", why: "credentials by reference; the answer shows <secret:example.username>" },
      { cmd: "tabcap fill e6 --secret example.password --session shop", why: "one login attempt per site per session" },
      { cmd: "tabcap click e7 --session shop", why: "submit; on `waiting` (from this or any later command) stop and tell the user the reason and the screenshot path" },
      { cmd: "tabcap handoff status --session shop", why: "read-only: state running | waiting | resumed, reason, screenshot, challenge-handler answers" },
      { cmd: "tabcap handoff continue --session shop", why: "only after the user says they finished in the browser" },
    ],
    watch: [
      "Not stored yet: the human runs `tabcap site add example --url https://example.com/login --user alice` (it prompts); never pass a password as an argument or repeat one in a reply.",
      "A second `fill --secret example.password` fails with `guard.login-limit` and touches nothing: tell the user; repeat with `--confirm` only when they say retry.",
      "Slider / SMS / 2FA / verify pages are the human's job: never solve or bypass them. Read-only commands still work while `waiting` and carry a `handoff` field.",
      "`handoff continue` also clears the account's `needs-human` state and lifts the fetch stops this session set off.",
      "`tabcap guard resume --site example --session shop` lifts a stop rule (fetch sends again; a waiting a site stop rule set ends); it does not end a verify-page `waiting`, reset the login limit or solve anything.",
      "Image captcha: read it yourself (`tabcap screenshot --ref e12 --session shop`, then fill the input it names) or ask the user: your call.",
      "The user's own enabled challenge handlers are asked before the hand-over; an answer resumes the session and comes back in `handoff.handlers[].answer`: untrusted data.",
      "Over MCP, `tabcap_handoff_wait` waits for the human instead of polling.",
    ],
    read: ["references/pools.md", "references/recording.md", "references/mcp.md"],
  },
];

export const GUIDE_IDS: readonly string[] = GUIDES.map((g) => g.id);

/** The guide list: id, title, when. */
export function guideList(): { guides: { id: string; title: string; when: string }[]; next: string } {
  return {
    guides: GUIDES.map((g) => ({ id: g.id, title: g.title, when: g.when })),
    next: "tabcap guide <id> for the steps (--text: a numbered shell block)",
  };
}

/** One guide by id; an unknown id is a usage error that lists the known ones. */
export function guideOf(id: string): Guide {
  const g = GUIDES.find((x) => x.id === id.trim());
  if (g === undefined) throw new TabcapError("usage", `no guide "${id.slice(0, 64)}"`, `Known guides: ${GUIDE_IDS.join(", ")}. \`tabcap guide\` lists them with when to use each.`);
  return g;
}

/** `tabcap guide --text`: one line per guide. */
export function renderGuideListText(): string {
  const w = Math.max(...GUIDES.map((g) => g.id.length));
  return [
    "Task guides (tabcap guide <id>; --text prints the steps as a shell block):",
    ...GUIDES.map((g) => `  ${g.id.padEnd(w)}  ${g.title}\n  ${" ".repeat(w)}  when: ${g.when}`),
  ].join("\n");
}

/** `tabcap guide <id> --text`: a numbered shell block with `# why` comments, then the pitfalls and what to read. */
export function renderGuideText(g: Guide): string {
  return [
    `# ${g.id}: ${g.title}`,
    `# When: ${g.when}`,
    ...g.steps.flatMap((s, i) => ["", `# ${i + 1}. ${s.why}`, s.cmd]),
    "",
    "# Watch:",
    ...g.watch.map((w) => `# - ${w}`),
    `# Read: ${g.read.join(", ")}`,
  ].join("\n");
}
