//! HTTP/2 frame layer (RFC 9113 Section 4 and 6; https://www.rfc-editor.org/rfc/rfc9113.txt).
//! Frame header: length(24) type(8) flags(8) R(1) stream_id(31). This module parses the frame types the
//! fingerprint layer cares about: SETTINGS (6.5), WINDOW_UPDATE (6.9), PRIORITY (6.3), HEADERS (6.2, with
//! PADDED and PRIORITY flags), CONTINUATION (6.10), DATA (6.1), RST_STREAM (6.4), PING (6.7), GOAWAY (6.8).
//! Zero-copy: every slice returned points into the caller's bytes.
//! Oracle: fixtures/h2/*.bin (real Chrome/Firefox/Safari client streams) — frame header fields cross-
//! checked by hand against the captured bytes, SETTINGS ids/values against Chromium defaults (Chromium 153
//! net/http/http_network_session.{h,cc} AddDefaultHttp2Settings).
//! Reproduce: `zig build test`; to eyeball a stream, `xxd fixtures/h2/chrome-153-macos.bin` and read the
//! 9-byte headers by hand starting at offset 0x18 (after the 24-byte preface).
//!
//! Error convention. `error.Truncated` means "the input ended before the structure did": only the
//! iterator and `stripPreface` can say that, because only they look at an open-ended byte stream. Once a
//! frame has been cut out, its payload length is authoritative, so a payload that is too short or too
//! long for its type and flags is a self-contradiction: `error.Malformed`. (RFC 9113 calls most of these
//! FRAME_SIZE_ERROR or PROTOCOL_ERROR; which one to send is the connection layer's business.)
//! What this module does NOT check: SETTINGS values (§6.5.2 ranges — a fingerprinter wants to see what
//! was sent), frame size against SETTINGS_MAX_FRAME_SIZE (§4.2, depends on what we advertised), and
//! frame ordering such as HEADERS→CONTINUATION (§6.10, needs connection state).
const std = @import("std");

pub const ParseError = error{ Truncated, Malformed };

pub const preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
pub const frame_header_len = 9;

pub const FrameType = enum(u8) {
    data = 0,
    headers = 1,
    priority = 2,
    rst_stream = 3,
    settings = 4,
    push_promise = 5,
    ping = 6,
    goaway = 7,
    window_update = 8,
    continuation = 9,
    _,
};

pub const Flags = struct {
    pub const end_stream: u8 = 0x01;
    pub const ack: u8 = 0x01;
    pub const end_headers: u8 = 0x04;
    pub const padded: u8 = 0x08;
    pub const priority: u8 = 0x20;
};

pub const FrameHeader = struct {
    length: u24,
    type: u8,
    flags: u8,
    stream_id: u31,
};

pub const Frame = struct {
    header: FrameHeader,
    payload: []const u8,
};

/// RFC 9113 §4.1 Frame Format:
///
///   HTTP Frame {
///     Length (24),            payload length, the 9 header octets not included
///     Type (8),
///     Flags (8),
///     Reserved (1),           "MUST be ignored when receiving"
///     Stream Identifier (31),
///     Frame Payload (..),
///   }
///
/// Needs exactly 9 octets, so it cannot fail; the type makes the length check the caller's.
pub fn parseFrameHeader(bytes: *const [frame_header_len]u8) FrameHeader {
    const stream_word = std.mem.readInt(u32, bytes[5..9], .big);
    return .{
        .length = std.mem.readInt(u24, bytes[0..3], .big),
        .type = bytes[3],
        .flags = bytes[4],
        .stream_id = @truncate(stream_word & 0x7fff_ffff), // drop R
    };
}

/// Iterates complete frames in `bytes`. A trailing partial frame yields `error.Truncated`.
pub const FrameIterator = struct {
    bytes: []const u8,
    pos: usize = 0,

    /// Returns null exactly at the end of `bytes`. Unknown frame types are returned like any other
    /// (§4.1: "Implementations MUST ignore and discard frames of unknown types" — discarding is the
    /// caller's decision; the fingerprint layer may want to see them).
    pub fn next(self: *FrameIterator) ParseError!?Frame {
        const rest = self.bytes[self.pos..];
        if (rest.len == 0) return null;
        if (rest.len < frame_header_len) return error.Truncated;
        const header = parseFrameHeader(rest[0..frame_header_len]);
        const payload_rest = rest[frame_header_len..];
        if (payload_rest.len < header.length) return error.Truncated;
        self.pos += frame_header_len + header.length;
        return .{ .header = header, .payload = payload_rest[0..header.length] };
    }
};

