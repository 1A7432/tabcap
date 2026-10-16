# fixtures/hpack — RFC 7541 附录 C 头块

HPACK 解码器（`src/h2/hpack.zig`）的测试输入与期望值。所有字节、头名/值、动态表条目与 size **都由脚本从 RFC 7541 原文解析得到**，没有手抄、没有推理出来的值。**以 RFC 原文为准**；若本目录与 RFC 不一致，错的是本目录。

## 数据来源

| 项 | 值 |
|---|---|
| 原文 | https://www.rfc-editor.org/rfc/rfc7541.txt |
| sha256 | `2239d7f8fb839b69ae2e928e685559b11376888269f131512197a0e3bacf7f7a` |
| 字节数 / 行数 | 117827 / 3083 |
| 下载日期 | 2026-09-23（UTC 07:57） |
| 勘误 | https://www.rfc-editor.org/errata/rfc7541 （2026-09-23 查询，状态筛选 All）：共 2 条，均为 Held for Document Update——4574（Appendix A：静态表并未排序）、5094（§5.1 措辞）。**没有涉及附录 B、C 的勘误。** |

同一份原文还生成了 `spec/hpack-huffman.json`（附录 B，257 项 Huffman 码表，含 EOS）。

## 文件清单

| section | 文件 | title | 头块字节数 | `headers` 条数 | `huffman` | `dynamic_table_max_size` | `continues_from` | 动态表条目数 | `dynamic_table_after.size` |
|---|---|---|---|---|---|---|---|---|---|
| C.2.1 | `c2_1.hex` / `.json` | Literal Header Field with Indexing | 26 | 1 | false | 4096 | `null` | 1 | 55 |
| C.2.2 | `c2_2.hex` / `.json` | Literal Header Field without Indexing | 14 | 1 | false | 4096 | `null` | 0 | 0 |
| C.2.3 | `c2_3.hex` / `.json` | Literal Header Field Never Indexed | 17 | 1 | false | 4096 | `null` | 0 | 0 |
| C.2.4 | `c2_4.hex` / `.json` | Indexed Header Field | 1 | 1 | false | 4096 | `null` | 0 | 0 |
| C.3.1 | `c3_1.hex` / `.json` | First Request | 20 | 4 | false | 4096 | `null` | 1 | 57 |
| C.3.2 | `c3_2.hex` / `.json` | Second Request | 14 | 5 | false | 4096 | `C.3.1` | 2 | 110 |
| C.3.3 | `c3_3.hex` / `.json` | Third Request | 29 | 5 | false | 4096 | `C.3.2` | 3 | 164 |
| C.4.1 | `c4_1.hex` / `.json` | First Request | 17 | 4 | true | 4096 | `null` | 1 | 57 |
| C.4.2 | `c4_2.hex` / `.json` | Second Request | 12 | 5 | true | 4096 | `C.4.1` | 2 | 110 |
| C.4.3 | `c4_3.hex` / `.json` | Third Request | 24 | 5 | true | 4096 | `C.4.2` | 3 | 164 |
| C.5.1 | `c5_1.hex` / `.json` | First Response | 70 | 4 | false | 256 | `null` | 4 | 222 |
| C.5.2 | `c5_2.hex` / `.json` | Second Response | 8 | 4 | false | 256 | `C.5.1` | 4 | 222 |
| C.5.3 | `c5_3.hex` / `.json` | Third Response | 98 | 6 | false | 256 | `C.5.2` | 3 | 215 |
| C.6.1 | `c6_1.hex` / `.json` | First Response | 54 | 4 | true | 256 | `null` | 4 | 222 |
| C.6.2 | `c6_2.hex` / `.json` | Second Response | 8 | 4 | true | 256 | `C.6.1` | 4 | 222 |
| C.6.3 | `c6_3.hex` / `.json` | Third Response | 79 | 6 | true | 256 | `C.6.2` | 3 | 215 |

## 生成方式

脚本是一次性的，**不进仓库**：

- `gen_fixtures.py`：只读取 RFC 印出的内容（dump、header list、动态表），不含任何 HPACK 解码逻辑。
- `check_fixtures.py`：校验。其中有一个**仅供校验**的 HPACK 解码器（整数、字符串、Huffman、动态表），它不进仓库（解码器只有 `src/h2/hpack.zig` 一份）。
- `gen_huffman.py` / `check_huffman.py`：生成与校验 `spec/hpack-huffman.json`。

解析规则（`gen_fixtures.py`）：

