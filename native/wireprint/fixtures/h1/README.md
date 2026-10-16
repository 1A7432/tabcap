# fixtures/h1

HTTP/1.1 请求头（request-line + field lines + 空行），`src/h1.zig` 与 `report --h1` 的测试输入。

| 文件 | 来源 |
|---|---|
| `get-basic.bin` | 手写（0.4-W2），按 RFC 9112 §2.1 / §3 / §5.1 的语法写成，形状仿 httpx 的 h1 请求：大小写混合的头名、`User-Agent: python-httpx/0.28.1`、一个合成的 `Cookie`（值 `sid=synthetic`，用来验证报告只写头名、不写 Cookie 值） |

oracle 就是文件本身的字节：期望值（方法、目标、版本、头名顺序与值）直接读自这份按 RFC 语法手写的输入，不来自解析器。