/// Checks the 24-octet client connection preface (RFC 9113 §3.4) and returns the bytes after it, where
/// the first frame (SETTINGS, §3.4 "MUST be the first frame the client sends") starts.
/// Fewer than 24 octets that agree with the preface so far: error.Truncated. Any differing octet:
/// error.Malformed (§3.4: a client preface that is not the expected one is a PROTOCOL_ERROR).
pub fn stripPreface(bytes: []const u8) ParseError![]const u8 {
    const n = @min(bytes.len, preface.len);
    if (!std.mem.eql(u8, bytes[0..n], preface[0..n])) return error.Malformed;
    if (bytes.len < preface.len) return error.Truncated;
    return bytes[preface.len..];
}

/// Shared by every typed accessor: the frame must be of the expected type, and `payload` must be
/// exactly what the header announced (true for frames from FrameIterator; guards hand-built frames).
fn expectType(frame: Frame, t: FrameType) ParseError!void {
    if (frame.header.type != @intFromEnum(t)) return error.Malformed;
    if (frame.payload.len != frame.header.length) return error.Malformed;
}

/// Removes padding (§6.1 / §6.2 PADDED flag): returns the payload between the Pad Length octet and the
/// Padding. "If the length of the padding is the length of the frame payload or greater, the recipient
/// MUST treat this as a connection error of type PROTOCOL_ERROR." With PRIORITY fields in HEADERS the
/// same logic applies to what is left after them; see `headers`.
fn stripPadding(frame: Frame) ParseError!struct { pad_len: u8, body: []const u8 } {
    if (frame.header.flags & Flags.padded == 0) return .{ .pad_len = 0, .body = frame.payload };
    if (frame.payload.len < 1) return error.Malformed; // PADDED but no room for Pad Length
    return .{ .pad_len = frame.payload[0], .body = frame.payload[1..] };
}

pub const Setting = struct { id: u16, value: u32 };

/// Walks a validated SETTINGS payload: 6 octets per setting, wire order preserved (§6.5.1 "Settings are
/// processed in the order in which they appear" — and the order is part of the Akamai fingerprint).
pub const SettingsIterator = struct {
    bytes: []const u8,
    pos: usize = 0,

    pub fn next(self: *SettingsIterator) ?Setting {
        // `settings()` guarantees a multiple of 6; the check keeps a hand-built iterator in bounds too.
        if (self.bytes.len - self.pos < 6) return null;
        const item = self.bytes[self.pos..][0..6];
        self.pos += 6;
        return .{
            .id = std.mem.readInt(u16, item[0..2], .big),
            .value = std.mem.readInt(u32, item[2..6], .big),
        };
    }
};

/// SETTINGS payload must be a multiple of 6; ACK frames must be empty (RFC 9113 6.5).
///
///   SETTINGS Frame { Length (24), Type (8) = 0x04, Unused Flags (7), ACK Flag (1),
///                    Reserved (1), Stream Identifier (31) = 0, Setting (48) ... }
///   Setting { Identifier (16), Value (32) }
///
/// An ACK frame yields an empty iterator.
pub fn settings(frame: Frame) ParseError!SettingsIterator {
    try expectType(frame, .settings);
    // "The stream identifier for a SETTINGS frame MUST be zero (0x00)." (PROTOCOL_ERROR)
    if (frame.header.stream_id != 0) return error.Malformed;
    // "Receipt of a SETTINGS frame with the ACK flag set and a length field value other than 0 MUST be
    // treated as a connection error of type FRAME_SIZE_ERROR."
    if (frame.header.flags & Flags.ack != 0 and frame.payload.len != 0) return error.Malformed;
    // "A SETTINGS frame with a length other than a multiple of 6 octets MUST be treated as a connection
    // error of type FRAME_SIZE_ERROR."
    if (frame.payload.len % 6 != 0) return error.Malformed;
    return .{ .bytes = frame.payload };
}

