// Evidence bundle v0 types. Spec: docs/04-evidence-bundle-spec-v0.md.
// Oracle for these shapes: docs/04 §3 (envelope), §4 (kinds), §5.1 (request),
// §7 (manifest) and the §11 sample lines (fixtures/bundles/sample-v0).
// Event shapes are `type` aliases (not interfaces) so they stay assignable to
// the open `RawEvent` record: readers must keep unknown fields (§3).

export const FORMAT_ID = "evidence-bundle/0";
export const FORMAT_MAJOR = 0;

export type Actor = "human" | "ai" | "system";

/** §3 public fields carried by every line of events.jsonl. */
export type Envelope = {
  seq: number;
  ts: number;
  mono: number | null;
  kind: string;
  actor: Actor;
  tab: string | null;
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

export type SessionEvent = Envelope & {
  kind: "session";
  phase: "start" | "stop";
  name: string;
  mode: { capture: CaptureMode; trace: boolean; raw: boolean };
};

export type TabReason = "ai-opened" | "borrowed" | "user-cancelled-debugging" | "closed" | "crashed" | "popup";

export type TabEvent = Envelope & {
  kind: "tab";
  phase: "open" | "attach" | "detach" | "close" | "replace";
  chromeTabId?: number | null;
  owned?: boolean;
  url?: string | null;
  title?: string | null;
  reason?: TabReason | null;
  /** Child target (OOPIF / service worker / worker) attached under host tab. */
  target?: { id: string; type: "iframe" | "service_worker" | "worker"; url: string; sessionId: string };
};

export type NavType = "navigation" | "history" | "reload" | "back_forward";

export type NavEvent = Envelope & {
  kind: "nav";
  frame: string; // "root" or a frameId
  nav: string; // n-<seq of this event>
  url: string;
  from: string | null;
  type: NavType;
  loaderId: string | null;
  loadEvent: { domContentLoaded: number | null; load: number | null } | null;
};

export type WsEvent = Envelope & {
  kind: "ws";
  ws: string; // r-<handshake request seq>
  phase: "frame" | "close" | "error";
  direction?: "send" | "recv";
  opcode?: 1 | 2;
  payload?: InlineOrBlob;
  reason?: string | null;
};

/**
 * An AI command is a start / end pair (docs/04 §14, §15). Events written while
 * the command runs carry `cmd: <start id>`; the start event's own `cmd` is its id.
 */
export type CmdStartEvent = Envelope & {
  kind: "cmd";
  phase: "start";
  id: string; // c-<seq>
  argv: string[] | null;
  input: Record<string, unknown>;
};

export type CmdEndEvent = Envelope & {
  kind: "cmd";
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

export type CmdEvent = CmdStartEvent | CmdEndEvent;

export type ActionOp = "click" | "fill" | "key" | "select" | "scroll" | "navigate" | "upload" | "dialog" | "evaluate";

export type ActionEvent = Envelope & {
  kind: "action";
  op: ActionOp;
  target: {
    ref?: string;
    role?: string;
    name?: string;
    selector?: string;
    rect?: [number, number, number, number];
    frame?: string;
  };
  value: string | null;
  phase: "done" | "failed";
  error?: unknown;
  shots?: { before?: string; after?: string };
  nav: string | null;
  trusted: boolean;
};

export type ScreenshotEvent = Envelope & {
  kind: "screenshot";
  blob: string;
  format: "png" | "jpeg";
  width: number;
  height: number;
  scale: number;
  reason: "nav" | "action" | "manual" | "interval" | "handoff";
  nav: string | null;
};

export type StateEvent = Envelope & {
  kind: "state";
  what: "cookies" | "localStorage" | "sessionStorage" | "env";
  origin: string | null;
  blob: string;
  count: number;
  reason: "session-start" | "nav" | "session-stop" | "manual";
};

export type FindingEvidence = { request: string; path?: string } | { ws: string; frame: number } | { blob: string } | { console: number };

export type FindingEvent = Envelope & {
  kind: "finding";
  tool: "find" | "diff" | "deps" | "trace" | "manual";
  grade: "实测" | "推断" | "待验" | "人确认";
  claim: string;
  evidence: FindingEvidence[];
  input: unknown;
  output: unknown;
};

export type NoteEvent = Envelope & {
  kind: "note";
  text: string;
  refs: unknown[];
};

// ---------------------------------------------------------------- §5.1 request

/** Lowercase header names; repeated headers as arrays; no ":" pseudo headers. */
export type Headers = { [name: string]: string | string[] };

export type HeadersSource = "event" | "wire" | "merged";

export type ResourceType =
  | "document"
  | "xhr"
  | "fetch"
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "media"
  | "websocket"
  | "eventsource"
  | "manifest"
  | "other";

/** §5.2 rule 5 reasons, plus "too-large" (rule 4). */
export type BodyMissingReason =
  | "too-large"
  | "redirect"
  | "not-modified"
  | "no-content"
  | "navigated"
  | "evicted"
  | "detached"
  | "stopped"
  | "failed"
  | "unsupported";

export type ResponseBody = {
  blob: string;
  size: number;
  base64: boolean;
  wireEncoding: string | null;
  truncated: boolean;
  /** HAR import only (§9.2): content-encoding present but bytes would not decode. */
  decodeFailed?: boolean;
};

export type RequestSide = {
  headers: Headers;
  headersSource: HeadersSource;
  postData: InlineOrBlob | null;
  postDataMissing?: { reason: string; detail: string | null };
};

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
  bodyMissing: { reason: BodyMissingReason; detail: string | null } | null;
};

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
  outcome: "finished" | "failed" | "incomplete";
  error: { text: string; canceled?: boolean | null; blockedReason?: string | null } | null;
} & { [field: string]: unknown }; // readers keep unknown fields (§3)

