//! wireprint command line, as a function of (arguments, file reader) -> (stdout, stderr, exit code), so
//! `zig build test` exercises every subcommand and exit code without spawning a process (src/main.zig
//! only wires it to the real argv, files and streams).
//!
//!   parse <pcap|bin>      ClientHello fields + JA3 + JA4 (+ TCP SYN fields when the input is a pcap) as JSON
//!   ja3   <pcap|bin>      JA3 string and MD5 only
//!   ja4   <pcap|bin>      JA4 / JA4_r / JA4_o / JA4_ro only
//!   h2    <bin>           HTTP/2 client stream dump (preface + frames): frames, SETTINGS, decoded headers, Akamai
//!   report --client-hello <file> [--h2 <file> | --h1 <file>] [--alpn P] [--sni N] [--peer H:P]
//!                         one per-connection report (the shape profile / check / diff read)
//!   profile ... report.json...   assemble a corpus profile
//!   check --claim <profile.json> <report.json>   cross-layer consistency findings (JSON)
//!   diff [--json] [--raw] <a.json> <b.json>      layer-grouped diff; reports are normalised (GREASE, PSK)
//!
//! Exit codes: 0 success; 1 usage or input error (one `error: ...` line on stderr, nothing on stdout);
//! 3 `check` verdict INCONSISTENT (the JSON is still on stdout).
//!
//! Input detection: a legacy pcap magic (a1b2c3d4 / d4c3b2a1 / a1b23c4d / 4d3cb2a1) selects the pcap path
//! (Ethernet|DLT_NULL -> IP -> TCP -> client-direction reassembly); anything else is treated as a raw
//! client->server TLS record stream (for example the ClientHello bytes tabcap's echo writes).
const std = @import("std");
const hex = @import("hex.zig");
const pcap = @import("pcap.zig");
const tcp_reassembly = @import("net/tcp_reassembly.zig");
const record = @import("tls/record.zig");
const client_hello = @import("tls/client_hello.zig");
const frame = @import("h2/frame.zig");
const report = @import("report.zig");
const profile = @import("profile.zig");
const claim = @import("check/claim.zig");
const diff = @import("diff.zig");

pub const version = "0.1.0";

pub const exit_ok: u8 = 0;
pub const exit_error: u8 = 1;
pub const exit_inconsistent: u8 = 3;

pub const usage =
    \\usage: wireprint <command> [args]
    \\  parse <pcap|bin>                          ClientHello fields, JA3, JA4 (JSON)
    \\  ja3 <pcap|bin>                            JA3 string and MD5 (JSON)
    \\  ja4 <pcap|bin>                            JA4 / JA4_r / JA4_o / JA4_ro (JSON)
    \\  h2 <bin>                                  HTTP/2 client stream: frames, SETTINGS, headers, Akamai (JSON)
    \\  report --client-hello <file> [--h2 <file> | --h1 <file>] [--alpn <proto>] [--sni <name>] [--peer <host:port>]
    \\                                            one per-connection report (JSON)
    \\  profile --name N --version V --os OS --arch A [--channel C] [--os-version X] [--headless]
    \\          [--method M] [--claims ID] [--captured-at T] [--raw-dir D] [--notes T]
    \\          [--server S] [--server-host-os OS] report.json...   assemble a corpus profile (JSON)
    \\  check --claim <profile.json> <report.json>   consistency findings (JSON); exit 3 when INCONSISTENT
    \\  diff [--json] [--raw] <a.json> <b.json>   layer-grouped diff (text, or JSON with --json)
    \\  version                                   print the version
    \\exit codes: 0 ok, 1 usage or input error (message on stderr), 3 check INCONSISTENT
    \\
;

/// Reads a whole file by path; the CLI never opens files any other way (tests pass an in-memory map).
pub const FileReader = struct {
    ptr: *anyopaque,
    readFn: *const fn (ptr: *anyopaque, gpa: std.mem.Allocator, path: []const u8) anyerror![]u8,

    pub fn read(self: FileReader, gpa: std.mem.Allocator, path: []const u8) anyerror![]u8 {
        return self.readFn(self.ptr, gpa, path);
    }
};

pub const Ctx = struct {
    gpa: std.mem.Allocator,
    out: *std.Io.Writer,
    err: *std.Io.Writer,
    files: FileReader,
};

