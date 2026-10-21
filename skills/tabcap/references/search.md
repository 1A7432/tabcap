# Searching inside commands: read only what you need

Filtering happens in the daemon. Ask for the part you need instead of reading a whole tree or body and searching it yourself. Every answer is still one JSON envelope; every cut says how to get more (`truncated`, `note`, `more`); every text is secret-scrubbed. All of these are read-only.

## Which one to use

| You want | Use |
|---|---|
| the line (and ref) of an element whose text you know | `tabcap snapshot --grep 'Add to cart'` |
| the elements a CSS selector / XPath matches, as snapshot lines with refs | `tabcap snapshot --css 'table#orders tr'`, `tabcap snapshot --xpath '//form//button'` |
| what is inside one element you already have a ref for | `tabcap snapshot --ref e12 --depth 2` |
| the markup of one element (an attribute, a hidden field, a `data-*` value) | `tabcap html e12`, `tabcap html --css 'form#login' --attrs` |
| an element's text without the tree around it | `tabcap html e12 --text` |
| where a value appears in one recorded response | `tabcap net body r-12 --grep 'csrf|token'` |
| a range of lines of a recorded response | `tabcap net body r-12 --lines 120-180` |
| the code at a `trace list` caller or a console stack frame | `tabcap net body --url <script url> --at <line>:<col> --pretty` |
| minified JavaScript or one-line JSON made readable before searching | add `--pretty` to `net body` / `net grep` |
| which recorded responses mention a string at all | `tabcap net grep 'x-sign|signature' --resource-types script` |
| which response carries a value the page shows, through base64 / JSON / gzip | `tabcap where` or `tabcap analyze find` — not `net grep` |

`net grep` is raw-text regex search over the recorded bodies. `analyze find` follows a value through decode chains (base64, URL encoding, JSON, compression…); use it when the value may be encoded.

## Snapshot filters

- `--grep <regex>` matches each line's role, name, value, states and description (not the ref). Each match comes with its ancestor lines, indented as in the full snapshot; `--context N` adds N sibling lines on each side; `--max-matches` (default 50) caps the matches shown over all documents, `search.matches` counts them all.
- `--css` / `--xpath` run in each document the snapshot shows (the root document, plus the frames `--frames` / `--frame f2` expand) and print the matched elements' lines with their ancestors. An element with no accessibility line (UI libraries often hide inputs and buttons from it) prints as `(no accessible node) <input#id.class> [e31]` with a DOM-backed ref: `click`, `fill`, `type` (after `fill` / `click` focused it), `hover`, `upload`, `html` and `screenshot --ref` take it like any ref, and it expires the same way.
- `--ref e12 --depth n` prints the subtree under the element, n levels; the ref's own frame is used for a frame ref (`f2/e7`), no `--frames` needed. Hidden deeper lines are counted in `search.hidden`.
- Refs in a filtered snapshot are the full snapshot's refs: click / fill them as usual. The header (overlays, frames) is always there.
- Regexes are JavaScript with the `u` flag, at most 256 characters; escape `. ( ) [ ] { } * + ? ^ $ | \` to match them literally (`\,` is not valid under `u`).

## `html`

`tabcap html <ref>` (outerHTML), `--inner`, `--text` (textContent) or `--attrs` (an object). `--css <selector>` takes the first match in the root document (`matched` counts all); use a frame ref for an element in a frame. `--max-chars` (default 4000) cuts the text, with `truncated: true` and `chars` (the whole length).

## Body line search

- `net body r-12 --grep <regex>`: `{line, col, text, before, after}` per match (1-based; columns in UTF-16 units, as V8 reports them), plus `total`, `lines`, `bytes`, `mime`. Lines over 500 characters are shown as a 500-character window around the match; `clip.from` is its first column.
- `--lines a-b`: at most 500 lines per call; `note` names the next range.
- `--at line:col`: the lines around that position of the raw body. `trace list` callers and console stack frames give exactly these positions; with `--url` instead of an id the last recorded request for that URL is used (`resolvedBy: "url"`). With `--pretty` the position is mapped into the pretty text and the answer keeps `raw: {line, col}`.
- `--pretty`: JavaScript gets line breaks after `;`, `{`, `}` and `,` outside brackets, strings, template literals, regex literals and comments (insertions only, no reformatting); JSON is re-indented. Line numbers then refer to the pretty text. Bodies over 8 MB are not prettified (`note` says so).
- Without these flags `net body` answers as before: a path and a 10000-character preview.

## A large body, with a shell: export it

With a shell: `tabcap net body r-12 --file` (or `--url <u> --file`, add `--pretty` for minified JavaScript / JSON), then `rg` / `grep` on the `file` path it returns. The file holds the decoded body, exactly the text `--grep` / `--lines` search, with known secret values already replaced by `<secret:…>` (`scrubbed: true`); it lands in the open recording's `exports/bodies/<r-N>[.pretty].<ext>` (else `<cache>/outputs/bodies/<stamp>-<r-N>…`), mode 0600, and a repeat overwrites it. The answer is `{id, url, mime, bytes, lines, pretty, file, scrubbed}`, with no body inline. A binary body is written as recorded and reports `scrubbed: false`. Not combinable with `--grep` / `--lines` / `--at` / `--out`. Without a shell: `net body --grep` / `net grep`.

## `net grep`

`tabcap net grep <regex> [--resource-types script,xhr,fetch,document] [--max-matches 20] [--context 1] [--pretty]` searches every recorded response body of the session. Per request: `{id, url, resourceType, count, matches}`; at most 50 requests (`more` counts the rest); bodies over 8 MB are listed under `skipped` (search them one at a time with `net body --grep`); binary bodies are counted under `binary`.

## JSON paths

One syntax wherever a command takes a JSON path: `--select`, the `json:` stop and end rules (`fetch --stop-on` / `--end-on`, `config.json` `fetch.stopOn`, `sites.<name>.guard`), `bundle info --usage --business-code`, and the replay key rules' `ignoreBodyFields` / `ignorePaths` (docs/04 §43).

- `$` is the root, then `.name`, `[2]`, `[*]` or `.*` (every element of an array, every value of an object), `["quoted name"]` (a JSON string, for names with spaces, `=`, `!` or brackets). A bare name has none of `.` `[` `]` `=` `!` or spaces; Chinese, `-`, `$`, `:` are fine. `["*"]` is a key named `*`.
- Rules and replay rules start with `$`: `json:$.code!=0`, `json:$["err msg"]="locked"`, `--business-code '$.data.items[*].code=0'`. `--select` may leave it out: `--select 'requests[*].url'` is `--select '$.requests[*].url'`.
- With a wildcard: `--select` returns every match as an array; `json:<path>=<v>` fires when any value equals `<v>`, `!=` when any value differs or there is none (an empty list too: mark "no more pages" with an end rule); `--business-code` counts an error when any value is not the ok value or there is none; replay rules drop every match.
- A bad path is refused, naming the character where it went wrong.
