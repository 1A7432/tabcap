// Pure side of the overlay adapter's results: validate what the page script
// returned (untrusted: the page controls the DOM it reads), turn node indexes
// into refs, and render the "overlays" / "detected" header block of snapshot and
// outline (docs/09 §2, §2.3: overlays come first).

import { isRecord } from "../../shared/json.ts";
import { challengeLine, type ChallengeView } from "../browser/captcha.ts";
import type { Detection } from "./detect.ts";

export const OVERLAY_KINDS = ["dialog", "iframe-layer", "mask", "timeout-prompt", "consent"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export type Button = { ref: string | null; label: string };
export type Overlay = {
  id: string;
  kind: OverlayKind;
  role: string;
  name: string;
  /** Blocks the whole page (aria-modal, a mask under it, or a full-viewport layer). */
  modal: boolean;
  /** Percent of the viewport the overlay (with its mask) covers. */
  coverage: number;
  /** Landmarks (main, form#id, table, nav …) whose centre is under the overlay. */
  covers: string[];
  /** Close buttons (never clicked by tabcap). */
  close: Button[];
  /** Other buttons; for consent and timeout prompts the human decides among them. */
  choices: Button[];
  iframe: string | null;
  evidence: string[];
  /** Ref of the overlay element itself. */
  ref: string | null;
  /** Frame path of the document the overlay is in (`f2`); absent: the root document (0.4-I). */
  frame?: string;
  /** Overlays with an iframe: frame path of that iframe; its close buttons are in `close` with frame-path refs. */
  layerFrame?: string;
};

const MAX_OVERLAYS = 12;
const s = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "");
const int = (v: unknown, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo);

/** `n` (index into the nodes the script returned) → ref, or null when the node could not be resolved. */
export type NodeRef = (n: unknown) => string | null;

/** Buttons `[{n, label}]` of the page script's data → refs and labels (at most 8). */
export function parseButtons(v: unknown, refOf: NodeRef): Button[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 8)
    .filter(isRecord)
    .map((b) => ({ ref: refOf(b["n"]), label: s(b["label"], 40) }));
}

/** Overlays from the page script's describe data, each with the node index `n` of its element; malformed entries are dropped. */
export function parseOverlayNodes(v: unknown, refOf: NodeRef): Array<{ overlay: Overlay; n: unknown }> {
  const list = isRecord(v) && Array.isArray(v["overlays"]) ? v["overlays"] : [];
  const out: Array<{ overlay: Overlay; n: unknown }> = [];
  for (const o of list.slice(0, MAX_OVERLAYS)) {
    const ov = parseOverlay(o, refOf, `o${out.length + 1}`);
    if (ov !== null && isRecord(o)) out.push({ overlay: ov, n: o["n"] });
  }
  return out;
}

/** Overlays from the page script's describe / act data; malformed entries are dropped. */
export function parseOverlays(v: unknown, refOf: NodeRef): Overlay[] {
  return parseOverlayNodes(v, refOf).map((x) => x.overlay);
}

export function parseOverlay(o: unknown, refOf: NodeRef, id: string): Overlay | null {
  if (!isRecord(o)) return null;
  const kind = o["kind"];
  if (typeof kind !== "string" || !(OVERLAY_KINDS as readonly string[]).includes(kind)) return null;
  return {
    id,
    kind: kind as OverlayKind,
    role: s(o["role"], 32),
    name: s(o["name"], 60),
    modal: o["modal"] === true,
    coverage: int(o["coverage"], 0, 100),
    covers: Array.isArray(o["covers"]) ? o["covers"].slice(0, 6).map((x) => s(x, 60)).filter((x) => x !== "") : [],
    close: parseButtons(o["close"], refOf),
    choices: parseButtons(o["choices"], refOf),
    iframe: typeof o["iframe"] === "string" ? s(o["iframe"], 200) : null,
    evidence: Array.isArray(o["evidence"]) ? o["evidence"].slice(0, 8).map((x) => s(x, 60)).filter((x) => x !== "") : [],
    ref: refOf(o["n"]),
  };
}