/// WINDOW_UPDATE (§6.9): { Reserved (1), Window Size Increment (31) }, stream 0 = connection window.
/// "The legal range for the increment to the flow-control window is 1 to 2^31-1".
pub fn windowUpdate(frame: Frame) ParseError!u31 {
    try expectType(frame, .window_update);
    // "A WINDOW_UPDATE frame with a length other than 4 octets MUST be treated as a connection error of
    // type FRAME_SIZE_ERROR."
    if (frame.payload.len != 4) return error.Malformed;
    const word = std.mem.readInt(u32, frame.payload[0..4], .big);
    const increment: u31 = @truncate(word & 0x7fff_ffff); // drop the reserved bit
    // "A receiver MUST treat the receipt of a WINDOW_UPDATE frame with a flow-control window increment of
    // 0 as a stream error of type PROTOCOL_ERROR" (connection error on stream 0).
    if (increment == 0) return error.Malformed;
    return increment;
}

/// RFC 7540 priority fields, kept by RFC 9113 for interoperability (§5.3.2) though deprecated.
/// `weight` is the octet as sent; the RFC 7540 §6.3 weight is `weight + 1` (1..256).
pub const Priority = struct { exclusive: bool, dependency: u31, weight: u8 };

/// Exclusive (1) + Stream Dependency (31) + Weight (8), the 5 octets shared by PRIORITY and HEADERS.
fn parsePriorityFields(bytes: *const [5]u8) Priority {
    const word = std.mem.readInt(u32, bytes[0..4], .big);
    return .{
        .exclusive = word & 0x8000_0000 != 0,
        .dependency = @truncate(word & 0x7fff_ffff),
        .weight = bytes[4],
    };
}

/// PRIORITY (§6.3). Deprecated by RFC 9113 but still a fingerprint signal (Akamai `P` segment).
pub fn priority(frame: Frame) ParseError!Priority {
    try expectType(frame, .priority);
    // "If a PRIORITY frame is received with a stream identifier of 0x00, the recipient MUST respond with
    // a connection error of type PROTOCOL_ERROR."
    if (frame.header.stream_id == 0) return error.Malformed;
    // "A PRIORITY frame with a length other than 5 octets MUST be treated as a stream error of type
    // FRAME_SIZE_ERROR."
    if (frame.payload.len != 5) return error.Malformed;
    // RFC 7540 §5.3.1 "A stream cannot depend on itself" is not re-checked here: RFC 9113 dropped the
    // dependency tree text, and a fingerprinter records what was sent.
    return parsePriorityFields(frame.payload[0..5]);
}

pub const HeadersFrame = struct {
    priority: ?Priority,
    /// HPACK header block fragment (padding and priority fields removed).
    fragment: []const u8,
    end_headers: bool,
    end_stream: bool,
};

/// HEADERS (§6.2):
///
///   HEADERS Frame { ..., [Pad Length (8)], [Exclusive (1)], [Stream Dependency (31)], [Weight (8)],
///                   Field Block Fragment (..), Padding (..2040) }
///
/// PADDED (0x08) switches on Pad Length + Padding, PRIORITY (0x20) the 5 priority octets. The fields are
/// peeled off in wire order: pad length, priority, then whatever is left minus the padding is the
/// fragment. An empty fragment is allowed (the field block may continue in CONTINUATION frames).
pub fn headers(frame: Frame) ParseError!HeadersFrame {
    try expectType(frame, .headers);
    // "If a HEADERS frame is received whose Stream Identifier field is 0x00, the recipient MUST respond
    // with a connection error of type PROTOCOL_ERROR."
    if (frame.header.stream_id == 0) return error.Malformed;

    const padded = try stripPadding(frame);
    var rest = padded.body;

    var prio: ?Priority = null;
    if (frame.header.flags & Flags.priority != 0) {
        // Flag says the 5 octets are present; the length says otherwise (FRAME_SIZE_ERROR, §4.2 "too
        // small to contain mandatory frame data").
        if (rest.len < 5) return error.Malformed;
        prio = parsePriorityFields(rest[0..5]);
        rest = rest[5..];
    }

    // "If the length of the padding is the length of the frame payload or greater" -> PROTOCOL_ERROR.
    // Generalised to the octets that are left after Pad Length and the priority fields: padding may use
    // all of them (empty fragment) but not more.
    if (padded.pad_len > rest.len) return error.Malformed;
    return .{
        .priority = prio,
        .fragment = rest[0 .. rest.len - padded.pad_len],
        .end_headers = frame.header.flags & Flags.end_headers != 0,
        .end_stream = frame.header.flags & Flags.end_stream != 0,
    };
}

