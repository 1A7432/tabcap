//! HTTP header consistency checks.
//!
//! Rules implemented here are the "self-contradiction" kind that need no corpus:
//!   H1  user-agent claims Chrome/Edge/Opera (a Chromium browser) but sec-ch-ua is absent, or vice versa
//!   H2  major version in user-agent differs from every version in sec-ch-ua
//!   H3  platform token in user-agent ("Macintosh", "Windows NT", "X11; Linux", "Android", "iPhone") differs
//!       from sec-ch-ua-platform
//!   H4  user-agent contains "HeadlessChrome" (headless keeps sec-ch-ua brand "Google Chrome")
//!   H5  user-agent claims Firefox/Safari but sec-ch-ua is present (only Chromium sends UA client hints)
//! Corpus-based rules (header order vs profile) live in the checker that has a profile at hand.
//! Oracle for the parsing helpers: the Structured Headers grammar of sec-ch-ua (RFC 8941 sf-list of
//! sf-string with a "v" parameter, https://wicg.github.io/ua-client-hints/#sec-ch-ua) and the UA formats
//! in https://www.chromium.org/updates/ua-reduction/ (frozen "Chrome/<major>.0.0.0").
const std = @import("std");

pub const Severity = enum { info, warn, red };

pub const Finding = struct {
    rule: []const u8,
    severity: Severity,
    message: []const u8,
};

/// One entry of a sec-ch-ua list: "Google Chrome";v="153"
pub const Brand = struct { name: []const u8, version: []const u8 };

/// Parses `"A";v="1", "B";v="2"` into brands (borrowing from `text`). Tolerant: malformed entries are skipped.
pub fn parseSecChUa(text: []const u8, out: []Brand) []Brand {
    var n: usize = 0;
    var rest = text;
    while (n < out.len) {
        rest = std.mem.trimStart(u8, rest, " \t,");
        if (rest.len == 0 or rest[0] != '"') break;
        const name_end = std.mem.indexOfScalarPos(u8, rest, 1, '"') orelse break;
        const name = rest[1..name_end];
        rest = rest[name_end + 1 ..];
        var version: []const u8 = "";
        if (std.mem.startsWith(u8, rest, ";v=\"")) {
            const v_end = std.mem.indexOfScalarPos(u8, rest, 4, '"') orelse break;
            version = rest[4..v_end];
            rest = rest[v_end + 1 ..];
        }
        out[n] = .{ .name = name, .version = version };
        n += 1;
        const next_comma = std.mem.indexOfScalar(u8, rest, ',') orelse {
            rest = rest[rest.len..];
            continue;
        };
        rest = rest[next_comma + 1 ..];
    }
    return out[0..n];
}

pub const UaFamily = enum { chrome, edge, opera, firefox, safari, other };

/// Product family as claimed by the user-agent string (order of checks matters: Edge/Opera UAs also contain "Chrome/").
pub fn uaFamily(ua: []const u8) UaFamily {
    if (std.mem.indexOf(u8, ua, "Edg/") != null or std.mem.indexOf(u8, ua, "EdgA/") != null or std.mem.indexOf(u8, ua, "EdgiOS/") != null) return .edge;
    if (std.mem.indexOf(u8, ua, "OPR/") != null) return .opera;
    if (std.mem.indexOf(u8, ua, "Firefox/") != null or std.mem.indexOf(u8, ua, "FxiOS/") != null) return .firefox;
    if (std.mem.indexOf(u8, ua, "Chrome/") != null or std.mem.indexOf(u8, ua, "CriOS/") != null or std.mem.indexOf(u8, ua, "HeadlessChrome/") != null) return .chrome;
    if (std.mem.indexOf(u8, ua, "Safari/") != null) return .safari;
    return .other;
}

/// Major version after "Chrome/" (or "HeadlessChrome/", "CriOS/", "Firefox/", "Version/" for Safari), or null.
pub fn uaMajorVersion(ua: []const u8) ?[]const u8 {
    const keys = [_][]const u8{ "HeadlessChrome/", "Chrome/", "CriOS/", "Firefox/", "FxiOS/", "Version/" };
    for (keys) |k| {
        if (std.mem.indexOf(u8, ua, k)) |i| {
            const start = i + k.len;
            var end = start;
            while (end < ua.len and std.ascii.isDigit(ua[end])) : (end += 1) {}
            if (end > start) return ua[start..end];
        }
    }
    return null;
}