1. 先剔除分页伪行：页脚 `Peon & Ruellan  Standards Track  [Page N]`、换页符 `\f`、页眉 `RFC 7541  HPACK  May 2015`。本次所用的 hex dump、header list、动态表段落都没有被分页切开（分页只落在若干 `Decoding process` 段里，该段只用来读 Huffman 标记）。
2. 用例边界：顶格的 `C.x.y.  <Title>` 行到下一个顶格行。`title` 取标题行里小节号之后的文字。
3. `.hex`：`Hex dump of encoded data:` 与 `Decoding process:` 之间的 dump 行，取 `|` 左侧的十六进制分组，去空白后按行拼接。`|` 右侧的 ASCII 栏只用于校验。
4. `headers`：取 `Decoded header list:` 段。每行去掉 3 格缩进，从第 2 个字符起找第一个 `": "`，拆成名和值（这样伪头的前导 `:` 不会被误拆；`date` 值里的 `20:13:21` 不含 `": "`）。生成时要求它与同一用例的 `Header list to encode:` 段逐条相同。
5. `dynamic_table_after`：取 `Dynamic Table (after decoding):` 段，每项形如 `[  n] (s =  S) name: value`。
   - `index = 61 + n`：RFC 印的是动态表内的位置 `[1]`、`[2]`…；在 HPACK 统一索引空间里动态表排在 61 项静态表之后（RFC 7541 §2.3.3）。
   - 每项 `size` 与表的 `size` 分别用 RFC 印出的 `s = S` 和 `Table size:`，**不是自己算的**。
   - C.2.2、C.2.3、C.2.4 印的是 `Dynamic table (after decoding): empty.`，记为 `"entries": []`、`"size": 0`。
   - **折行**：C.5.3 与 C.6.3 的 `[  1]`（set-cookie）在 RFC 里折成两行（`…QWEOIU;` / `max-age=3600; version=1`），按"去掉续行缩进、用一个空格拼接"还原。还原结果与 header list 中的值逐字相同，32 + 10 + 56 = 98 也与 RFC 印出的 `s =  98` 一致。
6. `huffman`：该用例 `Decoding process` 段里出现 RFC 自己的 `Huffman encoded:` 标记即为 `true`；同时要求它与分组标题（"Request/Response Examples with/without Huffman Coding"）一致。
7. `dynamic_table_max_size`：C.5、C.6 的分组引言原文 "SETTINGS_HEADER_TABLE_SIZE is set to the value of 256 octets" → `256`。C.2–C.4 的 RFC 7541 原文**没有写**表大小，取 HTTP/2 的初始值 `4096`（RFC 9113 §6.5.2："The initial value is 4,096 octets."）。
8. `continues_from`：C.3、C.5 的引言写 "several consecutive header lists … on the same connection"；C.4、C.6 的引言写 "the same examples as the previous section"（连续性与前一组相同）；C.2 的引言写 "several independent representation examples" → 全部 `null`。

## 文件格式

### `c<x>_<y>.hex`

头块的原始字节，十六进制：小写、无前缀、无空白、单行，**末尾有一个 `\n`**。

### `c<x>_<y>.json`

| 字段 | 含义 |
|---|---|
| `rfc` | 固定 `"7541"` |
| `section` | RFC 小节号，如 `"C.3.1"` |
| `title` | RFC 小节标题原文 |
| `huffman` | 该头块里的字符串字面量是否用 Huffman 编码 |
| `dynamic_table_max_size` | 解这条连接之前，动态表的最大 size（octets） |
| `continues_from` | 见下节 |
| `hex_file` | 对应的 `.hex` 文件名 |
| `headers` | 期望的解码结果：`[name, value]` 数组，保持 RFC 顺序，名值都是 RFC 原文 |
| `dynamic_table_after.entries` | 解完这个头块之后的动态表，按 RFC 列出的顺序（`[1]` 在前）；`index` 是统一索引空间里的编号（从 62 起），`name`/`value` 为 RFC 原文，`size` 为 RFC 印出的条目 size |
| `dynamic_table_after.size` | RFC 印出的 `Table size` |

### `continues_from` 的语义

- `null`：用一张**全新的空动态表**解这个头块。
- `"C.3.1"` 之类：必须在解完 C.3.1 之后的**同一张动态表**上继续解。C.3、C.4、C.5、C.6 各是同一连接上的三个连续头块，解码器要依次解 x.1 → x.2 → x.3，不能单独拿 x.2 或 x.3 用空表解（RFC 的 Decoding process 里 C.3.2 就引用了 `idx = 62`）。
- C.4 与 C.3、C.6 与 C.5 各自从空表开始：C.4.1、C.6.1 的 `continues_from` 都是 `null`（RFC 印出的 C.4.1 动态表只有 1 项、size 57，与 C.3.1 相同）。
- C.2.x 各自独立。

## 用法建议