/// CONTINUATION (§6.10): the payload is the next field block fragment; END_HEADERS is in
/// `frame.header.flags`. Whether it may appear here (after HEADERS/PUSH_PROMISE/CONTINUATION without
/// END_HEADERS on the same stream) is connection state, not checked here.
pub fn continuation(frame: Frame) ParseError![]const u8 {
    try expectType(frame, .continuation);
    // "If a CONTINUATION frame is received with a Stream Identifier field of 0x00, the recipient MUST
    // respond with a connection error of type PROTOCOL_ERROR."
    if (frame.header.stream_id == 0) return error.Malformed;
    return frame.payload;
}

/// DATA (§6.1): { [Pad Length (8)], Data (..), Padding (..2040) }. Returns the data with padding removed.
pub fn data(frame: Frame) ParseError![]const u8 {
    try expectType(frame, .data);
    // "If a DATA frame is received whose Stream Identifier field is 0x00, the recipient MUST respond with
    // a connection error of type PROTOCOL_ERROR."
    if (frame.header.stream_id == 0) return error.Malformed;
    const padded = try stripPadding(frame);
    // "If the length of the padding is the length of the frame payload or greater" -> PROTOCOL_ERROR.
    if (padded.pad_len > padded.body.len) return error.Malformed;
    return padded.body[0 .. padded.body.len - padded.pad_len];
}

/// RST_STREAM (§6.4): { Error Code (32) } on a non-zero stream.
pub fn rstStream(frame: Frame) ParseError!u32 {
    try expectType(frame, .rst_stream);
    // "If a RST_STREAM frame is received with a stream identifier of 0x00, the recipient MUST treat this
    // as a connection error of type PROTOCOL_ERROR."
    if (frame.header.stream_id == 0) return error.Malformed;
    // "A RST_STREAM frame with a length other than 4 octets MUST be treated as a connection error of type
    // FRAME_SIZE_ERROR."
    if (frame.payload.len != 4) return error.Malformed;
    return std.mem.readInt(u32, frame.payload[0..4], .big);
}

/// PING (§6.7): { Opaque Data (64) } on stream 0; ACK is in `frame.header.flags`.
pub fn ping(frame: Frame) ParseError!*const [8]u8 {
    try expectType(frame, .ping);
    // "If a PING frame is received with a Stream Identifier field value other than 0x00, the recipient
    // MUST respond with a connection error of type PROTOCOL_ERROR."
    if (frame.header.stream_id != 0) return error.Malformed;
    // "Receipt of a PING frame with a length field value other than 8 MUST be treated as a connection
    // error of type FRAME_SIZE_ERROR."
    if (frame.payload.len != 8) return error.Malformed;
    return frame.payload[0..8];
}

pub const Goaway = struct { last_stream_id: u31, error_code: u32, debug_data: []const u8 };

/// GOAWAY (§6.8): { Reserved (1), Last-Stream-ID (31), Error Code (32), Additional Debug Data (..) }.
pub fn goaway(frame: Frame) ParseError!Goaway {
    try expectType(frame, .goaway);
    // "An endpoint MUST treat a GOAWAY frame with a stream identifier other than 0x00 as a connection
    // error of type PROTOCOL_ERROR."
    if (frame.header.stream_id != 0) return error.Malformed;
    // 8 fixed octets are mandatory (§4.2 "too small to contain mandatory frame data").
    if (frame.payload.len < 8) return error.Malformed;
    return .{
        .last_stream_id = @truncate(std.mem.readInt(u32, frame.payload[0..4], .big) & 0x7fff_ffff),
        .error_code = std.mem.readInt(u32, frame.payload[4..8], .big),
        .debug_data = frame.payload[8..],
    };
}

