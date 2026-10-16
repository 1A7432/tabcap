# src/server — 回显服务器的 TCP/TLS 层

`listener.zig` + `tls_openssl.zig` 负责 accept → MSG_PEEK 首个 TLS record → OpenSSL 握手 → 把连接交给回调。
HTTP/2 不在这里：回调（CLI 里）用 `h2_conn.zig` 读写，`report.zig` 生成 JSON。机制在独立的 OpenSSL PoC 里验证过。

## 每个连接的流程（单线程，一次处理一个连接）

1. `server.accept(io)`（`std.Io.net`），拿 `stream.socket.handle` 作为 fd。
2. `peekFirstRecordTimeout`：`recvfrom(fd, MSG_PEEK | MSG_DONTWAIT)` 轮询。先看 5 字节头，按 `5 + length` 再 peek，
   直到这些字节全部可见；每轮之间睡 1 ms，总时长受 `peek_timeout_ms`（默认 5 s）限制。不用 `MSG_WAITALL`，因为它没有超时。
   ClientHello 被拆成两个 TCP segment 时也能拿全（实测 splitproxy 100+219 字节、间隔 0.3 s：242 次 peek）。
3. `capture_dir` 非空时，把 record 写到 `<dir>/clienthello-<seq>.bin`。
4. 给 socket 设 `SO_RCVTIMEO` / `SO_SNDTIMEO`（`io_timeout_ms`，默认 10 s），避免卡住的客户端拖住整个循环。
5. `tls_openssl.Connection.accept`：`SSL_new` → `SSL_set_fd` → `SSL_accept`。这一步 OpenSSL 从同一个 fd 读到的仍是完整的 ClientHello，因为 peek 没有消费数据。
6. `handler.onConnection(ctx, *ConnectionInfo)`。
7. `SSL_shutdown`（发 close_notify）→ `SSL_free` → `shutdown(SHUT_WR)` → 把客户端还在发的数据读掉丢弃，
   最多等 `close_drain_ms`（默认 1 s），然后 close。
   这样做的原因：socket 里还有没读的数据时直接 close 会发 RST，客户端可能来不及读我们的响应。

每一步失败都只打日志，然后处理下一个连接，`serve` 不会因此退出。`serve` 只在三种情况下返回：到达 `max_connections`、`error.Canceled`、监听 socket 坏掉。

## 对外契约（给 h2_conn / CLI）

```zig
pub fn serve(io: std.Io, gpa: std.mem.Allocator, opts: Options, handler: Handler) !void

pub const Handler = struct {
    ctx: *anyopaque,
    onConnection: *const fn (ctx: *anyopaque, conn: *ConnectionInfo) anyerror!void,
};

pub const ConnectionInfo = struct {
    seq: u64,                               // 从 1 开始；失败的连接也占号，和 clienthello-<seq>.bin 对应
    peer: std.Io.net.IpAddress,
    record: []const u8,                     // MSG_PEEK 到的完整首个 record（5 字节头 + fragment）
    tls: tls_openssl.Connection,            // 已握手成功
    handshake: tls_openssl.HandshakeInfo,
    capture_dir: ?[]const u8,
    pub fn readExact(self, buf) tls_openssl.Error!void
    pub fn writeAll(self, bytes) tls_openssl.Error!void
    pub fn readExactErased(ctx: *anyopaque, buf: []u8) anyerror!void          // ctx = *ConnectionInfo
    pub fn writeAllErased(ctx: *anyopaque, bytes: []const u8) anyerror!void
};
```

- **生命周期**：`ConnectionInfo` 里的所有切片，以及 `tls` 本身，都只在 `onConnection` 调用期间有效。handler 返回后，listener 负责关闭 TLS 和 socket。handler 不要自己调 `tls.close()`。
- **接 h2_conn**：`h2_conn.Io{ .ctx = conn, .readExact = listener.ConnectionInfo.readExactErased, .writeAll = listener.ConnectionInfo.writeAllErased }`。
  listener 不 import h2_conn，所以两边的签名可以各自演进。
- **读写错误**：`error.EndOfStream` 表示对端关了连接（close_notify，或没发 close_notify 的 TCP EOF）；`error.Timeout` 表示 `SO_RCVTIMEO` 到期；
  `error.Read` / `error.Write` 是其他错误，细节已经写进日志。
- **`HandshakeInfo`**：`version`、`cipher`（OpenSSL 的命名）、`alpn`（客户端没发 ALPN 时为 null，ALPN 回调只选 `h2`，没有交集就发 fatal alert 120）、
  `session_reused`、`sni`、`openssl_extension_order`，以及 `hello_retry`（出现 HRR 时为 true）。
  `openssl_extension_order` 是 `SSL_client_hello_get_extension_order` 的结果：只包含 OpenSSL 认识的扩展，**不含 GREASE**，是 ClientHello 解析器的第二个 oracle。遇到 HRR 时，它记录的是第一个 ClientHello，也就是被 peek 的那个。
- 日志中的十六进制一律用 4 位小写、不带前缀（例如 `openssl_ext_order=[ff01,0000,...]`）。

## `-Dopenssl=false`

`tls_openssl` 的所有函数都返回 `error.NotEnabled`（`info()` 返回空值），`serve` 也返回 `error.NotEnabled`。
`peekFirstRecord` / `wantLenFromHeader` 用 `std.posix.system`，不依赖 libc，照样可用（交叉编译 `x86_64-linux-musl` 的测试能通过编译）。

## 验证

- `zig build test`：用 fixture 检查 record 长度（oracle = PoC 用 MSG_PEEK 抓的文件大小）、检查 RFC 8446 §5.1 的边界，
  再在 AF_UNIX socketpair 上测 peek 的各条路径：不消费数据、EOF、非 TLS、超时、半个 record 后对端关闭、缓冲区不够。
- `tools/serve-smoke.sh`（只连 localhost，端口 8447）：它用 `zig build-exe` 编 `tools/serve_smoke.zig`，所以不需要改 build.zig。
  然后依次跑 5 个客户端：curl h2、明文 HTTP、只带 http/1.1 ALPN 的 curl、`s_client -sess_out`、`s_client -sess_in`，
  再逐条检查日志、退出码和 capture 文件大小。curl h2 以 exit 16 结束属于预期，因为 smoke 不回 h2 响应。

## 已知限制 / 待办

- 只取**首个 record**。如果 ClientHello 跨多个 record，需要 `tls.record.firstHandshakeMessage` 接着处理；
  `wantLenFromHeader` 等 `tls.record.recordLen` 实现后可以直接换掉。
- 对端发了半个 record 就关连接时，MSG_PEEK 会一直报告那些没读的字节，不会返回 0，所以这种情况最后报的是 `Timeout`，不是 `EndOfStream`。
- 单线程串行。浏览器并发开的第二条连接要排队等前一条关闭（最坏情况是等 `io_timeout_ms` 到期）。
- SIGPIPE：`std.process.Init` 的 `std.Io.Threaded` 给 SIGPIPE 装了空处理器，所以写已关闭的 socket 会得到 EPIPE，进程不会被杀。
  如果嵌入到不走 `std.process.Init` 的程序里，需要自己处理 SIGPIPE。
