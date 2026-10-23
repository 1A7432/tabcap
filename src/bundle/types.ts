// Evidence bundle v0 types. Spec: docs/04-evidence-bundle-spec-v0.md.
//
// Write-side contract: this file mirrors docs/04 §3 (envelope), §4 (event
// kinds, with the rulings of the later sections that added fields), §5.1
// (request) and §7 (manifest). `EventFields[K]` is everything a producer writes
// for kind K besides the §3 envelope; the recorder's own writes and
// `Recorder.event(kind, fields)` take it, so a field that drifts from docs/04
// does not compile. When docs/04 and this file disagree, one of them is a bug.
//
// The read side does not trust these types: a bundle on disk is untrusted
// input (imported HAR, other tools, older versions). reader.ts validates what
// it uses and normalises a request into `RequestEvent` (§5.1 with every field
// present); unknown kinds and fields are kept verbatim (§3).
// Event shapes are `type` aliases (not interfaces) so they stay assignable to
// the open `RawEvent` record.

import type { DecodedView } from "./decoded.ts";

export const FORMAT_ID = "evidence-bundle/0";
export const FORMAT_MAJOR = 0;

export const ACTORS = ["human", "ai", "system"] as const;
export type Actor = (typeof ACTORS)[number];

/** §3 public fields carried by every line of events.jsonl. */
export type Envelope = {
  seq: number;
  ts: number;
  mono: number | null;
  kind: string;
  actor: Actor;
  tab: string | null;
  /**
   * The AI command window (`c-<seq>`) the event belongs to, or null. A `request`
   * takes the window open when it started (requestWillBeSent), not the one open
   * when it was written; a `tabcap fetch` request always its own command's (§3, §5.1).
   */
  cmd: string | null;
};

/** Any event as stored: envelope plus arbitrary extra fields, kept verbatim. */
export type RawEvent = Envelope & { [field: string]: unknown };

/** An event before the writer assigns `seq`. */
export type UnsequencedEvent = Omit<Envelope, "seq"> & { [field: string]: unknown };

/** `{inline}` or `{blob, size}` payload reference (§4.1 ws, §5.1 postData). */
export type InlineOrBlob = { inline: string } | { blob: string; size: number };

// ---------------------------------------------------------------- §4.1 (P1)

export type CaptureMode = "passive" | "active" | "mixed";

/**
 * `manifest.mode.trace` (docs/04 §4.1 `signal`, §7): false, or the settings of
 * the recording's trace windows (the last `trace start` wins).
 */
export type TraceMode = {
  mechanism: Array<"fn-breakpoint" | "instrumentation">;
  /** `sha256:<hex>` of the active signals.json (the built-in list: its embedded JSON text). */
  apis: string;
  stack: number;
  firstN: number;
  maxHits: number;
  /** 0.6-L observe mode on (docs/04 §33): in-page decoding sinks armed on suspects. */
  decode?: boolean;
};

/** `manifest.traceWindows[]`: seqs of the `note` events that opened and closed one trace window (toSeq null while open). */
export type TraceWindow = { fromSeq: number; toSeq: number | null };

/** §4.1 `session`: the recording starts / stops; `stop` carries the manifest's `mode.trace`. */
export type SessionFields = {
  phase: "start" | "stop";
  name: string;
  mode: { capture: CaptureMode; trace: false | TraceMode; raw: boolean };
};

export type TabReason = "ai-opened" | "borrowed" | "user-cancelled-debugging" | "closed" | "crashed" | "popup";

/** A child target (OOPIF / service worker / worker) attached under its host tab (§4.1 `tab`). */
export type TabTarget = { id: string; type: "iframe" | "service_worker" | "worker"; url: string; sessionId: string };

/**
 * §4.1 `tab`. A tab joining the recording writes phase / chromeTabId / targetId /
 * owned / url / title / reason; a child target writes `{phase:"attach", target}`;
 * a closed tab `{phase:"close", reason:"closed", url}`.
 */
export type TabFields = {
  phase: "open" | "attach" | "detach" | "close" | "replace";
  chromeTabId?: number | null;
  /** The tab's CDP target id (the tab joining the recording). */
  targetId?: string;
  owned?: boolean;
  url?: string | null;
  title?: string | null;
  reason?: TabReason | null;
  target?: TabTarget;
};

export type NavType = "navigation" | "history" | "reload" | "back_forward";

