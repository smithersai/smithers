import { describe, expect, it } from "@effect/vitest"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const binPath = fileURLToPath(new URL("../bin/smithers-comments.mjs", import.meta.url))

interface CliRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const runBin = async (args: ReadonlyArray<string>, cwd: string): Promise<CliRunResult> => {
  try {
    const res = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 20_000
    })
    return { exitCode: 0, stdout: res.stdout, stderr: res.stderr }
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string }
    return {
      exitCode: typeof e.code === "number" ? e.code : 4,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? ""
    }
  }
}

describe("CLI E2E", () => {
  it("supports --help, --version, and returns exit code 2 for bad flags or invalid config", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-e2e-help-"))
    try {
      const help = await runBin(["--help"], tmp)
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain("smithers-comments")
      expect(help.stdout).toContain("check")
      expect(help.stdout).toContain("extract")
      expect(help.stdout).toContain("render")

      const ver = await runBin(["--version"], tmp)
      expect(ver.exitCode).toBe(0)
      expect(ver.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)

      const badCmd = await runBin(["unknown-subcommand"], tmp)
      expect(badCmd.exitCode).toBe(2)

      const badRenderFlags = await runBin(["render", "--out", "a", "--in-place"], tmp)
      expect(badRenderFlags.exitCode).toBe(2)

      const badRemoveFlag = await runBin(["render", "--remove-sidecars"], tmp)
      expect(badRemoveFlag.exitCode).toBe(2)

      const badCheckFlag = await runBin(["render", "--check"], tmp)
      expect(badCheckFlag.exitCode).toBe(2)

      // Bad config file -> exit 2
      await Fs.mkdir(Path.join(tmp, ".smithers"), { recursive: true })
      await Fs.writeFile(Path.join(tmp, ".smithers/comments.json"), "{ invalid json", "utf8")
      const badCfg = await runBin(["check"], tmp)
      expect(badCfg.exitCode).toBe(2)
    } finally {
      await Fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("runs the complete inline mode lifecycle with incremental Smithers caching and fix", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-e2e-inline-"))
    try {
      await Fs.mkdir(Path.join(tmp, "src"), { recursive: true })
      await Fs.writeFile(
        Path.join(tmp, "src/auth.ts"),
        [
          "/** Verifies an incoming session token against active signing keys. */",
          "export function verifyToken(token: string) {",
          "  // Reject empty tokens immediately before cryptographic hashing.",
          "  return token.length > 0",
          "}",
          ""
        ].join("\n"),
        "utf8"
      )

      // init inline
      const init1 = await runBin(["init", "--mode", "inline"], tmp)
      expect(init1.exitCode).toBe(0)

      // second init without --force exits 3
      const initDup = await runBin(["init", "--mode", "inline"], tmp)
      expect(initDup.exitCode).toBe(3)

      // Cold check -> exit 0, 0 cache hits
      const check1 = await runBin(["check", "--offline", "--json"], tmp)
      expect(check1.exitCode).toBe(0)
      const r1 = JSON.parse(check1.stdout)
      expect(r1.mode).toBe("inline")
      expect(r1.ok).toBe(true)
      expect(r1.commentsChecked).toBe(2)
      expect(r1.cacheHits).toBe(0)
      expect(r1.cacheMisses).toBe(2)

      // Warm check -> exit 0, 2 cache hits, 0 misses, 0 agent calls
      const check2 = await runBin(["lint", "--offline", "--json"], tmp)
      expect(check2.exitCode).toBe(0)
      const r2 = JSON.parse(check2.stdout)
      expect(r2.cacheHits).toBe(2)
      expect(r2.cacheMisses).toBe(0)
      expect(r2.agentCalls).toBe(0)

      // Introduce an empty comment and a stale @param -> check exits 1
      await Fs.writeFile(
        Path.join(tmp, "src/auth.ts"),
        [
          "/**",
          " * @param oldToken The raw bearer string",
          " */",
          "export function verifyToken(token: string) {",
          "  //",
          "  return token.length > 0",
          "}",
          ""
        ].join("\n"),
        "utf8"
      )

      const checkFail = await runBin(["check", "--offline", "--json"], tmp)
      expect(checkFail.exitCode).toBe(1)
      const rFail = JSON.parse(checkFail.stdout)
      expect(rFail.ok).toBe(false)
      expect(rFail.diagnostics.length).toBeGreaterThanOrEqual(2)

      // Fix repairs the comments
      const fixRes = await runBin(["fix", "--offline", "--json"], tmp)
      expect(fixRes.exitCode).toBe(0)
      const rFix = JSON.parse(fixRes.stdout)
      expect(rFix.editsApplied).toBeGreaterThan(0)

      // Re-check now exits 0
      const checkAfter = await runBin(["check", "--offline", "--json"], tmp)
      expect(checkAfter.exitCode).toBe(0)
    } finally {
      await Fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("runs the complete external mode lifecycle with custom folder, extract, check, render, and in-place restore", async () => {
    const tmp = await Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-e2e-external-"))
    try {
      await Fs.mkdir(Path.join(tmp, "src"), { recursive: true })
      const srcPath = Path.join(tmp, "src/cache.ts")
      await Fs.writeFile(
        srcPath,
        [
          "// SPDX-License-Identifier: MIT",
          "/** Evicts the oldest entry when capacity is reached. */",
          "export function evictOldest(items: Array<string>) {",
          "  // @ts-expect-error intentional demo pragma",
          "  // Keep array mutation in place to avoid GC churn.",
          "  return items.shift()",
          "}",
          ""
        ].join("\n"),
        "utf8"
      )

      // Init external mode with custom dir .notes
      const init = await runBin(["init", "--mode", "external", "--dir", ".notes"], tmp)
      expect(init.exitCode).toBe(0)

      // Extract inline comments into .notes/
      const extracted = await runBin(["extract", "--json"], tmp)
      expect(extracted.exitCode).toBe(0)
      const extReport = JSON.parse(extracted.stdout)
      expect(extReport.commentsDir).toBe(".notes")
      expect(extReport.commentsExtracted).toBe(2)
      expect(extReport.pragmasPreserved).toBe(2)
      expect(extReport.sidecarsWritten).toBe(1)

      // Verify source file is clean of prose comments while pragmas stay
      const cleanCode = await Fs.readFile(srcPath, "utf8")
      expect(cleanCode).toContain("SPDX-License-Identifier: MIT")
      expect(cleanCode).toContain("@ts-expect-error")
      expect(cleanCode).not.toContain("Evicts the oldest entry")
      expect(cleanCode).not.toContain("Keep array mutation")

      // Verify sidecar file exists at .notes/src/cache.ts.md
      const sidecarText = await Fs.readFile(Path.join(tmp, ".notes/src/cache.ts.md"), "utf8")
      expect(sidecarText).toContain("source: src/cache.ts")
      expect(sidecarText).toContain("Evicts the oldest entry")

      // Check in external mode passes
      const checkClean = await runBin(["check", "--offline", "--json"], tmp)
      expect(checkClean.exitCode).toBe(0)

      // Status reports external mode counts accurately
      const status = await runBin(["status", "--json"], tmp)
      expect(status.exitCode).toBe(0)
      const st = JSON.parse(status.stdout)
      expect(st.mode).toBe("external")
      expect(st.commentsDir).toBe(".notes")
      expect(st.sidecarFiles).toBe(1)
      expect(st.externalComments).toBe(2)
      expect(st.inlineComments).toBe(0)
      expect(st.pragmasPreserved).toBe(2)

      // Render single file to stdout
      const renderStdout = await runBin(["render", "--file", "src/cache.ts"], tmp)
      expect(renderStdout.exitCode).toBe(0)
      expect(renderStdout.stdout).toContain("Evicts the oldest entry")
      expect(renderStdout.stdout).toContain("Keep array mutation")
      expect(renderStdout.stdout).toContain("SPDX-License-Identifier: MIT")

      // Render to virtual output directory + verify --check passes then catches drift
      const renderOut = await runBin(["render", "--out", ".smithers/virtual-preview", "--json"], tmp)
      expect(renderOut.exitCode).toBe(0)
      const rOut = JSON.parse(renderOut.stdout)
      expect(rOut.filesRendered).toBe(1)
      expect(rOut.commentsInjected).toBe(2)

      const checkNoDrift = await runBin(["render", "--out", ".smithers/virtual-preview", "--check"], tmp)
      expect(checkNoDrift.exitCode).toBe(0)

      await Fs.writeFile(Path.join(tmp, ".smithers/virtual-preview/src/cache.ts"), "edited\n", "utf8")
      const checkDrift = await runBin(["render", "--out", ".smithers/virtual-preview", "--check"], tmp)
      expect(checkDrift.exitCode).toBe(1)

      // Stray inline comment in external mode triggers exit 1
      await Fs.writeFile(srcPath, cleanCode + "// stray inline comment\n", "utf8")
      const checkStray = await runBin(["check", "--offline", "--json"], tmp)
      expect(checkStray.exitCode).toBe(1)
      expect(JSON.parse(checkStray.stdout).diagnostics.some((d: { code: string }) => d.code === "stray-inline-comment"))
        .toBe(true)

      // Restore clean file, then render --in-place --remove-sidecars switches back to inline
      await Fs.writeFile(srcPath, cleanCode, "utf8")
      const restore = await runBin(["render", "--in-place", "--remove-sidecars"], tmp)
      expect(restore.exitCode).toBe(0)
      const restoredCode = await Fs.readFile(srcPath, "utf8")
      expect(restoredCode).toContain("Evicts the oldest entry")
      expect(restoredCode).toContain("Keep array mutation")
      await expect(Fs.access(Path.join(tmp, ".notes/src/cache.ts.md"))).rejects.toThrow()
    } finally {
      await Fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
