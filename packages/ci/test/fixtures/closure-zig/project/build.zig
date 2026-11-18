const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const greet = b.dependency("greet", .{ .target = target, .optimize = optimize }).module("greet");

    // alpha: a shared file, an embedded file and a package from build.zig.zon.
    const alpha = b.addTest(.{ .name = "alpha", .root_module = b.createModule(.{
        .root_source_file = b.path("src/alpha.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "greet", .module = greet }},
    }) });
    const test_alpha = b.step("test-alpha", "Run the alpha tests");
    test_alpha.dependOn(&b.addRunArtifact(alpha).step);

    // beta: the shared file only.
    const beta = b.addTest(.{ .name = "beta", .root_module = b.createModule(.{
        .root_source_file = b.path("src/beta.zig"),
        .target = target,
        .optimize = optimize,
    }) });
    const test_beta = b.step("test-beta", "Run the beta tests");
    test_beta.dependOn(&b.addRunArtifact(beta).step);

    // gamma: a module that a command writes from data/words.zig.in.
    const copy = b.addSystemCommand(&.{"cp"});
    copy.addFileArg(b.path("data/words.zig.in"));
    const words = copy.addOutputFileArg("words.zig");
    const gamma = b.addTest(.{ .name = "gamma", .root_module = b.createModule(.{
        .root_source_file = b.path("src/gamma.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "words", .module = b.createModule(.{ .root_source_file = words }) }},
    }) });
    const test_gamma = b.step("test-gamma", "Run the gamma tests");
    test_gamma.dependOn(&b.addRunArtifact(gamma).step);

    const test_step = b.step("test", "Run every test");
    test_step.dependOn(test_alpha);
    test_step.dependOn(test_beta);
    test_step.dependOn(test_gamma);

    // broken: a test whose root imports a file that does not exist.
    const broken = b.addTest(.{ .name = "broken", .root_module = b.createModule(.{
        .root_source_file = b.path("src/broken.zig"),
        .target = target,
        .optimize = optimize,
    }) });
    b.step("test-broken", "Run a test that cannot compile").dependOn(&b.addRunArtifact(broken).step);

    // fmt: reads a whole directory.
    const fmt = b.addFmt(.{ .paths = &.{b.path("src")}, .check = true });
    b.step("fmt", "Check formatting").dependOn(&fmt.step);

    // run: a program with side effects.
    const exe = b.addExecutable(.{ .name = "hello", .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    }) });
    b.step("run", "Run the program").dependOn(&b.addRunArtifact(exe).step);
}
