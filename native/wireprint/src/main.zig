//! wireprint CLI.
//!   parse <pcap|bin>      ClientHello fields + JA3 + JA4 (+ TCP SYN fields when the input is a pcap) as JSON
//!   ja3   <pcap|bin>      JA3 string and MD5 only
//!   ja4   <pcap|bin>      JA4 / JA4_r / JA4_o / JA4_ro only
//!   h2    <bin>           HTTP/2 client stream dump (preface + frames): frames, SETTINGS, decoded headers, Akamai string
//!   serve [--port N] --cert C --key K [--capture-dir D]   echo server (requires -Dopenssl=true)
//!   check --claim <profile-id> <report.json>              cross-layer consistency report
//!   diff  <a.json> <b.json>                               profile diff
//!
//! Input detection: a legacy pcap magic (a1b2c3d4 / d4c3b2a1 / a1b23c4d / 4d3cb2a1) selects the pcap path
//! (Ethernet|DLT_NULL -> IP -> TCP -> client-direction reassembly); anything else is treated as a raw
//! client->server TLS record stream (for example the .bin files written by `serve --capture-dir`).
const std = @import("std");
const wireprint = @import("wireprint");
const build_options = @import("build_options");
const hex = wireprint.hex;

const usage =
    \\usage: wireprint <command> [args]
    \\  parse <pcap|bin>                          ClientHello fields, JA3, JA4 (JSON)
    \\  ja3 <pcap|bin>                            JA3 string and MD5 (JSON)
    \\  ja4 <pcap|bin>                            JA4 / JA4_r / JA4_o / JA4_ro (JSON)
    \\  h2 <bin>                                  HTTP/2 client stream: frames, SETTINGS, headers, Akamai (JSON)
    \\  serve [--port 8443] --cert C --key K [--capture-dir D]
    \\  profile --name N --version V --os OS --arch A [--channel C] [--os-version X] [--headless]
    \\          [--method M] [--claims ID] [--captured-at T] [--raw-dir D] report.json...   assemble a corpus profile
    \\  check --claim <profile-id> <report.json>
    \\  diff <a.json> <b.json>
    \\
;

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const gpa = init.gpa;

    var stdout_buf: [16 * 1024]u8 = undefined;
    var stdout_w = std.Io.File.stdout().writer(io, &stdout_buf);
    const out = &stdout_w.interface;
    defer out.flush() catch {};

    // iterateAllocator, not iterate: the plain iterator is a compile error on Windows.
    var it = try init.minimal.args.iterateAllocator(gpa);
    defer it.deinit();
    _ = it.skip();
    const cmd = it.next() orelse {
        try out.writeAll(usage);
        return;
    };

    if (std.mem.eql(u8, cmd, "parse") or std.mem.eql(u8, cmd, "ja3") or std.mem.eql(u8, cmd, "ja4")) {
        const path = it.next() orelse return fail(out, "missing input file\n");
        const mode: Mode = if (std.mem.eql(u8, cmd, "parse")) .parse else if (std.mem.eql(u8, cmd, "ja3")) .ja3 else .ja4;
        try cmdParse(io, gpa, out, path, mode);
    } else if (std.mem.eql(u8, cmd, "h2")) {
        const path = it.next() orelse return fail(out, "missing input file\n");
        try cmdH2(io, gpa, out, path);
    } else if (std.mem.eql(u8, cmd, "serve")) {
        try cmdServe(io, gpa, out, &it);
    } else if (std.mem.eql(u8, cmd, "diff")) {
        const a = it.next() orelse return fail(out, "diff needs two files\n");
        const b = it.next() orelse return fail(out, "diff needs two files\n");
        try cmdDiff(io, gpa, out, a, b);
    } else if (std.mem.eql(u8, cmd, "profile")) {
        try cmdProfile(io, gpa, out, &it);
    } else if (std.mem.eql(u8, cmd, "check")) {
        var claim: ?[]const u8 = null;
        var report_path: ?[]const u8 = null;
        while (it.next()) |arg| {
            if (std.mem.eql(u8, arg, "--claim")) {
                claim = it.next() orelse return fail(out, "--claim needs a profile path\n");
            } else report_path = arg;
        }
        if (claim == null or report_path == null) return fail(out, "usage: check --claim <profile.json> <report.json>\n");
        try cmdCheck(io, gpa, out, claim.?, report_path.?);
    } else if (std.mem.eql(u8, cmd, "--version") or std.mem.eql(u8, cmd, "version")) {
        try out.print("wireprint 0.1.0 (openssl={})\n", .{build_options.openssl});
    } else {
        try out.writeAll(usage);
    }
}

