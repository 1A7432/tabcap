//! Smoke executable for src/server/listener.zig. Not part of build.zig: tools/serve-smoke.sh compiles it with
//! `zig build-exe` against the same module graph the CLI uses (wireprint = src/root.zig + build_options,
//! fixtures, spec). Serves `--max` connections on localhost only.
//!
//! Per successful handshake the handler reads the 24-byte HTTP/2 connection preface (RFC 9113 §3.4) through
//! `ConnectionInfo.readExact` and writes one empty SETTINGS frame (RFC 9113 §6.5) through `writeAll`, then
//! returns so the listener closes the connection. That is all the h2 it speaks, so an h2 client such as
//! `curl --http2` is expected to fail afterwards (typically exit 16, HTTP/2 framing layer).
//!
//! usage: serve-smoke --cert cert.pem --key key.pem [--port 8447] [--max N] [--capture DIR]
const std = @import("std");
const wireprint = @import("wireprint");
const listener = wireprint.server.listener;

pub const std_options: std.Options = .{ .log_level = .debug };

const h2_preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

const State = struct {
    handled: u32 = 0,
};

fn onConnection(ctx: *anyopaque, conn: *listener.ConnectionInfo) anyerror!void {
    const state: *State = @ptrCast(@alignCast(ctx));
    state.handled += 1;

    var buf: [h2_preface.len]u8 = undefined;
    conn.readExact(&buf) catch |err| {
        std.log.info("smoke #{d}: no HTTP/2 preface: {t}", .{ conn.seq, err });
        return;
    };
    const ok = std.mem.eql(u8, &buf, h2_preface);
    std.log.info("smoke #{d}: HTTP/2 preface {s} (record {d} bytes, peer {f})", .{
        conn.seq, if (ok) "matches" else "MISMATCH", conn.record.len, conn.peer,
    });
    if (!ok) return;
    // Empty SETTINGS: length 0, type 0x04, flags 0, stream 0.
    try conn.writeAll(&.{ 0, 0, 0, 0x04, 0, 0, 0, 0, 0 });
    std.log.info("smoke #{d}: wrote empty SETTINGS frame", .{conn.seq});
}

pub fn main(init: std.process.Init) !void {
    var opts: listener.Options = .{ .port = 8447, .cert_path = "", .key_path = "" };

    var it = init.minimal.args.iterate();
    _ = it.skip();
    while (it.next()) |arg| {
        if (std.mem.eql(u8, arg, "--port")) {
            opts.port = try std.fmt.parseInt(u16, it.next() orelse return error.MissingValue, 10);
        } else if (std.mem.eql(u8, arg, "--cert")) {
            opts.cert_path = it.next() orelse return error.MissingValue;
        } else if (std.mem.eql(u8, arg, "--key")) {
            opts.key_path = it.next() orelse return error.MissingValue;
        } else if (std.mem.eql(u8, arg, "--max")) {
            opts.max_connections = try std.fmt.parseInt(u32, it.next() orelse return error.MissingValue, 10);
        } else if (std.mem.eql(u8, arg, "--capture")) {
            opts.capture_dir = it.next() orelse return error.MissingValue;
        } else {
            std.log.err("unknown argument: {s}", .{arg});
            return error.BadArgument;
        }
    }
    if (opts.cert_path.len == 0 or opts.key_path.len == 0) {
        std.log.err("usage: serve-smoke --cert cert.pem --key key.pem [--port 8447] [--max N] [--capture DIR]", .{});
        return error.BadArgument;
    }

    var state: State = .{};
    try listener.serve(init.io, init.gpa, opts, .{ .ctx = &state, .onConnection = onConnection });
    std.log.info("smoke: handler ran {d} time(s)", .{state.handled});
}