- `@embedFile` 的路径相对于当前源文件，且不能跳出所在 module 的根目录。【实测，Zig 0.16.0，在 /tmp 的临时工程里】`src/h2/t.zig` 里写 `@embedFile("../../fixtures/hpack/c3_1.hex")` 编译报错 `embed of file outside package path`；把一个根文件放在 `fixtures/` 目录、在 `build.zig` 里建成独立 module，在那个文件里写 `@embedFile("hpack/c3_1.hex")`，测试再 `@import` 该 module，可以通过。具体怎么组织由作者决定。
- 读 `.hex` 后先去掉末尾的 `\n`，再两位一组转成字节。
- C.5 / C.6：解 x.1 之前先把动态表最大 size 设为 256。RFC 的场景是连接上的 `SETTINGS_HEADER_TABLE_SIZE = 256`；RFC 的 Decoding process 里 C.5.1、C.6.1 的第一条就是 `== Literal indexed ==`，头块里没有动态表大小更新。C.2–C.4 用 4096。
- C.4 / C.6 需要 Huffman 解码；码表在 `spec/hpack-huffman.json`（`tools/gen_huffman_table.py` 从它生成 `src/h2/huffman_table.zig`）。
- 人工抽查 RFC 原文：`check_fixtures.py` 会按用例逐字列出 header list、hex dump、动态表段落（带 RFC 行号），需要时重跑生成。

## 校验记录（2026-09-23）

`check_huffman.py`（对 `spec/hpack-huffman.json`）：全部 PASS。

- a. 恰好 257 项，sym 0..256 各一次、递增；只有 sym 256 带 `eos: true`。
- b. 每项 `int(code_bits, 2) == int(code_hex, 16)` 且 `len(code_bits) == bit_length`。
- c. `bit_length` 最小 5、最大 30。
- d. 257 × 256 个有序对两两检查，没有任何码字是另一个的前缀。
- e. Kraft 和（`fractions.Fraction` 精确计算）：含 EOS 的 257 项 **恰好等于 1**；不含 EOS 为 1 − 2⁻³⁰。
- f. 另一种解析方式交叉核对：只取每行末尾的 `hex  [len]` 两列与 `(sym)`，扫描**整份** RFC，找到 257 行（原文第 1497–1801 行），与 JSON 逐项一致；再把 `code_bits` 每 8 位插回 `|`，在对应 RFC 行里逐字找到原 bit 列；95 行带 ASCII 标签，标签字符都等于 `chr(sym)`。
- 附带信息（非门槛）：按 (长度, sym) 排序做 canonical Huffman 重建，与 RFC 的 257 个码字完全一致；EOS 为 30 个 1。

`check_fixtures.py`（对本目录）：全部 PASS。

- a. 16 个 `.hex`：单行、末尾 `\n`、偶数长度、只含 `[0-9a-f]`；另用独立定位方式从 RFC 原文重新抽取 dump，与 `.hex` 逐字节相同；39 行 dump 的 ASCII 栏与字节逐一吻合。
- b. 用 `spec/hpack-huffman.json` 做 Huffman 解码（仅校验用）：C.4.x、C.6.x 共 12 个 Huffman 字符串字面量全部解出，填充位都 ≤ 7 位且全为 1；C.4.x 解出的头列表与 C.3.x 的 `headers` 完全相同，C.6.x 与 C.5.x 完全相同。另外 16 个头块全部按 `continues_from` 链解码，解出的头列表与每个 JSON 的 `headers` 相同，解码后的动态表（顺序、名、值、条目 size、总 size）与 `dynamic_table_after` 相同。
- c. 35 个动态表条目：RFC 印出的 size 都等于 32 + name 长度 + value 长度（RFC 7541 §4.1）；各表条目 size 之和都等于 RFC 印出的 `Table size`，且不超过 `dynamic_table_max_size`；**没有不一致**。
- d. RFC 原文对应段落已逐字导出核对（481 行）。
- 变异测试：把 `c6_3.hex` 的最后一个字节改掉、把 `c5_1.json` 一个条目的 size 改成 64，校验脚本报出 7 项 FAIL（在 /tmp 副本上做，仓库文件未动）——说明这些检查会真的失败。

## 许可证说明

RFC 文本受 IETF Trust 法律条款约束：https://trustee.ietf.org/documents/trust-legal-provisions/ 。RFC 7541 自身的版权声明（原文第 37–48 行）：

> Copyright (c) 2015 IETF Trust and the persons identified as the document authors.  All rights reserved.
>
> This document is subject to BCP 78 and the IETF Trust's Legal Provisions Relating to IETF Documents (http://trustee.ietf.org/license-info) in effect on the date of publication of this document. … Code Components extracted from this document must include Simplified BSD License text as described in Section 4.e of the Trust Legal Provisions and are provided without warranty as described in the Simplified BSD License.

本目录的 `.hex` / `.json` 与 `spec/hpack-huffman.json` 是从 RFC 7541 附录 B、C 摘录的码表与示例，作为事实数据使用，每个文件都注明了来源小节。附录内容是否属于上文所说的 "Code Components"，这里不做判断。**以 RFC 原文为准。**

## 与仓库其他文件的关系

- `spec/test-vectors.json` 里的 `hpack_integer`（C.1）与 `hpack_static_table_spot_checks`（附录 A）不在本目录；本目录只收 C.2–C.6。
