# npm 包：组装、本地验证、发布

`tabcap` 在 npm 上是五个包：四个平台包各带一个编译好的二进制，主包 `tabcap` 只带启动垫片（shim）和 skill，用 `optionalDependencies` 指向四个平台包。npm 按平台包 package.json 里的 `os` / `cpu` 只装其中一个；`bin/tabcap.js` 找到它的二进制，原样转交参数、stdio、退出码和信号。没有 postinstall。

| npm 平台 | 包名（默认，不带 scope） | 二进制 | release 目标 |
|---|---|---|---|
| darwin-arm64 | `tabcap-darwin-arm64` | `bin/tabcap` | darwin-arm64 |
| linux-x64 | `tabcap-linux-x64` | `bin/tabcap` | linux-x64 |
| linux-arm64 | `tabcap-linux-arm64` | `bin/tabcap` | linux-arm64 |
| win32-x64 | `tabcap-win32-x64` | `bin/tabcap.exe` | windows-x64 |

本目录是模板：`tabcap/package.json`、`tabcap/bin/tabcap.js`（`PACKAGES` 表留空，打包时生成）、`platforms/<平台>/package.json`（不写 `name`）。包名、主包的 `optionalDependencies`、shim 里的表都由 `scripts/npm-pack.ts` 的 `NPM_SCOPE` 一个常量生成。

## scope

- 默认 `NPM_SCOPE = null`：平台包叫 `tabcap-<平台>`。2026-10-16 查过 `tabcap` 在 registry 上是 404（空着）；四个 `tabcap-<平台>` 名字没查过【待验】，npm 也可能因为「和已有包名太像」拒绝新名字【待验】。
- 你确认自己拥有 npm 上的 `@tabcap` scope（组织或用户名）时，把 `scripts/npm-pack.ts` 里那一行改成 `NPM_SCOPE: string | null = "tabcap"`，重新 `bun run npm:pack`：平台包变成 `@tabcap/<平台>`，主包依赖与 shim 跟着变，别的不用改。tarball 文件名不变（npm 把 `@tabcap/darwin-arm64` 打成 `tabcap-darwin-arm64-<版本>.tgz`）。
- 两种名字都用 `--access public` 发布（scope 包默认私有，必须带；不带 scope 的带上也无害）。

## 1. 组装

前置：Bun 1.4 以上、Zig 0.16.0（四个 wire 组件要用 Zig 交叉编译；`bun run build*` 在 `native/dist/` 缺组件时由 `scripts/prebuild.ts` 一句话拒绝，见 docs/07 §6「原生组件的调用」）。在仓库根目录：

```sh
bun run npm:pack                        # 四个平台包 + tabcap
bun run npm:pack --targets darwin-arm64 # 只打这些平台包（npm 名或 release 名，逗号分隔）；tabcap 总会打
bun run npm:pack --version 0.7.2        # 只做断言：package.json 与每个模板都必须是 0.7.2，否则拒绝
```

- 版本只来自 `package.json`；任何模板的 `version` 不同就拒绝（升版本时同时改 `packaging/npm/**/package.json`）。
- 二进制取 `dist/tabcap-<release 目标>[.exe]`。缺失，或内嵌的 package.json 版本不是本版本（旧二进制），就用 `scripts/release.ts` 的同一套命令重编：先 `bun scripts/native.ts build`（四个 Zig wire 组件，需要 Zig 0.16.0），再 `bun build --compile`。本机平台的二进制还要跑一次 `--version`，必须等于本版本。【实测 2026-10-16】主检出的 `dist/` 里 `tabcap-linux-x64`、`tabcap-windows-x64.exe` 内嵌的是 0.2.0，这个检查就是防它们被打进 0.7.2。
- 产物在 `dist/npm/`：每个包一个目录、一个 `npm pack` 出的 `.tgz`，加 `SHA256SUMS`。打包用 `npm pack --json --offline --ignore-scripts --no-update-notifier`，不连 registry；打完核对 tarball 里的文件与目录完全一致、二进制是可执行权限。
- 结尾打印发布命令（按顺序）和发布后的核对命令，路径是绝对路径，可以直接复制。

平台包内容：`package.json`、`bin/tabcap`（Windows 是 `bin/tabcap.exe`，0755）、`LICENSE`、`NOTICE`（二进制里有从 Apache-2.0 代码派生的部分，NOTICE 要随二进制分发）、五行 `README.md`。主包内容：`package.json`、`bin/tabcap.js`、`LICENSE`、`NOTICE`、`README.md`（README 的 Quick start，加一段 npm 安装说明）、`skills/tabcap/`（`SKILL.md` 与 `references/commands.md`；全局安装后在 `$(npm root -g)/tabcap/skills/tabcap/`）。`templates/plugins/decode-python/`（解码插件的 Python runner 模板；全局安装后在 `$(npm root -g)/tabcap/templates/plugins/decode-python/`）。

