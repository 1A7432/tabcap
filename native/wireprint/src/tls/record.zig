//! TLS record layer: from a client->server byte stream to the first handshake message.
//!
//! Spec: RFC 8446 Section 5.1 (https://www.rfc-editor.org/rfc/rfc8446.txt); the same text is Section 5.1
//! of RFC 9846 (https://www.rfc-editor.org/rfc/rfc9846.txt), which obsoletes 8446 without changing it.
//!
//!   struct {
//!       ContentType type;                      // 1 byte, 22 = handshake
//!       ProtocolVersion legacy_record_version; // 2 bytes, big-endian; "MUST be ignored for all purposes"
//!       uint16 length;                         // 2 bytes, big-endian; "MUST NOT exceed 2^14"
//!       opaque fragment[TLSPlaintext.length];  // exactly `length` bytes, no prefix of its own
//!   } TLSPlaintext;
//!
//! Records and handshake messages are two independent framings (Section 5.1): "Handshake messages MAY be
//! coalesced into a single TLSPlaintext record or fragmented across several records". So one record can
//! hold the start of several messages, and one message can need several records. A handshake message is
//! (RFC 8446 Section 4 / RFC 9846 Section 4) msg_type(1) + uint24 length(3) + body(length).
//!
//! Error discipline (AGENTS.md), applied to a byte *stream*:
//!   error.Truncated  the stream stops before a length it has already announced is satisfied (record
//!                    header, record fragment, or handshake message). Reading more bytes may fix it; a
//!                    server peeking at a socket should wait and retry.
//!   error.Malformed  no amount of extra bytes can fix it: record length > 2^14, a non-handshake record
//!                    where a handshake record is required, an empty handshake fragment.
//! Parsing never allocates. Results borrow from the input; only a message that spans records is copied,
//! into a caller-provided scratch buffer.
//!
//! Oracle: fixtures/clienthello/*.expected.json, written by tools/openssl_oracle.c. OpenSSL's
//! SSL_set_msg_callback reports the 5-byte record header it read (`record_header`) and the reassembled
//! handshake message (`handshake.msg_type`, `handshake.length`, `handshake.sha256`); the tests compare
//! our header fields and the SHA-256 of the message we extract. Multi-record inputs are synthetic
//! re-framings of the same real bytes (tests below), checked byte-for-byte against the single-record
//! message. Reproduce: tools/README-oracle.md, then `zig build test`.
const std = @import("std");

pub const ParseError = error{ Truncated, Malformed };

/// Errors of `firstHandshakeMessage`: the stream errors plus a resource limit of the caller.
pub const MessageError = ParseError || error{
    /// The message spans records and does not fit in the caller's `scratch` buffer. This is the
    /// caller's limit, not a protocol violation (a handshake message may be up to 2^24-1 bytes).
    MessageTooLarge,
};

/// ContentType (Section 5.1). Only `handshake` may carry a ClientHello.
pub const ContentType = enum(u8) {
    change_cipher_spec = 20,
    alert = 21,
    handshake = 22,
    application_data = 23,
    _,
};

/// type(1) + legacy_record_version(2) + length(2).
pub const record_header_len = 5;
/// Section 5.1: "The length MUST NOT exceed 2^14 bytes" (record_overflow otherwise).
pub const max_fragment_len = 1 << 14;
/// msg_type(1) + uint24 length(3), RFC 8446 Section 4.
pub const handshake_header_len = 4;

/// The fixed 5-byte record header on its own, so a reader can validate it before the fragment arrives.
pub const Header = struct {
    content_type: u8,
    legacy_version: u16,
    /// Fragment length (<= 2^14, checked).
    length: u16,
};

pub const Record = struct {
    content_type: u8,
    legacy_version: u16,
    /// Borrowed from the input: exactly `length` bytes after the header.
    fragment: []const u8,
};

/// Parses the 5-byte record header at the start of `bytes`.
/// `error.Truncated` if fewer than 5 bytes; `error.Malformed` if the length exceeds 2^14.
/// The content type is not checked here (see `firstHandshakeMessage`), and the version never is:
/// Section 5.1 says legacy_record_version "MUST be ignored for all purposes" (browsers send 0x0301 on
/// the initial ClientHello record, 0x0303 elsewhere).
pub fn parseHeader(bytes: []const u8) ParseError!Header {
    // Bytes 0..5 must exist before any of them can be read.
    if (bytes.len < record_header_len) return error.Truncated;
    const length = std.mem.readInt(u16, bytes[3..5], .big);
    // A 2-byte length could say up to 65535, but the record layer caps fragments at 2^14. Rejecting here,
    // before waiting for the fragment, means a peer cannot make us wait for 64 KiB that will never be valid.
    if (length > max_fragment_len) return error.Malformed;
    return .{
        .content_type = bytes[0],
        .legacy_version = std.mem.readInt(u16, bytes[1..3], .big),
        .length = length,
    };
}

