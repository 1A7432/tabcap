# 14 防护家族清单与来源（0.8-A 草案，10-20）

`docs/04` §41 的规则表要覆盖的家族、每家的可观察信号和**公开来源**。作者 10-20 定：只识别、不针对、不绕过；规则自己从公开来源写；家族面向 scrapfly/Antibot-Detector（NPOSL-3.0）看齐，它的代码与规则数据不进仓库，只学方法、本地对照（AGENTS.md「第三方材料」）。

来源规则：厂商文档、厂商 cookie / 隐私政策、厂商 KB，或中立的技术来源（安全研究、cookie 数据库、集成方文档）。**不用**绕过 / 打码服务商（hypersolutions、2captcha、capsolver 等）、Antibot-Detector、Wappalyzer 系的规则数据。调研方式：Exa agent 两轮（10-20），结果逐条带 URL 与原文摘录，整理稿在主循环 scratchpad，进规则文件时每条规则写 `sources`。

等级：表里的信号全部是【推断】（来源说有，本工具没在真实站点录到过）；作者真实项目的包里见到后改【实测】并记在规则的 `seen` 里。

强度：**强** = 厂商自己的文档 / 政策；**中** = 中立技术来源或集成方文档；**弱** = 只有逆向仓库或单一非正式来源；**无** = 没找到合格来源。作者 10-20 定：**弱与无都不进表**，列在 §5 backlog，等作者真实项目的包里见到（那时以包为 oracle）或找到强 / 中来源再加。

## 1. 防护（anti-bot / WAF）

| 家族 | 信号（层） | 来源 | 强度 |
|---|---|---|---|
| Cloudflare Bot Management / 挑战 | cookie `__cf_bm`、`cf_clearance`（L1）；脚本路径 `/cdn-cgi/challenge-platform/`（L1）；响应头 `cf-mitigated`（L1，recon v0 已有） | developers.cloudflare.com：cloudflare-cookies、javascript-detections | 强 |
| Cloudflare Waiting Room | cookie `__cfwaitingroom`（L1） | developers.cloudflare.com/waiting-room/reference/waiting-room-cookie | 强 |
| Akamai Bot Manager | cookie `_abck`、`bm_sz`、`ak_bmsc`、`bm_sv`（L1） | akamai.com/legal/manage-cookie-preferences | 强 |
| DataDome | cookie `datadome`、`dd_testcookie`（L1）；脚本 `js.datadome.co/tags.js`、上报 `api-js.datadome.co`（L1）；全局 `ddjskey`、`ddoptions`（L2）；拦截 iframe `*.captcha-delivery.com`（L2）；响应头 `x-datadome`（L1，已有） | docs.datadome.co：cookie-session-storage、javascript-tag | 强 |
| HUMAN（PerimeterX） | cookie `_px`、`_px2`、`_px3`、`_pxvid`、`pxcts`、`_pxff_*`（L1） | docs.humansecurity.com/applications/use-of-cookies-web-storage | 强 |
| AWS WAF | cookie `aws-waf-token`（L1）；请求头 `x-aws-waf-token`（L1）；响应头 `x-amzn-waf-action: captcha`（405）/ `challenge`（202）（L1，已有）；`challenge.js` 的主机文档里没给出，不收 | docs.aws.amazon.com/waf | 强 |
| Netacea | 响应头 `x-netacea-match`、`x-netacea-mitigate`、`x-netacea-captcha`（L1）；挑战路径 `/ATAverify`（L1） | docs.netacea.com | 强 |
| Radware Bot Manager（ShieldSquare） | 主机 `eupulse.shieldsquare.net`、`scus.shieldsquare.net`（L1） | support.radware.com 实施指南 | 强；`__uzm*` 无来源 |
| Reblaze（Link11） | cookie `rbzid`、`rbzsessionid`（L1） | waap.docs.link11.com | 强 |
| Sucuri | 响应头 `X-Sucuri-ID`、`X-Sucuri-Cache`（L1）；cookie `sucuri_cloudproxy_uuid_*`（L1） | docs.sucuri.net、cookiedatabase.org | 强 |
| ThreatMetrix | 脚本 `h.online-metrix.net/fp/tags.js`（L1） | Cybersource 集成文档 | 中 |
| Fingerprint（FingerprintJS Pro） | 脚本 `fpjscdn.net/v3/`（L1）；存储前缀 `_vid_`（L1 cookie） | docs.fingerprint.com | 强 |
| CHEQ | cookie `_cq_duid`、`_cq_suid`、`_cq_check`、`_cq_session` 等（L1）；全局 `_cq`（L2） | cheq.ai/cookie-policy、support.cheq.ai | 强 |
| Anubis | cookie `techaro.lol-anubis-auth`（L1）；响应头 `X-Anubis-Rule`、`X-Anubis-Action`、`X-Anubis-Status`（L1） | github.com/TecharoHQ/anubis 文档 | 强 |
| 知道创宇 加速乐 | cookie `__jsluid_h` / `__jsluid_s`、`__jsl_clearance` / `__jsl_clearance_s`（L1）；首个响应 HTTP 521 + JS（L1 挑战页） | 腾讯云开发者社区、博客园文章 | 中 |
| 瑞数 | 挑战响应 HTTP 202 / 412、`<meta … content>`、全局 `$_ts`（L1 挑战页 / L2）；cookie 成对 `<名>S` + `<名>T`（名字因站而异，只作佐证） | FreeBuf、腾讯云开发者社区 | 中 |

