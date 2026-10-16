// 0.6-D image captcha advisory: the heuristic over synthetic DOM descriptions
// (what CAPTCHA_SCAN_FN returns), the untrusted-input parsing and the header
// line. Oracle: the owner's wording in the 0.6-D brief (an <img> / <canvas>
// whose src / id / class / alt / nearby label mentions captcha / verify /
// 验证码 / 校验码, or an input named like captcha / vcode / verifyCode next to
// a login form; tell the model, never decide for it).

import { describe, expect, test } from "bun:test";
import { headerLines } from "../../src/daemon/adapters/view.ts";
import { challengeLine, detectCaptcha, imageLooksLikeCaptcha, onCaptchaForm, parseCaptchaScan, type CaptchaScan, type ScanImage, type ScanInput } from "../../src/daemon/browser/captcha.ts";

const img = (n: number, o: Partial<ScanImage> = {}): ScanImage => ({ n, tag: "img", src: "", id: "", cls: "", alt: "", title: "", label: "", form: 0, ...o });
const inp = (n: number, o: Partial<ScanInput> = {}): ScanInput => ({ n, type: "text", name: "", id: "", cls: "", placeholder: "", label: "", form: 0, ...o });
const scanOf = (o: Partial<CaptchaScan>): CaptchaScan => ({ images: [], inputs: [], passwordForms: [true], docPassword: true, target: null, ...o });

describe("image captcha heuristic (0.6-D, synthetic DOM descriptions)", () => {
  test("an image whose alt / src / id / class / title / label mentions captcha, verify, 验证码 or 校验码", () => {
    const cases: Array<Partial<ScanImage>> = [{ alt: "验证码" }, { src: "/captcha.jpg?r=1" }, { id: "verifyImg" }, { cls: "img-captcha" }, { title: "校验码" }, { label: "点击刷新验证码" }];
    for (const o of cases) expect(detectCaptcha(scanOf({ images: [img(0, o)], inputs: [inp(1, { name: "username" })] }))).toEqual({ image: 0, input: null, form: 0 });
    expect(detectCaptcha(scanOf({ images: [img(0, { alt: "公司 logo", src: "/logo.png" })] }))).toBeNull();
    expect(imageLooksLikeCaptcha(img(0, { src: "/img/verified-badge.png" }))).toBe(false);
  });

  test("the image's input: a captcha-like input of the same form", () => {
    const scan = scanOf({ images: [img(2, { alt: "验证码" })], inputs: [inp(0, { name: "username" }), inp(1, { name: "verifyCode" }), inp(3, { name: "vcode", form: 1 })], passwordForms: [true, true] });
    expect(detectCaptcha(scan)).toEqual({ image: 2, input: 1, form: 0 });
  });

  test("an input named like captcha / vcode / verifyCode next to a login form, paired with an image of its form", () => {
    const cases: Array<Partial<ScanInput>> = [{ name: "captcha" }, { name: "vcode" }, { id: "verifyCode" }, { name: "verify_code" }, { placeholder: "请输入验证码" }, { label: "校验码" }];
    for (const o of cases) expect(detectCaptcha(scanOf({ inputs: [inp(0, o)] }))).toEqual({ image: null, input: 0, form: 0 });
    expect(detectCaptcha(scanOf({ images: [img(1, { src: "/img?id=7" })], inputs: [inp(0, { name: "vcode" })] }))).toEqual({ image: 1, input: 0, form: 0 });
    // not next to a login form: a form without a password field, or no password on the page
    expect(detectCaptcha(scanOf({ inputs: [inp(0, { name: "captcha" })], passwordForms: [false] }))).toBeNull();
    expect(detectCaptcha(scanOf({ inputs: [inp(0, { name: "captcha", form: -1 })], passwordForms: [], docPassword: false }))).toBeNull();
    expect(detectCaptcha(scanOf({ inputs: [inp(0, { name: "captcha", form: -1 })], passwordForms: [], docPassword: true }))).toEqual({ image: null, input: 0, form: -1 });
    // a plain "code" field is not a captcha
    expect(detectCaptcha(scanOf({ inputs: [inp(0, { name: "code" })] }))).toBeNull();
  });

  test("actions on the captcha's form carry it; other forms and page reads do not", () => {
    const hit = { image: 0, input: 1, form: 0 };
    expect(onCaptchaForm(scanOf({ target: 0 }), hit)).toBe(true);
    expect(onCaptchaForm(scanOf({ target: 1 }), hit)).toBe(false);
    expect(onCaptchaForm(scanOf({ target: null }), hit)).toBe(false);
    expect(onCaptchaForm(scanOf({ target: -1 }), { ...hit, form: -1 })).toBe(true);
  });

  test("untrusted scan data never throws: junk is dropped, sizes are capped", () => {
    expect(parseCaptchaScan("junk")).toEqual({ images: [], inputs: [], passwordForms: [], docPassword: false, target: null });
    const p = parseCaptchaScan({ images: [{ n: -1 }, { n: 1.5 }, "x", { n: 3, alt: 7, src: "s".repeat(5000) }], inputs: Array.from({ length: 500 }, (_, i) => ({ n: i })), passwordForms: [1, true], target: "0" });
    expect(p.images).toEqual([img(3, { tag: "", alt: "", src: "s".repeat(300), form: -1 })]);
    expect(p.inputs.length).toBe(200);
    expect(p.passwordForms).toEqual([false, true]);
    expect(p.target).toBeNull();
  });

  test("the header line names the image and the input and the two ways on; the model decides", () => {
    const c = { kind: "image-captcha" as const, image: "e12", input: "e13", advisory: true as const };
    expect(challengeLine(c)).toBe("challenge  image-captcha img [e12] → input [e13]; read the image (screenshot --ref e12) or hand over (ask the human to type it)");
    expect(challengeLine({ ...c, image: null, input: "f2/e4", frame: "f2" })).toBe("challenge  image-captcha img (no ref) → input [f2/e4] · in f2; read the image (screenshot) or hand over (ask the human to type it)");
    expect(headerLines({ overlays: [], detected: [], error: null, challenge: c })).toEqual(["overlays  none", "detected  none", challengeLine(c)]);
    expect(headerLines({ overlays: [], detected: [], error: null })).toEqual(["overlays  none", "detected  none"]);
  });
});
