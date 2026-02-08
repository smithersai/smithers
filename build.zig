const std = @import("std");

pub fn build(b: *std.Build) void {
    // zig build dev — build and launch the app
    const dev_step = b.step("dev", "Build and launch the Smithers macOS app");

    const build_codex = b.addSystemCommand(&.{
        "cargo",
        "build",
        "--release",
        "-p",
        "codex-app-server",
    });
    build_codex.cwd = b.path("codex/codex-rs");

    const xcodebuild_app = b.addSystemCommand(&.{
        "xcodebuild",
        "-project",
        "apps/desktop/Smithers.xcodeproj",
        "-scheme",
        "Smithers",
        "-configuration",
        "Debug",
        "-derivedDataPath",
        "apps/desktop/.build/xcode",
        "build",
    });
    xcodebuild_app.step.dependOn(&build_codex.step);

    const open_app = b.addSystemCommand(&.{
        "open",
        "apps/desktop/.build/xcode/Build/Products/Debug/Smithers.app",
    });
    open_app.step.dependOn(&xcodebuild_app.step);

    dev_step.dependOn(&open_app.step);

    // zig build test — run UI tests
    const test_step = b.step("test", "Run Smithers UI tests");

    const xcodebuild_test = b.addSystemCommand(&.{
        "xcodebuild",
        "test",
        "-project",
        "apps/desktop/Smithers.xcodeproj",
        "-scheme",
        "SmithersUITests",
        "-destination",
        "platform=macOS",
        "-derivedDataPath",
        "apps/desktop/.build/xcode",
    });

    test_step.dependOn(&xcodebuild_test.step);
}
