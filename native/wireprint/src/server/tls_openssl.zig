//! Minimal OpenSSL 3.x server wrapper via @cImport (each translate-c workaround below says which pitfall it
//! avoids).
//!
//! Spec: RFC 8446 (TLS 1.3, https://www.rfc-editor.org/rfc/rfc8446.txt), RFC 7301 (ALPN,
//! https://www.rfc-editor.org/rfc/rfc7301.txt). OpenSSL API: SSL_CTX_set_client_hello_cb(3ssl),
//! SSL_CTX_set_alpn_select_cb(3ssl), SSL_get_error(3ssl), SSL_shutdown(3ssl).
//! Oracle: `openssl s_client -msg` and `curl -v` on the client side; OpenSSL's own
//! SSL_client_hello_get_extension_order() is exposed as `HandshakeInfo.openssl_extension_order`, a second
//! oracle for this project's ClientHello parser (recognised extensions only, GREASE excluded).
//! Reproduce: tools/serve-smoke.sh (localhost only; prints the handshake summary per connection).
//!
//! Compiled for real only with -Dopenssl=true (the default). With -Dopenssl=false every function returns
//! error.NotEnabled (or an empty value) and nothing here references the C headers.
const std = @import("std");
const build_options = @import("build_options");

pub const enabled = build_options.openssl;

const log = std.log.scoped(.tls_openssl);

pub const c = if (enabled) @cImport({
    @cInclude("openssl/ssl.h");
    @cInclude("openssl/err.h");
}) else struct {};

pub const Error = error{
    OpenSslInit,
    SslCtxNew,
    Cert,
    Key,
    MinProto,
    NumTickets,
    SslNew,
    SetFd,
    Accept,
    Read,
    Write,
    /// The peer closed the TLS connection (close_notify, or TCP EOF without close_notify).
    EndOfStream,
    /// No progress within the socket's SO_RCVTIMEO / SO_SNDTIMEO (listener.Options.io_timeout_ms).
    Timeout,
    NotEnabled,
};

/// Capacity for OpenSSL's recognised-extension order. OpenSSL reports only extension types it knows
/// (about 30 in 3.6), so 64 leaves headroom; a larger count makes the callback log a warning instead.
pub const max_extension_order = 64;

/// OpenSSL version of the headers this file was compiled against (`OPENSSL_VERSION_TEXT`); "" without
/// -Dopenssl. A `const` cannot call into the library, so the loaded library's version is `runtimeVersion()`.
pub const version_string: []const u8 = if (enabled) c.OPENSSL_VERSION_TEXT else "";

/// Version string of the libssl/libcrypto actually loaded, `OpenSSL_version(OPENSSL_VERSION)`.
pub fn runtimeVersion() []const u8 {
    if (!enabled) return "";
    return std.mem.span(c.OpenSSL_version(c.OPENSSL_VERSION));
}

