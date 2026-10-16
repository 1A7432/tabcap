//! wireprint build script (Zig 0.16).
//!
//! Options:
//!   -Dstrip=true   strip debug info from the executable (the release binaries tabcap embeds;
//!                  `zig objcopy --strip-all` is unimplemented for ELF, so stripping happens at link time).
//!
//! Layout: `src/root.zig` is the library module ("wireprint"), `src/main.zig` the CLI. Test inputs are
//! embedded through the `fixtures` and `spec` modules so `zig build test` never touches the network.
//! Pure Zig, no libc and no C libraries: every target cross-compiles from any host.
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const strip = b.option(bool, "strip", "Strip debug info from the executable") orelse false;

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
    });
    lib.addImport("fixtures", fixtures);
    lib.addImport("spec", spec);

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = strip,
    });
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
