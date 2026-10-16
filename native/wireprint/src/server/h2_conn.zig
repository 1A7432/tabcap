//! Minimal HTTP/2 server side for the echo server (RFC 9113, https://www.rfc-editor.org/rfc/rfc9113.txt).
//!
//! Flow (one connection, blocking I/O over the TLS connection):
//!   1. send the server connection preface: an empty SETTINGS frame (§3.4);
//!   2. read the client preface (24 bytes, §3.4) and then whole frames until the first request header block
//!      is complete (HEADERS with END_HEADERS, or the CONTINUATION carrying END_HEADERS, §6.2 / §6.10);
//!      every non-ACK SETTINGS is acknowledged (§6.5.3) as it arrives, everything read is appended to the
//!      raw capture so the fingerprint layer sees exactly the bytes the client sent;
//!   3. the caller builds the JSON report and calls `respond`: HEADERS (:status 200, content-type,
//!      content-length; HPACK literal-without-indexing / static indexes only, no Huffman, §6.2 / RFC 7541
//!      §6.2.2) + DATA with END_STREAM (§6.1) + GOAWAY NO_ERROR (§6.8).
//! Fingerprint observations are derived by `report.collectH2` from the captured bytes, so `wireprint h2`
//! on the capture file and the live server produce identical results.
const std = @import("std");
const frame = @import("../h2/frame.zig");
const report = @import("report.zig");

/// Blocking read/write callbacks over the TLS connection.
pub const Io = struct {
    ctx: *anyopaque,
    readExact: *const fn (ctx: *anyopaque, buf: []u8) anyerror!void,
    writeAll: *const fn (ctx: *anyopaque, bytes: []const u8) anyerror!void,

    fn read(self: Io, buf: []u8) anyerror!void {
        return self.readExact(self.ctx, buf);
    }
    fn write(self: Io, bytes: []const u8) anyerror!void {
        return self.writeAll(self.ctx, bytes);
    }
};

pub const Limits = struct {
    max_frames: usize = 64,
    max_bytes: usize = 256 * 1024,
    max_frame_payload: usize = 16384, // SETTINGS_MAX_FRAME_SIZE default (§6.5.2), we never advertise more
};

pub const Error = error{ BadPreface, TooManyFrames, TooManyBytes, FrameTooLarge, NoRequest } || std.mem.Allocator.Error;

pub const FirstRequest = struct {
    /// Exactly what the client sent: preface + every frame up to the end of the first header block.
    raw: []const u8,
    obs: report.H2Observation,
};

const empty_settings = [_]u8{ 0, 0, 0, 0x04, 0x00, 0, 0, 0, 0 };
const settings_ack = [_]u8{ 0, 0, 0, 0x04, 0x01, 0, 0, 0, 0 };

/// Sends the server preface, reads the client preface and frames until the first request headers are
/// complete, and returns the raw bytes plus the decoded observation (allocated in `arena`).
pub fn readFirstRequest(arena: std.mem.Allocator, io: Io, limits: Limits) anyerror!FirstRequest {
    try io.write(&empty_settings);

    var raw: std.ArrayList(u8) = .empty;
    var preface: [24]u8 = undefined;
    try io.read(&preface);
    if (!std.mem.eql(u8, &preface, frame.preface)) return error.BadPreface;
    try raw.appendSlice(arena, &preface);

    var frames: usize = 0;
    var headers_stream: ?u31 = null;
    var done = false;
    while (!done) {
        if (frames >= limits.max_frames) return error.TooManyFrames;
        var hdr: [frame.frame_header_len]u8 = undefined;
        try io.read(&hdr);
        const fh = frame.parseFrameHeader(&hdr);
        if (fh.length > limits.max_frame_payload) return error.FrameTooLarge;
        if (raw.items.len + hdr.len + fh.length > limits.max_bytes) return error.TooManyBytes;
        try raw.appendSlice(arena, &hdr);
        const payload = try arena.alloc(u8, fh.length);
        try io.read(payload);
        try raw.appendSlice(arena, payload);
        frames += 1;

        switch (@as(frame.FrameType, @enumFromInt(fh.type))) {
            .settings => if (fh.flags & frame.Flags.ack == 0) try io.write(&settings_ack),
            .headers => {
                headers_stream = fh.stream_id;
                if (fh.flags & frame.Flags.end_headers != 0) done = true;
            },
            .continuation => if (headers_stream != null and fh.flags & frame.Flags.end_headers != 0) {
                done = true;
            },
            .goaway => return error.NoRequest,
            else => {},
        }
    }

    const obs = try report.collectH2(arena, raw.items[24..]);
    return .{ .raw = raw.items, .obs = obs };
}