const btn = (b: Button) => (b.ref === null ? `"${b.label}" (no ref)` : `${b.ref} "${b.label}"`);

/** One header line for an overlay. */
export function overlayLine(o: Overlay): string {
  let line = `${o.id} ${o.kind}${o.name === "" ? "" : ` "${o.name}"`}`;
  if (o.coverage >= 90) line += o.covers.length > 0 ? ` covers the whole page (${o.covers.join(", ")})` : " covers the whole page";
  else if (o.covers.length > 0) line += ` covers ${o.covers.join(", ")}`;
  else line += ` ${o.coverage}% of the viewport`;
  if (o.frame !== undefined) line += ` · in ${o.frame}`;
  if (o.iframe !== null) line += ` · iframe ${o.layerFrame === undefined ? "" : `${o.layerFrame} `}${o.iframe === "" ? "(no src)" : o.iframe}`;
  if (o.kind === "consent") line += o.choices.length > 0 ? ` · the human decides: ${o.choices.map(btn).join(" / ")}` : " · the human decides";
  else if (o.kind === "timeout-prompt") {
    line += " · tell the human";
    if (o.choices.length > 0) line += `: ${o.choices.map(btn).join(" / ")}`;
    if (o.close.length > 0) line += ` · close ${o.close.map(btn).join(" / ")}`;
  } else line += o.close.length > 0 ? ` · close ${o.close.map(btn).join(" / ")}` : " · no close button";
  return line;
}

export function detectionText(d: Detection): string {
  return `${d.adapter} (${d.category}) ${d.confidence}${d.evidence.length > 0 ? `: ${d.evidence.slice(0, 3).join(", ")}` : ""}`;
}

const MAX_LINES = 6;
/** Header labels, padded to one column ("popups" is added by outline). */
export const LABEL = { overlays: "overlays  ", detected: "detected  ", popups: "popups    ", more: "          " } as const;

/** Header lines; `overlays` null means the check failed (`error` says why). */
export function headerLines(x: { overlays: Overlay[] | null; detected: Detection[] | null; error: string | null; challenge?: ChallengeView | null }): string[] {
  const lines: string[] = [];
  if (x.overlays === null) lines.push(`${LABEL.overlays}? (check failed: ${(x.error ?? "unknown").slice(0, 160)})`);
  else if (x.overlays.length === 0) lines.push(`${LABEL.overlays}none`);
  else {
    x.overlays.slice(0, MAX_LINES).forEach((o, i) => lines.push(`${i === 0 ? LABEL.overlays : LABEL.more}${overlayLine(o)}`));
    if (x.overlays.length > MAX_LINES) lines.push(`${LABEL.more}${x.overlays.length - MAX_LINES} more (outline lists them all)`);
  }
  const shown = (x.detected ?? []).filter((d) => d.category !== "overlay" && d.confidence > 0);
  if (x.detected === null) lines.push(`${LABEL.detected}?`);
  else lines.push(`${LABEL.detected}${shown.length === 0 ? "none" : shown.map(detectionText).join("; ")}`);
  // 0.6-D: an image captcha is an advisory line, only when there is one.
  if (x.challenge !== undefined && x.challenge !== null) lines.push(challengeLine(x.challenge));
  return lines;
}

/** Cut text at `max` chars on a line boundary (never inside a surrogate pair). */
export function cutText(full: string, max: number): { text: string; truncated: boolean } {
  if (full.length <= max) return { text: full, truncated: false };
  if (max <= 0) return { text: "", truncated: true };
  let cut = full.lastIndexOf("\n", max);
  if (cut <= 0) {
    cut = max;
    const code = full.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
  }
  return { text: full.slice(0, cut), truncated: true };
}