fn fail(out: *std.Io.Writer, msg: []const u8) !void {
    try out.writeAll("error: ");
    try out.writeAll(msg);
    try out.flush();
    std.process.exit(2);
}

const Mode = enum { parse, ja3, ja4 };

/// What `loadClientStream` found: a client->server byte stream plus, for pcaps, the client SYN facts.
const Input = struct {
    stream: []u8,
    syn: ?wireprint.net.tcp_reassembly.SynInfo,
    from_pcap: bool,

    fn deinit(self: *Input, gpa: std.mem.Allocator) void {
        gpa.free(self.stream);
        if (self.syn) |s| gpa.free(s.options);
        self.* = undefined;
    }
};

fn isPcapMagic(bytes: []const u8) bool {
    if (bytes.len < 4) return false;
    const m = std.mem.readInt(u32, bytes[0..4], .big);
    return m == 0xa1b2c3d4 or m == 0xd4c3b2a1 or m == 0xa1b23c4d or m == 0x4d3cb2a1;
}

fn loadClientStream(io: std.Io, gpa: std.mem.Allocator, path: []const u8) !Input {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .unlimited);
    if (!isPcapMagic(bytes)) return .{ .stream = bytes, .syn = null, .from_pcap = false };
    defer gpa.free(bytes);
    var reader = try wireprint.pcap.Reader.init(bytes);
    const first = try wireprint.net.tcp_reassembly.firstClientPayload(&reader, gpa);
    // Ownership of payload and syn.options moves into Input (freed by Input.deinit).
    return .{ .stream = first.payload, .syn = first.syn, .from_pcap = true };
}

fn cmdParse(io: std.Io, gpa: std.mem.Allocator, out: *std.Io.Writer, path: []const u8, mode: Mode) !void {
    const report = wireprint.server.report;
    var input = loadClientStream(io, gpa, path) catch |err| {
        try out.print("error: cannot load {s}: {t}\n", .{ path, err });
        return;
    };
    defer input.deinit(gpa);

    var scratch: [1 << 16]u8 = undefined;
    const record0 = wireprint.tls.record.parseRecord(input.stream) catch |err| {
        try out.print("error: TLS record: {t}\n", .{err});
        return;
    };
    const msg = wireprint.tls.record.firstHandshakeMessage(input.stream, &scratch) catch |err| {
        try out.print("error: handshake message: {t}\n", .{err});
        return;
    };
    const ch = wireprint.tls.client_hello.parse(msg.bytes) catch |err| {
        try out.print("error: ClientHello: {t}\n", .{err});
        return;
    };

    var js: std.json.Stringify = .{ .writer = out, .options = .{ .whitespace = .indent_2 } };
    try js.beginObject();
    try js.objectField("input");
    try js.write(path);
    try js.objectField("input_kind");
    try js.write(if (input.from_pcap) "pcap" else "raw-tls-stream");

    if (mode == .parse) {
        try js.objectField("record");
        try js.beginObject();
        try js.objectField("content_type");
        try js.write(record0.content_type);
        try js.objectField("legacy_version");
        try js.write(&hex.u16Hex(record0.legacy_version));
        try js.objectField("length");
        try js.write(record0.fragment.len);
        try js.objectField("stream_bytes");
        try js.write(input.stream.len);
        try js.endObject();
        try js.objectField("client_hello");
        try report.clientHello(gpa, &js, &ch);
        if (input.syn) |syn| {
            try js.objectField("tcp_syn");
            try report.tcpSyn(gpa, &js, syn);
        }
    }
    try report.fingerprints(gpa, &js, &ch, .tcp, switch (mode) {
        .parse => .both,
        .ja3 => .ja3,
        .ja4 => .ja4,
    });
    try js.endObject();
    try out.writeAll("\n");
}

fn cmdH2(io: std.Io, gpa: std.mem.Allocator, out: *std.Io.Writer, path: []const u8) !void {
    const report = wireprint.server.report;
    const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .unlimited) catch |err| {
        try out.print("error: cannot read {s}: {t}\n", .{ path, err });
        return;
    };
    defer gpa.free(bytes);
    const after = wireprint.h2.frame.stripPreface(bytes) catch |err| {
        try out.print("error: preface: {t}\n", .{err});
        return;
    };
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const obs = try report.collectH2(arena, after);

    var js: std.json.Stringify = .{ .writer = out, .options = .{ .whitespace = .indent_2 } };
    try js.beginObject();
    try js.objectField("input");
    try js.write(path);
    try js.objectField("http2");
    try report.http2(arena, &js, obs);
    try js.objectField("http");
    try report.http(arena, &js, obs.headers);
    try js.endObject();
    try out.writeAll("\n");
}