pub const Context = struct {
    ctx: if (enabled) *c.SSL_CTX else void,

    /// Server SSL_CTX: PEM certificate chain + private key, TLS >= 1.2, ALPN "h2" only (no overlap is a
    /// fatal no_application_protocol alert), ClientHello callback recording OpenSSL's extension order,
    /// session tickets left on (OpenSSL default; 2 NewSessionTicket messages per full handshake).
    pub fn init(cert_path: [:0]const u8, key_path: [:0]const u8) Error!Context {
        if (!enabled) return error.NotEnabled;

        // SSL_library_init() is a macro for OPENSSL_init_ssl(0, NULL) whose NULL does not translate
        // (translate-c); call the function directly.
        if (c.OPENSSL_init_ssl(0, null) != 1) {
            logErrorQueue("OPENSSL_init_ssl");
            return error.OpenSslInit;
        }
        c.ERR_clear_error();

        const ctx = c.SSL_CTX_new(c.TLS_server_method()) orelse {
            logErrorQueue("SSL_CTX_new");
            return error.SslCtxNew;
        };
        errdefer c.SSL_CTX_free(ctx);

        if (c.SSL_CTX_use_certificate_chain_file(ctx, cert_path.ptr) != 1) {
            log.err("cannot load certificate chain from {s}", .{cert_path});
            logErrorQueue("SSL_CTX_use_certificate_chain_file");
            return error.Cert;
        }
        // Also checks that the key matches the certificate loaded above.
        if (c.SSL_CTX_use_PrivateKey_file(ctx, key_path.ptr, c.SSL_FILETYPE_PEM) != 1) {
            log.err("cannot load private key from {s}", .{key_path});
            logErrorQueue("SSL_CTX_use_PrivateKey_file");
            return error.Key;
        }
        // Macro -> inline fn over SSL_CTX_ctrl(ctx, SSL_CTRL_SET_MIN_PROTO_VERSION, ...); translates fine.
        if (c.SSL_CTX_set_min_proto_version(ctx, c.TLS1_2_VERSION) != 1) {
            logErrorQueue("SSL_CTX_set_min_proto_version");
            return error.MinProto;
        }
        // Session tickets: SSL_OP_NO_TICKET is deliberately NOT set, so resumption (and with it the
        // pre_shared_key ClientHello variant) stays observable. SSL_OP_* constants are unusable via
        // @cImport anyway (SSL_OP_BIT(n) shift type error).
        if (c.SSL_CTX_set_num_tickets(ctx, 2) != 1) {
            logErrorQueue("SSL_CTX_set_num_tickets");
            return error.NumTickets;
        }
        c.SSL_CTX_set_alpn_select_cb(ctx, &callbacks.alpnSelect, null);
        c.SSL_CTX_set_client_hello_cb(ctx, &callbacks.clientHello, null);
        return .{ .ctx = ctx };
    }

    pub fn deinit(self: *Context) void {
        if (!enabled) return;
        c.SSL_CTX_free(self.ctx);
        self.* = undefined;
    }
};

pub const HandshakeInfo = struct {
    /// e.g. "TLSv1.3". Borrowed from OpenSSL (static string).
    version: []const u8,
    /// e.g. "TLS_AES_128_GCM_SHA256" (OpenSSL naming). Borrowed from OpenSSL.
    cipher: []const u8,
    /// Selected ALPN protocol; null when the client sent no ALPN extension. Borrowed from the SSL object.
    alpn: ?[]const u8,
    session_reused: bool,
    /// SNI host_name from the ClientHello (null if absent). Borrowed from the SSL object.
    sni: ?[]const u8,
    /// Extension types in wire order as parsed by OpenSSL (recognised extensions only). Borrowed from
    /// the `ext_buf` passed to `Connection.info`.
    openssl_extension_order: []const u16,
    /// OpenSSL's ClientHello callback ran more than once, i.e. the server sent a HelloRetryRequest and the
    /// client a second ClientHello. `openssl_extension_order` is always from the first ClientHello (the
    /// one the listener MSG_PEEKed).
    hello_retry: bool = false,
};

/// State shared with the ClientHello callback through the SSL object's app-data slot while
/// `Connection.accept` runs.
const HelloCapture = struct {
    exts: [max_extension_order]u16 = undefined,
    len: usize = 0,
    calls: u8 = 0,
};

/// `SSL_set_app_data(s, arg)` is `SSL_set_ex_data(s, 0, (char *)(arg))` (ssl.h:1034); ex_data index 0 is
/// the app-data slot, so no SSL_get_ex_new_index() registration is needed.
const app_data_index = 0;

/// Consecutive SSL_ERROR_WANT_READ/WANT_WRITE results retried on a blocking socket. They only happen when a
/// syscall was interrupted (EINTR, retried) or SO_RCVTIMEO/SO_SNDTIMEO expired (EAGAIN, reported as
/// error.Timeout at once); SSL_MODE_AUTO_RETRY is on by default in 3.x so non-application records alone
/// never cause them.
const max_want_retries = 3;

