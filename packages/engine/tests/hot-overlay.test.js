import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOverlay, cleanupGenerations, resolveOverlayEntry, } from "../src/hot/overlay.js";
function makeTempDir() {
    return mkdtempSync(join(tmpdir(), "smithers-hot-"));
}
describe("resolveOverlayEntry", () => {
    test("resolves entry path relative to overlay dir", () => {
        const result = resolveOverlayEntry("/project/src/workflow.ts", "/project", "/project/.smithers/hmr/gen-1");
        expect(result).toBe("/project/.smithers/hmr/gen-1/src/workflow.ts");
    });
    test("handles entry at root", () => {
        const result = resolveOverlayEntry("/project/workflow.ts", "/project", "/tmp/overlay/gen-1");
        expect(result).toBe("/tmp/overlay/gen-1/workflow.ts");
    });
    test("handles nested paths", () => {
        const result = resolveOverlayEntry("/project/a/b/c/entry.ts", "/project", "/out/gen-5");
        expect(result).toBe("/out/gen-5/a/b/c/entry.ts");
    });
});
describe("buildOverlay", () => {
    const dirs = [];
    afterEach(() => {
        for (const d of dirs) {
            try {
                rmSync(d, { recursive: true, force: true });
            }
            catch { }
        }
        dirs.length = 0;
    });
    test("creates generation directory with files", async () => {
        const root = makeTempDir();
        const outDir = makeTempDir();
        dirs.push(root, outDir);
        writeFileSync(join(root, "workflow.ts"), "export default {}");
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "helper.ts"), "export const x = 1");
        const genDir = await buildOverlay(root, outDir, 1);
        expect(genDir).toBe(join(outDir, "gen-1"));
        expect(existsSync(join(genDir, "workflow.ts"))).toBe(true);
        expect(existsSync(join(genDir, "src", "helper.ts"))).toBe(true);
        expect(readFileSync(join(genDir, "workflow.ts"), "utf8")).toBe("export default {}");
    });
    test("excludes node_modules by default", async () => {
        const root = makeTempDir();
        const outDir = makeTempDir();
        dirs.push(root, outDir);
        writeFileSync(join(root, "index.ts"), "ok");
        mkdirSync(join(root, "node_modules"));
        writeFileSync(join(root, "node_modules", "pkg.js"), "module");
        const genDir = await buildOverlay(root, outDir, 1);
        expect(existsSync(join(genDir, "index.ts"))).toBe(true);
        expect(existsSync(join(genDir, "node_modules"))).toBe(false);
    });
    test("excludes .git and .smithers by default", async () => {
        const root = makeTempDir();
        const outDir = makeTempDir();
        dirs.push(root, outDir);
        writeFileSync(join(root, "code.ts"), "ok");
        mkdirSync(join(root, ".git"));
        writeFileSync(join(root, ".git", "HEAD"), "ref");
        mkdirSync(join(root, ".smithers"));
        writeFileSync(join(root, ".smithers", "config"), "cfg");
        const genDir = await buildOverlay(root, outDir, 1);
        expect(existsSync(join(genDir, "code.ts"))).toBe(true);
        expect(existsSync(join(genDir, ".git"))).toBe(false);
        expect(existsSync(join(genDir, ".smithers"))).toBe(false);
    });
    test("skips dotfiles", async () => {
        const root = makeTempDir();
        const outDir = makeTempDir();
        dirs.push(root, outDir);
        writeFileSync(join(root, "visible.ts"), "ok");
        writeFileSync(join(root, ".hidden"), "secret");
        const genDir = await buildOverlay(root, outDir, 1);
        expect(existsSync(join(genDir, "visible.ts"))).toBe(true);
        expect(existsSync(join(genDir, ".hidden"))).toBe(false);
    });
    test("increments generation number in dir name", async () => {
        const root = makeTempDir();
        const outDir = makeTempDir();
        dirs.push(root, outDir);
        writeFileSync(join(root, "a.ts"), "ok");
        const gen1 = await buildOverlay(root, outDir, 1);
        const gen2 = await buildOverlay(root, outDir, 2);
        expect(gen1).toContain("gen-1");
        expect(gen2).toContain("gen-2");
        expect(existsSync(gen1)).toBe(true);
        expect(existsSync(gen2)).toBe(true);
    });
});
describe("cleanupGenerations", () => {
    const dirs = [];
    afterEach(() => {
        for (const d of dirs) {
            try {
                rmSync(d, { recursive: true, force: true });
            }
            catch { }
        }
        dirs.length = 0;
    });
    test("removes old generations keeping last N", async () => {
        const outDir = makeTempDir();
        dirs.push(outDir);
        for (let i = 1; i <= 5; i++) {
            mkdirSync(join(outDir, `gen-${i}`));
        }
        await cleanupGenerations(outDir, 2);
        expect(existsSync(join(outDir, "gen-1"))).toBe(false);
        expect(existsSync(join(outDir, "gen-2"))).toBe(false);
        expect(existsSync(join(outDir, "gen-3"))).toBe(false);
        expect(existsSync(join(outDir, "gen-4"))).toBe(true);
        expect(existsSync(join(outDir, "gen-5"))).toBe(true);
    });
    test("does nothing when fewer generations than keepLast", async () => {
        const outDir = makeTempDir();
        dirs.push(outDir);
        mkdirSync(join(outDir, "gen-1"));
        await cleanupGenerations(outDir, 5);
        expect(existsSync(join(outDir, "gen-1"))).toBe(true);
    });
    test("handles non-existent outDir", async () => {
        // Should not throw
        await cleanupGenerations("/tmp/nonexistent-dir-xyz-12345", 3);
    });
    test("ignores non-gen directories", async () => {
        const outDir = makeTempDir();
        dirs.push(outDir);
        mkdirSync(join(outDir, "gen-1"));
        mkdirSync(join(outDir, "gen-2"));
        mkdirSync(join(outDir, "gen-3"));
        mkdirSync(join(outDir, "other-dir"));
        await cleanupGenerations(outDir, 1);
        expect(existsSync(join(outDir, "gen-3"))).toBe(true);
        expect(existsSync(join(outDir, "other-dir"))).toBe(true);
        expect(existsSync(join(outDir, "gen-1"))).toBe(false);
    });
});
