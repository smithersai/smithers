const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const lib_dir = b.option([]const u8, "ffi-lib-dir", "Directory containing libsmithers_ffi") orelse "../../../target/debug";

    const mod = b.createModule(.{
        .root_source_file = b.path("live_document_abi_fuzz.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addLibraryPath(b.path(lib_dir));
    mod.addRPath(b.path(lib_dir));
    mod.linkSystemLibrary("smithers_ffi", .{});

    const tests = b.addTest(.{ .root_module = mod, .use_llvm = true });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run live_document C ABI Zig fuzz tests (add --fuzz on Linux)");
    test_step.dependOn(&run_tests.step);
}
