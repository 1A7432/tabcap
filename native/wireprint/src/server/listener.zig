//! Echo-server listener: std.Io.net listen/accept, MSG_PEEK the complete first TLS record from the raw fd
//! (without consuming it), hand the same fd to OpenSSL (tls_openssl.Connection.accept), then give the record,
//! the handshake summary and the TLS connection to a `Handler` callback. HTTP/2 is not spoken here: the
//! handler drives h2_conn.zig through `ConnectionInfo.readExact/writeAll`.
//!
//! Spec: RFC 8446 §5.1 (https://www.rfc-editor.org/rfc/rfc8446.txt): TLSPlaintext is type(1)
//! legacy_record_version(2) length(2) fragment; length MUST NOT exceed 2^14, and zero-length Handshake
//! fragments MUST NOT be sent.
//! Oracle: fixtures/clienthello/*.bin, each exactly one first record as MSG_PEEKed by the PoC and compared
//! byte for byte with `openssl s_client -msg`. Expected record length = file size.
//! Reproduce: `zig build test` (record-length and socketpair peek tests); tools/serve-smoke.sh against
//! localhost for the full accept -> peek -> handshake path.
//!
//! Verified mechanism: a standalone OpenSSL PoC server. Zig 0.16: std.posix has no recv();
//! the raw fd comes from Stream.socket.handle and is read with `std.posix.system.recvfrom` (== std.c when
//! libc is linked; the raw Linux syscall otherwise, so this file also builds with -Dopenssl=false).
//! The serving loop is single-threaded: one connection at a time, every per-connection failure is logged
//! and the loop moves on.
const std = @import("std");
pub const tls_openssl = @import("tls_openssl.zig");

const posix = std.posix;
const log = std.log.scoped(.listener);

pub const record_header_len = 5;
/// RFC 8446 §5.1: "The length MUST NOT exceed 2^14 bytes."
pub const max_fragment_len = 1 << 14;
/// Largest first record `peekFirstRecord` can return; size the peek buffer with this.
pub const max_record_len = record_header_len + max_fragment_len;
/// ContentType.handshake (RFC 8446 §5.1).
const content_type_handshake = 0x16;

pub const default_peek_timeout_ms = 5000;

pub const Options = struct {
    /// Bind address. Loopback by default; bind a routable address only on a host you own.
    host: []const u8 = "127.0.0.1",
    port: u16 = 8443,
    cert_path: [:0]const u8,
    key_path: [:0]const u8,
    /// Stop after N accepted connections (0 = forever); used by tests and scripts. Connections that fail
    /// (no TLS, handshake error) count too.
    max_connections: u32 = 0,
    /// Directory to write raw ClientHello records into as `<dir>/clienthello-<seq>.bin` (null = do not
    /// write). Created if missing. Also passed to the handler for its own dumps.
    capture_dir: ?[]const u8 = null,
    /// Total time allowed for the first record to become visible to MSG_PEEK.
    peek_timeout_ms: u32 = default_peek_timeout_ms,
    /// SO_RCVTIMEO / SO_SNDTIMEO on the accepted socket for the handshake and the handler's reads/writes, so
    /// a stalled client cannot wedge the single-threaded loop (0 = block forever).
    io_timeout_ms: u32 = 10_000,
    /// After close_notify + FIN, read and discard client bytes for up to this long (until the client
    /// closes). Closing a socket with unread data sends RST, which can make the client drop the response
    /// it has not read yet.
    close_drain_ms: u32 = 1000,
};

pub const PeekError = error{ EndOfStream, NotHandshake, Truncated, Malformed, Timeout, RecvFailed, Canceled };