pub const Connection = struct {
    ssl: if (enabled) *c.SSL else void,
    hello: HelloCapture = .{},
    /// Set after a fatal SSL_ERROR_SSL / SSL_ERROR_SYSCALL: SSL_shutdown(3ssl) must not be called then.
    broken: bool = false,

    /// Blocking server handshake on an already accepted socket. The socket BIO does not own `fd`
    /// (BIO_NOCLOSE): the caller closes it after `close()`. On failure the reason is logged with
    /// std.log.err and the SSL object is freed.
    pub fn accept(ctx: *Context, fd: std.posix.fd_t) Error!Connection {
        if (!enabled) return error.NotEnabled;

        // SSL_get_error(3ssl): the thread's error queue must be empty before the I/O call.
        c.ERR_clear_error();
        const ssl = c.SSL_new(ctx.ctx) orelse {
            logErrorQueue("SSL_new");
            return error.SslNew;
        };
        errdefer c.SSL_free(ssl);
        if (c.SSL_set_fd(ssl, fd) != 1) {
            logErrorQueue("SSL_set_fd");
            return error.SetFd;
        }

        var hello: HelloCapture = .{};
        if (c.SSL_set_ex_data(ssl, app_data_index, &hello) != 1) {
            logErrorQueue("SSL_set_ex_data");
            return error.SslNew;
        }
        // `hello` lives on this stack frame: detach it before returning on any path.
        defer _ = c.SSL_set_ex_data(ssl, app_data_index, null);

        const rc = c.SSL_accept(ssl);
        if (rc != 1) {
            const code = c.SSL_get_error(ssl, rc);
            if (code == c.SSL_ERROR_SYSCALL or code == c.SSL_ERROR_WANT_READ or code == c.SSL_ERROR_WANT_WRITE) {
                // WANT_* on this blocking socket: errno AGAIN = SO_RCVTIMEO/SO_SNDTIMEO expired.
                log.err("SSL_accept -> {d} ({s}, errno={t})", .{ rc, sslErrorName(code), std.posix.errno(@as(c_int, -1)) });
            } else {
                log.err("SSL_accept -> {d} ({s})", .{ rc, sslErrorName(code) });
            }
            logErrorQueue("SSL_accept");
            return error.Accept;
        }
        return .{ .ssl = ssl, .hello = hello };
    }

    /// Snapshot of the negotiated parameters. String slices borrow from OpenSSL and stay valid until
    /// `close()`; `openssl_extension_order` is copied into `ext_buf` (truncated to its length).
    pub fn info(self: *const Connection, ext_buf: []u16) HandshakeInfo {
        if (!enabled) return .{
            .version = "",
            .cipher = "",
            .alpn = null,
            .session_reused = false,
            .sni = null,
            .openssl_extension_order = &.{},
        };

        var alpn_ptr: [*c]const u8 = null;
        var alpn_len: c_uint = 0;
        c.SSL_get0_alpn_selected(self.ssl, &alpn_ptr, &alpn_len);

        const n = @min(ext_buf.len, self.hello.len);
        @memcpy(ext_buf[0..n], self.hello.exts[0..n]);

        return .{
            .version = cString(c.SSL_get_version(self.ssl)) orelse "",
            // SSL_get_cipher is a macro -> inline fn over SSL_CIPHER_get_name(SSL_get_current_cipher(s)).
            .cipher = cString(c.SSL_get_cipher(self.ssl)) orelse "",
            .alpn = if (alpn_ptr != null and alpn_len > 0) alpn_ptr[0..alpn_len] else null,
            .session_reused = c.SSL_session_reused(self.ssl) == 1,
            .sni = cString(c.SSL_get_servername(self.ssl, c.TLSEXT_NAMETYPE_host_name)),
            .openssl_extension_order = ext_buf[0..n],
            .hello_retry = self.hello.calls > 1,
        };
    }

    /// Reads exactly `buf.len` decrypted bytes. `error.EndOfStream` when the peer closed (with or without
    /// close_notify), `error.Timeout` when SO_RCVTIMEO expired, `error.Read` for anything else (logged).
    pub fn readExact(self: *Connection, buf: []u8) Error!void {
        if (!enabled) return error.NotEnabled;
        var got: usize = 0;
        var retries: u8 = 0;
        while (got < buf.len) {
            const want: c_int = @intCast(@min(buf.len - got, std.math.maxInt(c_int)));
            c.ERR_clear_error();
            const r = c.SSL_read(self.ssl, buf.ptr + got, want);
            if (r > 0) {
                got += @intCast(r);
                retries = 0;
                continue;
            }
            const code = c.SSL_get_error(self.ssl, r);
            switch (self.classify("SSL_read", r, code, got, buf.len, &retries)) {
                .retry => continue,
                .end_of_stream => return error.EndOfStream,
                .timeout => return error.Timeout,
                .failed => return error.Read,
            }
        }
    }

    /// Writes all of `bytes` (SSL_write only returns early on error without SSL_MODE_ENABLE_PARTIAL_WRITE,
    /// but loop anyway).
    pub fn writeAll(self: *Connection, bytes: []const u8) Error!void {
        if (!enabled) return error.NotEnabled;
        var sent: usize = 0;
        var retries: u8 = 0;
        while (sent < bytes.len) {
            const want: c_int = @intCast(@min(bytes.len - sent, std.math.maxInt(c_int)));
            c.ERR_clear_error();
            const r = c.SSL_write(self.ssl, bytes.ptr + sent, want);
            if (r > 0) {
                sent += @intCast(r);
                retries = 0;
                continue;
            }
            const code = c.SSL_get_error(self.ssl, r);
            switch (self.classify("SSL_write", r, code, sent, bytes.len, &retries)) {
                .retry => continue,
                .end_of_stream => return error.EndOfStream,
                .timeout => return error.Timeout,
                .failed => return error.Write,
            }
        }
    }

    /// Sends close_notify (unless the connection is broken) and frees the SSL object. Does not close the fd.
    pub fn close(self: *Connection) void {
        if (!enabled) return;
        if (!self.broken) {
            c.ERR_clear_error();
            // 0 = close_notify sent, peer's not yet received: fine, we are closing the socket anyway.
            _ = c.SSL_shutdown(self.ssl);
        }
        c.SSL_free(self.ssl);
        c.ERR_clear_error();
        self.* = undefined;
    }

    const Outcome = enum { retry, end_of_stream, timeout, failed };

    fn classify(self: *Connection, what: []const u8, r: c_int, code: c_int, done: usize, total: usize, retries: *u8) Outcome {
        if (!enabled) return .failed;
        switch (code) {
            c.SSL_ERROR_ZERO_RETURN => {
                log.debug("{s}: peer sent close_notify after {d}/{d} bytes", .{ what, done, total });
                return .end_of_stream;
            },
            c.SSL_ERROR_WANT_READ, c.SSL_ERROR_WANT_WRITE => {
                // errno is still the one from the socket BIO's failed read()/write().
                const errno = std.posix.errno(@as(c_int, -1));
                if (errno == .AGAIN) {
                    log.warn("{s}: socket timeout after {d}/{d} bytes", .{ what, done, total });
                    return .timeout;
                }
                if (retries.* < max_want_retries) {
                    retries.* += 1;
                    return .retry;
                }
                log.warn("{s}: {s} {d} times in a row after {d}/{d} bytes (errno={t})", .{
                    what, sslErrorName(code), retries.* + 1, done, total, errno,
                });
                return .failed;
            },
            c.SSL_ERROR_SYSCALL => {
                self.broken = true;
                const errno = std.posix.errno(@as(c_int, -1));
                if (c.ERR_peek_error() == 0 and (r == 0 or errno == .SUCCESS)) {
                    log.debug("{s}: TCP EOF without close_notify after {d}/{d} bytes", .{ what, done, total });
                    return .end_of_stream;
                }
                log.warn("{s} -> {d} (SSL_ERROR_SYSCALL, errno={t}) after {d}/{d} bytes", .{ what, r, errno, done, total });
                logErrorQueueAt(.warn, what);
                return .failed;
            },
            c.SSL_ERROR_SSL => {
                self.broken = true;
                const e = c.ERR_peek_error();
                if (c.ERR_GET_LIB(e) == c.ERR_LIB_SSL and c.ERR_GET_REASON(e) == c.SSL_R_UNEXPECTED_EOF_WHILE_READING) {
                    c.ERR_clear_error();
                    log.debug("{s}: TCP EOF without close_notify after {d}/{d} bytes", .{ what, done, total });
                    return .end_of_stream;
                }
                log.warn("{s} -> {d} (SSL_ERROR_SSL) after {d}/{d} bytes", .{ what, r, done, total });
                logErrorQueueAt(.warn, what);
                return .failed;
            },
            else => {
                self.broken = true;
                log.warn("{s} -> {d} ({s}) after {d}/{d} bytes", .{ what, r, sslErrorName(code), done, total });
                logErrorQueueAt(.warn, what);
                return .failed;
            },
        }
    }
};