/** §4.1 `nav`: a navigation epoch (`nav` is `n-<seq of this event>`). */
export type NavFields = {
  frame: string; // "root" or a frameId
  nav: string;
  url: string;
  from: string | null;
  type: NavType;
  loaderId: string | null;
  loadEvent: { domContentLoaded: number | null; load: number | null } | null;
  /** §14: the page the tab already showed when the recording started. */
  initial?: true;
};

/**
 * §4.1 `ws`, §15: a data frame (control frames only go to raw/), or the socket's
 * close / error. `payload` is null when a frame was over the blob cap (`reason` says so).
 */
export type WsFields =
  | { ws: string; phase: "frame"; direction: "send" | "recv"; opcode: 1 | 2; payload: InlineOrBlob | null; reason: string | null }
  | { ws: string; phase: "close" | "error"; reason: string | null };

/**
 * §4.1 `sse`, §47 (0.9-C): one message of a `text/event-stream` response, written right after its
 * `request`. `id` is the last event ID at dispatch ("" before any `id` field); `at` is the monotonic ms
 * the bytes completing the message arrived, null when unknown; `nav` is the request's.
 */
export type SseFields = { sse: string; nav: string | null; index: number; event: string; id: string; retry: number | null; data: InlineOrBlob; at: number | null };

/** §4.1 `download`, §48 (0.9-D): one download of a recording session, written when it ended. */
export type DownloadFields = {
  /** Always "d-" + seq. */
  id: string;
  nav: string | null;
  url: string;
  urlTruncated?: true;
  suggestedFilename: string;
  guid: string;
  state: "completed" | "canceled";
  reason: "too-large" | "canceled" | "stopped" | "browser-gone" | null;
  bytes: number;
  totalBytes: number | null;
  /** "downloads/<sha256>" inside the bundle; null when no file was kept (or the copy is redacted). */
  file: string | null;
  sha256: string | null;
  startedTs: number;
  /** §48: `bundle redact` copies carry no downloads/. */
  redacted?: true;
};

/**
 * An AI command is a start / end pair (docs/04 §14, §15). Events written while
 * the command runs carry `cmd: <start id>`; the start event's own `cmd` is its id.
 */
export type CmdStartFields = {
  id: string; // c-<seq>
  phase: "start";
  argv: string[] | null;
  input: Record<string, unknown>;
};

export type CmdEndFields = {
  phase: "end";
  ref: string; // id of the start event
  ok: boolean;
  error: unknown;
  durationMs: number;
  outputSummary: unknown;
  /** fill / type only: argv and input are withheld from the start event until the tool checked for secrets. */
  argv?: string[] | null;
  input?: Record<string, unknown>;
};

export type CmdFields = CmdStartFields | CmdEndFields;

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";
export type ConsoleSource = "console" | "exception" | "network" | "security" | "other";

/** §4.1 `console` (0.2), §15: line / col 1-based; `text` cut at 4 KB (then `truncated`); only exceptions carry a stack. */
export type ConsoleFields = {
  level: ConsoleLevel;
  source: ConsoleSource;
  text: string;
  truncated?: true;
  args: string[];
  url: string | null;
  line: number | null;
  col: number | null;
  stack: string | null;
};

export type ActionOp = "click" | "fill" | "key" | "select" | "scroll" | "navigate" | "upload" | "dialog" | "evaluate" | "input";

export type ActionTarget = {
  ref?: string;
  role?: string;
  name?: string;
  selector?: string;
  rect?: [number, number, number, number];
  frame?: string;
};

/** §4.1 `action` for the page actions a human makes (P2: not written yet; §23). */
export type ActionOpFields = {
  op: Exclude<ActionOp, "input">;
  target: ActionTarget;
  value: string | null;
  phase: "done" | "failed";
  error?: unknown;
  shots?: { before?: string; after?: string };
  nav: string | null;
  trusted: boolean;
};

/**
 * 0.7.1-A (§4.1, §37): one raw human input seen on a session tab while the
 * session waits; `actor:"human"`, `cmd:null`. Only the kind and the page time.
 */
export type ActionInputFields = {
  op: "input";
  /** "pointerdown" | "keydown" | "wheel" | "touchstart" (the take-over listener reports nothing else). */
  event: string;
  /** Page time of the input, epoch ms. */
  at: number;
  target: null;
  value: null;
  phase: "done";
  error: null;
  shots: null;
  nav: string | null;
  trusted: true;
};