/// HPACK literal header field without indexing, indexed name (RFC 7541 §6.2.2), raw (non-Huffman) value.
fn appendLiteralIndexedName(out: *std.ArrayList(u8), arena: std.mem.Allocator, static_index: u8, value: []const u8) !void {
    // 4-bit prefix integer for the name index.
    if (static_index < 15) {
        try out.append(arena, static_index);
    } else {
        try out.append(arena, 0x0f);
        try out.append(arena, @intCast(static_index - 15)); // all our indexes are < 15 + 128
    }
    // String literal: H=0, 7-bit prefix length.
    if (value.len < 127) {
        try out.append(arena, @intCast(value.len));
    } else {
        try out.append(arena, 0x7f);
        var rest = value.len - 127;
        while (rest >= 128) : (rest >>= 7) try out.append(arena, @intCast((rest & 0x7f) | 0x80));
        try out.append(arena, @intCast(rest));
    }
    try out.appendSlice(arena, value);
}

fn frameHeader(out: *std.ArrayList(u8), arena: std.mem.Allocator, length: usize, ftype: u8, flags: u8, stream_id: u31) !void {
    const len: u24 = @intCast(length);
    try out.appendSlice(arena, &.{ @intCast(len >> 16), @intCast((len >> 8) & 0xff), @intCast(len & 0xff), ftype, flags });
    var sid: [4]u8 = undefined;
    std.mem.writeInt(u32, &sid, stream_id, .big);
    try out.appendSlice(arena, &sid);
}

/// Sends a 200 application/json response with `body` on `stream_id`, then GOAWAY(NO_ERROR).
pub fn respond(arena: std.mem.Allocator, io: Io, stream_id: u31, body: []const u8) anyerror!void {
    var block: std.ArrayList(u8) = .empty;
    try block.append(arena, 0x88); // indexed: static table 8 = ":status: 200" (RFC 7541 Appendix A)
    try appendLiteralIndexedName(&block, arena, 31, "application/json; charset=utf-8"); // 31 = content-type
    var len_buf: [20]u8 = undefined;
    const len_str = try std.fmt.bufPrint(&len_buf, "{d}", .{body.len});
    try appendLiteralIndexedName(&block, arena, 28, len_str); // 28 = content-length
    try appendLiteralIndexedName(&block, arena, 24, "no-store"); // 24 = cache-control
    try appendLiteralIndexedName(&block, arena, 54, "wireprint"); // 54 = server

    var out: std.ArrayList(u8) = .empty;
    try frameHeader(&out, arena, block.items.len, @intFromEnum(frame.FrameType.headers), frame.Flags.end_headers, stream_id);
    try out.appendSlice(arena, block.items);
    var pos: usize = 0;
    while (true) {
        const chunk = @min(body.len - pos, 16384);
        const last = pos + chunk == body.len;
        try frameHeader(&out, arena, chunk, @intFromEnum(frame.FrameType.data), if (last) frame.Flags.end_stream else 0, stream_id);
        try out.appendSlice(arena, body[pos .. pos + chunk]);
        pos += chunk;
        if (last) break;
    }
    // GOAWAY: last_stream_id = stream_id, error NO_ERROR (0), no debug data.
    try frameHeader(&out, arena, 8, @intFromEnum(frame.FrameType.goaway), 0, 0);
    var tail: [8]u8 = undefined;
    std.mem.writeInt(u32, tail[0..4], stream_id, .big);
    std.mem.writeInt(u32, tail[4..8], 0, .big);
    try out.appendSlice(arena, &tail);
    try io.write(out.items);
}

