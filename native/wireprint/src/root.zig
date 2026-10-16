//! wireprint library root.
//!
//! Layers:
//!   pcap / net       legacy pcap reader, Ethernet|DLT_NULL -> IPv4/IPv6 -> TCP, client-direction reassembly
//!   tls              TLS record layer + ClientHello parser (zero-copy, error.Truncated / error.Malformed)
//!   h2 / h1          HTTP/2 frame parser + HPACK decoder (RFC 9113 / RFC 7541); HTTP/1.1 request head (RFC 9112)
//!   fp               fingerprint algorithms: JA3, JA4 (BSD-3), Akamai HTTP/2 format
//!   report           per-connection report JSON (the shape profile / check / diff read)
//!   check / profile  consistency rules and the corpus profile record; diff: layer-grouped comparison
//!   cli              the command line as a testable function (src/main.zig wires it to argv and files)
//! TLS termination is not here: tabcap's Bun echo terminates TLS and hands the raw bytes to `report`.
//!
//! Parsing discipline (AGENTS.md): parsers borrow from the input slice, never copy; every out-of-bounds
//! read is `error.Truncated`, every self-contradiction is `error.Malformed`; no `unreachable`, no
//! `@panic`, no `catch unreachable` on any parse path.
const std = @import("std");

pub const hex = @import("hex.zig");
pub const pcap = @import("pcap.zig");
pub const net = struct {
    pub const eth_ip_tcp = @import("net/eth_ip_tcp.zig");
    pub const tcp_reassembly = @import("net/tcp_reassembly.zig");
};
pub const tls = struct {
    pub const record = @import("tls/record.zig");
    pub const client_hello = @import("tls/client_hello.zig");
    pub const grease = @import("tls/grease.zig");
};
pub const h2 = struct {
    pub const frame = @import("h2/frame.zig");
    pub const hpack = @import("h2/hpack.zig");
    pub const huffman_table = @import("h2/huffman_table.zig");
    pub const static_table = @import("h2/static_table.zig");
};
pub const h1 = @import("h1.zig");
pub const fp = struct {
    pub const ja3 = @import("fp/ja3.zig");
    pub const ja4 = @import("fp/ja4.zig");
    pub const akamai = @import("fp/akamai.zig");
};
pub const report = @import("report.zig");
pub const check = struct {
    pub const headers = @import("check/headers.zig");
    pub const claim = @import("check/claim.zig");
};
pub const profile = @import("profile.zig");
pub const diff = @import("diff.zig");
pub const cli = @import("cli.zig");

test {
    // Reference every module so its tests are included in `zig build test` (the same set on every OS).
    _ = hex;
    _ = pcap;
    _ = net.eth_ip_tcp;
    _ = net.tcp_reassembly;
    _ = tls.record;
    _ = tls.client_hello;
    _ = tls.grease;
    _ = h2.frame;
    _ = h2.hpack;
    _ = h2.huffman_table;
    _ = h2.static_table;
    _ = h1;
    _ = fp.ja3;
    _ = fp.ja4;
    _ = fp.akamai;
    _ = report;
    _ = check.headers;
    _ = check.claim;
    _ = profile;
    _ = diff;
    _ = cli;
}