fn cmdProfile(io: std.Io, gpa: std.mem.Allocator, out: *std.Io.Writer, it: *std.process.Args.Iterator) !void {
    var meta: wireprint.profile.Meta = .{ .name = "", .version = "", .os = "", .arch = "" };
    var files: std.ArrayList([]const u8) = .empty;
    defer files.deinit(gpa);
    while (it.next()) |arg| {
        if (std.mem.eql(u8, arg, "--name")) {
            meta.name = it.next() orelse return fail(out, "--name needs a value\n");
        } else if (std.mem.eql(u8, arg, "--version")) {
            meta.version = it.next() orelse return fail(out, "--version needs a value\n");
        } else if (std.mem.eql(u8, arg, "--os")) {
            meta.os = it.next() orelse return fail(out, "--os needs a value\n");
        } else if (std.mem.eql(u8, arg, "--os-version")) {
            meta.os_version = it.next() orelse return fail(out, "--os-version needs a value\n");
        } else if (std.mem.eql(u8, arg, "--arch")) {
            meta.arch = it.next() orelse return fail(out, "--arch needs a value\n");
        } else if (std.mem.eql(u8, arg, "--channel")) {
            meta.channel = it.next() orelse return fail(out, "--channel needs a value\n");
        } else if (std.mem.eql(u8, arg, "--kind")) {
            meta.kind = it.next() orelse return fail(out, "--kind needs a value\n");
        } else if (std.mem.eql(u8, arg, "--claims")) {
            meta.claims = it.next() orelse return fail(out, "--claims needs a value\n");
        } else if (std.mem.eql(u8, arg, "--method")) {
            meta.method = it.next() orelse return fail(out, "--method needs a value\n");
        } else if (std.mem.eql(u8, arg, "--captured-at")) {
            meta.captured_at = it.next() orelse return fail(out, "--captured-at needs a value\n");
        } else if (std.mem.eql(u8, arg, "--raw-dir")) {
            meta.raw_dir = it.next() orelse return fail(out, "--raw-dir needs a value\n");
        } else if (std.mem.eql(u8, arg, "--notes")) {
            meta.notes = it.next() orelse return fail(out, "--notes needs a value\n");
        } else if (std.mem.eql(u8, arg, "--headless")) {
            meta.headless = true;
        } else if (std.mem.startsWith(u8, arg, "--")) {
            try out.print("error: unknown profile option {s}\n", .{arg});
            return;
        } else {
            try files.append(gpa, arg);
        }
    }
    if (meta.name.len == 0 or meta.version.len == 0 or meta.os.len == 0 or meta.arch.len == 0) return fail(out, "profile needs --name, --version, --os and --arch\n");
    if (files.items.len == 0) return fail(out, "profile needs at least one report.json\n");

    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var values: std.ArrayList(std.json.Value) = .empty;
    for (files.items) |path| {
        const text = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .unlimited) catch |err| {
            try out.print("error: cannot read {s}: {t}\n", .{ path, err });
            return;
        };
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, text, .{}) catch |err| {
            try out.print("error: {s}: {t}\n", .{ path, err });
            return;
        };
        try values.append(arena, parsed);
    }
    var js: std.json.Stringify = .{ .writer = out, .options = .{ .whitespace = .indent_2 } };
    wireprint.profile.assemble(arena, &js, values.items, meta) catch |err| {
        try out.print("error: profile: {t}\n", .{err});
        return;
    };
    try out.writeAll("\n");
}