/// Everything the listener knows about one connection whose TLS handshake succeeded. Passed by pointer to
/// `Handler.onConnection`; every slice (and `tls` itself) is valid only during that call. The listener
/// closes the TLS connection and the socket after the handler returns.
pub const ConnectionInfo = struct {
    /// 1-based sequence number of the accepted TCP connection (failed connections consume numbers too,
    /// so it matches `clienthello-<seq>.bin`).
    seq: u64,
    /// Remote address as reported by accept(2).
    peer: std.Io.net.IpAddress,
    /// The complete first TLS record (5-byte header + fragment) exactly as MSG_PEEKed before OpenSSL
    /// consumed it. Normally one whole ClientHello; parse with tls.record / tls.client_hello.
    record: []const u8,
    /// Handshake-complete TLS connection (OpenSSL owns the decryption state; do not touch the fd).
    tls: tls_openssl.Connection,
    /// Negotiated parameters; `openssl_extension_order` points into a listener-owned buffer.
    handshake: tls_openssl.HandshakeInfo,
    /// `Options.capture_dir`, for handlers that write their own dumps next to clienthello-<seq>.bin.
    capture_dir: ?[]const u8,

    pub fn readExact(self: *ConnectionInfo, buf: []u8) tls_openssl.Error!void {
        return self.tls.readExact(buf);
    }

    pub fn writeAll(self: *ConnectionInfo, bytes: []const u8) tls_openssl.Error!void {
        return self.tls.writeAll(bytes);
    }

    /// Type-erased `readExact` (ctx = *ConnectionInfo), shaped like the callbacks in h2_conn.Io.
    pub fn readExactErased(ctx: *anyopaque, buf: []u8) anyerror!void {
        const self: *ConnectionInfo = @ptrCast(@alignCast(ctx));
        return self.readExact(buf);
    }

    /// Type-erased `writeAll` (ctx = *ConnectionInfo), shaped like the callbacks in h2_conn.Io.
    pub fn writeAllErased(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *ConnectionInfo = @ptrCast(@alignCast(ctx));
        return self.writeAll(bytes);
    }
};

/// Called once per connection after a successful TLS handshake. An error is logged; it never stops `serve`.
pub const Handler = struct {
    ctx: *anyopaque,
    onConnection: *const fn (ctx: *anyopaque, conn: *ConnectionInfo) anyerror!void,
};

/// Total record size (5 + length) from a TLS record header, so the peek knows how much to wait for.
/// Same contract as tls.record.recordLen (still a stub; switch to it once it is implemented).
pub fn wantLenFromHeader(hdr: *const [record_header_len]u8) error{ NotHandshake, Malformed }!usize {
    if (hdr[0] != content_type_handshake) return error.NotHandshake;
    const len = std.mem.readInt(u16, hdr[3..5], .big);
    if (len == 0 or len > max_fragment_len) return error.Malformed;
    return record_header_len + @as(usize, len);
}

/// MSG_PEEKs exactly the first TLS record into `buf` without consuming it. Returns the record slice.
/// Waits at most `default_peek_timeout_ms`; `buf` should hold `max_record_len` bytes.
pub fn peekFirstRecord(io: std.Io, fd: posix.fd_t, buf: []u8) PeekError![]const u8 {
    return peekFirstRecordTimeout(io, fd, buf, default_peek_timeout_ms);
}