/// Runs one command line (`args` without the program name) and returns the exit code. stdout receives
/// the complete output only when the command succeeded (or for `check`, also when INCONSISTENT).
pub fn run(ctx: Ctx, args: []const []const u8) u8 {
    var arena_state = std.heap.ArenaAllocator.init(ctx.gpa);
    defer arena_state.deinit();
    var r: Runner = .{ .gpa = ctx.gpa, .arena = arena_state.allocator(), .files = ctx.files, .body = .init(arena_state.allocator()) };
    const code = r.dispatch(args) catch |e| {
        const msg = switch (e) {
            error.Failed => r.msg,
            error.OutOfMemory => "out of memory",
            error.WriteFailed => "output write failed",
        };
        ctx.err.print("error: {s}\n", .{msg}) catch {};
        ctx.err.flush() catch {};
        return exit_error;
    };
    if (code == exit_error) {
        ctx.err.writeAll(r.body.written()) catch {};
        ctx.err.flush() catch {};
        return code;
    }
    ctx.out.writeAll(r.body.written()) catch return exit_error;
    ctx.out.flush() catch return exit_error;
    return code;
}

const RunError = error{ Failed, OutOfMemory, WriteFailed };

const Runner = struct {
    gpa: std.mem.Allocator,
    arena: std.mem.Allocator,
    files: FileReader,
    body: std.Io.Writer.Allocating,
    msg: []const u8 = "",

    fn fail(self: *Runner, comptime fmt: []const u8, args: anytype) RunError {
        self.msg = std.fmt.allocPrint(self.arena, fmt, args) catch "out of memory";
        return error.Failed;
    }

    fn out(self: *Runner) *std.Io.Writer {
        return &self.body.writer;
    }

    fn readFile(self: *Runner, path: []const u8) RunError![]u8 {
        return self.files.read(self.arena, path) catch |e| switch (e) {
            error.OutOfMemory => error.OutOfMemory,
            else => self.fail("cannot read {s}: {t}", .{ path, e }),
        };
    }

    fn dispatch(self: *Runner, args: []const []const u8) RunError!u8 {
        if (args.len == 0) {
            // A usage error: the text goes to stderr (run() routes exit_error bodies there).
            try self.out().writeAll(usage);
            return exit_error;
        }
        const cmd = args[0];
        const rest = args[1..];
        if (eql(cmd, "parse")) return self.cmdParse(rest, .parse);
        if (eql(cmd, "ja3")) return self.cmdParse(rest, .ja3);
        if (eql(cmd, "ja4")) return self.cmdParse(rest, .ja4);
        if (eql(cmd, "h2")) return self.cmdH2(rest);
        if (eql(cmd, "report")) return self.cmdReport(rest);
        if (eql(cmd, "profile")) return self.cmdProfile(rest);
        if (eql(cmd, "check")) return self.cmdCheck(rest);
        if (eql(cmd, "diff")) return self.cmdDiff(rest);
        if (eql(cmd, "version") or eql(cmd, "--version")) {
            try self.out().print("wireprint {s}\n", .{version});
            return exit_ok;
        }
        if (eql(cmd, "help") or eql(cmd, "--help") or eql(cmd, "-h")) {
            try self.out().writeAll(usage);
            return exit_ok;
        }
        return self.fail("unknown command {s} (wireprint --help lists the commands)", .{cmd});
    }

    fn onePath(self: *Runner, rest: []const []const u8, what: []const u8) RunError![]const u8 {
        if (rest.len != 1) return self.fail("{s} needs exactly one input file", .{what});
        return rest[0];
    }

    // ---------------------------------------------------------------- parse / ja3 / ja4

    const Mode = enum { parse, ja3, ja4 };

    fn cmdParse(self: *Runner, rest: []const []const u8, mode: Mode) RunError!u8 {
        const path = try self.onePath(rest, @tagName(mode));
        const bytes = try self.readFile(path);
        var stream: []const u8 = bytes;
        var syn: ?tcp_reassembly.SynInfo = null;
        const from_pcap = isPcapMagic(bytes);
        if (from_pcap) {
            var reader = pcap.Reader.init(bytes) catch |e| return self.fail("{s}: pcap: {t}", .{ path, e });
            const first = tcp_reassembly.firstClientPayload(&reader, self.arena) catch |e| return self.fail("{s}: TCP reassembly: {t}", .{ path, e });
            stream = first.payload;
            syn = first.syn;
        }
        var scratch: [1 << 16]u8 = undefined;
        const record0 = record.parseRecord(stream) catch |e| return self.fail("{s}: TLS record: {t}", .{ path, e });
        const msg = record.firstHandshakeMessage(stream, &scratch) catch |e| return self.fail("{s}: handshake message: {t}", .{ path, e });
        const ch = client_hello.parse(msg.bytes) catch |e| return self.fail("{s}: ClientHello: {t}", .{ path, e });

        var js: std.json.Stringify = .{ .writer = self.out(), .options = .{ .whitespace = .indent_2 } };
        try js.beginObject();
        try js.objectField("input");
        try js.write(path);
        try js.objectField("input_kind");
        try js.write(if (from_pcap) "pcap" else "raw-tls-stream");
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
            try js.write(stream.len);
            try js.endObject();
            try js.objectField("client_hello");
            report.clientHello(self.arena, &js, &ch) catch |e| switch (e) {
                error.Truncated, error.Malformed, error.NotClientHello => return self.fail("{s}: ClientHello extension: {t}", .{ path, e }),
                error.OutOfMemory => return error.OutOfMemory,
                error.WriteFailed => return error.WriteFailed,
            };
            if (syn) |s| {
                try js.objectField("tcp_syn");
                try report.tcpSyn(self.arena, &js, s);
            }
        }
        try report.fingerprints(self.arena, &js, &ch, .tcp, switch (mode) {
            .parse => .both,
            .ja3 => .ja3,
            .ja4 => .ja4,
        });
        try js.endObject();
        try self.out().writeAll("\n");
        return exit_ok;
    }

    // ---------------------------------------------------------------- h2

    fn cmdH2(self: *Runner, rest: []const []const u8) RunError!u8 {
        const path = try self.onePath(rest, "h2");
        const bytes = try self.readFile(path);
        const after = frame.stripPreface(bytes) catch |e| return self.fail("{s}: preface: {t}", .{ path, e });
        const obs = try report.collectH2(self.arena, after);
        var js: std.json.Stringify = .{ .writer = self.out(), .options = .{ .whitespace = .indent_2 } };
        try js.beginObject();
        try js.objectField("input");
        try js.write(path);
        try js.objectField("http2");
        try report.http2(self.arena, &js, obs);
        try js.objectField("http");
        try report.http(self.arena, &js, obs.headers, "2");
        try js.endObject();
        try self.out().writeAll("\n");
        return exit_ok;
    }

    // ---------------------------------------------------------------- report

    fn value(self: *Runner, rest: []const []const u8, i: *usize, flag: []const u8) RunError![]const u8 {
        i.* += 1;
        if (i.* >= rest.len) return self.fail("{s} needs a value", .{flag});
        return rest[i.*];
    }

    fn cmdReport(self: *Runner, rest: []const []const u8) RunError!u8 {
        var ch_path: ?[]const u8 = null;
        var h2_path: ?[]const u8 = null;
        var h1_path: ?[]const u8 = null;
        var in: report.ReportInput = .{ .client_hello = "" };
        var i: usize = 0;
        while (i < rest.len) : (i += 1) {
            const a = rest[i];
            if (eql(a, "--client-hello")) {
                ch_path = try self.value(rest, &i, a);
            } else if (eql(a, "--h2")) {
                h2_path = try self.value(rest, &i, a);
            } else if (eql(a, "--h1")) {
                h1_path = try self.value(rest, &i, a);
            } else if (eql(a, "--alpn")) {
                in.alpn = try self.value(rest, &i, a);
            } else if (eql(a, "--sni")) {
                in.sni = try self.value(rest, &i, a);
            } else if (eql(a, "--peer")) {
                in.peer = try self.value(rest, &i, a);
            } else return self.fail("report: unexpected argument {s}", .{a});
        }
        const chp = ch_path orelse return self.fail("report needs --client-hello <file>", .{});
        if (h1_path != null and h2_path != null) return self.fail("report takes --h2 or --h1, not both", .{});
        in.client_hello = try self.readFile(chp);
        if (h2_path) |p| in.h2 = try self.readFile(p);
        if (h1_path) |p| in.h1 = try self.readFile(p);
        var js: std.json.Stringify = .{ .writer = self.out(), .options = .{ .whitespace = .indent_2 } };
        report.writeReport(self.arena, &js, in) catch |e| switch (e) {
            error.BadClientHello => return self.fail("{s}: not a complete TLS ClientHello", .{chp}),
            error.BadH2 => return self.fail("{s}: does not start with the HTTP/2 connection preface", .{h2_path orelse "--h2"}),
            error.BadH1 => return self.fail("{s}: not an HTTP/1.1 request head", .{h1_path orelse "--h1"}),
            error.BothH1AndH2 => return self.fail("report takes --h2 or --h1, not both", .{}),
            error.OutOfMemory => return error.OutOfMemory,
            error.WriteFailed => return error.WriteFailed,
        };
        try self.out().writeAll("\n");
        return exit_ok;
    }

    // ---------------------------------------------------------------- profile

    fn parseJsonFile(self: *Runner, path: []const u8) RunError!std.json.Value {
        const text = try self.readFile(path);
        return std.json.parseFromSliceLeaky(std.json.Value, self.arena, text, .{}) catch |e| switch (e) {
            error.OutOfMemory => error.OutOfMemory,
            else => self.fail("{s}: not JSON ({t})", .{ path, e }),
        };
    }

    fn cmdProfile(self: *Runner, rest: []const []const u8) RunError!u8 {
        var meta: profile.Meta = .{ .name = "", .version = "", .os = "", .arch = "" };
        var files: std.ArrayList([]const u8) = .empty;
        var i: usize = 0;
        while (i < rest.len) : (i += 1) {
            const a = rest[i];
            if (eql(a, "--name")) {
                meta.name = try self.value(rest, &i, a);
            } else if (eql(a, "--version")) {
                meta.version = try self.value(rest, &i, a);
            } else if (eql(a, "--os")) {
                meta.os = try self.value(rest, &i, a);
            } else if (eql(a, "--os-version")) {
                meta.os_version = try self.value(rest, &i, a);
            } else if (eql(a, "--arch")) {
                meta.arch = try self.value(rest, &i, a);
            } else if (eql(a, "--channel")) {
                meta.channel = try self.value(rest, &i, a);
            } else if (eql(a, "--kind")) {
                meta.kind = try self.value(rest, &i, a);
            } else if (eql(a, "--claims")) {
                meta.claims = try self.value(rest, &i, a);
            } else if (eql(a, "--method")) {
                meta.method = try self.value(rest, &i, a);
            } else if (eql(a, "--captured-at")) {
                meta.captured_at = try self.value(rest, &i, a);
            } else if (eql(a, "--raw-dir")) {
                meta.raw_dir = try self.value(rest, &i, a);
            } else if (eql(a, "--notes")) {
                meta.notes = try self.value(rest, &i, a);
            } else if (eql(a, "--server")) {
                meta.server = try self.value(rest, &i, a);
            } else if (eql(a, "--server-host-os")) {
                meta.server_host_os = try self.value(rest, &i, a);
            } else if (eql(a, "--headless")) {
                meta.headless = true;
            } else if (std.mem.startsWith(u8, a, "--")) {
                return self.fail("unknown profile option {s}", .{a});
            } else {
                try files.append(self.arena, a);
            }
        }
        if (meta.name.len == 0 or meta.version.len == 0 or meta.os.len == 0 or meta.arch.len == 0) return self.fail("profile needs --name, --version, --os and --arch", .{});
        if (files.items.len == 0) return self.fail("profile needs at least one report.json", .{});
        var values: std.ArrayList(std.json.Value) = .empty;
        for (files.items) |path| try values.append(self.arena, try self.parseJsonFile(path));
        var js: std.json.Stringify = .{ .writer = self.out(), .options = .{ .whitespace = .indent_2 } };
        profile.assemble(self.arena, &js, values.items, meta) catch |e| switch (e) {
            error.EmptyInput => return self.fail("profile needs at least one report.json", .{}),
            error.NotAReport => return self.fail("profile: the first input has no tls.client_hello (not a report)", .{}),
            error.OutOfMemory => return error.OutOfMemory,
            error.WriteFailed => return error.WriteFailed,
        };
        try self.out().writeAll("\n");
        return exit_ok;
    }

    // ---------------------------------------------------------------- check

    fn cmdCheck(self: *Runner, rest: []const []const u8) RunError!u8 {
        var claim_path: ?[]const u8 = null;
        var report_path: ?[]const u8 = null;
        var i: usize = 0;
        while (i < rest.len) : (i += 1) {
            const a = rest[i];
            if (eql(a, "--claim")) {
                claim_path = try self.value(rest, &i, a);
            } else if (std.mem.startsWith(u8, a, "--")) {
                return self.fail("unknown check option {s}", .{a});
            } else if (report_path == null) {
                report_path = a;
            } else return self.fail("check takes one report", .{});
        }
        const pp = claim_path orelse return self.fail("usage: check --claim <profile.json> <report.json>", .{});
        const rp = report_path orelse return self.fail("usage: check --claim <profile.json> <report.json>", .{});
        const p = try self.parseJsonFile(pp);
        const r = try self.parseJsonFile(rp);
        if (p != .object) return self.fail("{s}: not a profile (no JSON object)", .{pp});
        if (r != .object) return self.fail("{s}: not a report (no JSON object)", .{rp});
        var findings: std.ArrayList(claim.Finding) = .empty;
        try claim.checkClaim(self.arena, r, p, &findings);
        var red: usize = 0;
        var warn: usize = 0;
        for (findings.items) |f| switch (f.severity) {
            .red => red += 1,
            .warn => warn += 1,
            .info => {},
        };
        var js: std.json.Stringify = .{ .writer = self.out(), .options = .{ .whitespace = .indent_2 } };
        try js.beginObject();
        try js.objectField("claim");
        try js.write(if (p.object.get("id")) |id| (if (id == .string) id.string else null) else null);
        try js.objectField("verdict");
        try js.write(if (red == 0) "CONSISTENT" else "INCONSISTENT");
        try js.objectField("red");
        try js.write(red);
        try js.objectField("warn");
        try js.write(warn);
        try js.objectField("findings");
        try claim.writeFindings(&js, findings.items);
        try js.endObject();
        try self.out().writeAll("\n");
        return if (red == 0) exit_ok else exit_inconsistent;
    }

    // ---------------------------------------------------------------- diff

    fn cmdDiff(self: *Runner, rest: []const []const u8) RunError!u8 {
        var json = false;
        var raw = false;
        var paths: [2][]const u8 = undefined;
        var n: usize = 0;
        for (rest) |a| {
            if (eql(a, "--json")) {
                json = true;
            } else if (eql(a, "--raw")) {
                raw = true;
            } else if (std.mem.startsWith(u8, a, "--")) {
                return self.fail("unknown diff option {s}", .{a});
            } else {
                if (n == 2) return self.fail("diff needs exactly two files", .{});
                paths[n] = a;
                n += 1;
            }
        }
        if (n != 2) return self.fail("diff needs exactly two files", .{});
        const a = try self.parseJsonFile(paths[0]);
        const b = try self.parseJsonFile(paths[1]);
        const res = try diff.compare(self.arena, a, b, .{ .normalize = !raw });
        if (json) {
            var js: std.json.Stringify = .{ .writer = self.out(), .options = .{ .whitespace = .indent_2 } };
            try diff.writeJson(&js, res);
            try self.out().writeAll("\n");
        } else {
            try diff.writeText(self.out(), res, .{});
        }
        return exit_ok;
    }
};