## 2. 本地验证（发布前，不连 registry）

平台包还没发布，`npm install -g ./dist/npm/tabcap-0.7.2.tgz` 会去 registry 找它们。验证改用一个临时项目，把平台包和主包的 tgz 一起当本地文件装，`--offline` 保证不联网（另外三个平台包是可选依赖，取不到就跳过）：

```sh
bun run npm:pack
REPO=$PWD
T=$(mktemp -d) && cd "$T"
echo '{"name":"proof","version":"0.0.0","private":true}' > package.json
npm install --no-save --offline --no-audit --no-fund --no-update-notifier --cache "$T/cache" \
  "$REPO/dist/npm/tabcap-darwin-arm64-0.7.2.tgz" "$REPO/dist/npm/tabcap-0.7.2.tgz"
node_modules/.bin/tabcap --version
node_modules/.bin/tabcap wire version
node_modules/.bin/tabcap schema --json | head -c 200
```

【实测 2026-10-16，macOS arm64，npm 10.9.4，Node 22.21.1，作者自己的 npm 配置，`TABCAP_HOME` 指向临时目录】：

```text
added 2 packages in 774ms
$ ls node_modules
tabcap  tabcap-darwin-arm64
$ node_modules/.bin/tabcap --version
{"ok":true,"data":{"tool":"tabcap","version":"0.7.2"}}            # exit 0；直接跑 node_modules/tabcap-darwin-arm64/bin/tabcap --version 输出相同
$ node_modules/.bin/tabcap wire version
{"ok":true,"data":{"component":"wireprint 0.1.0","path":"<TABCAP_HOME>/cache/native/wireprint-2b0cb9d4…/wireprint","sha256":"2b0cb9d455628298e04ce8cb984aaa6699121495fccdfc94bab03e4f592a3f24","source":"embedded","target":"aarch64-macos"}}
$ node_modules/.bin/tabcap schema --json | head -c 200
{
  "schema": "tabcap-cli-schema/0",
  "tool": "tabcap",
  "version": "0.7.2",
  "envelope": {
    "ok": "{ok:true,data}",
    "error": "{ok:false,error:{code,message,next}}"
  },
  "commands": [
$ node_modules/.bin/tabcap no-such-command        # 退出码 2，与直接跑二进制相同
```

同样的两个 tgz 用 `npm install -g --prefix <临时目录> --offline …` 全局装也通过：`<prefix>/bin/tabcap --version` 输出同上（shim 在 `lib/node_modules/tabcap/`，平台包是它旁边的 `lib/node_modules/tabcap-darwin-arm64/`，`require.resolve` 向上找得到）【实测】。参数原样转交、退出码、被信号杀死时 shim 以同一信号退出、两种包名，在 `test/unit/npm-pack.test.ts` 里用替身二进制测（非 Windows）。Linux / Windows 的平台包没在真机装过【待验】。

## 3. 发布（CI 自动；作者 2026-10-17 定）

推送 `v<版本>` tag 就是发布决定：`release.yml` 在四个 runner 上编好二进制后，`npm` job 在 ubuntu 上下载四个二进制、跑 `bun run npm:pack`（校验内嵌版本、宿主平台跑 `--version`），再按顺序 `npm publish` 五个包（先四个平台包，最后 `tabcap`），发完逐个 `npm view` 核对。已在 registry 上的同版本会跳过，所以中途失败后重跑同一个 job 即可。认证：仓库 secret `NPM_TOKEN`（只能 publish、勾 bypass 2FA、限定这五个包的 granular token）存在时用它；不存在时走 npm 的 trusted publishing（OIDC，无长期密钥）——要先在 npmjs.com 给五个包各配一个 trusted publisher（包页 Settings → Add Trusted Publisher connection for GitHub Actions）：Organization or user `1A7432`，Repository `tabcap`，Workflow filename `release.yml`，Environment 留空，**勾「Allow npm publish」**（默认只允许 `npm stage publish`，job 用的是 `npm publish`）；每次保存要过一次账号的 2FA。trusted publishing 要求 runner 上 npm ≥ 11.5.1、Node ≥ 22.14（job 里 `npm install -g npm@11`），公开仓库自动带 provenance。干跑：Actions 页手动运行 `release`，勾 `npm_dry_run`，job 会走到 `npm publish --dry-run` 为止，不发布。GitHub Release 仍是草稿，由作者在网页上发布。【实测 2026-10-18，v0.7.1 run 39051903323：没配认证时 job 报 `ENEEDAUTH`；五个包的 trusted publisher 配好后重跑同一个 job，五个 `npm publish` 全部成功、带 provenance；`npm publish` 打出 `+ name@version` 后 registry 还要处理 1–7 分钟才能 `npm view` 到，所以核对步骤是轮询（最多 15 分钟）】