/// `peekFirstRecord` with an explicit total timeout.
///
/// Plain MSG_PEEK returns whatever is queued *now* and does not wait for more, so a ClientHello split across
/// TCP segments needs polling (measured: 246 rounds on macOS for a 0.3 s gap). MSG_PEEK|MSG_WAITALL
/// would block with no upper bound, so instead: MSG_PEEK|MSG_DONTWAIT, 1 ms sleeps, one overall deadline.
/// Errors: EndOfStream (peer closed before sending anything), NotHandshake (first byte is not 0x16),
/// Malformed (length 0 or > 2^14), Truncated (record larger than `buf`), Timeout (incomplete at the
/// deadline; also what a peer that sent a partial record and closed gets, because MSG_PEEK keeps
/// reporting the unread bytes instead of EOF), RecvFailed, Canceled.
pub fn peekFirstRecordTimeout(io: std.Io, fd: posix.fd_t, buf: []u8, timeout_ms: u32) PeekError![]const u8 {
    if (buf.len < record_header_len) return error.Truncated;
    const flags: u32 = posix.MSG.PEEK | posix.MSG.DONTWAIT;
    const start = std.Io.Clock.now(.awake, io);
    var want: usize = record_header_len;
    var header_seen = false;
    var calls: u32 = 0;
    var sleeps: u32 = 0;
    var last_got: usize = 0;

    while (true) {
        const rc = posix.system.recvfrom(fd, buf.ptr, want, flags, null, null);
        calls += 1;
        switch (posix.errno(rc)) {
            .SUCCESS => {
                const got: usize = @intCast(rc);
                if (got == 0) return error.EndOfStream;
                if (buf[0] != content_type_handshake) return error.NotHandshake;
                if (got != last_got) {
                    log.debug("peek: {d} bytes visible after {d} recv calls", .{ got, calls });
                    last_got = got;
                }
                if (!header_seen) {
                    if (got >= record_header_len) {
                        want = try wantLenFromHeader(buf[0..record_header_len]);
                        if (want > buf.len) return error.Truncated;
                        header_seen = true;
                        continue; // re-peek at once with the full size
                    }
                } else if (got >= want) {
                    log.debug("peek: complete record of {d} bytes ({d} recv calls, {d} sleeps)", .{ want, calls, sleeps });
                    return buf[0..want];
                }
            },
            .INTR => continue,
            .AGAIN => {}, // nothing queued yet (MSG_DONTWAIT)
            else => |e| {
                log.debug("peek: recv errno={t}", .{e});
                return error.RecvFailed;
            },
        }
        if (start.untilNow(io, .awake).toMilliseconds() >= timeout_ms) return error.Timeout;
        io.sleep(.fromMilliseconds(1), .awake) catch return error.Canceled;
        sleeps += 1;
    }
}

/// Accept loop. Binds `opts.host:opts.port`, then for every connection: MSG_PEEK the first record ->
/// optionally write it to `<capture_dir>/clienthello-<seq>.bin` -> OpenSSL handshake -> `handler` ->
/// close_notify + socket close. Returns after `max_connections` connections (never if 0), or on
/// cancellation / a broken listening socket. Per-connection failures are logged and skipped.
pub fn serve(io: std.Io, gpa: std.mem.Allocator, opts: Options, handler: Handler) !void {
    if (!tls_openssl.enabled) return error.NotEnabled;

    var ctx = try tls_openssl.Context.init(opts.cert_path, opts.key_path);
    defer ctx.deinit();

    const record_buf = try gpa.alloc(u8, max_record_len);
    defer gpa.free(record_buf);

    if (opts.capture_dir) |dir| {
        std.Io.Dir.cwd().createDirPath(io, dir) catch |err|
            log.warn("cannot create capture dir {s}: {t} (captures will fail)", .{ dir, err });
    }

    const addr = try std.Io.net.IpAddress.parse(opts.host, opts.port);
    var server = try addr.listen(io, .{ .reuse_address = true });
    defer server.deinit(io);
    log.info("listening on {f} (runtime {s}, ALPN h2 only)", .{ server.socket.address, tls_openssl.runtimeVersion() });

    var seq: u64 = 0;
    while (opts.max_connections == 0 or seq < opts.max_connections) {
        const stream = server.accept(io) catch |err| switch (err) {
            error.Canceled, error.SocketNotListening => return err,
            else => {
                log.err("accept failed: {t}", .{err});
                io.sleep(.fromMilliseconds(10), .awake) catch return error.Canceled;
                continue;
            },
        };
        seq += 1;
        const result = handleConnection(io, &ctx, opts, handler, stream, seq, record_buf);
        closeGracefully(io, stream, opts.close_drain_ms);
        log.info("#{d} closed", .{seq});
        try result; // only error.Canceled gets here
    }
    log.info("max_connections={d} reached; stopping", .{opts.max_connections});
}