// ---------------------------------------------------------------------------------------------------
// Tests. Frame sequences: the PoC server's own 9-byte header reader at capture time (independent of
// this parser). SETTINGS / WINDOW_UPDATE values: Chromium 153 source (see test comments). Error cases
// are built from the RFC 9113 rules quoted above.
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const fixtures = @import("fixtures");
const hpack = @import("hpack.zig");

const FrameSummary = struct { type: FrameType, length: u24, flags: u8, stream_id: u31 };

fn expectFrames(stream: []const u8, want: []const FrameSummary) !void {
    var it: FrameIterator = .{ .bytes = try stripPreface(stream) };
    for (want) |w| {
        const f = (try it.next()) orelse return error.TestUnexpectedResult;
        try testing.expectEqual(@intFromEnum(w.type), f.header.type);
        try testing.expectEqual(w.length, f.header.length);
        try testing.expectEqual(w.flags, f.header.flags);
        try testing.expectEqual(w.stream_id, f.header.stream_id);
    }
    try testing.expectEqual(@as(?Frame, null), try it.next());
}

/// Returns the n-th frame (0-based) after the preface.
fn nthFrame(stream: []const u8, n: usize) !Frame {
    var it: FrameIterator = .{ .bytes = try stripPreface(stream) };
    var i: usize = 0;
    while (try it.next()) |f| : (i += 1) {
        if (i == n) return f;
    }
    return error.TestUnexpectedResult;
}

test "parseFrameHeader: fields are big-endian, R bit ignored (§4.1)" {
    const h = parseFrameHeader(&.{ 0x00, 0x01, 0xd9, 0x01, 0x25, 0x80, 0x00, 0x00, 0x01 });
    try testing.expectEqual(@as(u24, 473), h.length);
    try testing.expectEqual(@as(u8, 1), h.type);
    try testing.expectEqual(@as(u8, 0x25), h.flags);
    try testing.expectEqual(@as(u31, 1), h.stream_id);
}

test "stripPreface (§3.4)" {
    try testing.expectEqualStrings("rest", try stripPreface(preface ++ "rest"));
    try testing.expectEqual(@as(usize, 0), (try stripPreface(preface)).len);
    try testing.expectError(error.Truncated, stripPreface(preface[0..10]));
    try testing.expectError(error.Truncated, stripPreface(""));
    try testing.expectError(error.Malformed, stripPreface("GET / HTTP/1.1\r\n\r\n12345678"));
    try testing.expectError(error.Malformed, stripPreface("PRI * HTTP/1.1"));
}

test "FrameIterator: trailing partial frame is Truncated" {
    const stream = fixtures.h2.chrome_153_macos;
    const frames = try stripPreface(stream);
    // Cut anywhere inside the last frame (header or payload): the first two frames still come out.
    for ([_]usize{ 1, 8, 9, 100, 481 }) |cut| {
        var it: FrameIterator = .{ .bytes = frames[0 .. frames.len - cut] };
        _ = (try it.next()) orelse return error.TestUnexpectedResult;
        _ = (try it.next()) orelse return error.TestUnexpectedResult;
        try testing.expectError(error.Truncated, it.next());
    }
}

test "fixtures/h2 Chrome 153: frame sequence" {
    try expectFrames(fixtures.h2.chrome_153_macos, &.{
        .{ .type = .settings, .length = 24, .flags = 0x00, .stream_id = 0 },
        .{ .type = .window_update, .length = 4, .flags = 0x00, .stream_id = 0 },
        .{ .type = .headers, .length = 473, .flags = 0x25, .stream_id = 1 },
    });
}

test "fixtures/h2 Safari 26.6.2: frame sequence" {
    try expectFrames(fixtures.h2.safari_26_6_2_macos, &.{
        .{ .type = .settings, .length = 24, .flags = 0x00, .stream_id = 0 },
        .{ .type = .window_update, .length = 4, .flags = 0x00, .stream_id = 0 },
        .{ .type = .settings, .length = 0, .flags = Flags.ack, .stream_id = 0 },
        .{ .type = .headers, .length = 279, .flags = 0x05, .stream_id = 1 },
    });
}

