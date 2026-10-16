// Image captcha advisory (0.6-D, owner 10-16: 「guard 识别图片验证码也不一定转交，
// 模型能自己过就过吧。就告诉模型有个什么东西拦着，它自己判断要不要喊人」).
// tabcap never solves, fills or hands over on its own: it only says that an
// image captcha is there, which image and which input, and what the model can
// do (read the image with `screenshot --ref`, or ask the human). The page
// script (CAPTCHA_SCAN_FN, run in tabcap's isolated world, read-only)
// describes the document's images and text inputs; the decision is pure
// (detectCaptcha) over that description, which is untrusted: the page
// controls every string in it.
//
// Heuristic (the owner's brief, literally):
//   - an <img> / <canvas> whose src / id / class / alt / title / nearby label
//     mentions captcha / verify / 验证码 / 校验码, or
//   - an input whose name / id / placeholder / label is like captcha / vcode /
//     verifyCode / 验证码 / 校验码, next to a login form (in a form with a
//     password field; outside any form: on a page with a password field).
// The image and the input are paired within the same form (or both outside
// any form). Invisible images (zero-size box) are left out.

import { isRecord } from "../../shared/json.ts";

export type ScanImage = { n: number; tag: string; src: string; id: string; cls: string; alt: string; title: string; label: string; form: number };
export type ScanInput = { n: number; type: string; name: string; id: string; cls: string; placeholder: string; label: string; form: number };
export type CaptchaScan = { images: ScanImage[]; inputs: ScanInput[]; passwordForms: boolean[]; docPassword: boolean; target: number | null };

/** What was found: node indexes into the scan's node list, and the form (-1: outside any form). */
export type CaptchaHit = { image: number | null; input: number | null; form: number };

export const IMAGE_WORDS = /captcha|verify|验证码|校验码/i;
export const INPUT_WORDS = /captcha|vcode|verify_?code|验证码|校验码/i;

const MAX_ITEMS = 200;
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** The page script's JSON (untrusted) → a scan; malformed entries are dropped, never thrown on. */
export function parseCaptchaScan(v: unknown): CaptchaScan {
  const r = isRecord(v) ? v : {};
  const images: ScanImage[] = [];
  for (const x of (Array.isArray(r["images"]) ? r["images"] : []).slice(0, MAX_ITEMS)) {
    if (!isRecord(x)) continue;
    const n = int(x["n"]);
    if (n === null || n < 0) continue;
    images.push({ n, tag: str(x["tag"], 16), src: str(x["src"], 300), id: str(x["id"], 120), cls: str(x["cls"], 200), alt: str(x["alt"], 120), title: str(x["title"], 120), label: str(x["label"], 120), form: int(x["form"]) ?? -1 });
  }
  const inputs: ScanInput[] = [];
  for (const x of (Array.isArray(r["inputs"]) ? r["inputs"] : []).slice(0, MAX_ITEMS)) {
    if (!isRecord(x)) continue;
    const n = int(x["n"]);
    if (n === null || n < 0) continue;
    inputs.push({ n, type: str(x["type"], 32), name: str(x["name"], 120), id: str(x["id"], 120), cls: str(x["cls"], 200), placeholder: str(x["placeholder"], 120), label: str(x["label"], 120), form: int(x["form"]) ?? -1 });
  }
  const passwordForms = (Array.isArray(r["passwordForms"]) ? r["passwordForms"] : []).slice(0, MAX_ITEMS).map((x) => x === true);
  return { images, inputs, passwordForms, docPassword: r["docPassword"] === true, target: int(r["target"]) };
}

export const imageLooksLikeCaptcha = (i: ScanImage): boolean => [i.src, i.id, i.cls, i.alt, i.title, i.label].some((s) => IMAGE_WORDS.test(s));
export const inputLooksLikeCaptcha = (i: ScanInput): boolean => [i.name, i.id, i.placeholder, i.label].some((s) => INPUT_WORDS.test(s));

/** Is this input next to a login form? */
function nearLogin(scan: CaptchaScan, form: number): boolean {
  return form >= 0 ? scan.passwordForms[form] === true : scan.docPassword;
}

