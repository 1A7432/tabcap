// Built-in protection families (docs/04 §41.1, docs/14): one JSON per family under
// ./families/, embedded into the binary and validated like a user file. User
// families in config/protection/<id>.json override a built-in of the same id or
// add a new one; a bad user file is skipped and reported, never fatal.
// Generated import list: keep it sorted, one line per file in ./families/.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tryParseJson } from "../../shared/json.ts";
import { MAX_FAMILY_BYTES, parseFamily, type Family } from "./rules.ts";

import F_AKAMAI_BOT_MANAGER from "./families/akamai-bot-manager.json" with { type: "json" };
import F_ALIYUN_CAPTCHA from "./families/aliyun-captcha.json" with { type: "json" };
import F_ANUBIS from "./families/anubis.json" with { type: "json" };
import F_ARKOSE from "./families/arkose.json" with { type: "json" };
import F_AWS_WAF from "./families/aws-waf.json" with { type: "json" };
import F_CAPTCHA_EU from "./families/captcha-eu.json" with { type: "json" };
import F_CAPY from "./families/capy.json" with { type: "json" };
import F_CHEQ from "./families/cheq.json" with { type: "json" };
import F_CLOUDFLARE_BOT_MANAGEMENT from "./families/cloudflare-bot-management.json" with { type: "json" };
import F_CLOUDFLARE_WAITING_ROOM from "./families/cloudflare-waiting-room.json" with { type: "json" };
import F_DATADOME from "./families/datadome.json" with { type: "json" };
import F_DINGXIANG from "./families/dingxiang.json" with { type: "json" };
import F_FINGERPRINT_PRO from "./families/fingerprint-pro.json" with { type: "json" };
import F_FP_CANVAS from "./families/fp-canvas.json" with { type: "json" };
import F_FP_FONTS from "./families/fp-fonts.json" with { type: "json" };
import F_FP_HARDWARE from "./families/fp-hardware.json" with { type: "json" };
import F_FP_MEDIA_DEVICES from "./families/fp-media-devices.json" with { type: "json" };
import F_FP_NAVIGATOR from "./families/fp-navigator.json" with { type: "json" };
import F_FP_PERMISSIONS from "./families/fp-permissions.json" with { type: "json" };
import F_FP_SCREEN from "./families/fp-screen.json" with { type: "json" };
import F_FP_SPEECH from "./families/fp-speech.json" with { type: "json" };
import F_FP_TIMEZONE from "./families/fp-timezone.json" with { type: "json" };
import F_FP_WEBGL from "./families/fp-webgl.json" with { type: "json" };
import F_FRIENDLY_CAPTCHA from "./families/friendly-captcha.json" with { type: "json" };
import F_GEETEST_V3 from "./families/geetest-v3.json" with { type: "json" };
import F_GEETEST_V4 from "./families/geetest-v4.json" with { type: "json" };
import F_HCAPTCHA from "./families/hcaptcha.json" with { type: "json" };
import F_HUMAN_PERIMETERX from "./families/human-perimeterx.json" with { type: "json" };
import F_JIASULE from "./families/jiasule.json" with { type: "json" };
import F_MTCAPTCHA from "./families/mtcaptcha.json" with { type: "json" };
import F_NETACEA from "./families/netacea.json" with { type: "json" };
import F_NETEASE_YIDUN from "./families/netease-yidun.json" with { type: "json" };
import F_PROSOPO from "./families/prosopo.json" with { type: "json" };
import F_RADWARE_BOT_MANAGER from "./families/radware-bot-manager.json" with { type: "json" };
import F_REBLAZE from "./families/reblaze.json" with { type: "json" };
import F_RECAPTCHA from "./families/recaptcha.json" with { type: "json" };
import F_RUISHU from "./families/ruishu.json" with { type: "json" };
import F_SHUMEI from "./families/shumei.json" with { type: "json" };
import F_SUCURI from "./families/sucuri.json" with { type: "json" };
import F_TENCENT_CAPTCHA from "./families/tencent-captcha.json" with { type: "json" };
import F_THREATMETRIX from "./families/threatmetrix.json" with { type: "json" };
import F_TURNSTILE from "./families/turnstile.json" with { type: "json" };
import F_YANDEX_SMARTCAPTCHA from "./families/yandex-smartcaptcha.json" with { type: "json" };