test "fixtures/h2 Firefox 157b4: frame sequence" {
    try expectFrames(fixtures.h2.firefox_157b4_macos, &.{
        .{ .type = .settings, .length = 24, .flags = 0x00, .stream_id = 0 },
        .{ .type = .window_update, .length = 4, .flags = 0x00, .stream_id = 0 },
        .{ .type = .settings, .length = 0, .flags = Flags.ack, .stream_id = 0 },
    });
}

test "fixtures/h2 Chrome 153: SETTINGS and WINDOW_UPDATE equal Chromium defaults" {
    // Oracle: Chromium 153 net/http/http_network_session.cc AddDefaultHttp2Settings + .h constants:
    //   ENABLE_PUSH = kSpdyDisablePush = 0, HEADER_TABLE_SIZE = kSpdyMaxHeaderTableSize = 64 * 1024,
    //   INITIAL_WINDOW_SIZE = kSpdyStreamMaxRecvWindowSize = 6 * 1024 * 1024,
    //   MAX_HEADER_LIST_SIZE = kSpdyMaxHeaderListSize = 256 * 1024.
    // spdy::SettingsMap is an ordered map, so ids go out ascending.
    const want = [_]Setting{
        .{ .id = 1, .value = 64 * 1024 },
        .{ .id = 2, .value = 0 },
        .{ .id = 4, .value = 6 * 1024 * 1024 },
        .{ .id = 6, .value = 256 * 1024 },
    };
    var it = try settings(try nthFrame(fixtures.h2.chrome_153_macos, 0));
    for (want) |w| {
        const got = it.next() orelse return error.TestUnexpectedResult;
        try testing.expectEqual(w.id, got.id);
        try testing.expectEqual(w.value, got.value);
    }
    try testing.expectEqual(@as(?Setting, null), it.next());

    // Connection WINDOW_UPDATE: spdy_session.cc SendInitialData sends
    // session_max_recv_window_size_ - session_recv_window_size_ =
    // kSpdySessionMaxRecvWindowSize (15 * 1024 * 1024) - kDefaultInitialWindowSize (65535).
    const wu = try nthFrame(fixtures.h2.chrome_153_macos, 1);
    try testing.expectEqual(@as(u31, 15 * 1024 * 1024 - 65535), try windowUpdate(wu));
}

test "fixtures/h2 Chrome 153: HEADERS carries PRIORITY fields and a decodable request" {
    const f = try nthFrame(fixtures.h2.chrome_153_macos, 2);
    const h = try headers(f);
    try testing.expect(h.end_headers);
    try testing.expect(h.end_stream);
    // 0x25 = END_STREAM | END_HEADERS | PRIORITY: 5 octets come off the front, no padding.
    try testing.expect(h.priority != null);
    try testing.expectEqual(@as(usize, 473 - 5), h.fragment.len);

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // Our side never changed SETTINGS_HEADER_TABLE_SIZE, so the initial 4096 applies (RFC 9113 §6.5.2).
    var decoder = hpack.Decoder.init(testing.allocator, 4096);
    defer decoder.deinit();
    var list: std.ArrayList(hpack.Header) = .empty;
    try decoder.decodeBlock(h.fragment, arena, &list);

    try expectRequestShape(list.items);
    for (list.items) |x| {
        if (std.mem.eql(u8, x.name, ":method")) try testing.expectEqualStrings("GET", x.value);
        if (std.mem.eql(u8, x.name, ":authority")) try testing.expect(std.mem.startsWith(u8, x.value, "localhost"));
    }
}

test "fixtures/h2 Safari 26.6.2: HEADERS without PRIORITY, decodable request" {
    const f = try nthFrame(fixtures.h2.safari_26_6_2_macos, 3);
    const h = try headers(f);
    try testing.expectEqual(@as(?Priority, null), h.priority);
    try testing.expectEqual(@as(usize, 279), h.fragment.len);

    var arena_state = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena_state.deinit();
    var decoder = hpack.Decoder.init(testing.allocator, 4096);
    defer decoder.deinit();
    var list: std.ArrayList(hpack.Header) = .empty;
    try decoder.decodeBlock(h.fragment, arena_state.allocator(), &list);
    try expectRequestShape(list.items);
}

