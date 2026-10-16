//! GREASE values (RFC 8701, https://www.rfc-editor.org/rfc/rfc8701.txt).
//!
//! Oracle: RFC 8701 Section 2 lists the 16 two-byte values reserved for cipher suites, ALPN, extensions,
//! named groups, signature algorithms and versions: 0x0a0a, 0x1a1a, ..., 0xfafa (both bytes equal, low
//! nibble 0xa). The 8 single-byte PskKeyExchangeModes values (0x0b, 0x2a, ...) are not needed by JA3/JA4.
//! Reproduce: `isGrease(v)` over all u16 yields exactly the 16 values in spec/test-vectors.json `grease.values`.
const std = @import("std");

/// True for the 16 RFC 8701 u16 GREASE values (pattern ?a?a with both bytes identical).
pub fn isGrease(v: u16) bool {
    const hi: u8 = @truncate(v >> 8);
    const lo: u8 = @truncate(v);
    return hi == lo and (lo & 0x0f) == 0x0a;
}

test "exactly the 16 RFC 8701 values are GREASE" {
    var count: usize = 0;
    var v: u32 = 0;
    while (v <= 0xffff) : (v += 1) {
        if (isGrease(@intCast(v))) count += 1;
    }
    try std.testing.expectEqual(@as(usize, 16), count);
    try std.testing.expect(isGrease(0x0a0a));
    try std.testing.expect(isGrease(0xfafa));
    try std.testing.expect(!isGrease(0x0a1a));
    try std.testing.expect(!isGrease(0x1301));
    try std.testing.expect(!isGrease(0x00ff));
    try std.testing.expect(!isGrease(0x5600));
    try std.testing.expect(!isGrease(0xfe00));
    try std.testing.expect(!isGrease(0x0000));
}