fn cmdCheck(io: std.Io, gpa: std.mem.Allocator, out: *std.Io.Writer, profile_path: []const u8, report_path: []const u8) !void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const ptext = std.Io.Dir.cwd().readFileAlloc(io, profile_path, arena, .unlimited) catch |err| {
        try out.print("error: cannot read {s}: {t}\n", .{ profile_path, err });
        return;
    };
    const rtext = std.Io.Dir.cwd().readFileAlloc(io, report_path, arena, .unlimited) catch |err| {
        try out.print("error: cannot read {s}: {t}\n", .{ report_path, err });
        return;
    };
    const profile = std.json.parseFromSliceLeaky(std.json.Value, arena, ptext, .{}) catch |err| {
        try out.print("error: {s}: {t}\n", .{ profile_path, err });
        return;
    };
    const report = std.json.parseFromSliceLeaky(std.json.Value, arena, rtext, .{}) catch |err| {
        try out.print("error: {s}: {t}\n", .{ report_path, err });
        return;
    };
    var findings: std.ArrayList(wireprint.check.claim.Finding) = .empty;
    try wireprint.check.claim.checkClaim(arena, report, profile, &findings);
    var red: usize = 0;
    var warn: usize = 0;
    for (findings.items) |f| {
        switch (f.severity) {
            .red => red += 1,
            .warn => warn += 1,
            .info => {},
        }
        try out.print("{s: <4} {s: <4} {s}\n", .{ @tagName(f.severity), f.rule, f.message });
    }
    try out.print("verdict: {s} ({d} red, {d} warn)\n", .{ if (red == 0) "CONSISTENT" else "INCONSISTENT", red, warn });
}

fn cmdDiff(io: std.Io, gpa: std.mem.Allocator, out: *std.Io.Writer, a_path: []const u8, b_path: []const u8) !void {
    const a = std.Io.Dir.cwd().readFileAlloc(io, a_path, gpa, .unlimited) catch |err| {
        try out.print("error: cannot read {s}: {t}\n", .{ a_path, err });
        return;
    };
    defer gpa.free(a);
    const b = std.Io.Dir.cwd().readFileAlloc(io, b_path, gpa, .unlimited) catch |err| {
        try out.print("error: cannot read {s}: {t}\n", .{ b_path, err });
        return;
    };
    defer gpa.free(b);
    const stats = wireprint.diff.diffText(gpa, out, a, b, .{}) catch |err| {
        try out.print("error: diff: {t}\n", .{err});
        return;
    };
    try out.print("summary: {d} changed, {d} reordered, {d} added, {d} removed, {d} unchanged\n", .{ stats.changed, stats.reordered, stats.added, stats.removed, stats.unchanged });
}

fn cmdServe(io: std.Io, gpa: std.mem.Allocator, out: *std.Io.Writer, it: *std.process.Args.Iterator) !void {
    var opts_port: u16 = 8443;
    var cert: ?[:0]const u8 = null;
    var key: ?[:0]const u8 = null;
    var capture_dir: ?[]const u8 = null;
    var max_connections: u32 = 0;
    while (it.next()) |arg| {
        if (std.mem.eql(u8, arg, "--port")) {
            opts_port = try std.fmt.parseInt(u16, it.next() orelse return fail(out, "--port needs a value\n"), 10);
        } else if (std.mem.eql(u8, arg, "--cert")) {
            cert = it.next() orelse return fail(out, "--cert needs a value\n");
        } else if (std.mem.eql(u8, arg, "--key")) {
            key = it.next() orelse return fail(out, "--key needs a value\n");
        } else if (std.mem.eql(u8, arg, "--capture-dir")) {
            capture_dir = it.next() orelse return fail(out, "--capture-dir needs a value\n");
        } else if (std.mem.eql(u8, arg, "--max-connections")) {
            max_connections = try std.fmt.parseInt(u32, it.next() orelse return fail(out, "--max-connections needs a value\n"), 10);
        } else {
            try out.print("error: unknown serve option {s}\n", .{arg});
            return;
        }
    }
    if (!build_options.openssl) return fail(out, "this build has no OpenSSL (-Dopenssl=false); serve is unavailable\n");
    if (cert == null or key == null) return fail(out, "serve needs --cert and --key\n");

    var ctx: ServeCtx = .{ .io = io, .gpa = gpa, .out = out };
    try out.print("wireprint serve: https://127.0.0.1:{d}/  (ALPN h2 only; capture_dir={s}; max_connections={d})\n", .{ opts_port, capture_dir orelse "(none)", max_connections });
    try out.flush();
    try wireprint.server.listener.serve(io, gpa, .{
        .port = opts_port,
        .cert_path = cert.?,
        .key_path = key.?,
        .capture_dir = capture_dir,
        .max_connections = max_connections,
    }, .{ .ctx = &ctx, .onConnection = ServeCtx.onConnection });
}

