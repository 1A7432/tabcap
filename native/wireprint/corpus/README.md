# corpus

浏览器画像语料（格式见 `spec/profile-schema.md`）。画像只从 tabcap 集成发布的 Chrome for Testing 版本采集，每个 os-arch 一份，由 tabcap 自己采集（`tabcap wire profile`，0.4-W2 起），启动参数是 tabcap 的生产参数（画像的 `tabcap.flags` / `tabcap.flagsSha256`）；其它来源一律不收（个人浏览器、手工抓包、第三方站点流量、文章或其它项目里的数值）。

| 文件 | 采集 |
|---|---|
| `chrome/155/macos-arm64/155.0.8059.79.json` | 2026-10-16，macOS arm64，`tabcap wire profile --samples 3`（`browser start --proxy none`），3 次导航 + 3 次页面 fetch，全是首次连接（echo 不发会话票据） |

Linux / Windows 的从 CI e2e 作业上传的 `wire-profile-<os>` 产物补。`accept-language` 等头的值随采集机器的语言设置而变，以采集为准。