fn eql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

fn isPcapMagic(bytes: []const u8) bool {
    if (bytes.len < 4) return false;
    const m = std.mem.readInt(u32, bytes[0..4], .big);
    return m == 0xa1b2c3d4 or m == 0xd4c3b2a1 or m == 0xa1b23c4d or m == 0x4d3cb2a1;
}

// ---------------------------------------------------------------- tests

const testing = std.testing;
const fixtures = @import("fixtures");

/// In-memory files for the CLI tests: inputs are fixtures; outputs of one command become inputs of the next.
const MemFiles = struct {
    map: std.StringHashMapUnmanaged([]const u8) = .empty,
    arena: std.heap.ArenaAllocator,

    fn init() MemFiles {
        return .{ .arena = std.heap.ArenaAllocator.init(testing.allocator) };
    }
    fn deinit(self: *MemFiles) void {
        self.arena.deinit();
    }
    fn put(self: *MemFiles, path: []const u8, bytes: []const u8) !void {
        const a = self.arena.allocator();
        try self.map.put(a, try a.dupe(u8, path), try a.dupe(u8, bytes));
    }
    fn readFn(ptr: *anyopaque, gpa: std.mem.Allocator, path: []const u8) anyerror![]u8 {
        const self: *MemFiles = @ptrCast(@alignCast(ptr));
        const bytes = self.map.get(path) orelse return error.FileNotFound;
        return gpa.dupe(u8, bytes);
    }
    fn reader(self: *MemFiles) FileReader {
        return .{ .ptr = self, .readFn = readFn };
    }
};