fn handleConnection(
    io: std.Io,
    ctx: *tls_openssl.Context,
    opts: Options,
    handler: Handler,
    stream: std.Io.net.Stream,
    seq: u64,
    record_buf: []u8,
) error{Canceled}!void {
    const fd = stream.socket.handle;
    log.info("#{d} accepted from {f}", .{ seq, stream.socket.address });

    const record = peekFirstRecordTimeout(io, fd, record_buf, opts.peek_timeout_ms) catch |err| switch (err) {
        error.Canceled => return error.Canceled,
        else => {
            log.warn("#{d} no complete TLS record: {t}", .{ seq, err });
            return;
        },
    };
    // record.len >= 6 here: wantLenFromHeader rejects a zero-length fragment.
    log.info("#{d} first record: content_type={d} legacy_version={x:0>4} length={d} total={d} bytes, handshake msg_type={d}", .{
        seq,
        record[0],
        std.mem.readInt(u16, record[1..3], .big),
        std.mem.readInt(u16, record[3..5], .big),
        record.len,
        record[5],
    });
    if (opts.capture_dir) |dir| writeCapture(io, dir, seq, record);

    setIoTimeout(fd, opts.io_timeout_ms);

    var conn: ConnectionInfo = .{
        .seq = seq,
        .peer = stream.socket.address,
        .record = record,
        .tls = tls_openssl.Connection.accept(ctx, fd) catch |err| {
            log.warn("#{d} TLS handshake failed: {t}", .{ seq, err });
            return;
        },
        .handshake = undefined,
        .capture_dir = opts.capture_dir,
    };
    defer conn.tls.close();

    var ext_buf: [tls_openssl.max_extension_order]u16 = undefined;
    conn.handshake = conn.tls.info(&ext_buf);
    const hs = conn.handshake;
    log.info("#{d} TLS ok: version={s} cipher={s} alpn={s} sni={s} session_reused={} hello_retry={} openssl_ext_order=[{f}]", .{
        seq,
        hs.version,
        hs.cipher,
        hs.alpn orelse "(none)",
        hs.sni orelse "(none)",
        hs.session_reused,
        hs.hello_retry,
        HexU16List{ .items = hs.openssl_extension_order },
    });

    handler.onConnection(handler.ctx, &conn) catch |err| {
        log.warn("#{d} handler failed: {t}", .{ seq, err });
    };
}

fn writeCapture(io: std.Io, dir: []const u8, seq: u64, record: []const u8) void {
    var path_buf: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/clienthello-{d}.bin", .{ dir, seq }) catch {
        log.warn("#{d} capture path too long", .{seq});
        return;
    };
    std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = record }) catch |err| {
        log.warn("#{d} write {s} failed: {t}", .{ seq, path, err });
        return;
    };
    log.info("#{d} wrote {s} ({d} bytes)", .{ seq, path, record.len });
}

/// Raw setsockopt: std.posix.setsockopt treats EINVAL as unreachable, and macOS returns EINVAL for a socket
/// the peer has already shut down. A failure here only loses the timeout, so it is logged and ignored.
fn setIoTimeout(fd: posix.fd_t, ms: u32) void {
    if (ms == 0) return;
    const tv: posix.timeval = .{ .sec = @intCast(ms / 1000), .usec = @intCast((ms % 1000) * 1000) };
    const opts = [_]struct { name: []const u8, opt: u32 }{
        .{ .name = "SO_RCVTIMEO", .opt = posix.SO.RCVTIMEO },
        .{ .name = "SO_SNDTIMEO", .opt = posix.SO.SNDTIMEO },
    };
    for (opts) |o| {
        const rc = posix.system.setsockopt(fd, posix.SOL.SOCKET, o.opt, std.mem.asBytes(&tv).ptr, @sizeOf(posix.timeval));
        switch (posix.errno(rc)) {
            .SUCCESS => {},
            else => |e| log.warn("setsockopt({s}) failed: {t}", .{ o.name, e }),
        }
    }
}

