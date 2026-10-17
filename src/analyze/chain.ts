// `tabcap analyze chain <bundle> --request r-N`: the action chain behind one
// request (docs/03 §8: `analyze chain` gives the chain that `export-python`
// turns into a scaffold). From the deps graph: the target, then every request
// whose response produced a value the chain sends (set-cookie or response body,
// the `primary` source, followed through carried-forward inputs), de-duplicated,
// in recording order. Each step lists what it provides to later steps and what
// it still needs from the caller: `computed-in-page` and `unrecorded` inputs
// (also listed in `todo`), `caller-input` values the caller chooses (listed in
// `inputs`, not `todo`; 0.6-E), and recorded user input (`action`).
// Default target: the data-bearing xhr / fetch / document request (2xx with a
// recorded body) of the bundle, or of `--session`, that STARTED last
// (`timing.start`, else `mono`; recording order only breaks ties). Request ids
// are given when the response is written, so a login POST whose 302 body is
// still being fetched can come after the data request in the event stream
// (0.6-E, seen on v04a s07 under parallel load).
// Oracle: test/unit/deps.test.ts (chain cases on planted flows) and
// test/e2e/v04a.e2e.test.ts (docs/05 s07: login → data).
// Reproduce: bun test test/unit/deps.test.ts

import { TabcapError } from "../shared/envelope.ts";
import type { RequestEvent } from "../bundle/types.ts";
import { redactUrl } from "../daemon/tools/liveredact.ts";
import { DepsGraph, type DepsClass, type InputLocation } from "./deps.ts";
import type { StepName } from "./decoders.ts";

export const CHAIN_SCHEMA = "tabcap-chain/0";
const DATA_TYPES = new Set(["xhr", "fetch", "document"]);

export type ChainTo = { request: string; location: InputLocation; name: string; path?: string };

export type ChainProvide = {
  kind: "set-cookie" | "response";
  to: ChainTo;
  /** set-cookie: the cookie name. */
  cookie?: string;
  /** response: JSON path in this step's response body (absent for a text match). */
  path?: string;
  decode?: StepName[];
  match?: "exact" | "embedded";
  /** response into a header: sent as prefix + value + suffix (`Bearer `). */
  prefix?: string;
  suffix?: string;
};

export type ChainNeed = {
  location: InputLocation;
  name: string;
  path?: string;
  class: Extract<DepsClass, "computed-in-page" | "unrecorded" | "action" | "caller-input">;
  hints: string[];
  covaries: string[];
  /** The value was carried forward from this earlier request, where it has no source either. */
  via?: string;
  /** action: event seq of the fill / type. */
  action?: number;
  secret?: string;
};

/** One step of the chain: the request itself (`id`, docs/04 §2.1), what it provides and needs. */
export type ChainStep = { id: string; method: string; url: string; provides: ChainProvide[]; needs: ChainNeed[] };

export type ChainTodo = Omit<ChainNeed, "class" | "action" | "secret"> & { request: string; class: "computed-in-page" | "unrecorded" };

/** A caller-input of a step: a plain parameter with the recorded value as its default (0.6-E). */
export type ChainInput = Omit<ChainNeed, "class" | "action" | "secret"> & { request: string; class: "caller-input" };

export type ChainResult = { schema: typeof CHAIN_SCHEMA; bundle: string; target: string; steps: ChainStep[]; todo: ChainTodo[]; inputs: ChainInput[]; warnings: string[] };

export type ChainOptions = { request?: string | undefined; session?: string | undefined };

/** 2xx xhr / fetch / document with a recorded, non-empty response body. */
export const dataBearing = (r: RequestEvent): boolean => {
  const st = r.response?.status ?? null;
  return DATA_TYPES.has(r.type) && st !== null && st >= 200 && st < 300 && (r.response?.body?.size ?? 0) > 0;
};

/** When a request started on the monotonic clock: `timing.start`, else `mono`; null when the bundle has neither. */
const startKey = (r: RequestEvent): number | null => {
  const t = r.timing?.start;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  return typeof r.mono === "number" && Number.isFinite(r.mono) ? r.mono : null;
};

/** Requests latest start first; recording order (seq) when the start times tie or one is missing. */
export function latestStartFirst(list: readonly RequestEvent[]): RequestEvent[] {
  return [...list].sort((a, b) => {
    const ka = startKey(a);
    const kb = startKey(b);
    if (ka !== null && kb !== null && ka !== kb) return kb - ka;
    return b.seq - a.seq;
  });
}

/**
 * The target rule of `analyze chain` and `replay export-python` (one rule for
 * both, 0.6-C): among `list`, the data-bearing xhr / fetch / document request
 * that started last, else the latest-started of those types with a response.
 */
export function latestTarget(list: readonly RequestEvent[]): RequestEvent | undefined {
  const last = latestStartFirst(list);
  return last.find(dataBearing) ?? last.find((r) => DATA_TYPES.has(r.type) && r.response !== null);
}

/** The default target: latestTarget over the graph's requests (of one session). */
export function defaultTarget(g: DepsGraph, session?: string): RequestEvent {
  const hit = latestTarget(g.select({ session }));
  if (hit === undefined) throw new TabcapError("not-found", "no xhr / fetch / document request with a response to build a chain for", "Pass the target explicitly: --request r-N.");
  return hit;
}