const ServeCtx = struct {
    io: std.Io,
    gpa: std.mem.Allocator,
    out: *std.Io.Writer,

    fn onConnection(ctx_ptr: *anyopaque, conn: *wireprint.server.listener.ConnectionInfo) anyerror!void {
        const self: *ServeCtx = @ptrCast(@alignCast(ctx_ptr));
        const report = wireprint.server.report;
        const h2_conn = wireprint.server.h2_conn;
        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        // 1. TLS layer from the MSG_PEEKed record (first record; a ClientHello spanning records is not
        //    expected on any real client but is reported instead of crashing).
        var scratch: [1 << 16]u8 = undefined;
        const msg = wireprint.tls.record.firstHandshakeMessage(conn.record, &scratch) catch |err| blk: {
            std.log.warn("#{d}: handshake message: {t}", .{ conn.seq, err });
            break :blk null;
        };
        const ch: ?wireprint.tls.client_hello.ClientHello = if (msg) |m| wireprint.tls.client_hello.parse(m.bytes) catch |err| blk: {
            std.log.warn("#{d}: ClientHello: {t}", .{ conn.seq, err });
            break :blk null;
        } else null;

        // 2. HTTP/2: server preface, client preface + frames up to the first request.
        const h2io: h2_conn.Io = .{ .ctx = conn, .readExact = wireprint.server.listener.ConnectionInfo.readExactErased, .writeAll = wireprint.server.listener.ConnectionInfo.writeAllErased };
        const req = h2_conn.readFirstRequest(arena, h2io, .{}) catch |err| {
            std.log.warn("#{d}: h2: {t}", .{ conn.seq, err });
            return;
        };

        // 3. Report JSON.
        var body_w: std.Io.Writer.Allocating = .init(arena);
        var js: std.json.Stringify = .{ .writer = &body_w.writer, .options = .{ .whitespace = .indent_2 } };
        try js.beginObject();
        try js.objectField("wireprint");
        try js.write("0.1.0");
        try js.objectField("connection");
        try js.beginObject();
        try js.objectField("seq");
        try js.write(conn.seq);
        try js.objectField("peer");
        try js.print("\"{f}\"", .{conn.peer});
        try js.objectField("record_bytes");
        try js.write(conn.record.len);
        try js.endObject();
        try js.objectField("tls");
        try js.beginObject();
        try js.objectField("handshake");
        try js.beginObject();
        try js.objectField("version");
        try js.write(conn.handshake.version);
        try js.objectField("cipher");
        try js.write(conn.handshake.cipher);
        try js.objectField("alpn");
        try js.write(conn.handshake.alpn);
        try js.objectField("sni");
        try js.write(conn.handshake.sni);
        try js.objectField("session_reused");
        try js.write(conn.handshake.session_reused);
        try js.objectField("hello_retry");
        try js.write(conn.handshake.hello_retry);
        try js.objectField("openssl_recognized_extension_order");
        try js.beginArray();
        for (conn.handshake.openssl_extension_order) |e| try js.write(&hex.u16Hex(e));
        try js.endArray();
        try js.endObject();
        if (ch) |*c| {
            try js.objectField("client_hello");
            try report.clientHello(arena, &js, c);
            try report.fingerprints(arena, &js, c, .tcp, .both);
        } else {
            try js.objectField("client_hello");
            try js.write(null);
        }
        try js.endObject();
        try js.objectField("http2");
        try report.http2(arena, &js, req.obs);
        try js.objectField("http");
        try report.http(arena, &js, req.obs.headers);
        try js.endObject();
        try body_w.writer.writeAll("\n");
        const body = body_w.written();

        // 4. Capture files next to the listener's clienthello-<seq>.bin.
        if (conn.capture_dir) |dir| {
            const h2_name = try std.fmt.allocPrint(arena, "{s}/h2-{d}.bin", .{ dir, conn.seq });
            std.Io.Dir.cwd().writeFile(self.io, .{ .sub_path = h2_name, .data = req.raw }) catch |err| std.log.warn("#{d}: write {s}: {t}", .{ conn.seq, h2_name, err });
            const rep_name = try std.fmt.allocPrint(arena, "{s}/report-{d}.json", .{ dir, conn.seq });
            std.Io.Dir.cwd().writeFile(self.io, .{ .sub_path = rep_name, .data = body }) catch |err| std.log.warn("#{d}: write {s}: {t}", .{ conn.seq, rep_name, err });
        }

        // 5. Answer.
        try h2_conn.respond(arena, h2io, req.obs.headers_stream_id orelse 1, body);

        const ua = report.findHeader(req.obs.headers, "user-agent") orelse "-";
        try self.out.print("#{d} {s} alpn={s} reused={} ext={d} h2frames={d} ua={s}\n", .{
            conn.seq,                             conn.handshake.version,    conn.handshake.alpn orelse "-", conn.handshake.session_reused,
            if (ch) |c| c.extension_count else 0, req.obs.frame_headers.len, ua,
        });
        try self.out.flush();
    }
};