## 3b. 手动发布（CI 不可用时的后备）

前提：上面本地验证通过；`dist/npm/` 是同一次 `bun run npm:pack` 的产物（`SHA256SUMS` 对得上）。`npm publish <tgz>` 原样上传这个文件，不再重新打包。

1. **registry 写明**。你的默认 registry 可能指向镜像（`npm config get registry` 查看）；`~/.npmrc` 里有 npmjs 的 token，但普通 shell 里 `npm whoami` 失败，最可能就是因为默认 registry 是镜像【推断】。下面每条命令都带 `--registry https://registry.npmjs.org`（`npm:pack` 打印的命令也带），或者在这个 shell 里先 `export npm_config_registry=https://registry.npmjs.org`。不要把 token 贴进对话、日志或命令行参数。
2. **登录确认**：
   ```sh
   npm whoami --registry https://registry.npmjs.org     # 必须打印你的 npm 用户名
   ```
   失败才 `npm login --registry https://registry.npmjs.org`，在你自己的终端里完成（浏览器或 OTP），然后再 `whoami` 一次。
3. **（可选）预演**：`npm publish <tgz> --dry-run --access public --registry https://registry.npmjs.org` 只显示将上传的内容，不上传（是否仍连 registry 核对登录与版本【待验】）。
4. **按顺序发布**：先四个平台包，最后 `tabcap`。直接粘贴 `bun run npm:pack` 结尾打印的那几行；形如
   ```sh
   npm publish <repo>/dist/npm/tabcap-darwin-arm64-0.7.2.tgz --access public --registry https://registry.npmjs.org
   npm publish <repo>/dist/npm/tabcap-linux-x64-0.7.2.tgz    --access public --registry https://registry.npmjs.org
   npm publish <repo>/dist/npm/tabcap-linux-arm64-0.7.2.tgz  --access public --registry https://registry.npmjs.org
   npm publish <repo>/dist/npm/tabcap-win32-x64-0.7.2.tgz    --access public --registry https://registry.npmjs.org
   npm publish <repo>/dist/npm/tabcap-0.7.2.tgz              --access public --registry https://registry.npmjs.org
   ```
   账号开了发布二次验证时每条加 `--otp <六位码>`，或按提示在浏览器确认。从自己机器发布，不加 `--provenance`（那只在 CI 的 OIDC 环境里可用）。
5. **核对**：粘贴打印的 `npm view …` 几行，每个都应输出 `0.7.2`，`tabcap@0.7.2 optionalDependencies` 应列出四个平台包。然后换一个干净目录 `npm install -g tabcap --registry https://registry.npmjs.org && tabcap --version`。
6. **dist-tag**：第一次发布自动打 `latest`，不用 `npm dist-tag`。以后发预发布版本才需要 `--tag next`。

### 中途失败

- 每个 `npm publish` 单独成败。哪一条失败（网络、认证、OTP 过期、名字被拒），修好原因后重跑**同一条**；已成功的用 `npm view <名字>@<版本> version` 确认，不要重发（同一版本号再发，registry 会以 403「cannot publish over the previously published versions」拒绝）。
- 四个平台包都 `npm view` 得到之后才发 `tabcap`。`tabcap` 已发而某个平台包缺失时，那个平台的用户装完运行会看到 `tabcap: tabcap-<平台> is not installed …`；补发那个平台包（同一版本），用户重装即可。
- 某个已发布的包有问题：npm 的同一个 `名字@版本` 永远不能再用，即使 unpublish 之后也不行（npm 规则，本格未实测）。做法是：`package.json` 与 `packaging/npm/**/package.json` 一起升补丁版本，重新 `bun run npm:pack`，五个包全部按顺序重发，再对坏版本 `npm deprecate <名字>@<坏版本> "<原因>" --registry https://registry.npmjs.org`。
- 名字被拒（与已有包太像、或被占）：改用 scope（见上面「scope」），重新打包，从第一个平台包重新发。
