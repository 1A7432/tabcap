# 指纹字符串规范格式

> 本文件是实现时的速查卡。规范说明见仓库 `docs/11`；边界规则以各自官方原文为准。机器可读的向量在 `test-vectors.json`。

## JA3

```
<legacy_version>,<ciphers>,<extensions>,<supported_groups>,<ec_point_formats>
```
- 全部十进制；列表内 `-` 分隔；字段间 `,`；缺失字段为空但保留逗号。
- 去 GREASE；保持原始顺序。
- 哈希：MD5，32 位小写十六进制。

## JA4

```
<a>_<b>_<c>
a = <proto:1><version:2><sni:1><ciphers:2><extensions:2><alpn:2>
b = sha256(sorted ciphers, "," joined)[:12]
c = sha256(sorted extensions minus 0000/0010, "," joined, + "_" + sig_algs original order "," joined)[:12]
```
- proto: `t` | `q` | `d`
- version: 来自 supported_versions 最高非 GREASE 值；无该扩展则 legacy_version。`13 12 11 10 s3 s2 d1 d2 d3 00`
- sni: `d` 有 | `i` 无
- 计数：两位十进制补零，>99 → `99`；去 GREASE；SCSV/保留值计入；**extension 计数包含 SNI 与 ALPN**
- alpn: 首 ALPN 值的首末字符；无 → `00`；单字符重复；非字母数字走十六进制规则
- 空列表 → `000000000000`
- 变体：`_r`（不哈希）、`_o`（原始顺序，含 0000/0010）、`_ro`

## Akamai HTTP/2

```
<S>|<WU>|<P>|<PS>
S  = id:value;id:value;...     SETTINGS 帧内原始顺序
WU = window_update increment   无 → 00
P  = streamid:exclusive:dep:weight,...   无 → 0
PS = 伪头顺序 m,a,s,p 的排列
```
- 只取连接前言之后、第一个请求 HEADERS（含 CONTINUATION）结束之前的帧。
- weight 是帧内字节值 +1。

## 十六进制约定

- 所有 u16 写成 4 位小写，无前缀：`0x001d` → `001d`。
- 哈希输出小写。
- 排序 = 按数值排序（等价于按 4 位十六进制字符串排序）。