/// Parses the record at the start of `bytes`. `error.Truncated` if fewer than 5 + length bytes.
/// Bytes after the record are ignored (they belong to the next record).
pub fn parseRecord(bytes: []const u8) ParseError!Record {
    const header = try parseHeader(bytes);
    const total = record_header_len + @as(usize, header.length);
    // The header promised `length` fragment bytes; if the input stops early, more bytes may come.
    if (bytes.len < total) return error.Truncated;
    return .{
        .content_type = header.content_type,
        .legacy_version = header.legacy_version,
        .fragment = bytes[record_header_len..total],
    };
}

/// Total record size (5 + length) if the header is available, so a server can `MSG_PEEK` exactly enough.
/// `error.Truncated` if fewer than 5 bytes are available, `error.Malformed` if the length exceeds 2^14.
pub fn recordLen(bytes: []const u8) ParseError!usize {
    const header = try parseHeader(bytes);
    return record_header_len + @as(usize, header.length);
}

pub const HandshakeMessage = struct {
    msg_type: u8,
    /// Whole message: 1-byte type, 3-byte length, body. Borrowed from the input when it fits in one
    /// record, otherwise copied into the caller-provided scratch buffer.
    bytes: []const u8,
};

/// Extracts the first handshake message from a client->server stream of TLS records.
/// `scratch` is used only when the message spans records (Chrome's ClientHello does not on loopback,
/// but the spec allows it). Returns `error.Truncated` if the stream ends before the message completes.
///
/// Every record consumed must have content type 22 (handshake) and a non-empty fragment; otherwise
/// `error.Malformed`. Bytes after the end of the first message (the rest of its last record, or later
/// records) are ignored. The message body is not interpreted; `client_hello.parse` does that.
pub fn firstHandshakeMessage(stream: []const u8, scratch: []u8) MessageError!HandshakeMessage {
    // Fast path: the whole message lies inside the first record's fragment. This is the common case
    // (all six fixtures), and also the "one record holds several messages" case: we borrow only the
    // first `4 + length` bytes of the fragment.
    const first = try handshakeRecordAt(stream, 0);
    if (first.fragment.len >= handshake_header_len) {
        const total = handshake_header_len + @as(usize, std.mem.readInt(u24, first.fragment[1..4], .big));
        if (total <= first.fragment.len) {
            return .{ .msg_type = first.fragment[0], .bytes = first.fragment[0..total] };
        }
    }

    // Slow path: the message (possibly even its 4-byte header) continues in the next record(s).
    // Concatenate fragments into `scratch` until we hold 4 header bytes plus the announced body.
    // Section 5.1: "if a handshake message is split over two or more records, there MUST NOT be any
    // other records between them" -- so every record we walk over must be a handshake record.
    if (scratch.len < handshake_header_len) return error.MessageTooLarge;
    var filled: usize = 0; // bytes of the message copied so far
    var pos: usize = 0; // offset of the next record in `stream`
    while (true) {
        const rec = try handshakeRecordAt(stream, pos);
        pos += record_header_len + rec.fragment.len;

        var fragment = rec.fragment;
        while (fragment.len > 0) {
            // How long the message is, as far as we know: 4 until the header is complete, then 4 + length.
            const want = messageLenSoFar(scratch[0..filled]);
            const take = @min(fragment.len, want - filled);
            @memcpy(scratch[filled..][0..take], fragment[0..take]);
            filled += take;
            fragment = fragment[take..];

            const now_want = messageLenSoFar(scratch[0..filled]);
            // Check the size as soon as the header is known, before waiting for more records.
            if (now_want > scratch.len) return error.MessageTooLarge;
            if (filled == now_want) return .{ .msg_type = scratch[0], .bytes = scratch[0..filled] };
        }
    }
}

/// The record at `stream[pos..]`, required to be a non-empty handshake record.
fn handshakeRecordAt(stream: []const u8, pos: usize) ParseError!Record {
    const rest = stream[pos..];
    // Validate the header before waiting for the fragment: a plaintext HTTP request ("GET / ...") fails
    // here immediately instead of looking like a record of 0x202f bytes that has not fully arrived yet.
    const header = try parseHeader(rest);
    if (header.content_type != @intFromEnum(ContentType.handshake)) return error.Malformed;
    // Section 5.1: "Implementations MUST NOT send zero-length fragments of Handshake types".
    if (header.length == 0) return error.Malformed;
    return parseRecord(rest);
}

/// Total message length known from the first `prefix.len` bytes of a handshake message.
fn messageLenSoFar(prefix: []const u8) usize {
    if (prefix.len < handshake_header_len) return handshake_header_len;
    return handshake_header_len + @as(usize, std.mem.readInt(u24, prefix[1..4], .big));
}