export function chainOf(g: DepsGraph, bundle: string, opts: ChainOptions = {}): ChainResult {
  const target = opts.request !== undefined ? (g.select({ session: opts.session, request: opts.request })[0] ?? defaultTarget(g, opts.session)) : defaultTarget(g, opts.session);
  const inChain = new Set<string>([target.id]);
  const queue = [target.id];
  const provides = new Map<string, ChainProvide[]>();
  const needs = new Map<string, ChainNeed[]>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const input of g.inputs(id)) {
      const root = g.root(id, input);
      const rp = root.input.primary;
      const to: ChainTo = { request: id, location: input.location, name: input.name, ...(input.path === undefined ? {} : { path: input.path }) };
      if (rp !== null && rp.request !== undefined && (rp.kind === "set-cookie" || rp.kind === "response")) {
        const list = provides.get(rp.request) ?? [];
        list.push({
          kind: rp.kind,
          to,
          ...(rp.cookie === undefined ? {} : { cookie: rp.cookie }),
          ...(rp.path === undefined ? {} : { path: rp.path }),
          ...(rp.decode === undefined ? {} : { decode: rp.decode }),
          ...(rp.match === undefined ? {} : { match: rp.match }),
          ...(rp.prefix === undefined ? {} : { prefix: rp.prefix }),
          ...(rp.suffix === undefined ? {} : { suffix: rp.suffix }),
        });
        provides.set(rp.request, list);
        if (!inChain.has(rp.request)) {
          inChain.add(rp.request);
          queue.push(rp.request);
        }
        continue;
      }
      const cls = root.input.class;
      if (cls !== "computed-in-page" && cls !== "unrecorded" && cls !== "action" && cls !== "caller-input") continue;
      const list = needs.get(id) ?? [];
      list.push({
        location: input.location,
        name: input.name,
        ...(input.path === undefined ? {} : { path: input.path }),
        class: cls,
        hints: root.input.hints,
        covaries: root.input.covaries,
        ...(root.request === id ? {} : { via: root.request }),
        ...(rp?.kind === "action" && rp.action !== undefined ? { action: rp.action } : {}),
        ...(rp?.kind === "action" && rp.secret !== undefined ? { secret: rp.secret } : {}),
      });
      needs.set(id, list);
    }
  }
  const steps: ChainStep[] = [...inChain]
    .map((id) => g.byId.get(id))
    .filter((r): r is RequestEvent => r !== undefined)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ id: r.id, method: r.method, url: r.url, provides: provides.get(r.id) ?? [], needs: needs.get(r.id) ?? [] }));
  const todo: ChainTodo[] = [];
  const inputs: ChainInput[] = [];
  for (const s of steps) {
    for (const n of s.needs) {
      if (n.class === "action") continue;
      const base = { request: s.id, location: n.location, name: n.name, ...(n.path === undefined ? {} : { path: n.path }), hints: n.hints, covaries: n.covaries, ...(n.via === undefined ? {} : { via: n.via }) };
      if (n.class === "caller-input") inputs.push({ ...base, class: n.class });
      else todo.push({ ...base, class: n.class });
    }
  }
  return { schema: CHAIN_SCHEMA, bundle, target: target.id, steps, todo, inputs, warnings: [...g.warnings] };
}

export function chain(bundleDir: string, opts: ChainOptions = {}): ChainResult {
  return chainOf(DepsGraph.open(bundleDir), bundleDir, opts);
}

// ------------------------------------------------------------ text rendering

const label = (t: { location: string; name: string; path?: string }) => `${t.location} ${t.path ?? t.name}`;

/**
 * `analyze chain --text`. 0.7-E: step URLs show sensitive query parameters as
 * `<redacted:name>` (the docs/04 §8.3 URL rule; a CAS `ticket=` in a login
 * return URL); the JSON answer keeps the URLs as recorded (export-python reads it).
 */
export function renderChainText(r: ChainResult): string {
  const lines = [`chain to ${r.target} in ${r.bundle}: ${r.steps.length} step(s), ${r.todo.length} TODO, ${r.inputs.length} caller input(s)`];
  r.steps.forEach((s, i) => {
    const url = redactUrl(s.url, { scrub: (x) => x });
    lines.push("", `${i + 1}. ${s.id} ${s.method} ${url.length > 100 ? url.slice(0, 99) + "…" : url}`);
    for (const p of s.provides) lines.push(`   provides ${p.kind === "set-cookie" ? `set-cookie ${p.cookie ?? ""}` : `response ${p.path ?? "(text)"}`} → ${p.to.request} ${label(p.to)}${p.prefix === undefined ? "" : ` (prefix ${JSON.stringify(p.prefix)})`}`);
    for (const n of s.needs) {
      const extra = [n.hints.length > 0 ? `[${n.hints.join(",")}]` : "", n.covaries.length > 0 ? `varies with ${n.covaries.join(", ")}` : "", n.via === undefined ? "" : `via ${n.via}`].filter((x) => x !== "").join(" ");
      lines.push(`   needs    ${label(n)}: ${n.class}${n.secret === undefined ? "" : ` <secret:${n.secret}>`}${extra === "" ? "" : `  ${extra}`}`);
    }
  });
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n");
}