const Ran = struct {
    code: u8,
    out: []const u8,
    err: []const u8,
};

fn runIn(files: *MemFiles, args: []const []const u8) !Ran {
    const a = files.arena.allocator();
    var out: std.Io.Writer.Allocating = .init(a);
    var err: std.Io.Writer.Allocating = .init(a);
    const code = run(.{ .gpa = testing.allocator, .out = &out.writer, .err = &err.writer, .files = files.reader() }, args);
    return .{ .code = code, .out = out.written(), .err = err.written() };
}

fn jsonGet(v: std.json.Value, path: []const []const u8) ?std.json.Value {
    var cur = v;
    for (path) |k| {
        if (cur != .object) return null;
        cur = cur.object.get(k) orelse return null;
    }
    return cur;
}

fn putCftFixtures(files: *MemFiles) !void {
    try files.put("nav1.ch", fixtures.clienthello.cft_155_macos_nav_1);
    try files.put("nav2.ch", fixtures.clienthello.cft_155_macos_nav_2);
    try files.put("psk.ch", fixtures.clienthello.cft_155_macos_psk);
    try files.put("nav.h2", fixtures.h2.cft_155_macos_nav);
    try files.put("favicon.h2", fixtures.h2.cft_155_macos_favicon);
    try files.put("get.h1", fixtures.h1.get_basic);
}