// ---------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------

const testing = std.testing;
const fixtures = @import("fixtures");
const hex = @import("../hex.zig");

fn expectedJson(name: []const u8) ![]const u8 {
    for (fixtures.clienthello_expected.all) |e| {
        if (std.mem.eql(u8, e.name, name)) return e.json;
    }
    return error.TestExpectedFixture;
}

fn jsonGet(obj: std.json.Value, key: []const u8) !std.json.Value {
    if (obj != .object) return error.TestUnexpectedJson;
    return obj.object.get(key) orelse error.TestUnexpectedJson;
}

test "fixtures: record header and first handshake message match the OpenSSL oracle" {
    const gpa = testing.allocator;
    try testing.expectEqual(fixtures.clienthello.all.len, fixtures.clienthello_expected.all.len);
    for (fixtures.clienthello.all) |fx| {
        const parsed = try std.json.parseFromSlice(std.json.Value, gpa, try expectedJson(fx.name), .{});
        defer parsed.deinit();
        const root = parsed.value;

        // The expectation belongs to exactly these bytes.
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(fx.bytes, &digest, .{});
        var digest_hex: [64]u8 = undefined;
        try testing.expectEqualStrings((try jsonGet(root, "input_sha256")).string, hex.encode(&digest_hex, &digest));

        // Record header, as OpenSSL's record layer saw it.
        const rh = try jsonGet(root, "record_header");
        const record = try parseRecord(fx.bytes);
        try testing.expectEqual((try jsonGet(rh, "content_type")).integer, record.content_type);
        try testing.expectEqualStrings((try jsonGet(rh, "legacy_version")).string, &hex.u16Hex(record.legacy_version));
        try testing.expectEqual((try jsonGet(rh, "length")).integer, @as(i64, @intCast(record.fragment.len)));
        try testing.expectEqual(fx.bytes.len, try recordLen(fx.bytes));

        // First handshake message: borrowed (single record), same type/length/hash as OpenSSL's.
        var scratch: [16]u8 = undefined; // deliberately tiny: the fast path must not touch it
        const msg = try firstHandshakeMessage(fx.bytes, &scratch);
        try testing.expectEqual(@intFromPtr(fx.bytes.ptr) + record_header_len, @intFromPtr(msg.bytes.ptr));
        const hs = try jsonGet(root, "handshake");
        try testing.expectEqual((try jsonGet(hs, "msg_type")).integer, msg.msg_type);
        try testing.expectEqual((try jsonGet(hs, "length")).integer, @as(i64, @intCast(msg.bytes.len - handshake_header_len)));
        std.crypto.hash.sha2.Sha256.hash(msg.bytes, &digest, .{});
        try testing.expectEqualStrings((try jsonGet(hs, "sha256")).string, hex.encode(&digest_hex, &digest));
    }
}

test "truncating the stream anywhere before the end of the first record is error.Truncated" {
    // Every prefix: inside the record header (0..4), the handshake header (5..8), and every byte of
    // the ClientHello body (random, session_id, cipher list, extension block, ...).
    var scratch: [4096]u8 = undefined;
    for (fixtures.clienthello.all) |fx| {
        for (0..fx.bytes.len) |k| {
            try testing.expectError(error.Truncated, firstHandshakeMessage(fx.bytes[0..k], &scratch));
            try testing.expectError(error.Truncated, parseRecord(fx.bytes[0..k]));
            if (k < record_header_len) try testing.expectError(error.Truncated, recordLen(fx.bytes[0..k]));
        }
    }
}

/// Test helper: re-frames `message` into records whose fragments have the given sizes (last one takes
/// the rest), with the record version of the original fixture.
fn frame(gpa: std.mem.Allocator, message: []const u8, sizes: []const usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    var rest = message;
    for (sizes) |n| {
        try appendRecord(gpa, &out, 22, rest[0..n]);
        rest = rest[n..];
    }
    if (rest.len > 0) try appendRecord(gpa, &out, 22, rest);
    return out.toOwnedSlice(gpa);
}

fn appendRecord(gpa: std.mem.Allocator, out: *std.ArrayList(u8), content_type: u8, fragment: []const u8) !void {
    var header: [5]u8 = .{ content_type, 0x03, 0x01, 0, 0 };
    std.mem.writeInt(u16, header[3..5], @intCast(fragment.len), .big);
    try out.appendSlice(gpa, &header);
    try out.appendSlice(gpa, fragment);
}

