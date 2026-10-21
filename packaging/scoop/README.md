# Scoop

`tabcap.json` 是**最近一次已发布** release 的 Scoop 清单：`version` 和 `architecture.64bit` 里 windows-x64 zip 的 `url`、`hash`、`extract_dir` 都来自同一次发布的 `SHA256SUMS`，其余字段（`description`、`bin`、`checkver`、`autoupdate` 等）原样保留。还没有 bucket。

**自动更新（2026-10-21 起）**：`.github/workflows/homebrew.yml` 的 `scoop` job 在 GitHub Release **发布**时运行（与推 tap 的 `formula` job 并列）：检出 `main`，下载该 release 的 `SHA256SUMS`，用 `scripts/scoop-manifest.ts` 渲染 `packaging/scoop/tabcap.json`；与 `main` 上的文件相同就什么都不做，不同就以 `[skip ci]` 提交并用 `GITHUB_TOKEN` 推到 `main`（job 权限 `contents: write`）。推送被拒（分支保护，或检出后 `main` 又动了）时，把同一个提交推到 `scoop-<版本>` 分支并 `gh pr create`；用 `GITHUB_TOKEN` 开 PR 要在仓库 Settings → Actions → General 勾「Allow GitHub Actions to create and approve pull requests」（2026-10-21 查过是关的，`main` 也没有分支保护，所以正常走推送这条路），开不成时 job 失败并打印手动开 PR 的命令。`GITHUB_TOKEN` 触发的推送和 PR 都不会再触发工作流，这个提交只改清单。

**发版时不用管它**：release 提交不改 `tabcap.json`（版本号只改 `package.json` 与 `packaging/npm/**/package.json`）。所以 release 提交到 Release 发布之间，清单仍是上一个版本——它自己的 `version`、`url`、`hash` 始终是同一次发布的；`test/unit/packaging.test.ts` 只要求它不比 `package.json` 新。以前每次发版后手工补 hash 的跟进 PR 不再需要。

**重跑与旧 tag**：Actions → homebrew → Run workflow 填 tag（例如 `v0.8.1`），或 `gh workflow run homebrew.yml -f tag=v0.8.1`。比 `main` 上清单旧的版本，脚本一个字也不写（`the Scoop manifest already has …, newer than …: nothing written`），所以重跑旧 tag 不会把 `main` 退回去。

本地渲染：

```sh
gh release download v0.8.1 --repo 1A7432/tabcap --pattern SHA256SUMS --dir /tmp/sums
bun scripts/scoop-manifest.ts --version 0.8.1 --sums /tmp/sums/SHA256SUMS            # 打到 stdout
bun scripts/scoop-manifest.ts --version 0.8.1 --sums /tmp/sums/SHA256SUMS --out packaging/scoop/tabcap.json
```

【实测 2026-10-21】用 v0.8.1 真实的 `SHA256SUMS` 渲染，结果与 PR #29 手工补的清单逐字节相同。