export type ActionFields = ActionOpFields | ActionInputFields;

/** §4.1 `screenshot` (kind reserved; nothing writes it yet: hand-off screenshots are files named by `handoff.screenshot`). */
export type ScreenshotFields = {
  blob: string;
  format: "png" | "jpeg";
  width: number;
  height: number;
  scale: number;
  reason: "nav" | "action" | "manual" | "interval" | "handoff";
  nav: string | null;
};

export type StateReason = "session-start" | "nav" | "session-stop" | "manual";

/** §4.1 `state`: a cookie (or storage) snapshot stored as a blob. */
export type StoreStateFields = {
  what: "cookies" | "localStorage" | "sessionStorage";
  origin: string | null;
  blob: string;
  count: number;
  reason: StateReason;
};

/** One field of an env snapshot (§4.3): a JSON value, a hash, or why there is none. */
export type EnvField = { name: string; value?: unknown; hash?: string; error?: string };

/** docs/04 §4.3: a read-only environment snapshot; `fingerprint probe` (0.4-G) writes source "fingerprint-probe" with the fields inline. */
export type EnvStateFields = {
  what: "env";
  source: string;
  origin: string | null;
  count: number;
  reason: StateReason;
  fields: EnvField[];
};

export type StateFields = StoreStateFields | EnvStateFields;

/** §4.1 / §15 evidence items of a `finding`; `analyze deps --write-findings` also cites an action by its event seq. */
export type FindingEvidence = { request: string; path?: string } | { ws: string; frame: number } | { blob: string } | { console: number } | { action: number };

export type FindingTool = "find" | "diff" | "deps" | "trace" | "where" | "wire" | "manual";
export type FindingGrade = "实测" | "推断" | "待验" | "人确认";

/**
 * §4.1 `finding` (`actor` "ai" or "human" in the envelope). `evidence` items have
 * the FindingEvidence shapes; they come from the analysis commands as plain
 * records (shared with the offline `--save` path, analyze/finding.ts), so the
 * write side only checks that they are records.
 */
export type FindingFields = {
  tool: FindingTool;
  grade: FindingGrade;
  claim: string;
  evidence: Array<Record<string, unknown>>;
  input: unknown;
  output: unknown;
};

/** §4.1 `note`; a decode plugin disabled by the recorder adds `plugin` (§28). */
export type NoteFields = {
  text: string;
  refs: unknown[];
  plugin?: string;
};

/** One frame of a `signal` stack; line / col as CDP gives them (0-based). */
export type SignalFrame = { url: string; line: number; col: number };

/**
 * docs/04 §4.1 `signal` (0.4-F trace mode): reads of one browser signal API,
 * aggregated per (document, api, caller location). Recorded from debugger
 * breakpoints; nothing in the page is changed.
 */
export type SignalFields = {
  frame: string | null;
  nav: string | null;
  api: string;
  access: "get" | "call" | "event";
  args: string | null;
  caller: { kind: "page" | "tabcap"; url: string; scriptId: string; line: number; col: number };
  stack: SignalFrame[];
  count: number;
  firstMono: number | null;
  lastMono: number | null;
  truncated?: true;
  value?: unknown;
};

// ---------------------------------------------------------------- §5.1 request

/** Lowercase header names; repeated headers as arrays; no ":" pseudo headers. */
export type Headers = { [name: string]: string | string[] };

export const HEADERS_SOURCES = ["event", "wire", "merged"] as const;
export type HeadersSource = (typeof HEADERS_SOURCES)[number];