/// Lingering close: FIN (after the TLS close_notify already sent), discard whatever the client still
/// sends until it closes or `drain_ms` elapses, then close the fd. Raw syscalls: the socket may already be
/// reset, and std's wrappers treat some of those errno values as programmer bugs.
fn closeGracefully(io: std.Io, stream: std.Io.net.Stream, drain_ms: u32) void {
    const fd = stream.socket.handle;
    _ = posix.system.shutdown(fd, posix.SHUT.WR);
    if (drain_ms > 0) {
        const start = std.Io.Clock.now(.awake, io);
        var scratch: [4096]u8 = undefined;
        drain: while (true) {
            const rc = posix.system.recvfrom(fd, &scratch, scratch.len, posix.MSG.DONTWAIT, null, null);
            switch (posix.errno(rc)) {
                .SUCCESS => if (rc == 0) break :drain else continue :drain,
                .INTR => continue :drain,
                .AGAIN => {},
                else => break :drain, // ECONNRESET etc.: nothing left to protect
            }
            if (start.untilNow(io, .awake).toMilliseconds() >= drain_ms) break :drain;
            io.sleep(.fromMilliseconds(1), .awake) catch break :drain;
        }
    }
    stream.close(io);
}

/// Formats u16 values as 4-digit lowercase hex without prefix (AGENTS.md), comma separated.
const HexU16List = struct {
    items: []const u16,

    pub fn format(self: HexU16List, w: *std.Io.Writer) std.Io.Writer.Error!void {
        for (self.items, 0..) |v, i| {
            if (i != 0) try w.writeByte(',');
            try w.print("{x:0>4}", .{v});
        }
    }
};

// ---------------------------------------------------------------------------------------------------------
// Tests (offline: record arithmetic on fixtures, and the peek loop over an AF_UNIX socketpair)
// ---------------------------------------------------------------------------------------------------------

const testing = std.testing;

test "wantLenFromHeader: every fixture is exactly one record of 5 + length bytes" {
    const fixtures = @import("fixtures");
    for (fixtures.clienthello.all) |f| {
        errdefer std.debug.print("fixture {s}\n", .{f.name});
        try testing.expectEqual(f.bytes.len, try wantLenFromHeader(f.bytes[0..record_header_len]));
    }
}

test "wantLenFromHeader: RFC 8446 §5.1 limits" {
    // length = 2^14 is the maximum allowed; 2^14 + 1 and 0 (zero-length handshake fragment) are not.
    try testing.expectEqual(@as(usize, 5 + 16384), try wantLenFromHeader(&.{ 0x16, 0x03, 0x01, 0x40, 0x00 }));
    try testing.expectError(error.Malformed, wantLenFromHeader(&.{ 0x16, 0x03, 0x01, 0x40, 0x01 }));
    try testing.expectError(error.Malformed, wantLenFromHeader(&.{ 0x16, 0x03, 0x01, 0x00, 0x00 }));
    // ContentType 23 (application_data) and plaintext HTTP are not a handshake record.
    try testing.expectError(error.NotHandshake, wantLenFromHeader(&.{ 0x17, 0x03, 0x03, 0x00, 0x10 }));
    try testing.expectError(error.NotHandshake, wantLenFromHeader("GET /"));
}

test "HexU16List formats 4-digit lowercase hex" {
    var buf: [32]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try w.print("{f}", .{HexU16List{ .items = &.{ 0xff01, 0x000b, 0x0029 } }});
    try testing.expectEqualStrings("ff01,000b,0029", w.buffered());
}

