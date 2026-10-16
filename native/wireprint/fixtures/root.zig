//! Fixture module: every test input is embedded here so `zig build test` is offline and deterministic.
//! Provenance of each file is documented in the sibling README files; expected values come from
//! oracles (OpenSSL ClientHello callbacks, RFC 7541 appendices, FoxIO JA4.md, Chromium source), never
//! from this project's own parsers.

/// Raw first TLS record (5-byte record header + ClientHello handshake message) as seen by the
/// echo-server PoC via MSG_PEEK on 2026-09-23 (macOS 26.6.2, loopback).
pub const clienthello = struct {
    pub const chrome_153_macos_1 = @embedFile("clienthello/chrome-153-macos-1.bin");
    pub const chrome_153_macos_2 = @embedFile("clienthello/chrome-153-macos-2.bin");
    /// Resumption attempt: pre_shared_key (0x0029) is the last extension.
    pub const chrome_153_macos_psk = @embedFile("clienthello/chrome-153-macos-psk.bin");
    pub const firefox_157b4_macos_1 = @embedFile("clienthello/firefox-157b4-macos-1.bin");
    pub const firefox_157b4_macos_psk = @embedFile("clienthello/firefox-157b4-macos-psk.bin");
    pub const safari_26_6_2_macos_1 = @embedFile("clienthello/safari-26.6.2-macos-1.bin");
    /// Chrome for Testing 155.0.8059.79 (macOS arm64) through a Bun TLS relay on 2026-10-16 (the 0.4-W2
    /// spike, first record as relayed): two first connections that each carried a navigation, and one
    /// resumption (pre_shared_key last) that carried /favicon.ico.
    pub const cft_155_macos_nav_1 = @embedFile("clienthello/cft-155-macos-nav-1.bin");
    pub const cft_155_macos_nav_2 = @embedFile("clienthello/cft-155-macos-nav-2.bin");
    pub const cft_155_macos_psk = @embedFile("clienthello/cft-155-macos-psk.bin");

    pub const all = [_]struct { name: []const u8, bytes: []const u8 }{
        .{ .name = "chrome-153-macos-1", .bytes = chrome_153_macos_1 },
        .{ .name = "chrome-153-macos-2", .bytes = chrome_153_macos_2 },
        .{ .name = "chrome-153-macos-psk", .bytes = chrome_153_macos_psk },
        .{ .name = "firefox-157b4-macos-1", .bytes = firefox_157b4_macos_1 },
        .{ .name = "firefox-157b4-macos-psk", .bytes = firefox_157b4_macos_psk },
        .{ .name = "safari-26.6.2-macos-1", .bytes = safari_26_6_2_macos_1 },
        .{ .name = "cft-155-macos-nav-1", .bytes = cft_155_macos_nav_1 },
        .{ .name = "cft-155-macos-nav-2", .bytes = cft_155_macos_nav_2 },
        .{ .name = "cft-155-macos-psk", .bytes = cft_155_macos_psk },
    };
};

/// OpenSSL-oracle expectations for the ClientHello fixtures (fixtures/clienthello/index.zig).
pub const clienthello_expected = @import("clienthello/index.zig");

/// Synthetic legacy pcap files wrapping the real ClientHello bytes (fixtures/pcap/index.zig).
pub const pcap = @import("pcap/index.zig");

/// Decrypted client->server HTTP/2 bytes from the same capture: connection preface followed by the
/// first frames (SETTINGS, WINDOW_UPDATE, possibly SETTINGS ACK and HEADERS). HEADERS payloads are
/// HPACK-encoded request headers to https://localhost:<port>/ (no cookies).
pub const h2 = struct {
    pub const chrome_153_macos = @embedFile("h2/chrome-153-macos.bin");
    pub const firefox_157b4_macos = @embedFile("h2/firefox-157b4-macos.bin");
    pub const safari_26_6_2_macos = @embedFile("h2/safari-26.6.2-macos.bin");
    /// Chrome for Testing 155 (same connections as clienthello.cft_155_macos_nav_1 / _psk): the decrypted
    /// client stream of the navigation to https://localhost:<port>/?h=localhost&r=1 and of /favicon.ico.
    pub const cft_155_macos_nav = @embedFile("h2/cft-155-macos-nav.bin");
    pub const cft_155_macos_favicon = @embedFile("h2/cft-155-macos-favicon.bin");
};

/// HTTP/1.1 request heads (see fixtures/h1/README.md): request line + header fields + empty line.
pub const h1 = struct {
    pub const get_basic = @embedFile("h1/get-basic.bin");
};

/// RFC 7541 Appendix C header blocks (see fixtures/hpack/README.md).
pub const hpack = struct {
    pub const Case = struct { section: []const u8, hex: []const u8, json: []const u8 };
    pub const cases = [_]Case{
        .{ .section = "C.2.1", .hex = @embedFile("hpack/c2_1.hex"), .json = @embedFile("hpack/c2_1.json") },
        .{ .section = "C.2.2", .hex = @embedFile("hpack/c2_2.hex"), .json = @embedFile("hpack/c2_2.json") },
        .{ .section = "C.2.3", .hex = @embedFile("hpack/c2_3.hex"), .json = @embedFile("hpack/c2_3.json") },
        .{ .section = "C.2.4", .hex = @embedFile("hpack/c2_4.hex"), .json = @embedFile("hpack/c2_4.json") },
        .{ .section = "C.3.1", .hex = @embedFile("hpack/c3_1.hex"), .json = @embedFile("hpack/c3_1.json") },
        .{ .section = "C.3.2", .hex = @embedFile("hpack/c3_2.hex"), .json = @embedFile("hpack/c3_2.json") },
        .{ .section = "C.3.3", .hex = @embedFile("hpack/c3_3.hex"), .json = @embedFile("hpack/c3_3.json") },
        .{ .section = "C.4.1", .hex = @embedFile("hpack/c4_1.hex"), .json = @embedFile("hpack/c4_1.json") },
        .{ .section = "C.4.2", .hex = @embedFile("hpack/c4_2.hex"), .json = @embedFile("hpack/c4_2.json") },
        .{ .section = "C.4.3", .hex = @embedFile("hpack/c4_3.hex"), .json = @embedFile("hpack/c4_3.json") },
        .{ .section = "C.5.1", .hex = @embedFile("hpack/c5_1.hex"), .json = @embedFile("hpack/c5_1.json") },
        .{ .section = "C.5.2", .hex = @embedFile("hpack/c5_2.hex"), .json = @embedFile("hpack/c5_2.json") },
        .{ .section = "C.5.3", .hex = @embedFile("hpack/c5_3.hex"), .json = @embedFile("hpack/c5_3.json") },
        .{ .section = "C.6.1", .hex = @embedFile("hpack/c6_1.hex"), .json = @embedFile("hpack/c6_1.json") },
        .{ .section = "C.6.2", .hex = @embedFile("hpack/c6_2.hex"), .json = @embedFile("hpack/c6_2.json") },
        .{ .section = "C.6.3", .hex = @embedFile("hpack/c6_3.hex"), .json = @embedFile("hpack/c6_3.json") },
    };
};