// ---------------------------------------------------------------- §4.2 (P2, types only)

export type HandoffEvent = Envelope & {
  kind: "handoff";
  state: "waiting" | "human-active" | "resumed";
  reason: string;
  question: string | null;
  timeoutMs: number | null;
  answerRef: string | null;
};

export type ConfirmEvent = Envelope & {
  kind: "confirm";
  question: string;
  options: string[];
  answer: string | null;
  by: "human";
  refs: unknown[];
  producesFinding: string | null;
};

export type GuardEvent = Envelope & {
  kind: "guard";
  event: "budget" | "breaker" | "probe";
  site: string;
  account: string | null;
  detail: unknown;
};

export type KnownEvent =
  | SessionEvent
  | TabEvent
  | NavEvent
  | RequestEvent
  | WsEvent
  | CmdEvent
  | ActionEvent
  | ScreenshotEvent
  | StateEvent
  | FindingEvent
  | NoteEvent
  | HandoffEvent
  | ConfirmEvent
  | GuardEvent;

export type KnownKind = KnownEvent["kind"];

export const P1_KINDS = [
  "session",
  "tab",
  "nav",
  "request",
  "ws",
  "cmd",
  "action",
  "screenshot",
  "state",
  "finding",
  "note",
] as const;

// ---------------------------------------------------------------- §7 manifest

export type BodyMissingCounts = { [reason: string]: number };

export type ManifestCounts = {
  events: number;
  requests: number;
  bodies: number;
  blobBytes: number;
  bodyMissing: BodyMissingCounts;
};

export type Producer = {
  tool: string;
  version: string;
  daemon?: string | null;
  extension?: string | null;
  browser?: { name: string; version: string; userAgent?: string | null } | null;
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
  mode: { capture: CaptureMode; trace: boolean; raw: boolean; humanRecorder: boolean; sample?: boolean };
  counts: ManifestCounts;
  redaction: Redaction | null;
  imported: Imported | null;
  notes: string;
  sample?: SampleIndex;
  [field: string]: unknown;
};