test "exit codes: usage and input errors are 1 with stderr only; help and version are 0" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);

    var r = try runIn(&files, &.{});
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);
    try testing.expect(std.mem.indexOf(u8, r.err, "usage:") != null);

    r = try runIn(&files, &.{"bogus"});
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);
    try testing.expect(std.mem.startsWith(u8, r.err, "error: unknown command bogus"));

    r = try runIn(&files, &.{ "parse", "missing.bin" });
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);
    try testing.expect(std.mem.startsWith(u8, r.err, "error: cannot read missing.bin"));

    // Not a ClientHello: the h2 bytes start with "PRI " (0x50), which is no TLS record content type.
    r = try runIn(&files, &.{ "parse", "nav.h2" });
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);

    r = try runIn(&files, &.{ "h2", "nav1.ch" });
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);

    r = try runIn(&files, &.{ "diff", "only-one.json" });
    try testing.expectEqual(exit_error, r.code);
    r = try runIn(&files, &.{ "check", "x.json" });
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);
    r = try runIn(&files, &.{ "report", "--h2", "nav.h2" });
    try testing.expectEqual(exit_error, r.code);
    try testing.expect(std.mem.indexOf(u8, r.err, "--client-hello") != null);
    r = try runIn(&files, &.{ "report", "--client-hello", "nav1.ch", "--h2", "nav.h2", "--h1", "get.h1" });
    try testing.expectEqual(exit_error, r.code);
    r = try runIn(&files, &.{ "report", "--client-hello", "nav.h2" });
    try testing.expectEqual(exit_error, r.code);
    try testing.expectEqualStrings("", r.out);
    r = try runIn(&files, &.{ "report", "--client-hello", "nav1.ch", "--h2", "get.h1" });
    try testing.expectEqual(exit_error, r.code);
    r = try runIn(&files, &.{ "report", "--client-hello", "nav1.ch", "--h1", "nav.h2" });
    try testing.expectEqual(exit_error, r.code);
    r = try runIn(&files, &.{ "profile", "--name", "x", "nav1.ch" });
    try testing.expectEqual(exit_error, r.code);

    r = try runIn(&files, &.{"--help"});
    try testing.expectEqual(exit_ok, r.code);
    try testing.expect(std.mem.indexOf(u8, r.out, "usage:") != null);
    try testing.expectEqualStrings("", r.err);
    r = try runIn(&files, &.{"version"});
    try testing.expectEqual(exit_ok, r.code);
    try testing.expectEqualStrings("wireprint 0.1.0\n", r.out);

    r = try runIn(&files, &.{ "ja4", "nav1.ch" });
    try testing.expectEqual(exit_ok, r.code);
    try testing.expectEqualStrings("", r.err);
}