pub const Platform = enum { macos, windows, linux, android, ios, chromeos, other };

pub fn uaPlatform(ua: []const u8) Platform {
    if (std.mem.indexOf(u8, ua, "iPhone") != null or std.mem.indexOf(u8, ua, "iPad") != null) return .ios;
    if (std.mem.indexOf(u8, ua, "Android") != null) return .android;
    if (std.mem.indexOf(u8, ua, "CrOS") != null) return .chromeos;
    if (std.mem.indexOf(u8, ua, "Macintosh") != null) return .macos;
    if (std.mem.indexOf(u8, ua, "Windows NT") != null) return .windows;
    if (std.mem.indexOf(u8, ua, "Linux") != null or std.mem.indexOf(u8, ua, "X11") != null) return .linux;
    return .other;
}

/// sec-ch-ua-platform values are quoted sf-strings: "macOS", "Windows", "Linux", "Android", "iOS", "Chrome OS", "Chromium OS", "Unknown".
pub fn clientHintPlatform(value: []const u8) Platform {
    const v = std.mem.trim(u8, value, "\" ");
    if (std.ascii.eqlIgnoreCase(v, "macOS")) return .macos;
    if (std.ascii.eqlIgnoreCase(v, "Windows")) return .windows;
    if (std.ascii.eqlIgnoreCase(v, "Linux")) return .linux;
    if (std.ascii.eqlIgnoreCase(v, "Android")) return .android;
    if (std.ascii.eqlIgnoreCase(v, "iOS")) return .ios;
    if (std.ascii.eqlIgnoreCase(v, "Chrome OS") or std.ascii.eqlIgnoreCase(v, "Chromium OS")) return .chromeos;
    return .other;
}

fn isGreaseBrand(name: []const u8) bool {
    // GREASE brands look like "Not/A)Brand", "Not;A=Brand", "Not_A Brand": they contain "Brand" and a "Not" prefix.
    return std.mem.startsWith(u8, name, "Not") and std.mem.indexOf(u8, name, "Brand") != null;
}

fn push(arena: std.mem.Allocator, out: *std.ArrayList(Finding), rule: []const u8, severity: Severity, comptime fmt: []const u8, args: anytype) std.mem.Allocator.Error!void {
    const msg = try std.fmt.allocPrint(arena, fmt, args);
    try out.append(arena, .{ .rule = rule, .severity = severity, .message = msg });
}

/// Evaluates rules H1..H5. Findings are appended to `out` (messages allocated in `arena`).
pub fn uaVersusClientHints(arena: std.mem.Allocator, user_agent: ?[]const u8, sec_ch_ua: ?[]const u8, sec_ch_ua_platform: ?[]const u8, out: *std.ArrayList(Finding)) std.mem.Allocator.Error!void {
    const ua = user_agent orelse {
        try push(arena, out, "H0", .warn, "no user-agent header", .{});
        return;
    };
    const family = uaFamily(ua);
    const chromium = family == .chrome or family == .edge or family == .opera;

    if (std.mem.indexOf(u8, ua, "HeadlessChrome") != null) {
        try push(arena, out, "H4", .red, "user-agent says HeadlessChrome", .{});
    }

    if (sec_ch_ua) |ch| {
        var brands_buf: [8]Brand = undefined;
        const brands = parseSecChUa(ch, &brands_buf);
        if (!chromium) {
            try push(arena, out, "H5", .red, "user-agent claims {t} but sec-ch-ua is present (only Chromium-based browsers send UA client hints)", .{family});
        }
        if (uaMajorVersion(ua)) |major| {
            var matched = false;
            for (brands) |b| {
                if (isGreaseBrand(b.name)) continue;
                if (std.mem.eql(u8, b.version, major)) matched = true;
            }
            if (!matched and brands.len > 0) {
                try push(arena, out, "H2", .red, "user-agent major version {s} does not appear in sec-ch-ua ({s})", .{ major, ch });
            }
        }
    } else if (chromium) {
        try push(arena, out, "H1", .warn, "user-agent claims a Chromium browser but no sec-ch-ua header was sent", .{});
    }

    if (sec_ch_ua_platform) |p| {
        const ua_plat = uaPlatform(ua);
        const ch_plat = clientHintPlatform(p);
        if (ua_plat != .other and ch_plat != .other and ua_plat != ch_plat) {
            try push(arena, out, "H3", .red, "user-agent platform {t} vs sec-ch-ua-platform {s}", .{ ua_plat, p });
        }
    }
}

