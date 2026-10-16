//! HTTP/1.1 request head parser: request-line and field lines up to the empty line.
//!
//! Spec: RFC 9112 §2.1 (message format: start-line CRLF *( field-line CRLF ) CRLF), §3 (request-line =
//! method SP request-target SP HTTP-version), §5.1 (field-line = field-name ":" OWS field-value OWS; "No
//! whitespace is allowed between the field name and colon"), §5.2 (obs-fold: a server MUST reject or
//! replace it; we reject), RFC 9110 §5.6.2 (token characters of method and field-name).
//! Oracle: that grammar and the literal bytes of fixtures/h1/*.bin (written by hand from it, see
//! fixtures/h1/README.md); reproduce with `zig build test`.
//!
//! Zero-copy: every slice points into the input. Truncated input (no empty line yet) is
//! `error.Truncated`; anything the grammar forbids is `error.Malformed`. Header names keep their case
//! (the case a client sends is part of what it looks like on the wire).
const std = @import("std");
const hpack = @import("h2/hpack.zig");

pub const Error = error{ Truncated, Malformed, OutOfMemory };

pub const Request = struct {
    method: []const u8,
    target: []const u8,
    version: []const u8,
    /// Field lines in wire order (`hpack.Header` so the report writers can share one code path).
    headers: []hpack.Header,
    /// Bytes up to and including the empty line.
    head_len: usize,
};

/// RFC 9110 §5.6.2 tchar.
fn isTchar(c: u8) bool {
    return switch (c) {
        'a'...'z', 'A'...'Z', '0'...'9' => true,
        '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~' => true,
        else => false,
    };
}

fn isToken(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |c| if (!isTchar(c)) return false;
    return true;
}

/// Field values: visible characters, SP / HTAB and obs-text; never CR, LF or NUL (RFC 9110 §5.5).
fn isFieldValue(s: []const u8) bool {
    for (s) |c| if (c == '\r' or c == '\n' or c == 0) return false;
    return true;
}

/// Parses the request head at the start of `bytes`. Bytes after the empty line (a body) are ignored.
/// `headers` is allocated with `gpa` (caller frees `Request.headers`).
pub fn parseHead(gpa: std.mem.Allocator, bytes: []const u8) Error!Request {
    const end = std.mem.indexOf(u8, bytes, "\r\n\r\n") orelse return error.Truncated;
    const head = bytes[0 .. end + 2]; // every line, each with its CRLF

    var lines = std.mem.splitSequence(u8, head[0 .. head.len - 2], "\r\n");
    const request_line = lines.next() orelse return error.Malformed;
    const sp1 = std.mem.indexOfScalar(u8, request_line, ' ') orelse return error.Malformed;
    const sp2 = std.mem.indexOfScalarPos(u8, request_line, sp1 + 1, ' ') orelse return error.Malformed;
    const method = request_line[0..sp1];
    const target = request_line[sp1 + 1 .. sp2];
    const version = request_line[sp2 + 1 ..];
    if (!isToken(method) or target.len == 0 or std.mem.indexOfAny(u8, target, " \t\r\n") != null) return error.Malformed;
    // HTTP-version = "HTTP/" DIGIT "." DIGIT (§2.3); only major version 1 is an HTTP/1 head (the h2
    // connection preface "PRI * HTTP/2.0" is, by design, not one: RFC 9113 §3.4).
    if (version.len != "HTTP/1.1".len or !std.mem.startsWith(u8, version, "HTTP/1.") or !std.ascii.isDigit(version[7])) return error.Malformed;

    var headers: std.ArrayList(hpack.Header) = .empty;
    errdefer headers.deinit(gpa);
    while (lines.next()) |line| {
        if (line.len == 0) return error.Malformed; // an empty line before the terminating one cannot happen
        if (line[0] == ' ' or line[0] == '\t') return error.Malformed; // obs-fold
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.Malformed;
        const name = line[0..colon];
        if (!isToken(name)) return error.Malformed; // also rejects whitespace before the colon
        const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
        if (!isFieldValue(value)) return error.Malformed;
        try headers.append(gpa, .{ .name = name, .value = value });
    }
    return .{ .method = method, .target = target, .version = version, .headers = try headers.toOwnedSlice(gpa), .head_len = end + 4 };
}

const testing = std.testing;

test "parseHead: the synthetic httpx-style head (names keep their case, order kept)" {
    const fixtures = @import("fixtures");
    const r = try parseHead(testing.allocator, fixtures.h1.get_basic);
    defer testing.allocator.free(r.headers);
    try testing.expectEqualStrings("GET", r.method);
    try testing.expectEqualStrings("/client?x=1", r.target);
    try testing.expectEqualStrings("HTTP/1.1", r.version);
    try testing.expectEqual(fixtures.h1.get_basic.len, r.head_len);
    const names = [_][]const u8{ "Host", "Accept", "Accept-Encoding", "Connection", "User-Agent", "Cookie" };
    try testing.expectEqual(names.len, r.headers.len);
    for (names, r.headers) |n, h| try testing.expectEqualStrings(n, h.name);
    try testing.expectEqualStrings("python-httpx/0.28.1", r.headers[4].value);
    try testing.expectEqualStrings("*/*", r.headers[1].value);
}

test "parseHead: truncation at every byte is Truncated, never a crash" {
    const fixtures = @import("fixtures");
    const full = fixtures.h1.get_basic;
    var i: usize = 0;
    while (i < full.len) : (i += 1) {
        try testing.expectError(error.Truncated, parseHead(testing.allocator, full[0..i]));
    }
}

test "parseHead: grammar violations are Malformed" {
    const bad = [_][]const u8{
        "GET /\r\n\r\n", // no version
        "GET  / HTTP/1.1\r\n\r\n", // empty target
        "G@T / HTTP/1.1\r\n\r\n", // method is not a token
        "GET / HTTP/1.1\r\nHost : x\r\n\r\n", // whitespace before the colon (RFC 9112 §5.1)
        "GET / HTTP/1.1\r\nHost: x\r\n folded\r\n\r\n", // obs-fold
        "GET / HTTP/1.1\r\nno-colon\r\n\r\n",
        "GET / HTTP/1.1\r\n: empty-name\r\n\r\n",
        "GET / HTTP/2\r\n\r\n",
        "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", // the h2 connection preface
        "GET / HTTP/1.1\r\nA: b\rc\r\n\r\n", // bare CR inside a value
    };
    for (bad) |b| try testing.expectError(error.Malformed, parseHead(testing.allocator, b));
}

test "parseHead: OWS around the value is trimmed, a body after the head is ignored" {
    const r = try parseHead(testing.allocator, "POST /x HTTP/1.1\r\nA:\t v \t\r\nB:\r\n\r\nBODY");
    defer testing.allocator.free(r.headers);
    try testing.expectEqualStrings("v", r.headers[0].value);
    try testing.expectEqualStrings("", r.headers[1].value);
    try testing.expectEqual(@as(usize, "POST /x HTTP/1.1\r\nA:\t v \t\r\nB:\r\n\r\n".len), r.head_len);
}