// `report` over the spike's CfT 155 navigation bytes. Expected values: the Akamai string and the
// header order are what the decrypted stream carries (the spike's `wireprint h2` reading of the same
// file, and the chrome-153 oracle string, which CfT 155 shares); JA4 must equal what `ja4` prints for
// the same ClientHello (one implementation, two entry points).
test "report: h2 navigation from CfT 155 carries the serve-shaped layers" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);
    const r = try runIn(&files, &.{ "report", "--client-hello", "nav1.ch", "--h2", "nav.h2", "--alpn", "h2", "--sni", "localhost", "--peer", "127.0.0.1:57608" });
    try testing.expectEqual(exit_ok, r.code);
    try testing.expectEqualStrings("", r.err);
    const a = files.arena.allocator();
    const v = try std.json.parseFromSliceLeaky(std.json.Value, a, r.out, .{});
    try testing.expectEqualStrings("h2", jsonGet(v, &.{ "tls", "handshake", "alpn" }).?.string);
    try testing.expectEqualStrings("localhost", jsonGet(v, &.{ "tls", "handshake", "sni" }).?.string);
    try testing.expectEqualStrings("127.0.0.1:57608", jsonGet(v, &.{ "connection", "peer" }).?.string);
    try testing.expectEqual(@as(i64, fixtures.clienthello.cft_155_macos_nav_1.len), jsonGet(v, &.{ "connection", "record_bytes" }).?.integer);
    try testing.expectEqualStrings("localhost", jsonGet(v, &.{ "tls", "client_hello", "server_name" }).?.string);
    try testing.expectEqualStrings("1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p", jsonGet(v, &.{ "http2", "akamai" }).?.string);
    try testing.expectEqualStrings("2", jsonGet(v, &.{ "http", "version" }).?.string);
    const order = jsonGet(v, &.{ "http", "headers_order" }).?.array.items;
    try testing.expectEqualStrings(":method", order[0].string);
    try testing.expectEqualStrings("sec-ch-ua", order[4].string);
    try testing.expectEqualStrings("priority", order[order.len - 1].string);

    const j = try runIn(&files, &.{ "ja4", "nav1.ch" });
    const jv = try std.json.parseFromSliceLeaky(std.json.Value, a, j.out, .{});
    try testing.expectEqualStrings(jsonGet(jv, &.{ "ja4", "ja4" }).?.string, jsonGet(v, &.{ "tls", "ja4", "ja4" }).?.string);
    try testing.expect(std.mem.startsWith(u8, jsonGet(v, &.{ "tls", "ja4", "ja4" }).?.string, "t13d"));
}