test "sec-ch-ua parsing" {
    var buf: [8]Brand = undefined;
    const b = parseSecChUa("\"Google Chrome\";v=\"153\", \"Chromium\";v=\"153\", \"Not/A)Brand\";v=\"24\"", &buf);
    try std.testing.expectEqual(@as(usize, 3), b.len);
    try std.testing.expectEqualStrings("Google Chrome", b[0].name);
    try std.testing.expectEqualStrings("153", b[0].version);
    try std.testing.expectEqualStrings("Not/A)Brand", b[2].name);
    try std.testing.expect(isGreaseBrand(b[2].name));
    try std.testing.expectEqual(@as(usize, 0), parseSecChUa("", &buf).len);
}

test "ua helpers" {
    const chrome_mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
    const firefox_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0";
    const safari_mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
    const edge_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";
    try std.testing.expectEqual(UaFamily.chrome, uaFamily(chrome_mac));
    try std.testing.expectEqual(UaFamily.firefox, uaFamily(firefox_win));
    try std.testing.expectEqual(UaFamily.safari, uaFamily(safari_mac));
    try std.testing.expectEqual(UaFamily.edge, uaFamily(edge_win));
    try std.testing.expectEqualStrings("153", uaMajorVersion(chrome_mac).?);
    try std.testing.expectEqualStrings("156", uaMajorVersion(firefox_win).?);
    try std.testing.expectEqualStrings("26", uaMajorVersion(safari_mac).?);
    try std.testing.expectEqual(Platform.macos, uaPlatform(chrome_mac));
    try std.testing.expectEqual(Platform.windows, uaPlatform(firefox_win));
    try std.testing.expectEqual(Platform.macos, clientHintPlatform("\"macOS\""));
}

test "rules H1-H5" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const chrome_mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
    const ch_153 = "\"Google Chrome\";v=\"153\", \"Chromium\";v=\"153\", \"Not/A)Brand\";v=\"24\"";

    // consistent: no findings
    var f: std.ArrayList(Finding) = .empty;
    try uaVersusClientHints(arena, chrome_mac, ch_153, "\"macOS\"", &f);
    try std.testing.expectEqual(@as(usize, 0), f.items.len);

    // H2: version mismatch (UA says 153, hints say 150)
    f = .empty;
    try uaVersusClientHints(arena, chrome_mac, "\"Google Chrome\";v=\"150\", \"Chromium\";v=\"150\"", "\"macOS\"", &f);
    try std.testing.expectEqual(@as(usize, 1), f.items.len);
    try std.testing.expectEqualStrings("H2", f.items[0].rule);

    // H3: platform mismatch (UA says Windows, hints say macOS)
    f = .empty;
    const chrome_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
    try uaVersusClientHints(arena, chrome_win, ch_153, "\"macOS\"", &f);
    try std.testing.expectEqual(@as(usize, 1), f.items.len);
    try std.testing.expectEqualStrings("H3", f.items[0].rule);

    // H1: Chromium UA without hints
    f = .empty;
    try uaVersusClientHints(arena, chrome_mac, null, null, &f);
    try std.testing.expectEqual(@as(usize, 1), f.items.len);
    try std.testing.expectEqualStrings("H1", f.items[0].rule);

    // H5: Firefox UA with hints
    f = .empty;
    try uaVersusClientHints(arena, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0", ch_153, null, &f);
    try std.testing.expect(f.items.len >= 1);
    try std.testing.expectEqualStrings("H5", f.items[0].rule);

    // H4: headless
    f = .empty;
    try uaVersusClientHints(arena, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36", ch_153, "\"macOS\"", &f);
    try std.testing.expectEqual(@as(usize, 1), f.items.len);
    try std.testing.expectEqualStrings("H4", f.items[0].rule);
}
