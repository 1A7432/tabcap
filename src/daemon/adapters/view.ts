// Pure side of the overlay adapter's results: validate what the page script
// returned (untrusted: the page controls the DOM it reads), turn node indexes
// into refs, and render the "遮挡" / "识别到" header block of snapshot and
// outline (docs/09 §2, §2.3 "遮挡排在最前").

import { isRecord } from "../../shared/json.ts";
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
};

const MAX_OVERLAYS = 12;
const s = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "");
const int = (v: unknown, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo);

/** `n` (index into the nodes the script returned) → ref, or null when the node could not be resolved. */
export type NodeRef = (n: unknown) => string | null;

function buttons(v: unknown, refOf: NodeRef): Button[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 8)
    .filter(isRecord)
    .map((b) => ({ ref: refOf(b["n"]), label: s(b["label"], 40) }));
}

/** Overlays from the page script's describe / act data; malformed entries are dropped. */
export function parseOverlays(v: unknown, refOf: NodeRef): Overlay[] {
  const list = isRecord(v) && Array.isArray(v["overlays"]) ? v["overlays"] : [];
  const out: Overlay[] = [];
  for (const o of list.slice(0, MAX_OVERLAYS)) {
    const ov = parseOverlay(o, refOf, `o${out.length + 1}`);
    if (ov !== null) out.push(ov);
  }
  return out;
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
    close: buttons(o["close"], refOf),
    choices: buttons(o["choices"], refOf),
    iframe: typeof o["iframe"] === "string" ? s(o["iframe"], 200) : null,
    evidence: Array.isArray(o["evidence"]) ? o["evidence"].slice(0, 8).map((x) => s(x, 60)).filter((x) => x !== "") : [],
    ref: refOf(o["n"]),
  };
}

const btn = (b: Button) => (b.ref === null ? `「${b.label}」(no ref)` : `${b.ref}「${b.label}」`);

/** One header line for an overlay. */
export function overlayLine(o: Overlay): string {
  let line = `${o.id} ${o.kind}${o.name === "" ? "" : `「${o.name}」`}`;
  if (o.coverage >= 90) line += o.covers.length > 0 ? ` 挡住 整页（${o.covers.join(", ")}）` : " 挡住 整页";
  else if (o.covers.length > 0) line += ` 挡住 ${o.covers.join(", ")}`;
  else line += ` 占视口 ${o.coverage}%`;
  if (o.iframe !== null) line += ` · iframe ${o.iframe === "" ? "(no src)" : o.iframe}`;
  if (o.kind === "consent") line += o.choices.length > 0 ? ` · 由人决定：${o.choices.map(btn).join(" / ")}` : " · 由人决定";
  else if (o.kind === "timeout-prompt") {
    line += " · 提醒人";
    if (o.choices.length > 0) line += `：${o.choices.map(btn).join(" / ")}`;
    if (o.close.length > 0) line += ` · 关闭 ${o.close.map(btn).join(" / ")}`;
  } else line += o.close.length > 0 ? ` · 关闭 ${o.close.map(btn).join(" / ")}` : " · 无关闭按钮";
  return line;
}

export function detectionText(d: Detection): string {
  return `${d.adapter}（${d.category}）${d.confidence}${d.evidence.length > 0 ? `：${d.evidence.slice(0, 3).join(", ")}` : ""}`;
}

const MAX_LINES = 6;

/** Header lines; `overlays` null means the check failed (`error` says why). */
export function headerLines(x: { overlays: Overlay[] | null; detected: Detection[] | null; error: string | null }): string[] {
  const lines: string[] = [];
  if (x.overlays === null) lines.push(`遮挡    ?（检查失败：${(x.error ?? "unknown").slice(0, 160)}）`);
  else if (x.overlays.length === 0) lines.push("遮挡    无");
  else {
    x.overlays.slice(0, MAX_LINES).forEach((o, i) => lines.push(`${i === 0 ? "遮挡    " : "        "}${overlayLine(o)}`));
    if (x.overlays.length > MAX_LINES) lines.push(`        另有 ${x.overlays.length - MAX_LINES} 个（outline 列全）`);
  }
  const shown = (x.detected ?? []).filter((d) => d.category !== "overlay" && d.confidence > 0);
  if (x.detected === null) lines.push("识别到  ?");
  else lines.push(`识别到  ${shown.length === 0 ? "无" : shown.map(detectionText).join("；")}`);
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