站点自有的（不是厂商产品）：同花顺 `hexin-v` 请求头 = cookie `v`、脚本 `chameleon.min.js`（ctfiot、CSDN，中）——按范围规则，作者真实项目用到才进表。

## 2. 验证码（captcha）

| 家族 | 信号（层） | 来源 | 强度 |
|---|---|---|---|
| Google reCAPTCHA v2 / v3 / Enterprise | 脚本 `www.google.com/recaptcha/api.js`、`…/enterprise.js`、主机 `www.gstatic.com/recaptcha/`（L1）；cookie `_GRECAPTCHA`（L1）；DOM `.g-recaptcha[data-sitekey]`（L2）；全局 `grecaptcha`（L2）；表单字段 `g-recaptcha-response`（L1 请求体） | developers.google.com/recaptcha、cloud.google.com/recaptcha | 强 |
| Cloudflare Turnstile | 脚本 `challenges.cloudflare.com/turnstile/v0/api.js`（L1）；DOM `.cf-turnstile[data-sitekey]`（L2）；全局 `turnstile`（L2）；字段 `cf-turnstile-response`（L1） | developers.cloudflare.com/turnstile | 强 |
| hCaptcha | 脚本 `js.hcaptcha.com/1/api.js`（L1）；DOM `.h-captcha[data-sitekey]`（L2）；全局 `hcaptcha`（L2）；字段 `h-captcha-response`（L1） | docs.hcaptcha.com | 强 |
| Arkose Labs（FunCaptcha） | 脚本 `*-api.arkoselabs.com/v2/<key>/api.js`、`client-api.arkoselabs.com`（L1） | developer.arkoselabs.com | 强 |
| Friendly Captcha | 脚本 `@friendlycaptcha/sdk` `site.min.js`（L1）；DOM `.frc-captcha[data-sitekey]`（L2） | developer.friendlycaptcha.com | 强 |
| MTCaptcha | 脚本 `service.mtcaptcha.com/mtcv1/client/mtcaptcha.min.js`、`service2…`（L1）；cookie `mtv1*`（L1）；DOM `.mtcaptcha`、全局 `mtcaptcha`（L2） | docs.mtcaptcha.com | 强 |
| Yandex SmartCaptcha | 脚本 `smartcaptcha.cloud.yandex.ru/captcha.js`（L1）；DOM `.smart-captcha[data-sitekey]`、全局 `smartCaptcha`（L2） | yandex.cloud/en/docs/smartcaptcha | 强 |
| Prosopo Procaptcha | 脚本 `js.prosopo.io/js/procaptcha.bundle.js`（L1）；DOM `.procaptcha[data-sitekey]`（L2）；字段 `procaptcha-response`（L1） | docs.prosopo.io | 强 |
| Captcha.eu | 脚本 `www.captcha.eu/sdk.js`（L1）；全局 `KROT`（L2）；字段 `captcha_at_solution`、DOM `.cpt_widget`（L1 / L2） | docs.captcha.eu、github.com/captcha-eu/docs | 强 |
| Capy Puzzle | 校验 `jp.api.capy.me/gimpy/verify`（服务器侧，浏览器多半看不到）；字段 `capy_challengekey`、`capy_answer`（L1 请求体） | capy.me/developers | 中 |
| 极验 v3 | 脚本 `static.geetest.com/static/js/gt.*.js`（L1）；全局 `initGeetest`（L2） | docs.geetest.com/captcha/deploy/client/web | 强 |
| 极验 v4 | 脚本 `static.geetest.com/v4/gt4.js`（L1）；全局 `initGeetest4`（L2） | docs.geetest.com/gt4 | 强 |
| 腾讯云验证码 | 脚本 `turing.captcha.qcloud.com/TJCaptcha.js`（2.0）、`*.captcha.qcloud.com/TCaptcha-global.js`、`global.captcha.gtimg.com/TCaptcha-global.js`（L1）；全局 `TencentCaptcha`（L2） | cloud.tencent.com/document/product/1110/112026、tencentcloud.com/document/product/1159/73397 | 强 |
| 网易易盾 | 脚本 `cstaticdun.126.net/load.min.js`（L1）；全局 `initNECaptcha`、`initNECaptchaWithFallback`、`createNEFingerprint`（L2） | support.dun.163.com | 强 |
| 阿里云验证码 | 脚本 `o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`、旧版 `g.alicdn.com/AWSC/AWSC/awsc.js`（L1）；全局 `initAliyunCaptcha`、`AWSC`（L2） | developer.aliyun.com、help.aliyun.com | 强 |
| 顶象 | 脚本 `cdn.dingxiang-inc.com/ctu-group/captcha-ui/`、`…/constid-js/`（L1）；接口 `constid.dingxiang-inc.com/udid/`（L1）；全局 `_dx`（L2） | dingxiang-inc.com/docs | 强 |
| 数美 | 脚本 `static.portal101.cn/dist/web/…/fp.min.js`（L1）；接口 `/deviceprofile/v4`（L1，路径通用，佐证）；全局 `SMSdk`、`_smConf`、`initSMCaptcha`（L2）；`smidV2`（L1 cookie / 存储，中） | help.ishumei.com、数美 PDF | 强 |

