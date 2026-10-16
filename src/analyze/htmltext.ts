// Text nodes of an HTML response with a selector each, for `tabcap where`
// (docs/09 §3.1: a value's path "可以是 JSON path、HTML 选择器"). `analyze find`
// searches HTML as plain text and has no selector syntax, so this one is new:
// a child-combinator path of tag names, `:nth-of-type(k)` when the parent has
// more than one child of that tag, e.g. `html > body > table > tr:nth-of-type(2) > td:nth-of-type(3)`.
// It points into the response source as written (no implied <tbody>), not
// necessarily into the live DOM.
// Not a full HTML5 parser: comments, doctype and processing instructions are
// skipped, script / style / template contents are not text, void elements
// have no children, and an open p / li / td / th / tr / option / dt / dd is
// closed by the start of a sibling that would close it in a browser.
// Untrusted input: linear scan, no recursion, bounded output.
// Oracle: test/unit/where.test.ts (hand-written HTML with known cell paths).

import { decodeHtmlEntities } from "./decoders.ts";

export const MAX_TEXT_NODES = 100_000;

export type HtmlText = {
  /** Entity-decoded text, edges trimmed. */
  text: string;
  /** The text needed html-entity decoding. */
  entities: boolean;
  selector: string;
};

type El = { tag: string; parent: El | null; children: El[] };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "template", "noscript", "iframe", "xmp", "noembed", "noframes"]);
/** Opening the key closes an open element of these tags (stopping at the listed boundaries). */
const AUTO_CLOSE: Record<string, { close: string[]; stop: string[] }> = {
  p: { close: ["p"], stop: ["div", "body", "td", "th", "li", "section", "article"] },
  li: { close: ["li"], stop: ["ul", "ol", "menu"] },
  dt: { close: ["dt", "dd"], stop: ["dl"] },
  dd: { close: ["dt", "dd"], stop: ["dl"] },
  td: { close: ["td", "th"], stop: ["tr", "table"] },
  th: { close: ["td", "th"], stop: ["tr", "table"] },
  tr: { close: ["tr", "td", "th"], stop: ["table", "thead", "tbody", "tfoot"] },
  option: { close: ["option"], stop: ["select", "datalist", "optgroup"] },
};

const NAME = /^[A-Za-z][A-Za-z0-9:-]*/;

/** Index just past the `>` that ends a tag starting at `from` (quotes respected), or the input length. */
function tagEnd(html: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (q !== null) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i + 1;
  }
  return html.length;
}

export function htmlTextNodes(html: string): HtmlText[] {
  const root: El = { tag: "", parent: null, children: [] };
  let cur = root;
  const texts: { el: El; raw: string }[] = [];
  const open = (tag: string): El => {
    const rule = AUTO_CLOSE[tag];
    if (rule !== undefined) {
      for (let e: El | null = cur; e !== null && e !== root; e = e.parent) {
        if (rule.stop.includes(e.tag)) break;
        if (rule.close.includes(e.tag)) {
          cur = e.parent ?? root;
          break;
        }
      }
    }
    const el: El = { tag, parent: cur, children: [] };
    cur.children.push(el);
    return el;
  };
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length && texts.length < MAX_TEXT_NODES) {
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 ? html.length : lt;
    if (textEnd > i) texts.push({ el: cur, raw: html.slice(i, textEnd) });
    if (lt < 0) break;
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e < 0 ? html.length : e + 3;
    } else if (next === "!" || next === "?") {
      i = tagEnd(html, lt + 2);
    } else if (next === "/") {
      const m = NAME.exec(html.slice(lt + 2, lt + 66));
      i = tagEnd(html, lt + 2);
      if (m === null) continue;
      const tag = m[0].toLowerCase();
      for (let e: El | null = cur; e !== null && e !== root; e = e.parent) {
        if (e.tag === tag) {
          cur = e.parent ?? root;
          break;
        }
      }
    } else {
      const m = NAME.exec(html.slice(lt + 1, lt + 65));
      if (m === null) {
        // a lone "<" is text
        texts.push({ el: cur, raw: "<" });
        i = lt + 1;
        continue;
      }
      const tag = m[0].toLowerCase();
      const end = tagEnd(html, lt + 1 + m[0].length);
      const selfClosing = html[end - 2] === "/";
      const el = open(tag);
      i = end;
      if (RAW_TEXT.has(tag)) {
        const close = lower.indexOf(`</${tag}`, i);
        i = close < 0 ? html.length : tagEnd(html, close + 2);
      } else if (!VOID.has(tag) && !selfClosing) cur = el;
    }
  }
  const out: HtmlText[] = [];
  const selectors = new Map<El, string>();
  /** Per element: its position among same-tag siblings and how many there are. */
  const typeIndex = new Map<El, { k: number; of: number }>();
  const indexChildren = (p: El): void => {
    const counts = new Map<string, number>();
    for (const c of p.children) {
      const k = (counts.get(c.tag) ?? 0) + 1;
      counts.set(c.tag, k);
      typeIndex.set(c, { k, of: 0 });
    }
    for (const c of p.children) {
      const x = typeIndex.get(c);
      if (x !== undefined) x.of = counts.get(c.tag) ?? 1;
    }
  };
  const selectorOf = (el: El): string => {
    const have = selectors.get(el);
    if (have !== undefined) return have;
    const chain: El[] = [];
    for (let e: El | null = el; e !== null && e !== root; e = e.parent) chain.push(e);
    const parts = chain.reverse().map((e) => {
      if (!typeIndex.has(e)) indexChildren(e.parent ?? root);
      const x = typeIndex.get(e) ?? { k: 1, of: 1 };
      return x.of > 1 ? `${e.tag}:nth-of-type(${x.k})` : e.tag;
    });
    const s = parts.length === 0 ? ":root" : parts.join(" > ");
    selectors.set(el, s);
    return s;
  };
  for (const t of texts) {
    if (t.raw.trim() === "") continue;
    const decoded = decodeHtmlEntities(t.raw);
    const text = (decoded ?? t.raw).trim();
    if (text === "") continue;
    out.push({ text, entities: decoded !== null, selector: selectorOf(t.el) });
  }
  return out;
}