const BUILTIN: ReadonlyArray<readonly [string, unknown]> = [
  ["akamai-bot-manager", F_AKAMAI_BOT_MANAGER],
  ["aliyun-captcha", F_ALIYUN_CAPTCHA],
  ["anubis", F_ANUBIS],
  ["arkose", F_ARKOSE],
  ["aws-waf", F_AWS_WAF],
  ["captcha-eu", F_CAPTCHA_EU],
  ["capy", F_CAPY],
  ["cheq", F_CHEQ],
  ["cloudflare-bot-management", F_CLOUDFLARE_BOT_MANAGEMENT],
  ["cloudflare-waiting-room", F_CLOUDFLARE_WAITING_ROOM],
  ["datadome", F_DATADOME],
  ["dingxiang", F_DINGXIANG],
  ["fingerprint-pro", F_FINGERPRINT_PRO],
  ["fp-canvas", F_FP_CANVAS],
  ["fp-fonts", F_FP_FONTS],
  ["fp-hardware", F_FP_HARDWARE],
  ["fp-media-devices", F_FP_MEDIA_DEVICES],
  ["fp-navigator", F_FP_NAVIGATOR],
  ["fp-permissions", F_FP_PERMISSIONS],
  ["fp-screen", F_FP_SCREEN],
  ["fp-speech", F_FP_SPEECH],
  ["fp-timezone", F_FP_TIMEZONE],
  ["fp-webgl", F_FP_WEBGL],
  ["friendly-captcha", F_FRIENDLY_CAPTCHA],
  ["geetest-v3", F_GEETEST_V3],
  ["geetest-v4", F_GEETEST_V4],
  ["hcaptcha", F_HCAPTCHA],
  ["human-perimeterx", F_HUMAN_PERIMETERX],
  ["jiasule", F_JIASULE],
  ["mtcaptcha", F_MTCAPTCHA],
  ["netacea", F_NETACEA],
  ["netease-yidun", F_NETEASE_YIDUN],
  ["prosopo", F_PROSOPO],
  ["radware-bot-manager", F_RADWARE_BOT_MANAGER],
  ["reblaze", F_REBLAZE],
  ["recaptcha", F_RECAPTCHA],
  ["ruishu", F_RUISHU],
  ["shumei", F_SHUMEI],
  ["sucuri", F_SUCURI],
  ["tencent-captcha", F_TENCENT_CAPTCHA],
  ["threatmetrix", F_THREATMETRIX],
  ["turnstile", F_TURNSTILE],
  ["yandex-smartcaptcha", F_YANDEX_SMARTCAPTCHA],
];

let cache: Family[] | null = null;

export function builtinFamilies(): Family[] {
  if (cache === null) cache = BUILTIN.map(([id, raw]) => parseFamily(raw, `builtin:${id}`, true));
  return cache;
}

export type LoadedFamilies = { families: Family[]; warnings: string[] };

/** Built-ins plus `<dir>/*.json` (config/protection/): same id overrides, a bad file is skipped with a warning. */
export function loadFamilies(dir: string | null, builtins: readonly Family[] = builtinFamilies()): LoadedFamilies {
  const byId = new Map(builtins.map((f) => [f.id, f] as const));
  const warnings: string[] = [];
  if (dir !== null && existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const file = join(dir, name);
      try {
        if (statSync(file).size > MAX_FAMILY_BYTES) throw new Error(`larger than ${MAX_FAMILY_BYTES} bytes`);
        const raw = tryParseJson(readFileSync(file, "utf8"));
        if (raw === undefined) throw new Error("not valid JSON");
        const f = parseFamily(raw, file, false);
        byId.set(f.id, f);
      } catch (e) {
        warnings.push(`protection rules ${file} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { families: [...byId.values()], warnings };
}
