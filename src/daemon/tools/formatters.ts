/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Text conventions derived from chrome-devtools-mcp (commit
// e9000381f414bf5fd5fb83a9164fabfb8e0987b3, read 2026-10-15):
// - src/formatters/NetworkFormatter.ts: URL_CONTEXT_SIZE_LIMIT (255) for the
//   concise request list, BODY_CONTEXT_SIZE_LIMIT (10000) for inline bodies,
//   getSizeLimitedString's "... <truncated>" suffix, the <empty response> /
//   <binary data> markers;
// - src/formatters/SnapshotFormatter.ts: booleanPropertyMap (the capability
//   word printed next to a true state: focusable focused, expandable expanded …)
//   and `attr="value"` attributes.
// Modifications for tabcap (2026-10-15): standalone helpers over tabcap's own
// data (no Puppeteer objects), JSON fields instead of text lines (`url` cut
// in `net list` rows with `urlTruncated: true`); snapshot lines keep tabcap's
// `- role "name" [e12]` head and ref ids (see src/daemon/browser/ax.ts).

export const BODY_CONTEXT_SIZE_LIMIT = 10000;
export const URL_CONTEXT_SIZE_LIMIT = 255;

export function getSizeLimitedString(text: string, sizeLimit: number): string {
  if (text.length > sizeLimit) {
    return text.substring(0, sizeLimit) + "... <truncated>";
  }
  return text;
}

/** A URL for the concise request list: cut at 255 chars with "... <truncated>" (net show has it whole). */
export function listUrl(url: string): { url: string; urlTruncated?: true } {
  return url.length > URL_CONTEXT_SIZE_LIMIT ? { url: getSizeLimitedString(url, URL_CONTEXT_SIZE_LIMIT), urlTruncated: true } : { url };
}

/** A body as preview text: <empty response>, <binary data>, or the text cut at `sizeLimit` chars. */
export function bodyPreview(bytes: Uint8Array, textLike: boolean, sizeLimit = BODY_CONTEXT_SIZE_LIMIT): { text: string; truncated: boolean; binary: boolean } {
  if (bytes.length === 0) return { text: "<empty response>", truncated: false, binary: false };
  // Decode at most 4 bytes per char of the limit (plus one char to see that there is more).
  const head = bytes.subarray(0, (sizeLimit + 1) * 4);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: !textLike }).decode(head, { stream: head.length < bytes.length });
  } catch {
    return { text: "<binary data>", truncated: false, binary: true };
  }
  const truncated = text.length > sizeLimit || head.length < bytes.length;
  return { text: text.length > sizeLimit ? text.substring(0, sizeLimit) : text, truncated, binary: false };
}

/** SnapshotFormatter.booleanPropertyMap: state → capability word. */
export const booleanPropertyMap: Record<string, string> = {
  disabled: "disableable",
  expanded: "expandable",
  focused: "focusable",
  selected: "selectable",
};