/// C callbacks registered on the SSL_CTX. Only defined with -Dopenssl=true (their signatures use C types).
const callbacks = if (enabled) struct {
    /// ALPN: offer only "h2" (RFC 7301 protocol-list format: 1-byte length prefixes). No overlap ->
    /// SSL_TLSEXT_ERR_ALERT_FATAL, i.e. alert 120 no_application_protocol (RFC 7301 §3.2).
    fn alpnSelect(
        ssl: ?*c.SSL,
        out: [*c][*c]const u8,
        outlen: [*c]u8,
        in: [*c]const u8,
        inlen: c_uint,
        arg: ?*anyopaque,
    ) callconv(.c) c_int {
        _ = ssl;
        _ = arg;
        const server_protos = "\x02h2";
        const offer: []const u8 = if (in != null) in[0..inlen] else &.{};
        log.debug("ALPN offered: {f}", .{ProtocolList{ .bytes = offer }});

        // SSL_select_next_proto takes `unsigned char **out` while the callback gets
        // `const unsigned char **out`: go through a local non-const pointer.
        var sel: [*c]u8 = null;
        var sel_len: u8 = 0;
        const rc = c.SSL_select_next_proto(&sel, &sel_len, server_protos, server_protos.len, in, inlen);
        if (rc == c.OPENSSL_NPN_NEGOTIATED and sel != null) {
            out.* = sel;
            outlen.* = sel_len;
            return c.SSL_TLSEXT_ERR_OK;
        }
        // OPENSSL_NPN_NO_OVERLAP: out/outlen must be ignored for ALPN.
        log.warn("ALPN: no overlap with \"h2\" (client offered {f}); sending no_application_protocol", .{ProtocolList{ .bytes = offer }});
        return c.SSL_TLSEXT_ERR_ALERT_FATAL;
    }

    /// Records OpenSSL's view of the ClientHello extension order into the connection's HelloCapture.
    /// Never fails the handshake.
    fn clientHello(ssl: ?*c.SSL, al: [*c]c_int, arg: ?*anyopaque) callconv(.c) c_int {
        _ = al;
        _ = arg;
        const raw = c.SSL_get_ex_data(ssl, app_data_index) orelse return c.SSL_CLIENT_HELLO_SUCCESS;
        const cap: *HelloCapture = @ptrCast(@alignCast(raw));
        cap.calls +|= 1;
        // A second call is the ClientHello after a HelloRetryRequest; keep the first one's order.
        if (cap.calls > 1) return c.SSL_CLIENT_HELLO_SUCCESS;

        var n: usize = cap.exts.len;
        if (c.SSL_client_hello_get_extension_order(ssl, &cap.exts, &n) != 1) {
            log.warn("SSL_client_hello_get_extension_order failed (more than {d} recognised extensions?)", .{cap.exts.len});
            cap.len = 0;
            return c.SSL_CLIENT_HELLO_SUCCESS;
        }
        cap.len = @min(n, cap.exts.len);
        return c.SSL_CLIENT_HELLO_SUCCESS;
    }
} else struct {};