test "report: an HTTP/1.1 head (no ALPN) gives http version 1.1, names in wire case, no http2" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);
    const r = try runIn(&files, &.{ "report", "--client-hello", "nav1.ch", "--h1", "get.h1" });
    try testing.expectEqual(exit_ok, r.code);
    const v = try std.json.parseFromSliceLeaky(std.json.Value, files.arena.allocator(), r.out, .{});
    try testing.expect(jsonGet(v, &.{"http2"}).? == .null);
    try testing.expect(jsonGet(v, &.{ "tls", "handshake", "alpn" }).? == .null);
    try testing.expectEqualStrings("1.1", jsonGet(v, &.{ "http", "version" }).?.string);
    const order = jsonGet(v, &.{ "http", "headers_order" }).?.array.items;
    try testing.expectEqualStrings("Host", order[0].string);
    try testing.expectEqualStrings("Cookie", order[5].string);
    try testing.expectEqualStrings("python-httpx/0.28.1", jsonGet(v, &.{ "http", "user_agent" }).?.string);
    // The Cookie value is never printed (allow-list), only its name.
    try testing.expect(std.mem.indexOf(u8, r.out, "synthetic") == null);
}

fn reportTo(files: *MemFiles, out_path: []const u8, args: []const []const u8) !void {
    const r = try runIn(files, args);
    try testing.expectEqual(exit_ok, r.code);
    try files.put(out_path, r.out);
}

test "profile: one first-connection sample leaves the extension order unknown and check skips T4" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);
    try reportTo(&files, "nav1.json", &.{ "report", "--client-hello", "nav1.ch", "--h2", "nav.h2", "--alpn", "h2", "--sni", "localhost" });
    try reportTo(&files, "nav2.json", &.{ "report", "--client-hello", "nav2.ch", "--h2", "nav.h2", "--alpn", "h2", "--sni", "localhost" });
    try reportTo(&files, "psk.json", &.{ "report", "--client-hello", "psk.ch", "--h2", "favicon.h2", "--alpn", "h2", "--sni", "localhost" });
    const a = files.arena.allocator();
    const meta = [_][]const u8{ "profile", "--name", "chrome", "--version", "155.0.8059.79", "--os", "macos", "--arch", "arm64" };

    // nav1 (first) + psk (resumed): one first-connection sample → unknown, randomized null.
    var r = try runIn(&files, &(meta ++ [_][]const u8{ "nav1.json", "psk.json" }));
    try testing.expectEqual(exit_ok, r.code);
    var v = try std.json.parseFromSliceLeaky(std.json.Value, a, r.out, .{});
    try testing.expectEqualStrings("unknown", jsonGet(v, &.{ "tls", "client_hello", "extension_order" }).?.string);
    try testing.expect(jsonGet(v, &.{ "tls", "client_hello", "extension_order_randomized" }).? == .null);
    try files.put("one.profile", r.out);

    // nav1 + nav2: two first connections with different real orders → randomized.
    r = try runIn(&files, &(meta ++ [_][]const u8{ "nav1.json", "nav2.json" }));
    v = try std.json.parseFromSliceLeaky(std.json.Value, a, r.out, .{});
    try testing.expectEqualStrings("randomized", jsonGet(v, &.{ "tls", "client_hello", "extension_order" }).?.string);
    try testing.expectEqual(true, jsonGet(v, &.{ "tls", "client_hello", "extension_order_randomized" }).?.bool);

    // check nav2 against the one-sample profile: no T4 red (order unknown), JSON on stdout, exit 0.
    const c = try runIn(&files, &.{ "check", "--claim", "one.profile", "nav2.json" });
    try testing.expectEqual(exit_ok, c.code);
    const cv = try std.json.parseFromSliceLeaky(std.json.Value, a, c.out, .{});
    try testing.expectEqualStrings("CONSISTENT", jsonGet(cv, &.{"verdict"}).?.string);
    try testing.expectEqualStrings("chrome/155/macos-arm64/155.0.8059.79", jsonGet(cv, &.{"claim"}).?.string);
    for (jsonGet(cv, &.{"findings"}).?.array.items) |f| {
        if (std.mem.eql(u8, jsonGet(f, &.{"rule"}).?.string, "T4")) try testing.expectEqualStrings("info", jsonGet(f, &.{"severity"}).?.string);
    }
}

test "check: INCONSISTENT exits 3 with the JSON still on stdout" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);
    try reportTo(&files, "nav1.json", &.{ "report", "--client-hello", "nav1.ch", "--h2", "nav.h2", "--alpn", "h2" });
    try reportTo(&files, "h1.json", &.{ "report", "--client-hello", "nav1.ch", "--h1", "get.h1" });
    const p = try runIn(&files, &.{ "profile", "--name", "chrome", "--version", "155.0.8059.79", "--os", "macos", "--arch", "arm64", "nav1.json" });
    try files.put("p.json", p.out);
    // Same TLS bytes, but an HTTP/1.1 request with python-httpx headers: the header layer disagrees.
    const r = try runIn(&files, &.{ "check", "--claim", "p.json", "h1.json" });
    try testing.expectEqual(exit_inconsistent, r.code);
    try testing.expectEqualStrings("", r.err);
    const v = try std.json.parseFromSliceLeaky(std.json.Value, files.arena.allocator(), r.out, .{});
    try testing.expectEqualStrings("INCONSISTENT", jsonGet(v, &.{"verdict"}).?.string);
    try testing.expect(jsonGet(v, &.{"red"}).?.integer > 0);
}

