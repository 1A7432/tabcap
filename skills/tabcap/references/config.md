<!-- GENERATED from src/shared/config.ts (CONFIG_KEYS) by `bun run gen:docs`; do not edit by hand. -->

# config.json keys

`config.json` is in tabcap's config directory (`~/.config/tabcap/` on macOS, `$XDG_CONFIG_HOME/tabcap/` or `~/.config/tabcap/` on Linux, `%LOCALAPPDATA%\tabcap\config\` on Windows; `tabcap setup` answers its path as `config`). Every key is optional; `<site>` stands for a store site name (`tabcap site list`). A file that is not valid JSON, or not a JSON object, is a `bad-input` error naming the line and column for every command that reads it (`tabcap status` instead keeps its answer and reports that error in `config.error`), and `tabcap setup` does not rewrite it. A key this table does not list at its level is not an error: `browser start` / `browser status` (`warnings`), `tabcap status` (`config.warnings`) and `tabcap setup` (`warnings`) name it, e.g. `config.json: unknown key fetch.minIntervalMS (did you mean minIntervalMs?)`. `replay` and `sites.<site>.replay` hold replay key rules, which refuse unknown keys. The last column is the section of docs/04 (the evidence bundle spec in the tabcap repository) that specifies the key.

| Key | Type | Default | Meaning | docs/04 |
|---|---|---|---|---|
| `chrome` | `object` | — | the browser `tabcap setup` recorded, and Chrome switches for `browser start` | §42 |
| `proxy` | `"system" \| "none" \| "<scheme>://host:port"` | `"system"` | default of `browser start --proxy`; no `user:pass@` (store such a proxy with `tabcap proxy add`) | §42 |
| `webdriver` | `"hidden" \| "visible"` | `"hidden"` | default of `browser start --webdriver` | §40 |
| `pool` | `object` | — | how `--account auto` picks accounts, proxy rotation, health checks and hourly budgets | — |
| `fetch` | `object` | — | pacing and stop rules of `tabcap fetch` for every host | §26 |
| `sites` | `object (store site name → settings)` | `{}` | settings of one store site: `fetch`, `guard`, `replay` | §26 |
| `record` | `object` | — | recording defaults | §5.2 |
| `trace` | `object` | — | defaults of `trace start` | §33 |
| `handoff` | `object` | — | the human take-over listener | §37 |
| `protection` | `object` | — | the live protection-family probe | §41.3 |
| `replay` | `object ({rules: [...]})` | — | replay key rules for every bundle, after the site's own | §31 |
| `chrome.executablePath` | `string` | — | the Chrome for Testing binary, written by `tabcap setup`; `--executable-path` and `$TABCAP_CHROME` come first | — |
| `chrome.version` | `string` | — | its version, written by `tabcap setup` | — |
| `chrome.platform` | `string \| null` | — | the build `tabcap setup` downloaded (mac-arm64, mac-x64, linux64, win64); null for `--executable-path` | — |
| `chrome.args` | `string[]` | `[]` | Chrome switches added at every `browser start`, before `--chrome-arg` | §42 |
| `chrome.dropArgs` | `string[]` | `[]` | tabcap's own switches removed at every `browser start`, before `--drop-chrome-arg` | §42 |
| `pool.strategy` | `"fixed" \| "round-robin" \| "lru"` | `"fixed"` | how `session start --account auto` picks one of the site's accounts | — |
| `pool.egress` | `object` | — | when an account's proxy is rotated | — |
| `pool.health` | `object` | — | proxy health checks | — |
| `pool.budget` | `object` | — | hourly request budget per account | §4.1 |
| `pool.egress.mode` | `"fixed" \| "rotate"` | `"fixed"` | keep one proxy per account, or rotate | — |
| `pool.egress.rotateOn` | `"per-session" \| "every:<N>requests" \| "every:<T>min"` | `"per-session"` | when `rotate` moves to the next proxy | — |
| `pool.health.url` | `null \| http(s) URL` | `null` | address fetched through a proxy by `proxy check` (without `--url`) and the periodic check | — |
| `pool.health.intervalS` | `number (seconds, ≥ 10)` | `300` | time between the periodic checks of one proxy | — |
| `pool.budget.requestsPerHour` | `null \| integer ≥ 1` | `null` | requests per account and hour; past it the account's page commands wait for the next hour | §4.1 |
| `fetch.minIntervalMs` | `integer (ms, 0–3600000)` | `3000` | least time between two requests `tabcap fetch` sends to one host (also the floor of `replay check --live`) | §26 |
| `fetch.concurrency` | `integer (1–16)` | `1` | requests `tabcap fetch` keeps in flight per host | §26 |
| `fetch.stopOn` | `string[] (stop rules)` | `[]` | stop rules checked on every `tabcap fetch` answer; one that matches stops the site's fetches | §26 |
| `sites.<site>.fetch` | `object` | — | `fetch` keys for this site only, over the global ones (a `stopOn` here replaces the global list) | §26 |
| `sites.<site>.guard` | `object` | — | stop / end rules checked on every recorded response of the site, in every session | §18 |
| `sites.<site>.replay` | `object ({rules: [...]})` | — | replay key rules for bundles of this site, before the global `replay` | §31 |
| `sites.<site>.fetch.minIntervalMs` | `integer (ms, 0–3600000)` | `3000` | least time between two requests `tabcap fetch` sends to one host (also the floor of `replay check --live`) | §26 |
| `sites.<site>.fetch.concurrency` | `integer (1–16)` | `1` | requests `tabcap fetch` keeps in flight per host | §26 |
| `sites.<site>.fetch.stopOn` | `string[] (stop rules)` | `[]` | stop rules checked on every `tabcap fetch` answer; one that matches stops the site's fetches | §26 |
| `sites.<site>.guard.stopOn` | `string[] (stop rules)` | `[]` | a match stops the site's fetches and hands the session to the human (`waiting`, reason stop-rule) | §18 |
| `sites.<site>.guard.consecutiveNon200` | `null \| integer (1–10000)` | `null` | this many non-2xx responses in a row (by arrival) is a stop | §18 |
| `sites.<site>.guard.endOn` | `string[] (stop rule syntax)` | `[]` | end rules: "the list has ended", checked before every stop rule; a match stops nothing | §38 |
| `record.bodies` | `"all" \| "api" \| "api+script" \| "none"` | `"all"` | default of `net start --bodies`: which response bodies are stored | §5.2 |
| `trace.decode` | `boolean` | `false` | default of `trace start --decode` (observe mode) | §33 |
| `trace.weakRows` | `boolean` | `true` | file single-suspect decoded rows (`link: weak`); false counts them as `drops.weak` | §33 |
| `handoff.detectTakeover` | `boolean` | `true` | watch owned tabs for human input; read at `browser start` | §37 |
| `protection.live` | `boolean` | `true` | probe each navigated page for protection families; read at `browser start` | §41.3 |
| `replay.schema` | `"tabcap-replay-rules/0"` | — | may be left out here (a `--rules` file must carry it) | §31 |
| `replay.rules` | `rule[] ({match, key, response, prefer})` | `[]` | replay key rules: how `replay serve` / `replay check` / `bundle export fixtures` key and compare requests | §31 |
| `sites.<site>.replay.schema` | `"tabcap-replay-rules/0"` | — | may be left out here (a `--rules` file must carry it) | §31 |
| `sites.<site>.replay.rules` | `rule[] ({match, key, response, prefer})` | `[]` | replay key rules: how `replay serve` / `replay check` / `bundle export fixtures` key and compare requests | §31 |