const TestPair = struct {
    fds: [2]posix.fd_t,
    writer_closed: bool = false,

    fn open() !TestPair {
        var fds: [2]posix.fd_t = undefined;
        switch (posix.errno(posix.system.socketpair(posix.AF.UNIX, posix.SOCK.STREAM, 0, &fds))) {
            .SUCCESS => return .{ .fds = fds },
            else => return error.SkipZigTest,
        }
    }

    fn send(p: *TestPair, bytes: []const u8) !void {
        var off: usize = 0;
        while (off < bytes.len) {
            const rc = posix.system.write(p.fds[1], bytes[off..].ptr, bytes.len - off);
            switch (posix.errno(rc)) {
                .SUCCESS => off += @intCast(rc),
                .INTR => {},
                else => return error.TestWriteFailed,
            }
        }
    }

    fn closeWriter(p: *TestPair) void {
        _ = posix.system.close(p.fds[1]);
        p.writer_closed = true;
    }

    fn deinit(p: *TestPair) void {
        if (!p.writer_closed) _ = posix.system.close(p.fds[1]);
        _ = posix.system.close(p.fds[0]);
    }
};

test "peekFirstRecord: returns exactly the first record and consumes nothing" {
    const fixtures = @import("fixtures");
    const rec = fixtures.clienthello.chrome_153_macos_psk;
    var pair = try TestPair.open();
    defer pair.deinit();
    try pair.send(rec);
    try pair.send(&.{ 0x14, 0x03, 0x03, 0x00, 0x01, 0x01 }); // a following record must not leak in

    var buf: [max_record_len]u8 = undefined;
    const got = try peekFirstRecordTimeout(testing.io, pair.fds[0], &buf, 1000);
    try testing.expectEqualSlices(u8, rec, got);

    // Still unread: a plain recv starts at the record header again.
    var again: [record_header_len]u8 = undefined;
    const rc = posix.system.recvfrom(pair.fds[0], &again, again.len, 0, null, null);
    try testing.expectEqual(posix.E.SUCCESS, posix.errno(rc));
    try testing.expectEqualSlices(u8, rec[0..record_header_len], &again);
}

test "peekFirstRecord: error paths" {
    const fixtures = @import("fixtures");
    const rec = fixtures.clienthello.firefox_157b4_macos_1;
    var buf: [max_record_len]u8 = undefined;

    { // peer closed before sending anything
        var pair = try TestPair.open();
        defer pair.deinit();
        pair.closeWriter();
        try testing.expectError(error.EndOfStream, peekFirstRecordTimeout(testing.io, pair.fds[0], &buf, 1000));
    }
    { // plaintext HTTP instead of TLS
        var pair = try TestPair.open();
        defer pair.deinit();
        try pair.send("GET / HTTP/1.1\r\n\r\n");
        try testing.expectError(error.NotHandshake, peekFirstRecordTimeout(testing.io, pair.fds[0], &buf, 1000));
    }
    { // nothing sent, connection open
        var pair = try TestPair.open();
        defer pair.deinit();
        try testing.expectError(error.Timeout, peekFirstRecordTimeout(testing.io, pair.fds[0], &buf, 20));
    }
    { // partial record then close: MSG_PEEK keeps reporting the unread bytes, so this ends in Timeout
        var pair = try TestPair.open();
        defer pair.deinit();
        try pair.send(rec[0..100]);
        pair.closeWriter();
        try testing.expectError(error.Timeout, peekFirstRecordTimeout(testing.io, pair.fds[0], &buf, 20));
    }
    { // record larger than the caller's buffer
        var pair = try TestPair.open();
        defer pair.deinit();
        try pair.send(rec);
        try testing.expectError(error.Truncated, peekFirstRecordTimeout(testing.io, pair.fds[0], buf[0 .. rec.len - 1], 1000));
    }
}

test "every entry point is analyzed in this build mode" {
    _ = &peekFirstRecord;
    _ = &serve;
    _ = &handleConnection;
    _ = &closeGracefully;
    _ = &ConnectionInfo.readExactErased;
    _ = &ConnectionInfo.writeAllErased;
}