test "diff: two CfT first connections differ in nothing once GREASE is stripped; PSK is a label" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);
    try reportTo(&files, "nav1.json", &.{ "report", "--client-hello", "nav1.ch", "--h2", "nav.h2", "--alpn", "h2", "--sni", "localhost" });
    try reportTo(&files, "nav2.json", &.{ "report", "--client-hello", "nav2.ch", "--h2", "nav.h2", "--alpn", "h2", "--sni", "localhost" });
    try reportTo(&files, "psk.json", &.{ "report", "--client-hello", "psk.ch", "--h2", "nav.h2", "--alpn", "h2", "--sni", "localhost" });
    const a = files.arena.allocator();

    var r = try runIn(&files, &.{ "diff", "--json", "nav1.json", "nav2.json" });
    try testing.expectEqual(exit_ok, r.code);
    var v = try std.json.parseFromSliceLeaky(std.json.Value, a, r.out, .{});
    try testing.expectEqual(@as(usize, 0), jsonGet(v, &.{"differences"}).?.array.items.len);
    try testing.expectEqual(@as(usize, 0), jsonGet(v, &.{"labels"}).?.array.items.len);
    try testing.expectEqual(true, jsonGet(v, &.{"normalized"}).?.bool);

    // Raw (no normalisation): GREASE values and the permuted order show up as noise.
    r = try runIn(&files, &.{ "diff", "--json", "--raw", "nav1.json", "nav2.json" });
    v = try std.json.parseFromSliceLeaky(std.json.Value, a, r.out, .{});
    try testing.expect(jsonGet(v, &.{"differences"}).?.array.items.len > 0);

    // First connection vs resumption: one `psk` label, and no field difference in the TLS layer.
    r = try runIn(&files, &.{ "diff", "--json", "nav1.json", "psk.json" });
    v = try std.json.parseFromSliceLeaky(std.json.Value, a, r.out, .{});
    const labels = jsonGet(v, &.{"labels"}).?.array.items;
    try testing.expectEqual(@as(usize, 1), labels.len);
    try testing.expectEqualStrings("psk", jsonGet(labels[0], &.{"label"}).?.string);
    try testing.expectEqual(false, jsonGet(labels[0], &.{"a"}).?.bool);
    try testing.expectEqual(true, jsonGet(labels[0], &.{"b"}).?.bool);
    for (jsonGet(v, &.{"differences"}).?.array.items) |d| {
        const path = jsonGet(d, &.{"path"}).?.string;
        if (std.mem.startsWith(u8, path, "tls")) {
            std.debug.print("unexpected TLS difference first vs PSK: {s}\n", .{path});
            return error.TestUnexpectedResult;
        }
    }

    // Text mode prints the label and never "reordered" for the two first connections.
    r = try runIn(&files, &.{ "diff", "nav1.json", "nav2.json" });
    try testing.expectEqual(exit_ok, r.code);
    try testing.expect(std.mem.indexOf(u8, r.out, "reordered (") == null);
    try testing.expect(std.mem.indexOf(u8, r.out, "summary: 0 changed, 0 reordered, 0 added, 0 removed") != null);
}

test "diff: a browser navigation vs an HTTP/1.1 client differs in the http2 and http layers" {
    var files = MemFiles.init();
    defer files.deinit();
    try putCftFixtures(&files);
    try reportTo(&files, "nav1.json", &.{ "report", "--client-hello", "nav1.ch", "--h2", "nav.h2", "--alpn", "h2" });
    try reportTo(&files, "h1.json", &.{ "report", "--client-hello", "nav1.ch", "--h1", "get.h1" });
    const r = try runIn(&files, &.{ "diff", "--json", "nav1.json", "h1.json" });
    try testing.expectEqual(exit_ok, r.code);
    const v = try std.json.parseFromSliceLeaky(std.json.Value, files.arena.allocator(), r.out, .{});
    var saw_h2 = false;
    var saw_http = false;
    var saw_alpn = false;
    for (jsonGet(v, &.{"differences"}).?.array.items) |d| {
        const path = jsonGet(d, &.{"path"}).?.string;
        if (std.mem.eql(u8, path, "http2")) saw_h2 = true;
        if (std.mem.startsWith(u8, path, "http.")) saw_http = true;
        if (std.mem.eql(u8, path, "tls.handshake.alpn")) saw_alpn = true;
    }
    try testing.expect(saw_h2 and saw_http and saw_alpn);
}
