//! Hex helpers. Project convention (AGENTS.md): hex is lowercase, no prefix, u16 values are 4 digits.
const std = @import("std");

pub const digits = "0123456789abcdef";

/// `0x1301` -> "1301".
pub fn u16Hex(v: u16) [4]u8 {
    return .{ digits[v >> 12], digits[(v >> 8) & 0xf], digits[(v >> 4) & 0xf], digits[v & 0xf] };
}

/// `0xab` -> "ab".
pub fn u8Hex(v: u8) [2]u8 {
    return .{ digits[v >> 4], digits[v & 0xf] };
}

/// Lowercase hex of `bytes` written to `out` (out.len must be >= 2 * bytes.len). Returns the slice written.
pub fn encode(out: []u8, bytes: []const u8) []u8 {
    std.debug.assert(out.len >= bytes.len * 2);
    for (bytes, 0..) |b, i| {
        out[i * 2] = digits[b >> 4];
        out[i * 2 + 1] = digits[b & 0xf];
    }
    return out[0 .. bytes.len * 2];
}

pub fn encodeAlloc(gpa: std.mem.Allocator, bytes: []const u8) std.mem.Allocator.Error![]u8 {
    const out = try gpa.alloc(u8, bytes.len * 2);
    return encode(out, bytes);
}

pub const DecodeError = error{ OddLength, InvalidCharacter };

/// Parses lowercase or uppercase hex without separators. `out.len` must be >= text.len / 2.
pub fn decode(out: []u8, text: []const u8) DecodeError![]u8 {
    if (text.len % 2 != 0) return error.OddLength;
    std.debug.assert(out.len >= text.len / 2);
    var i: usize = 0;
    while (i < text.len) : (i += 2) {
        const hi = try nibble(text[i]);
        const lo = try nibble(text[i + 1]);
        out[i / 2] = (hi << 4) | lo;
    }
    return out[0 .. text.len / 2];
}

pub fn decodeAlloc(gpa: std.mem.Allocator, text: []const u8) (DecodeError || std.mem.Allocator.Error)![]u8 {
    const trimmed = std.mem.trim(u8, text, " \r\n\t");
    const out = try gpa.alloc(u8, trimmed.len / 2);
    errdefer gpa.free(out);
    return try decode(out, trimmed);
}

fn nibble(c: u8) DecodeError!u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => error.InvalidCharacter,
    };
}

test "u16Hex is 4 lowercase digits" {
    try std.testing.expectEqualStrings("1301", &u16Hex(0x1301));
    try std.testing.expectEqualStrings("0000", &u16Hex(0));
    try std.testing.expectEqualStrings("ff01", &u16Hex(0xff01));
}

test "encode/decode round trip" {
    var buf: [8]u8 = undefined;
    try std.testing.expectEqualStrings("16030107", encode(&buf, &.{ 0x16, 0x03, 0x01, 0x07 }));
    var out: [4]u8 = undefined;
    try std.testing.expectEqualSlices(u8, &.{ 0x16, 0x03, 0x01, 0x07 }, try decode(&out, "16030107"));
    try std.testing.expectError(error.OddLength, decode(&out, "160"));
    try std.testing.expectError(error.InvalidCharacter, decode(&out, "16zz"));
}