export const RESOURCE_TYPES = ["document", "xhr", "fetch", "script", "stylesheet", "image", "font", "media", "websocket", "eventsource", "manifest", "other"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** §5.2 rule 5 reasons, plus "too-large" (rule 4). */
export const BODY_MISSING_REASONS = ["too-large", "redirect", "not-modified", "no-content", "navigated", "evicted", "detached", "stopped", "failed", "unsupported"] as const;
export type BodyMissingReason = (typeof BODY_MISSING_REASONS)[number];

export type BodyMissing = { reason: BodyMissingReason; detail: string | null };

export type ResponseBody = {
  blob: string;
  size: number;
  base64: boolean;
  wireEncoding: string | null;
  truncated: boolean;
  /** HAR import only (§9.2): content-encoding present but bytes would not decode. */
  decodeFailed?: boolean;
  /** §47 (0.9-C): a streaming response that did not end normally; the bytes are what arrived. */
  partial?: true;
};

/** 0.6-I (§5.2 rule 10): `response.body` of a body `net start --bodies` did not store; `bodyMissing` is then null. */
export type SkippedBody = { skipped: string };

/** 0.6-P (§34): the `credentials` a `tabcap fetch` handed to the page's fetch(). */
export type FetchCredentials = "include" | "same-origin" | "omit";

/** §5.1 `initiator` as the recorder writes it (script initiators take url / line / col from the stack's top frame, 0-based). */
export type InitiatorFields = { type: string; url: string | null; line: number | null; col: number | null; stack: null };

/** §5.1 `request` side as written. */
export type RequestSideFields = {
  headers: Headers;
  headersSource: HeadersSource;
  postData: InlineOrBlob | null;
  /** §5.3: the body was there but could not be stored. */
  postDataMissing?: { reason: string; detail: string | null };
  /** Plaintext view of the request body from a decode plugin (docs/04 §28). */
  decoded?: DecodedView;
};

/**
 * §14 / §15: no response arrived (cut by a navigation, failed before headers,
 * still open at stop): never `response: null`, but status null, empty headers
 * and why there is no body.
 */
export type NoResponseFields = {
  status: null;
  headers: Headers;
  body: SkippedBody | null;
  bodyMissing: BodyMissing | null;
};

/** §5.1 `response` side as written when a response line arrived. */
export type ResponseLineFields = {
  status: number;
  statusText: string;
  headers: Headers;
  headersSource: HeadersSource;
  mimeType: string | null;
  charset: string | null;
  protocol: string | null;
  remote: { ip: string; port: number | null } | null;
  fromCache: boolean;
  fromServiceWorker: boolean;
  fromPrefetch: boolean;
  body: ResponseBody | SkippedBody | null;
  bodyMissing: BodyMissing | null;
  /** Plaintext view of the response body from a decode plugin (docs/04 §28). */
  decoded?: DecodedView;
};

export type ResponseFields = NoResponseFields | ResponseLineFields;

export type RequestOutcome = "finished" | "failed" | "incomplete";

/** §5.1 `request` event as the recorder writes it (one per HTTP exchange, when it ends). */
export type RequestFields = {
  /** 0.6-A (§5.1, §26): the `tabcap fetch` this request belongs to, `c-N:f-K`. */
  fetchId?: string;
  /** 0.6-P (§5.1, §34): that fetch's credentials mode. */
  fetchCredentials?: FetchCredentials;
  nav: string | null;
  cdp: { requestId: string; loaderId: string | null; frameId: string | null; sessionId: string | null } | null;
  type: ResourceType;
  method: string;
  url: string;
  urlFragment: string | null;
  initiator: InitiatorFields | null;
  request: RequestSideFields;
  response: ResponseFields;
  redirect: { from: string } | null;
  /** Monotonic ms; `end` null when written from the Fetch body (§5.2 rule 9); `cdp` is Network.ResourceTiming as is. */
  timing: { start: number | null; responseStart: number | null; end: number | null; cdp: Record<string, unknown> | null };
  outcome: RequestOutcome;
  error: { text: string; canceled: boolean; blockedReason: string | null } | null;
  /** §14 / §5.2 rule 9: the body came from Fetch interception. */
  bodySource?: "fetch";
  /** §5.2 rule 9: finished from the Fetch body, the page never read it. */
  unreadByPage?: true;
  /** Always "r-" + seq; the last key of the line (the writer knows the seq). */
  id: string;
};

/** Plain `request` event minus `id`, as built before the writer assigns the seq. */
export type RequestDraft = Omit<Envelope, "seq" | "kind"> & { kind: "request" } & Omit<RequestFields, "id">;

// ---------------------------------------------------------------- §5.1 request, read side

/** reader.ts normalised `request` side: every field present. */
export type RequestSide = {
  headers: Headers;
  headersSource: HeadersSource;
  postData: InlineOrBlob | null;
  postDataMissing?: { reason: string; detail: string | null };
  /** Plaintext view of the request body from a decode plugin (docs/04 §28). */
  decoded?: DecodedView;
};

/** reader.ts normalised `response` side (no-response events read as status null with the rest empty). */
export type ResponseSide = {
  /** null when no response arrived (navigated away, failed, stopped, detached: docs/04 §14, §15). */
  status: number | null;
  statusText: string;
  headers: Headers;
  headersSource: HeadersSource;
  mimeType: string | null;
  charset: string | null;
  protocol: string | null;
  remote: { ip: string; port: number | null } | null;
  fromCache: boolean;
  fromServiceWorker: boolean;
  fromPrefetch: boolean;
  body: ResponseBody | null;
  bodyMissing: BodyMissing | null;
  /** Plaintext view of the response body from a decode plugin (docs/04 §28). */
  decoded?: DecodedView;
  /** 0.6-I: `response.body: {skipped}` (net start --bodies); `body` is then null and nothing is missing. */
  bodySkipped?: string;
};

/**
 * A `request` event as reader.ts `parseRequest` returns it: §5.1 with every
 * field present (absent on disk → null / empty; imported HAR may lack most).
 */
export type RequestEvent = Envelope & {
  kind: "request";
  nav: string | null;
  id: string; // always "r-" + seq
  cdp: { requestId: string; loaderId: string | null; frameId: string | null; sessionId: string | null } | null;
  type: ResourceType;
  method: string;
  url: string;
  urlFragment: string | null;
  initiator: { type: string; url?: string | null; line?: number | null; col?: number | null; stack?: unknown } | null;
  request: RequestSide;
  response: ResponseSide | null;
  redirect: { from: string } | null;
  timing: { start: number | null; responseStart: number | null; end: number | null; cdp: Record<string, unknown> | null } | null;
  outcome: RequestOutcome;
  error: { text: string; canceled?: boolean | null; blockedReason?: string | null } | null;
} & { [field: string]: unknown }; // readers keep unknown fields (§3)

// ---------------------------------------------------------------- §4.2 (P2 kinds the daemon writes since 0.3-A)

/** Why a session waits for the human (§4.2): a verify page, a site stop rule (0.6-I), the human took over (0.7.1-A). */
export type HandoffReason = "verify-page" | "stop-rule" | "human-takeover";

/**
 * Who ended a handoff (§4.2, §39): `handoff continue`, a challenge handler, `guard resume
 * --site`, a `handoff wait` condition, the browser going away, `session stop`
 * (never recorded: the recording has ended by then).
 */
export type HandoffBy = "human" | `plugin:${string}` | "guard-resume" | "condition" | "browser-gone" | "session-stop";

/** 0.7.5-B (§39): the `handoff wait --until-*` condition that ended a handoff (a cookie by name only). */
export type HandoffCondition = { kind: "url" | "text" | "selector" | "cookie"; value: string };

/** §4.2 / §18 / §37 / §41.3: the session started waiting for the human. */
export type HandoffWaitingFields = {
  state: "waiting";
  /** 0.8-A (§41.3): protection family names identified on the tab, when any. */
  protection?: string[];
  reason: HandoffReason;
  question: string;
  timeoutMs: null;
  answerRef: null;
  /** The recorded request that tripped it (`r-N`); null for a take-over. */
  request: string | null;
  url: string;
  /** The hand-off screenshot's path; null when there is none (always for a take-over). */
  screenshot: string | null;
  /** 0.7.1-A take-over only (§37): the human input that started it (kind, page time in epoch ms). */
  input?: { event: string; at: number };
};

/** §4.2 / §39: the handoff ended. */
export type HandoffResumedFields = {
  state: "resumed";
  reason: HandoffReason;
  question: null;
  timeoutMs: null;
  /** The challenge handler's command window (`c-N`) when one answered. */
  answerRef: string | null;
  by: HandoffBy;
  condition?: HandoffCondition;
};

/** §4.2 placeholder, not written: "the human is operating" is daemon state (§16, §37), not an event. */
export type HandoffHumanActiveFields = {
  state: "human-active";
  reason: HandoffReason;
  question: string | null;
  timeoutMs: number | null;
  answerRef: string | null;
};

export type HandoffFields = HandoffWaitingFields | HandoffResumedFields | HandoffHumanActiveFields;

/** §4.2 `confirm` (P2 placeholder, not written). */
export type ConfirmFields = {
  question: string;
  options: string[];
  answer: string | null;
  by: "human";
  refs: unknown[];
  producesFinding: string | null;
};

/** §4.2 `guard` budget details: the hourly request budget (0.4-D), failed logins, the login limit (§30). */
export type GuardBudgetDetail =
  | { rule: "requests-per-hour"; requests: number; limit: number; windowStart: number; decision: "limit-reached" }
  | { rule: "requests-per-hour"; requests: number; limit: number; windowStart: number; decision: "refused"; action: string }
  | { rule: "failed-logins"; failures: number | null; limit: number; decision: "refused" | "needs-human" }
  | { rule: "login-limit"; attempts: number; limit: number; decision: "allowed" | "confirmed" | "refused" };

export type GuardBudgetFields = { event: "budget"; site: string; account: string | null; detail: GuardBudgetDetail };

/** §4.2: a verify page tripped the breaker (0.3-A); `coolUntil` when the account started cooling (0.4-D). */
export type GuardVerifyBreakerFields = {
  event: "breaker";
  protection?: string[];
  site: string | null;
  account: string | null;
  detail: { reason: "verify-page"; request: string; url: string; status: number | null; mime: string | null; coolUntil?: number };
};

/** §4.2 / §26: a `tabcap fetch` stop rule fired (no waiting, no cooling). */
export type GuardFetchStopBreakerFields = {
  event: "breaker";
  site: string;
  account: string | null;
  reason: "fetch-stop";
  rule: string;
  request: string;
  detail: { reason: "fetch-stop"; rule: string; detail: string; request: string; fetchId: string | null; url: string; status: number | null };
};

/** §4.2 / §18 (0.6-I): a site stop rule fired; a `handoff` waiting follows. */
export type GuardStopRuleBreakerFields = {
  event: "breaker";
  protection?: string[];
  site: string;
  account: string | null;
  reason: "stop-rule";
  rule: string;
  request: string;
  detail: { reason: "stop-rule"; rule: string; detail: string; request: string; url: string; status: number | null; fetchId?: string };
};

/** Who lifted a fetch stop (§4.2, §26). */
export type GuardResumeBy = "guard-resume" | "handoff-continue";

/** §4.2 / §26: a fetch stop (or a site stop rule's stop) was lifted. */
export type GuardResumeFields = {
  event: "resume";
  site: string;
  account: null;
  reason: "fetch-stop" | "stop-rule";
  rule: string;
  request: string;
  by: GuardResumeBy;
  detail: { reason: "fetch-stop" | "stop-rule"; rule: string; request: string; by: GuardResumeBy };
};

/** §4.2 / §38 (0.7.5-A): an end rule matched ("no more pages"): no stop, no waiting. */
export type GuardEndFields = {
  event: "end";
  site: string;
  account: null;
  rule: string;
  request: string;
  detail: { rule: string; detail: string; request: string; url: string; status: number | null; fetchId?: string };
};

/** §4.2 / §27 (0.6-D): an image captcha advisory, once per page; never a waiting state. `image` / `input` are refs. */
export type GuardChallengeFields = {
  event: "challenge";
  site: string | null;
  account: string | null;
  detail: { kind: "image-captcha"; advisory: true; image: string | null; input: string | null; url: string; frame?: string };
};

/** §4.2 placeholder, not written. */
export type GuardProbeFields = { event: "probe"; site: string; account: string | null; detail: unknown };

export type GuardFields =
  | GuardBudgetFields
  | GuardVerifyBreakerFields
  | GuardFetchStopBreakerFields
  | GuardStopRuleBreakerFields
  | GuardResumeFields
  | GuardEndFields
  | GuardChallengeFields
  | GuardProbeFields;

/** One matched rule of a protection family: pointers only (request ids, cookie / header names …), never a value (§41.2). */
export type ProtectionMatch = { rule: string; layer: 1 | 2 | 3; kind: string; where: string[] };

export type ProtectionDetection = {
  family: string;
  name: string;
  category: "anti-bot" | "captcha" | "fingerprint";
  confidence: number;
  matched: ProtectionMatch[];
};

/** §4.2 / §41.3 (0.8-A): the families identified on a tab changed; `actor:"system"`. */
export type ProtectionFields = {
  nav: string | null;
  url: string;
  detections: ProtectionDetection[];
};

// ---------------------------------------------------------------- kinds

/** docs/04 §4: the fields each event kind carries besides the §3 envelope. */
export type EventFields = {
  session: SessionFields;
  tab: TabFields;
  nav: NavFields;
  request: RequestFields;
  ws: WsFields;
  sse: SseFields;
  download: DownloadFields;
  cmd: CmdFields;
  console: ConsoleFields;
  action: ActionFields;
  screenshot: ScreenshotFields;
  state: StateFields;
  finding: FindingFields;
  note: NoteFields;
  signal: SignalFields;
  handoff: HandoffFields;
  confirm: ConfirmFields;
  guard: GuardFields;
  protection: ProtectionFields;
};

export type EventKind = keyof EventFields;

/** One event of kind K before the writer assigns `seq`. */
export type Unsequenced<K extends EventKind> = Omit<Envelope, "seq" | "kind"> & { kind: K } & EventFields[K];

/** Any event of a known kind before the writer assigns `seq` (what the recorder writes). */
export type UnsequencedKnown = { [K in EventKind]: Unsequenced<K> }[EventKind];

/** An event of kind K as stored. */
export type EventOf<K extends EventKind> = Omit<Envelope, "kind"> & { kind: K } & EventFields[K];

export type KnownEvent = { [K in EventKind]: EventOf<K> }[EventKind];

export type SessionEvent = EventOf<"session">;
export type TabEvent = EventOf<"tab">;
export type NavEvent = EventOf<"nav">;
export type WsEvent = EventOf<"ws">;
export type SseEvent = EventOf<"sse">;
export type DownloadEvent = EventOf<"download">;
export type CmdStartEvent = Omit<Envelope, "kind"> & { kind: "cmd" } & CmdStartFields;
export type CmdEndEvent = Omit<Envelope, "kind"> & { kind: "cmd" } & CmdEndFields;
export type CmdEvent = CmdStartEvent | CmdEndEvent;
export type ConsoleEvent = EventOf<"console">;
export type ActionEvent = EventOf<"action">;
export type ScreenshotEvent = EventOf<"screenshot">;
export type StateEvent = EventOf<"state">;
export type FindingEvent = EventOf<"finding">;
export type NoteEvent = EventOf<"note">;
export type SignalEvent = EventOf<"signal">;
export type HandoffEvent = EventOf<"handoff">;
export type ConfirmEvent = EventOf<"confirm">;
export type GuardEvent = EventOf<"guard">;
export type ProtectionEvent = EventOf<"protection">;

// ---------------------------------------------------------------- §7 manifest

export type BodyMissingCounts = { [reason: string]: number };

export type ManifestCounts = {
  events: number;
  requests: number;
  bodies: number;
  blobBytes: number;
  bodyMissing: BodyMissingCounts;
  /** 0.9-D (docs/04 §48): `download` events (completed and canceled); 0 in bundles written before. */
  downloads: number;
};

export type Producer = {
  tool: string;
  version: string;
  daemon?: string | null;
  extension?: string | null;
  /** `webdriver`: 0.7.6-A (docs/04 §40); `args` / `extraArgs` / `dropArgs`: 0.8.1-A (§42); absent in older bundles. */
  browser?: {
    name: string;
    version: string;
    userAgent?: string | null;
    webdriver?: "hidden" | "visible";
    args?: string[];
    extraArgs?: string[];
    dropArgs?: string[];
  } | null;
  platform?: string | null;
};

export type ManifestTab = { tab: string; chromeTabId: number | null; owned: boolean; firstUrl: string | null };

export type Redaction = { rules: string; applied: number; salt?: string };

export type Imported = {
  from: "har";
  creator: { name: string; version: string } | null;
  lossy: string[];
};

/** §4.3 sample profile index (P2/P3, optional). */
export type SampleIndex = {
  challengeRequests: string[];
  scripts: { request: string; sha256: string; inline: boolean }[];
  env: string | null;
};

export type Manifest = {
  format: string;
  id: string; // ULID
  created: number;
  finished?: number; // absent = not closed (recording or crashed)
  producer: Producer;
  session: {
    name: string;
    site: string | null;
    account: string | null;
    /** 0.4-D: the proxy name the session went out through, `system` / `none`, or null (names only). */
    proxy?: string | null;
    tabs: ManifestTab[];
  };
  mode: { capture: CaptureMode; trace: false | TraceMode; raw: boolean; humanRecorder: boolean; sample?: boolean };
  /** 0.6-I: which response bodies the recording stored (`net start --bodies`); absent in older bundles = all. */
  record?: { bodies: "all" | "api" | "api+script" | "none" };
  /** One entry per trace window (docs/04 §7, 0.4-F); absent when trace mode never ran during the recording. */
  traceWindows?: TraceWindow[];
  counts: ManifestCounts;
  redaction: Redaction | null;
  imported: Imported | null;
  notes: string;
  sample?: SampleIndex;
  [field: string]: unknown;
};