/// Each of the four request pseudo-headers exactly once, all before the first regular header
/// (RFC 9113 §8.3: "All pseudo-header fields MUST appear in a field block before all regular field
/// lines"), and a user-agent. The pseudo-header *order* is an observation, not asserted here.
fn expectRequestShape(list: []const hpack.Header) !void {
    const names = [_][]const u8{ ":method", ":scheme", ":authority", ":path" };
    var seen = [_]usize{0} ** names.len;
    var regular_seen = false;
    var has_user_agent = false;
    for (list) |x| {
        if (x.name.len > 0 and x.name[0] == ':') {
            try testing.expect(!regular_seen);
            for (names, 0..) |n, i| {
                if (std.mem.eql(u8, n, x.name)) seen[i] += 1;
            }
        } else {
            regular_seen = true;
            if (std.mem.eql(u8, x.name, "user-agent")) has_user_agent = true;
        }
    }
    for (seen) |count| try testing.expectEqual(@as(usize, 1), count);
    try testing.expect(has_user_agent);
}

fn testFrame(t: FrameType, flags: u8, stream_id: u31, payload: []const u8) Frame {
    return .{
        .header = .{ .length = @intCast(payload.len), .type = @intFromEnum(t), .flags = flags, .stream_id = stream_id },
        .payload = payload,
    };
}

test "settings: RFC 9113 §6.5 contradictions" {
    const six = [_]u8{ 0, 1, 0, 0, 0x10, 0 };
    var it = try settings(testFrame(.settings, 0, 0, &six));
    try testing.expectEqual(Setting{ .id = 1, .value = 4096 }, it.next() orelse return error.TestUnexpectedResult);
    try testing.expectEqual(@as(?Setting, null), it.next());

    var ack = try settings(testFrame(.settings, Flags.ack, 0, ""));
    try testing.expectEqual(@as(?Setting, null), ack.next());
    try testing.expectError(error.Malformed, settings(testFrame(.settings, Flags.ack, 0, &six))); // ACK with payload
    try testing.expectError(error.Malformed, settings(testFrame(.settings, 0, 0, six[0..5]))); // not a multiple of 6
    try testing.expectError(error.Malformed, settings(testFrame(.settings, 0, 1, &six))); // stream != 0
    try testing.expectError(error.Malformed, settings(testFrame(.ping, 0, 0, &six))); // wrong type
    var bad_len = testFrame(.settings, 0, 0, &six);
    bad_len.header.length = 12; // header and payload disagree
    try testing.expectError(error.Malformed, settings(bad_len));
}

test "windowUpdate: §6.9 length, reserved bit, zero increment" {
    try testing.expectEqual(@as(u31, 1), try windowUpdate(testFrame(.window_update, 0, 0, &.{ 0x80, 0, 0, 1 })));
    try testing.expectEqual(@as(u31, 0x7fff_ffff), try windowUpdate(testFrame(.window_update, 0, 3, &.{ 0xff, 0xff, 0xff, 0xff })));
    try testing.expectError(error.Malformed, windowUpdate(testFrame(.window_update, 0, 0, &.{ 0x80, 0, 0, 0 })));
    try testing.expectError(error.Malformed, windowUpdate(testFrame(.window_update, 0, 0, &.{ 0, 0, 1 })));
    try testing.expectError(error.Malformed, windowUpdate(testFrame(.window_update, 0, 0, &.{ 0, 0, 0, 1, 0 })));
}

test "priority: §6.3 fixed 5 octets, non-zero stream" {
    // Whitepaper Firefox tuple 9:0:7:1 on the wire: stream 9, dependency 7, weight octet 0.
    const p = try priority(testFrame(.priority, 0, 9, &.{ 0, 0, 0, 7, 0 }));
    try testing.expectEqual(Priority{ .exclusive = false, .dependency = 7, .weight = 0 }, p);
    const e = try priority(testFrame(.priority, 0, 3, &.{ 0x80, 0, 0, 0, 200 }));
    try testing.expect(e.exclusive);
    try testing.expectEqual(@as(u31, 0), e.dependency);
    try testing.expectError(error.Malformed, priority(testFrame(.priority, 0, 0, &.{ 0, 0, 0, 7, 0 })));
    try testing.expectError(error.Malformed, priority(testFrame(.priority, 0, 9, &.{ 0, 0, 0, 7 })));
    try testing.expectError(error.Malformed, priority(testFrame(.priority, 0, 9, &.{ 0, 0, 0, 7, 0, 0 })));
}

