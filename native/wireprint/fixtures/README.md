# fixtures

嵌入式测试输入（`root.zig` 用 `@embedFile` 建成 `fixtures` module）与 oracle 给出的期望值。

```
clienthello/   真实浏览器的首个 TLS record（.bin）+ tools/openssl_oracle.c 的原样输出（.expected.json）
h2/            真实浏览器的 HTTP/2 客户端流（前言 + 首批帧）；`cft-155-macos-*` 是 0.4-W2 spike 里 CfT 155 的解密流
h1/            手写的 HTTP/1.1 请求头（RFC 9112 语法）
pcap/          tools/mkpcap.py 合成的 legacy pcap（文档地址段、本地管理 MAC）+ 生成器写进线上的值
hpack/         RFC 7541 附录 C 的头块与期望头列表 / 动态表
```

- 期望值只来自 oracle，不手改；要更新就重跑对应的生成器或 oracle（各子目录 README 写了命令）。
- 不提交真实网卡抓的包（pcap 一律合成），不提交含 Cookie 或 Authorization 的 HTTP 请求。