/** Pure: the first image captcha of a document, or null. */
export function detectCaptcha(scan: CaptchaScan): CaptchaHit | null {
  const images = scan.images.filter(imageLooksLikeCaptcha);
  const inputs = scan.inputs.filter((i) => inputLooksLikeCaptcha(i) && nearLogin(scan, i.form));
  const img = images[0];
  if (img !== undefined) {
    // Its input: the first captcha-like input of the same form (null when there is none).
    const own = scan.inputs.filter((i) => i.form === img.form && inputLooksLikeCaptcha(i));
    return { image: img.n, input: own[0]?.n ?? null, form: img.form };
  }
  const inp = inputs[0];
  if (inp === undefined) return null;
  // Its image: any visible image in the same form (the input names the captcha, the image needs no words).
  const pic = scan.images.find((i) => i.form === inp.form && inp.form >= 0);
  return { image: pic?.n ?? null, input: inp.n, form: inp.form };
}

/** Does an action on the scan's target element act on the captcha's form? (-1: both outside any form.) */
export const onCaptchaForm = (scan: CaptchaScan, hit: CaptchaHit): boolean => scan.target !== null && scan.target === hit.form;

/** The challenge advisory as snapshot / outline / fill / click show it (refs, frame path of the document). */
export type ChallengeView = { kind: "image-captcha"; image: string | null; input: string | null; advisory: true; frame?: string };

/** The header line (docs/04 §27): what blocks, and the two ways on; the model decides. */
export function challengeLine(c: ChallengeView): string {
  const img = c.image === null ? "img (no ref)" : `img [${c.image}]`;
  const inp = c.input === null ? "input (none found)" : `input [${c.input}]`;
  const read = c.image === null ? "read the image (screenshot)" : `read the image (screenshot --ref ${c.image})`;
  return `challenge  ${c.kind} ${img} → ${inp}${c.frame === undefined ? "" : ` · in ${c.frame}`}; ${read} or hand over (ask the human to type it)`;
}

/**
 * Page script for Runtime.callFunctionOn in the isolated world: `this` is the
 * target element of an action (or the document element for a page scan).
 * Returns [JSON scan, ...nodes]; node indexes `n` point into the nodes.
 */
export const CAPTCHA_SCAN_FN = `function (cap, withTarget) {
  const target = withTarget && this && this.nodeType ? (this.nodeType === 1 ? this : this.parentElement) : null;
  const text = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
  const labelOf = (el) => {
    const parts = [el.getAttribute("aria-label") || ""];
    try { if (el.labels) for (const l of Array.from(el.labels)) parts.push(l.textContent); } catch (e) {}
    const lab = el.closest("label"); if (lab) parts.push(lab.textContent);
    const prev = el.previousElementSibling; if (prev) parts.push(prev.textContent);
    if (!parts.join("").trim() && el.parentElement) parts.push(el.parentElement.textContent);
    return text(parts.join(" "), 120);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const forms = [];
  const formId = (el) => { const f = (el && (el.form || el.closest("form"))) || null; if (!f) return -1; let i = forms.indexOf(f); if (i < 0) { forms.push(f); i = forms.length - 1; } return i; };
  const nodes = [], images = [], inputs = [];
  for (const el of Array.from(document.querySelectorAll("img, canvas")).slice(0, cap)) {
    if (!visible(el)) continue;
    nodes.push(el);
    images.push({ n: nodes.length - 1, tag: el.localName, src: text(el.getAttribute("src"), 300), id: text(el.id, 120), cls: text(el.getAttribute("class"), 200), alt: text(el.getAttribute("alt"), 120), title: text(el.getAttribute("title"), 120), label: labelOf(el), form: formId(el) });
  }
  const SKIP = ["hidden", "submit", "button", "checkbox", "radio", "file", "image", "reset", "range", "color"];
  for (const el of Array.from(document.querySelectorAll("input")).slice(0, cap)) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (SKIP.includes(type)) continue;
    nodes.push(el);
    inputs.push({ n: nodes.length - 1, type, name: text(el.getAttribute("name"), 120), id: text(el.id, 120), cls: text(el.getAttribute("class"), 200), placeholder: text(el.getAttribute("placeholder"), 120), label: labelOf(el), form: formId(el) });
  }
  const t = target ? formId(target) : null;
  const passwordForms = forms.map((f) => !!f.querySelector("input[type=password]"));
  return [JSON.stringify({ images, inputs, passwordForms, docPassword: !!document.querySelector("input[type=password]"), target: t }), ...nodes.slice(0, 64)];
}`;

/** Images and inputs the page script looks at per kind (the node list holds at most 64). */
export const CAPTCHA_SCAN_CAP = 32;
