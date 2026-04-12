import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_MAX_PATCH_FILES, SANDBOX_MAX_README_BYTES, validateSandboxBundle, writeSandboxBundle, } from "../src/bundle.js";
/**
 * @param {string} prefix
 */
function tempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}
describe("sandbox bundle", () => {
    test("writes and validates a bundle", async () => {
        const bundlePath = tempDir("smithers-sandbox-bundle-");
        const streamLogPath = join(bundlePath, "source-stream.ndjson");
        writeFileSync(streamLogPath, "{\"event\":\"started\"}\n", "utf8");
        await writeSandboxBundle({
            bundlePath,
            output: { ok: true },
            status: "finished",
            runId: "child-run-1",
            streamLogPath,
            patches: [
                {
                    path: "patches/0001-change.patch",
                    content: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
                },
            ],
            artifacts: [
                {
                    path: "artifacts/report.json",
                    content: "{\"ok\":true}",
                },
            ],
        });
        const validated = await validateSandboxBundle(bundlePath);
        expect(validated.manifest.status).toBe("finished");
        expect(validated.manifest.outputs).toEqual({ ok: true });
        expect(validated.patchFiles).toContain("patches/0001-change.patch");
        expect(validated.logsPath).toBe(join(bundlePath, "logs", "stream.ndjson"));
    });
    test("rejects bundle without README", async () => {
        const bundlePath = tempDir("smithers-sandbox-bundle-");
        await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("missing README.md");
    });
    test("rejects README that is not JSON", async () => {
        const bundlePath = tempDir("smithers-sandbox-bundle-");
        writeFileSync(join(bundlePath, "README.md"), "not-json", "utf8");
        await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("must contain valid JSON");
    });
    test("rejects manifest patch path traversal", async () => {
        const bundlePath = tempDir("smithers-sandbox-bundle-");
        writeFileSync(join(bundlePath, "README.md"), JSON.stringify({
            outputs: {},
            status: "finished",
            patches: ["../../etc/passwd"],
        }), "utf8");
        await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("escapes sandbox root");
    });
    test("rejects too many patch files", async () => {
        const bundlePath = tempDir("smithers-sandbox-bundle-");
        mkdirSync(join(bundlePath, "patches"), { recursive: true });
        writeFileSync(join(bundlePath, "README.md"), JSON.stringify({ outputs: {}, status: "finished" }), "utf8");
        for (let i = 0; i <= SANDBOX_MAX_PATCH_FILES; i += 1) {
            writeFileSync(join(bundlePath, "patches", `${String(i).padStart(4, "0")}.patch`), "diff --git a/a b/a\n", "utf8");
        }
        await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("too many patch files");
    });
    test("rejects oversized README", async () => {
        const bundlePath = tempDir("smithers-sandbox-bundle-");
        const hugeReadme = "x".repeat(SANDBOX_MAX_README_BYTES + 1);
        writeFileSync(join(bundlePath, "README.md"), hugeReadme, "utf8");
        await expect(validateSandboxBundle(bundlePath)).rejects.toThrow("README.md exceeds");
    });
});
