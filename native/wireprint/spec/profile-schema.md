# 画像（profile）记录格式

> 语料库中每个 JSON 文件的结构。字段名用 snake_case。所有十六进制值小写、无 `0x` 前缀、定宽（u16 为 4 位）。
> 原则：**哈希与原始列表同时存**——哈希用于匹配，原始列表用于 diff 与解释。

```jsonc
{
  "schema_version": 1,
  "id": "chrome/140/macos-arm64/140.0.7339.80",

  "subject": {
    "kind": "browser",                 // browser | library | tool
    "name": "chrome",                  // chrome | firefox | safari | edge | curl | python-requests | go-net-http | curl_cffi | wreq | utls ...
    "version": "140.0.7339.80",        // 精确版本；库写包版本
    "channel": "stable",               // stable | beta | dev | canary | null
    "claims": null                     // 伪装库填它声称模仿的画像 id，如 "chrome/140/macos-arm64"
  },

  "platform": {
    "os": "macos",                     // macos | windows | linux | android | ios
    "os_version": "15.6",
    "arch": "arm64",                   // arm64 | x64
    "headless": false
  },

  "capture": {
    "captured_at": "2026-09-20T14:03:11+08:00",
    "method": "playwright-chrome-channel",  // playwright-* | manual | script
    "server": "tabcap-wire-echo 0.4.0",  // 采集端：TLS 由谁终结（tabcap 的 Bun echo）；wireprint report 拼成报告
    "server_host_os": "macos",         // 服务器所在 OS，解释 TCP 层的观察环境
    "connection": "first",             // first | resumed
    "samples": 5,                      // 对同一配置采样次数（Chrome 乱序需要多次）
    "raw_dir": "140.0.7339.80.samples/" // 原始字节所在目录
  },

  "tls": {
    "ja3": { "string": "771,4865-4866-...,0-23-...,29-23-24,0", "hash": "cd08e31494f9531f560d64c695473da9", "stable_across_samples": false },
    "ja4": {
      "fingerprint": "t13d1516h2_8daaf6152771_e5627efa2ab1",
      "raw": "t13d1516h2_002f,0035,...",
      "original": "t13d1516h2_acb858a92679_18f69afefd3d",
      "raw_original": "t13d1516h2_1301,1302,...",
      "stable_across_samples": true
    },
    "client_hello": {
      "record_legacy_version": "0303",
      "legacy_version": "0303",
      "session_id_length": 32,
      "cipher_suites": ["1301", "1302", "1303", "c02b", "c02f", "c02c", "c030", "cca9", "cca8", "c013", "c014", "009c", "009d", "002f", "0035"],
      "cipher_grease_positions": [0],
      "extensions_order_samples": [
        ["001b", "0000", "0033", "0010", "4469", "0017", "002d", "000d", "0005", "0023", "0012", "002b", "ff01", "000b", "000a", "0015"],
        ["0000", "0033", "001b", "..."]
      ],
      "extensions_sorted": ["0000", "0005", "000a", "000b", "000d", "0010", "0012", "0015", "0017", "001b", "0023", "002b", "002d", "0033", "4469", "ff01"],
      "extension_order": "randomized",   // randomized | fixed | unknown（判断用的首连样本少于 2 个）
      "extension_order_samples_judged": 3,
      "extension_order_randomized": true, // 同上的布尔版，unknown 时为 null
      "extension_grease_positions": [0, 15],
      "supported_versions": ["0304", "0303"],
      "supported_groups": ["11ec", "001d", "0017", "0018"],
      "key_share_groups": ["11ec", "001d"],
      "signature_algorithms": ["0403", "0804", "0401", "0503", "0805", "0501", "0806", "0601"],
      "ec_point_formats": ["00"],
      "alpn": ["h2", "http/1.1"],
      "sni_present": true,
      "psk_present": false,
      "ech_present": true,               // GREASE ECH 也算 present；真 ECH 另标
      "ech_kind": "grease",              // grease | real | null
      "alps_codepoint": "4469",          // 4469 | 44cd | null
      "padding_length": 187,
      "total_length": 1772,
      "tcp_segments": 2
    }
  },

  "http2": {
    "akamai": "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
    "settings": [["1", 65536], ["2", 0], ["4", 6291456], ["6", 262144]],   // 有序
    "window_update": 15663105,
    "priority_frames": [],                                                 // [[stream, exclusive, dep, weight], ...]
    "pseudo_header_order": ["m", "a", "s", "p"],
    "sends_priority_header": true,
    "no_rfc7540_priorities": null                                          // SETTINGS 0x9 的值，未发为 null
  },

  "http": {
    "method": "GET",
    "version": "2",
    "headers_order": ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language", "priority"],
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "client_hints": {
      "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"macOS\"",
      "sec-ch-ua-full-version-list": null   // 需要 Accept-CH 才会给
    },
    "accept": "text/html,application/xhtml+xml,...",
    "accept_encoding": "gzip, deflate, br, zstd",
    "accept_language": "zh-CN,zh;q=0.9,en;q=0.8",
    "roles": {                            // 每种请求角色一份头顺序（报告顶层的 role，否则 navigate→navigation、其它→other）
      "navigation": { "samples": 3, "method": "GET", "headers_order": ["sec-ch-ua", "..."], "headers_order_stable_across_samples": true,
                      "accept": "text/html,...", "sec_fetch_site": "none", "sec_fetch_mode": "navigate", "sec_fetch_dest": "document" },
      "fetch":      { "samples": 3, "method": "GET", "headers_order": ["sec-ch-ua-platform", "..."], "headers_order_stable_across_samples": true,
                      "accept": "*/*", "sec_fetch_site": "same-origin", "sec_fetch_mode": "cors", "sec_fetch_dest": "empty" }
    }
  },

  "tcp": {
    "window_size": 65535,
    "options": [2, 1, 3, 1, 1, 8, 4, 0],
    "mss": 1460,
    "window_scale": 6,
    "ttl_observed": 64,
    "source": "libpcap"                   // libpcap | tcp_saved_syn | null
  },

  "session": {
    "resumption_observed": true,          // 第二次连接是否带 pre_shared_key
    "resumed_ja4": "t13d1716h2_8daaf6152771_...",
    "connections_per_page_load": 1
  },

  "notes": ""
}
```

## 约束

- `id` 与文件路径一致：`corpus/<name>/<major>/<os>-<arch>/<version>.json`。
- 所有 `*_order` / `*_samples` 字段保持原始顺序；所有 `*_sorted` 字段升序。
- 采集不到的字段填 `null`，不要省略键，让 diff 能区分"没采"和"没有"。
- 不存 Cookie 值、不存 Authorization 等敏感头的值；`headers_order` 只有名字。
- 伪装库的画像 `subject.kind = "library"`，`subject.claims` 指向它模仿的真画像，diff 就是逼真度报告。
- `extension_order` 为 `unknown` 时（参与判断的首连样本少于 2 个），`check` 不判 T4（只给一条 info）。
- tabcap 采集的画像（`tabcap wire profile`）在顶层另有 `tabcap` 段：CfT 版本、启动参数（本机路径换成 `<profile>` 这类记号）与其 sha256、各角色样本数；`corpus/` 只收这种画像（见 `corpus/README.md`）。