/// Formats an ALPN protocol-list (RFC 7301 §3.1) as `"h2","http/1.1"`; stops at the first malformed entry.
const ProtocolList = struct {
    bytes: []const u8,

    pub fn format(self: ProtocolList, w: *std.Io.Writer) std.Io.Writer.Error!void {
        var i: usize = 0;
        var first = true;
        while (i < self.bytes.len) {
            const l = self.bytes[i];
            if (l == 0 or i + 1 + l > self.bytes.len) {
                try w.writeAll(if (first) "<malformed>" else ",<malformed>");
                return;
            }
            if (!first) try w.writeByte(',');
            try w.print("\"{s}\"", .{self.bytes[i + 1 .. i + 1 + l]});
            first = false;
            i += 1 + l;
        }
        if (first) try w.writeAll("(empty)");
    }
};

fn cString(p: [*c]const u8) ?[]const u8 {
    return if (p == null) null else std.mem.span(p);
}

fn sslErrorName(code: c_int) []const u8 {
    if (!enabled) return "n/a";
    return switch (code) {
        c.SSL_ERROR_NONE => "SSL_ERROR_NONE",
        c.SSL_ERROR_SSL => "SSL_ERROR_SSL",
        c.SSL_ERROR_WANT_READ => "SSL_ERROR_WANT_READ",
        c.SSL_ERROR_WANT_WRITE => "SSL_ERROR_WANT_WRITE",
        c.SSL_ERROR_WANT_X509_LOOKUP => "SSL_ERROR_WANT_X509_LOOKUP",
        c.SSL_ERROR_SYSCALL => "SSL_ERROR_SYSCALL",
        c.SSL_ERROR_ZERO_RETURN => "SSL_ERROR_ZERO_RETURN",
        c.SSL_ERROR_WANT_CONNECT => "SSL_ERROR_WANT_CONNECT",
        c.SSL_ERROR_WANT_ACCEPT => "SSL_ERROR_WANT_ACCEPT",
        c.SSL_ERROR_WANT_CLIENT_HELLO_CB => "SSL_ERROR_WANT_CLIENT_HELLO_CB",
        else => "SSL_ERROR_other",
    };
}

