# Homebrew

`tabcap.rb` 是 formula 模板（`{{VERSION}}`、`{{SHA256_DARWIN_ARM64}}`、`{{SHA256_LINUX_X64}}`、`{{SHA256_LINUX_ARM64}}`），`scripts/homebrew-formula.ts` 用一次发布的 `SHA256SUMS` 把它填成真 formula；`TAP-README.md` 是 tap 仓库的 README。

**自动更新**：`.github/workflows/homebrew.yml` 在 GitHub Release **发布**（不是草稿）时运行：下载该 release 的 `SHA256SUMS`，渲染 `Formula/tabcap.rb`，`brew style` 检查，然后推到 tap 仓库 `1A7432/homebrew-tabcap`。Release 发布后附件才公开可下，所以这一步不在 `release.yml` 里。没有 secret 时只渲染不推送（打一条 warning，不失败）。手动重跑：Actions → homebrew → Run workflow，填 tag（例如 `v0.7.2`），或 `gh workflow run homebrew.yml -f tag=v0.7.2`。

**一次性配置（作者做）**——2026-10-19 已完成：tap 仓库已建，secret 已存，0.7.3 已推进 tap。PAT 到期后重做第 2、3 步。

1. 新建空的公开仓库 `1A7432/homebrew-tabcap`（不初始化 README，工作流第一次推送时会带上）。
2. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token：Resource owner `1A7432`；Repository access 选 Only select repositories → `homebrew-tabcap`；Permissions → Repository permissions → Contents: **Read and write**（Metadata 会自动带上）；有效期按需（到期后换一个再 `gh secret set` 即可）。
3. 存成仓库 secret：`gh secret set HOMEBREW_TAP_TOKEN --repo 1A7432/tabcap`（交互式粘贴，不要把 token 贴进聊天），或网页 Settings → Secrets and variables → Actions → New repository secret。
4. 对已发布的版本跑一次：`gh workflow run homebrew.yml --repo 1A7432/tabcap -f tag=v0.7.2`，然后 `brew install 1A7432/tabcap/tabcap` 验证。

本地渲染：`bun scripts/homebrew-formula.ts --version 0.7.2 --sums <SHA256SUMS> --out /tmp/tabcap.rb && brew style /tmp/tabcap.rb`。