## 3. 指纹技术（L3，不分厂商）

和 Antibot-Detector 的 fingerprint 一类同义：按**页面调用了哪些 API** 认技术。0.8-A1 内置 10 类，只用追踪模式默认名单（`src/daemon/trace/signals.ts`）里有的 API：canvas、WebGL、navigator、硬件、屏幕、时区 / Intl、媒体设备、权限、语音、字体。audio、WebRTC、电量、剪贴板、crypto、CSS 媒体查询、手柄、地理位置、IndexedDB、存储、USB、设备方向、performance 要先把对应 API 加进追踪名单（改追踪模式的默认行为，待作者定）。数据来自追踪模式的 `signal` 事件（`docs/04` §4.1，API 名单在 `src/daemon/trace/signals.ts`），技术与 API 的对应只用 API 名（Web IDL 规范为 oracle），不需要厂商来源。每个技术报：调用了哪些 API、调用方脚本 URL；调用方脚本命中 §1 / §2 某家族的脚本规则时，标「归因到 <家族>」。

## 4. 本地对照

作者 10-20 定：对照脚本**只留本地，绝对不进仓库、不推到任何远端**（放在作者本机或主循环 scratchpad，仓库里不放脚本、不放它的输出）。做法：用作者本机的 Antibot-Detector 检出跑同一个证据包，只看两边结论不一致的家族名；不一致时回到公开来源补我们的规则，不照抄对方的规则。

## 5. backlog（不进表）

| 家族 | 现有线索 | 为什么不进 |
|---|---|---|
| Imperva / Incapsula | cookie `visid_incap_*`、`incap_ses_*`、`nlbi_*`、`___utmvc`，头 `X-Iinfo`、`X-CDN: Incapsula`（wafrift-detect 规则库、某站 cookie 政策）；`reese84` 无来源 | 没有厂商自己的来源（作者 10-20：偏弱的先不加）；recon v0 原有的 `x-iinfo` 头名一行照旧保留在通用信号里 |
| Kasada | 头 `x-kpsdk-ct`、`x-kpsdk-cd`，脚本 `ips.js`（一个逆向仓库） | 弱 |
| F5 BIG-IP ASM | cookie `TS` 前缀（techdocs.f5.com） | 只有一个短前缀，单独不能定案，没有能组合的第二个信号 |
| F5 Distributed Cloud Bot Defense（Shape） | JS 路径由客户配置 | 弱，几乎不可被动识别 |
| 阿里云 WAF | 只有「JS 挑战页」的描述 | 弱，没有具体名字 |
| Google BotGuard、Amazon、Azure Front Door、白山云 YUNDUN、Hunt、Meetrics、Ocule、DeepSeek PoW、OpenAI Sentinel | 没有合格的具体信号（Sentinel 只有一个账号工具仓库） | 无 |
| Basilisk、Binance bCAPTCHA、速卖通 baxia | 只有打码服务商的来源或没有 | 无 |