test "headers: PADDED and PRIORITY peeling (§6.2)" {
    const pp = Flags.padded | Flags.priority | Flags.end_headers;
    // pad 2 | E+dep 3 | weight 15 | fragment "ab" | 2 padding octets
    const h = try headers(testFrame(.headers, pp, 5, &.{ 2, 0x80, 0, 0, 3, 15, 'a', 'b', 0, 0 }));
    try testing.expectEqualStrings("ab", h.fragment);
    try testing.expectEqual(Priority{ .exclusive = true, .dependency = 3, .weight = 15 }, h.priority orelse return error.TestUnexpectedResult);
    try testing.expect(h.end_headers and !h.end_stream);

    // Padding may consume everything after the fixed fields: empty fragment.
    const empty = try headers(testFrame(.headers, Flags.padded, 1, &.{ 2, 0, 0 }));
    try testing.expectEqual(@as(usize, 0), empty.fragment.len);
    // Padding longer than what is left.
    try testing.expectError(error.Malformed, headers(testFrame(.headers, Flags.padded, 1, &.{ 3, 0, 0 })));
    try testing.expectError(error.Malformed, headers(testFrame(.headers, pp, 1, &.{ 1, 0, 0, 0, 3, 15 })));
    // PADDED with an empty payload, PRIORITY with fewer than 5 octets.
    try testing.expectError(error.Malformed, headers(testFrame(.headers, Flags.padded, 1, "")));
    try testing.expectError(error.Malformed, headers(testFrame(.headers, Flags.priority, 1, &.{ 0, 0, 0, 3 })));
    // Stream 0.
    try testing.expectError(error.Malformed, headers(testFrame(.headers, 0, 0, "ab")));
}

test "continuation, data, rst_stream, ping, goaway" {
    try testing.expectEqualStrings("xy", try continuation(testFrame(.continuation, Flags.end_headers, 1, "xy")));
    try testing.expectError(error.Malformed, continuation(testFrame(.continuation, 0, 0, "xy")));

    try testing.expectEqualStrings("hi", try data(testFrame(.data, Flags.padded, 1, &.{ 1, 'h', 'i', 0 })));
    try testing.expectError(error.Malformed, data(testFrame(.data, Flags.padded, 1, &.{ 4, 'h', 'i', 0 })));
    try testing.expectError(error.Malformed, data(testFrame(.data, 0, 0, "hi")));

    try testing.expectEqual(@as(u32, 8), try rstStream(testFrame(.rst_stream, 0, 1, &.{ 0, 0, 0, 8 })));
    try testing.expectError(error.Malformed, rstStream(testFrame(.rst_stream, 0, 0, &.{ 0, 0, 0, 8 })));

    const opaque_data = "12345678";
    try testing.expectEqualStrings(opaque_data, try ping(testFrame(.ping, Flags.ack, 0, opaque_data)));
    try testing.expectError(error.Malformed, ping(testFrame(.ping, 0, 1, opaque_data)));
    try testing.expectError(error.Malformed, ping(testFrame(.ping, 0, 0, opaque_data[0..7])));

    const g = try goaway(testFrame(.goaway, 0, 0, &.{ 0x80, 0, 0, 3, 0, 0, 0, 1, 'd', 'b', 'g' }));
    try testing.expectEqual(@as(u31, 3), g.last_stream_id);
    try testing.expectEqual(@as(u32, 1), g.error_code);
    try testing.expectEqualStrings("dbg", g.debug_data);
    try testing.expectError(error.Malformed, goaway(testFrame(.goaway, 0, 0, &.{ 0, 0, 0, 3, 0, 0, 0 })));
    try testing.expectError(error.Malformed, goaway(testFrame(.goaway, 0, 1, &.{ 0, 0, 0, 3, 0, 0, 0, 1 })));
}
