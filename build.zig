const std = @import("std");
const builtin = @import("builtin");

pub fn build(b: *std.Build) !void {
    // =========================================================================
    // Build Options
    // =========================================================================
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // =========================================================================
    // Build Steps
    // =========================================================================
    const run_step = b.step("run", "Build and run the macOS app");
    const test_step = b.step("test", "Run all tests");
    const check_step = b.step("check", "Type-check Python (pyright)");
    const lint_step = b.step("lint", "Lint Python (ruff)");
    const fmt_step = b.step("fmt", "Format all code");
    const smitherskit_step = b.step("smitherskit", "Build SmithersKit library");

    // =========================================================================
    // Python / Smithers Core
    // =========================================================================
    const uv_sync = b.addSystemCommand(&.{ "uv", "sync" });

    const py_check = b.addSystemCommand(&.{ "uv", "run", "pyright" });
    py_check.step.dependOn(&uv_sync.step);

    const py_lint = b.addSystemCommand(&.{ "uv", "run", "ruff", "check", "." });

    const py_fmt = b.addSystemCommand(&.{ "uv", "run", "ruff", "format", "." });

    const py_test = b.addSystemCommand(&.{ "uv", "run", "pytest" });
    py_test.step.dependOn(&uv_sync.step);

    check_step.dependOn(&py_check.step);
    lint_step.dependOn(&py_lint.step);
    fmt_step.dependOn(&py_fmt.step);
    test_step.dependOn(&py_test.step);

    // =========================================================================
    // GhosttyKit (from submodule)
    // =========================================================================
    // Build GhosttyKit.xcframework from the ghostty submodule
    // This produces: ghostty/macos/GhosttyKit.xcframework
    // We disable the macOS app build since we're building our own Smithers app
    const ghostty_build = b.addSystemCommand(&.{
        "zig",
        "build",
        "-Doptimize=ReleaseFast",
        "-Dapp-runtime=none",
        "-Demit-xcframework=true",
        "-Demit-macos-app=false",
    });
    ghostty_build.setCwd(b.path("ghostty"));

    const ghostty_step = b.step("ghostty", "Build GhosttyKit.xcframework");
    ghostty_step.dependOn(&ghostty_build.step);

    // =========================================================================
    // SmithersKit (Zig proxy layer)
    // =========================================================================
    // Build SmithersKit as a shared library that wraps GhosttyKit
    // Using Zig 0.15+ API: addLibrary with .linkage option
    const smitherskit_mod = b.createModule(.{
        .root_source_file = b.path("src/smitherskit/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Add include paths for C headers
    smitherskit_mod.addIncludePath(b.path("include"));
    smitherskit_mod.addIncludePath(b.path("ghostty/include"));

    const smitherskit = b.addLibrary(.{
        .name = "SmithersKit",
        .linkage = .dynamic,
        .root_module = smitherskit_mod,
    });

    // Link against system frameworks
    smitherskit.linkFramework("Foundation");

    // Install the library
    const smitherskit_install = b.addInstallArtifact(smitherskit, .{});
    smitherskit_step.dependOn(&smitherskit_install.step);
    smitherskit_step.dependOn(&ghostty_build.step);

    // =========================================================================
    // macOS App (Smithers.app)
    // =========================================================================
    // Build the Smithers macOS app using xcodebuild
    // First ensure GhosttyKit is built
    const xcode_build = b.addSystemCommand(&.{
        "xcodebuild",
        "-project",
        "macos/Smithers.xcodeproj",
        "-scheme",
        "Smithers",
        "-configuration",
        "Debug",
        "SYMROOT=build",
        "build",
    });
    xcode_build.step.dependOn(&ghostty_build.step);

    const xcode_run = b.addSystemCommand(&.{ "open", "macos/build/Debug/Smithers.app" });
    xcode_run.step.dependOn(&xcode_build.step);

    run_step.dependOn(&xcode_run.step);

    // =========================================================================
    // All / Default
    // =========================================================================
    const all_step = b.step("all", "Build everything");
    all_step.dependOn(&uv_sync.step);
    all_step.dependOn(&ghostty_build.step);
    // NOTE: SmithersKit is not included in default build because it requires
    // linking against GhosttyKit, but the Xcode project links GhosttyKit directly.
    // SmithersKit is a future abstraction layer for AI features.
    // all_step.dependOn(smitherskit_step);

    b.default_step = all_step;

    // =========================================================================
    // Clean
    // =========================================================================
    const clean_py = b.addSystemCommand(&.{ "rm", "-rf", ".pytest_cache", "__pycache__" });
    const clean_zig = b.addSystemCommand(&.{ "rm", "-rf", "zig-cache", "zig-out", ".zig-cache" });
    const clean_ghostty = b.addSystemCommand(&.{ "rm", "-rf", "ghostty/zig-cache", "ghostty/zig-out" });
    const clean_macos = b.addSystemCommand(&.{ "rm", "-rf", "macos/build" });

    const clean_step = b.step("clean", "Clean build artifacts");
    clean_step.dependOn(&clean_py.step);
    clean_step.dependOn(&clean_zig.step);
    clean_step.dependOn(&clean_ghostty.step);
    clean_step.dependOn(&clean_macos.step);
}
