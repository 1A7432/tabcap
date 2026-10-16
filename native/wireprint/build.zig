//! wireprint build script (Zig 0.16).
//!
//! Options:
//!   -Dopenssl=false       drop OpenSSL and the `serve` subcommand (pure-Zig offline tools only).
//!   -Dopenssl-prefix=DIR  OpenSSL install prefix (default: Homebrew openssl@3 on macOS).
//!
//! Layout: `src/root.zig` is the library module ("wireprint"), `src/main.zig` the CLI. Test inputs are
//! embedded through the `fixtures` and `spec` modules so `zig build test` never touches the network.
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const with_openssl = b.option(bool, "openssl", "Link OpenSSL and build the `serve` subcommand") orelse true;
    const openssl_prefix = b.option([]const u8, "openssl-prefix", "OpenSSL install prefix") orelse "/opt/homebrew/opt/openssl@3";

    const options = b.addOptions();
    options.addOption(bool, "openssl", with_openssl);
    // One options module shared by the library and the CLI (creating it twice makes Zig see two modules
    // rooted at the same generated file).
    const build_options = options.createModule();

    const fixtures = b.createModule(.{
        .root_source_file = b.path("fixtures/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const spec = b.createModule(.{
        .root_source_file = b.path("spec/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const lib = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = with_openssl,
    });
    lib.addImport("build_options", build_options);
    lib.addImport("fixtures", fixtures);
    lib.addImport("spec", spec);
    if (with_openssl) linkOpenSsl(b, lib, openssl_prefix);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = with_openssl,
    });
    exe_mod.addImport("build_options", build_options);
    exe_mod.addImport("wireprint", lib);

    const exe = b.addExecutable(.{ .name = "wireprint", .root_module = exe_mod });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    run.step.dependOn(b.getInstallStep());
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run wireprint").dependOn(&run.step);

    const tests = b.addTest(.{ .root_module = lib });
    const run_tests = b.addRunArtifact(tests);
    b.step("test", "Run unit tests (offline, deterministic)").dependOn(&run_tests.step);
}

fn linkOpenSsl(b: *std.Build, mod: *std.Build.Module, prefix: []const u8) void {
    // Homebrew OpenSSL is keg-only: pass explicit -I/-L instead of relying on pkg-config (not installed here).
    mod.addIncludePath(.{ .cwd_relative = b.fmt("{s}/include", .{prefix}) });
    mod.addLibraryPath(.{ .cwd_relative = b.fmt("{s}/lib", .{prefix}) });
    mod.linkSystemLibrary("ssl", .{ .use_pkg_config = .no });
    mod.linkSystemLibrary("crypto", .{ .use_pkg_config = .no });
}