/// Drains the thread's OpenSSL error queue into std.log.err. ERR_print_errors_fp(stderr) is unusable:
/// macOS `stderr` is a macro that does not translate.
fn logErrorQueue(where: []const u8) void {
    logErrorQueueAt(.err, where);
}

fn logErrorQueueAt(comptime level: std.log.Level, where: []const u8) void {
    if (!enabled) return;
    var buf: [256]u8 = undefined;
    var any = false;
    while (true) {
        const e = c.ERR_get_error();
        if (e == 0) break;
        any = true;
        c.ERR_error_string_n(e, &buf, buf.len);
        const text = std.mem.sliceTo(&buf, 0);
        switch (level) {
            .err => log.err("{s}: {s}", .{ where, text }),
            .warn => log.warn("{s}: {s}", .{ where, text }),
            .info => log.info("{s}: {s}", .{ where, text }),
            .debug => log.debug("{s}: {s}", .{ where, text }),
        }
    }
    if (!any and level == .err) log.err("{s}: (OpenSSL error queue empty)", .{where});
}

test "ProtocolList formats RFC 7301 protocol-name lists" {
    // Input bytes are the RFC 7301 §3.1 encoding of the IANA ALPN IDs "h2" and "http/1.1".
    var buf: [64]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try w.print("{f}", .{ProtocolList{ .bytes = "\x02h2\x08http/1.1" }});
    try std.testing.expectEqualStrings("\"h2\",\"http/1.1\"", w.buffered());

    w = .fixed(&buf);
    try w.print("{f}", .{ProtocolList{ .bytes = "\x02h2\x09http" }});
    try std.testing.expectEqualStrings("\"h2\",<malformed>", w.buffered());

    w = .fixed(&buf);
    try w.print("{f}", .{ProtocolList{ .bytes = "" }});
    try std.testing.expectEqualStrings("(empty)", w.buffered());
}

test "every entry point is analyzed in this build mode" {
    // Forces semantic analysis of all function bodies so both -Dopenssl=true and -Dopenssl=false are
    // compile-checked by `zig build test` (Zig only analyzes referenced functions).
    _ = &runtimeVersion;
    _ = &Context.init;
    _ = &Context.deinit;
    _ = &Connection.accept;
    _ = &Connection.info;
    _ = &Connection.readExact;
    _ = &Connection.writeAll;
    _ = &Connection.close;
    _ = &Connection.classify;
    _ = &logErrorQueue;
    if (enabled) {
        _ = &callbacks.alpnSelect;
        _ = &callbacks.clientHello;
    }
}

test "disabled build returns NotEnabled" {
    if (enabled) return error.SkipZigTest;
    try std.testing.expectError(error.NotEnabled, Context.init("cert.pem", "key.pem"));
    try std.testing.expectEqualStrings("", runtimeVersion());
}

test "headers and loaded library are the same OpenSSL 3 release" {
    if (!enabled) return error.SkipZigTest;
    // SSL_client_hello_get_extension_order and SSL_CTX_set_num_tickets need 3.x; a header/library mismatch
    // means the wrong libssl was picked up at run time.
    try std.testing.expect(std.mem.startsWith(u8, runtimeVersion(), "OpenSSL 3."));
    try std.testing.expectEqualStrings(version_string, runtimeVersion());
}
