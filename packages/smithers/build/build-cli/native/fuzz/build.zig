const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{
        .default_target = .{
            .abi = .musl,
        },
    });
    const optimize = b.standardOptimizeOption(.{});

    const mod = b.createModule(.{
        .root_source_file = b.path("observe_fuzz.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addIncludePath(b.path(".gen"));
    mod.addCSourceFile(.{
        .file = b.path("observe_fuzz_shim.c"),
        .flags = &.{ "-std=c11", "-Wno-unused-function", "-Wno-unused-variable", "-fno-sanitize-coverage=inline-8bit-counters,pc-table,trace-cmp" },
    });

    const tests = b.addTest(.{
        .root_module = mod,
        .use_llvm = true,
    });

    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run observe.c Zig fuzz tests (add --fuzz on Linux for continuous coverage-guided fuzzing)");
    test_step.dependOn(&run_tests.step);
}
