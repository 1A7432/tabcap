//! Expected values for ../clienthello/*.bin produced by the OpenSSL oracle (tools/openssl_oracle.c).
//! (Owned by the ClientHello parser implementation.)
//!
//! Each JSON file is the verbatim stdout of `openssl_oracle <name>.bin` (see tools/README-oracle.md and
//! README.md in this directory). Do not edit them by hand: regenerate from the oracle instead.
//! `name` matches the `name` field of `clienthello.all` in ../root.zig.
pub const all = [_]struct { name: []const u8, json: []const u8 }{
    .{ .name = "chrome-153-macos-1", .json = @embedFile("chrome-153-macos-1.expected.json") },
    .{ .name = "chrome-153-macos-2", .json = @embedFile("chrome-153-macos-2.expected.json") },
    .{ .name = "chrome-153-macos-psk", .json = @embedFile("chrome-153-macos-psk.expected.json") },
    .{ .name = "firefox-157b4-macos-1", .json = @embedFile("firefox-157b4-macos-1.expected.json") },
    .{ .name = "firefox-157b4-macos-psk", .json = @embedFile("firefox-157b4-macos-psk.expected.json") },
    .{ .name = "safari-26.6.2-macos-1", .json = @embedFile("safari-26.6.2-macos-1.expected.json") },
};