test "a message spanning records is reassembled into scratch, byte-for-byte" {
    const gpa = testing.allocator;
    for (fixtures.clienthello.all) |fx| {
        const message = (try parseRecord(fx.bytes)).fragment;
        // Split points: inside the 4-byte handshake header (1, 3), right after it (4), in the middle,
        // one byte before the end; and a three-way split.
        const splits = [_][]const usize{
            &.{1},               &.{3},        &.{4}, &.{message.len / 2},
            &.{message.len - 1}, &.{ 2, 700 },
        };
        for (splits) |sizes| {
            const stream = try frame(gpa, message, sizes);
            defer gpa.free(stream);
            const scratch = try gpa.alloc(u8, message.len);
            defer gpa.free(scratch);

            const msg = try firstHandshakeMessage(stream, scratch);
            try testing.expectEqual(@as(u8, 1), msg.msg_type);
            try testing.expectEqualSlices(u8, message, msg.bytes);
            try testing.expectEqual(@intFromPtr(scratch.ptr), @intFromPtr(msg.bytes.ptr)); // copied

            // Every strict prefix of the multi-record stream is still Truncated.
            for (0..stream.len) |k| {
                try testing.expectError(error.Truncated, firstHandshakeMessage(stream[0..k], scratch));
            }
            // A scratch buffer one byte too small is the caller's limit, reported as such.
            try testing.expectError(error.MessageTooLarge, firstHandshakeMessage(stream, scratch[0 .. message.len - 1]));
        }
    }
}

test "a record holding two messages yields only the first (borrowed)" {
    const gpa = testing.allocator;
    const message = (try parseRecord(fixtures.clienthello.chrome_153_macos_1)).fragment;
    // Second message: an arbitrary 4-byte-header message (type 2, length 1, body 0xaa).
    const second = [_]u8{ 0x02, 0x00, 0x00, 0x01, 0xaa };
    var fragment: std.ArrayList(u8) = .empty;
    defer fragment.deinit(gpa);
    try fragment.appendSlice(gpa, message);
    try fragment.appendSlice(gpa, &second);
    var stream: std.ArrayList(u8) = .empty;
    defer stream.deinit(gpa);
    try appendRecord(gpa, &stream, 22, fragment.items);

    var scratch: [1]u8 = undefined;
    const msg = try firstHandshakeMessage(stream.items, &scratch);
    try testing.expectEqualSlices(u8, message, msg.bytes);
    try testing.expectEqual(@intFromPtr(stream.items.ptr) + record_header_len, @intFromPtr(msg.bytes.ptr));

    // Same when the first message spans records and the last record also starts the next message.
    var split: std.ArrayList(u8) = .empty;
    defer split.deinit(gpa);
    try appendRecord(gpa, &split, 22, message[0..100]);
    try appendRecord(gpa, &split, 22, fragment.items[100..]);
    var big_scratch: [4096]u8 = undefined;
    const msg2 = try firstHandshakeMessage(split.items, &big_scratch);
    try testing.expectEqualSlices(u8, message, msg2.bytes);
}

test "record layer contradictions are error.Malformed" {
    const gpa = testing.allocator;
    var scratch: [4096]u8 = undefined;
    const message = (try parseRecord(fixtures.clienthello.safari_26_6_2_macos_1)).fragment;

    // Length above 2^14: rejected from the header alone (no need to wait for 16385 bytes).
    const oversize = [_]u8{ 22, 0x03, 0x01, 0x40, 0x01 };
    try testing.expectError(error.Malformed, parseHeader(&oversize));
    try testing.expectError(error.Malformed, recordLen(&oversize));
    try testing.expectError(error.Malformed, parseRecord(&oversize));
    try testing.expectError(error.Malformed, firstHandshakeMessage(&oversize, &scratch));
    // Exactly 2^14 is allowed (and merely incomplete here).
    try testing.expectError(error.Truncated, parseRecord(&[_]u8{ 22, 0x03, 0x01, 0x40, 0x00 }));

    // First record is not a handshake record: an alert, application data, or plaintext HTTP.
    try testing.expectError(error.Malformed, firstHandshakeMessage(&[_]u8{ 21, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28 }, &scratch));
    try testing.expectError(error.Malformed, firstHandshakeMessage("GET / HTTP/1.1\r\n", &scratch));

    // Zero-length handshake fragment (Section 5.1 forbids it).
    try testing.expectError(error.Malformed, firstHandshakeMessage(&[_]u8{ 22, 0x03, 0x01, 0x00, 0x00 }, &scratch));

    // A message split over two records with a change_cipher_spec record in between (interleaving).
    var stream: std.ArrayList(u8) = .empty;
    defer stream.deinit(gpa);
    try appendRecord(gpa, &stream, 22, message[0..10]);
    try appendRecord(gpa, &stream, 20, &.{0x01});
    try appendRecord(gpa, &stream, 22, message[10..]);
    try testing.expectError(error.Malformed, firstHandshakeMessage(stream.items, &scratch));
}