// ---- tests: drive readFirstRequest / respond over an in-memory pipe made from the real Chrome capture ----

const MemIo = struct {
    input: []const u8,
    pos: usize = 0,
    written: std.ArrayList(u8) = .empty,
    gpa: std.mem.Allocator,

    fn readExact(ctx: *anyopaque, buf: []u8) anyerror!void {
        const self: *MemIo = @ptrCast(@alignCast(ctx));
        if (self.pos + buf.len > self.input.len) return error.EndOfStream;
        @memcpy(buf, self.input[self.pos .. self.pos + buf.len]);
        self.pos += buf.len;
    }
    fn writeAll(ctx: *anyopaque, bytes: []const u8) anyerror!void {
        const self: *MemIo = @ptrCast(@alignCast(ctx));
        try self.written.appendSlice(self.gpa, bytes);
    }
    fn io(self: *MemIo) Io {
        return .{ .ctx = self, .readExact = readExact, .writeAll = writeAll };
    }
};

test "readFirstRequest consumes the real Chrome stream, acks SETTINGS and decodes the request" {
    const fixtures = @import("fixtures");
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var mem: MemIo = .{ .input = fixtures.h2.chrome_153_macos, .gpa = arena };
    const req = try readFirstRequest(arena, mem.io(), .{});
    try std.testing.expectEqual(fixtures.h2.chrome_153_macos.len, req.raw.len);
    try std.testing.expectEqualSlices(u8, fixtures.h2.chrome_153_macos, req.raw);
    try std.testing.expectEqual(@as(usize, 3), req.obs.frame_headers.len);
    try std.testing.expectEqual(@as(?u31, 1), req.obs.headers_stream_id);
    try std.testing.expectEqualStrings("GET", report.findHeader(req.obs.headers, ":method").?);
    // Server wrote: empty SETTINGS, then one SETTINGS ACK (Chrome sent exactly one non-ACK SETTINGS).
    try std.testing.expectEqualSlices(u8, &(empty_settings ++ settings_ack), mem.written.items);

    // respond(): HEADERS + DATA(END_STREAM) + GOAWAY, decodable by our own frame parser and HPACK decoder.
    mem.written = .empty;
    try respond(arena, mem.io(), 1, "{\"ok\":true}");
    var it = frame.FrameIterator{ .bytes = mem.written.items };
    const h = (try it.next()).?;
    try std.testing.expectEqual(@intFromEnum(frame.FrameType.headers), h.header.type);
    const hf = try frame.headers(h);
    var headers: std.ArrayList(@import("../h2/hpack.zig").Header) = .empty;
    var dec = @import("../h2/hpack.zig").Decoder.init(arena, 4096);
    defer dec.deinit();
    try dec.decodeBlock(hf.fragment, arena, &headers);
    try std.testing.expectEqualStrings("200", report.findHeader(headers.items, ":status").?);
    try std.testing.expectEqualStrings("11", report.findHeader(headers.items, "content-length").?);
    try std.testing.expectEqualStrings("application/json; charset=utf-8", report.findHeader(headers.items, "content-type").?);
    const d = (try it.next()).?;
    try std.testing.expectEqual(@intFromEnum(frame.FrameType.data), d.header.type);
    try std.testing.expect(d.header.flags & frame.Flags.end_stream != 0);
    try std.testing.expectEqualStrings("{\"ok\":true}", d.payload);
    const g = (try it.next()).?;
    try std.testing.expectEqual(@intFromEnum(frame.FrameType.goaway), g.header.type);
    try std.testing.expectEqual(@as(?frame.Frame, null), try it.next());
}

test "readFirstRequest rejects a bad preface" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var mem: MemIo = .{ .input = "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n", .gpa = arena };
    try std.testing.expectError(error.BadPreface, readFirstRequest(arena, mem.io(), .{}));
}
