/**
 * Real CLI fixtures for the supported Windows WSL2 execution environment.
 * windows-confinement.yml provisions WSL2 and bubblewrap before running these;
 * missing confinement fails the suite. The same fixtures run on native Linux
 * and macOS for comparison. No test turns confinement off or skips a denial.
 */
import { ProcessSandbox } from "@smthrs/platform-node"
import { execFileSync, spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { openPackageIndex } from "../src/Cli.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { write } from "./helpers/WriteFile.ts"

const fixture = async <A>(body: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-windows-confinement-")))
  try {
    await write(root, "package.json", "{\"name\":\"confined-fixture\",\"private\":true}\n")
    await write(root, "yarn.lock", "")
    await write(root, "input.txt", "declared input\n")
    await write(root, "private.txt", "undeclared contents\n")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("confined-fixture", {
  repository: "git+https://example.invalid/confined-fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
  ${process.platform === "linux" ? "sandboxes: S.Sandboxes({ default: S.Sandbox.Bubblewrap() })," : ""}
})\n`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  declared: S.Shell.Build({ shell: "mkdir -p out && cat input.txt > out/result.txt", data: [S.file("input.txt")], outDirs: ["out"] }),
  readDenied: S.Shell.Run({ shell: "cat private.txt" }),
  writeDenied: S.Shell.Run({ shell: "printf escaped > private.txt" }),
  compare: S.Shell.Diff({ shell: "cat input.txt > result.txt", data: [S.file("input.txt")], changes: ["result.txt"] })
} })\n`
    )
    await write(root, "result.txt", "old result\n")
    execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
    execFileSync("jj", [
      "--repository",
      root,
      "--config",
      "user.name=Confinement fixture",
      "--config",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture"
    ], { stdio: "pipe" })
    return await body(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

const execute = async (root: string, target: string) => {
  const index = await openPackageIndex({ workspace: root })
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: [`//:${target}`] }
  const planned = await PackageExec.plan(options)
  return PackageExec.execute(planned, options)
}

if (process.platform === "win32") {
  it("executes the confined CLI fixtures through the provisioned Windows WSL2 backend", () => {
    const workspace = process.env["SMITHERS_WSL_WORKSPACE"]
    expect(workspace, "Provision WSL2 with windows-confinement.yml before running Windows confinement").toBeTruthy()
    const child = spawnSync("wsl.exe", [
      "--distribution",
      "Ubuntu-24.04",
      "--user",
      "confinement",
      "--cd",
      workspace!,
      "--exec",
      "env",
      "SMITHERS_WINDOWS_WSL_CONFINEMENT=1",
      "pnpm",
      "--dir",
      "packages/smithers/build/build-cli",
      "exec",
      "vitest",
      "run",
      "test/WindowsConfinement.test.ts",
      "--coverage.enabled=false",
      "--reporter=verbose"
    ], { encoding: "utf8" })
    expect(child.error).toBeUndefined()
    const output = child.stdout + child.stderr
    expect(child.status, output).toBe(0)
    expect(output).toContain("5 passed")
    for (
      const evidence of [
        "requires a real confined execution host",
        "restores cached bytes",
        "readDenied",
        "writeDenied",
        "declaration comparison"
      ]
    ) {
      expect(output).toContain(evidence)
    }
  })
} else {
  describe("Windows WSL2 confinement (#4166)", () => {
    it("requires a real confined execution host", async () => {
      if (process.env["SMITHERS_WINDOWS_WSL_CONFINEMENT"] === "1") {
        expect(process.platform).toBe("linux")
        expect(process.getuid?.()).toBeGreaterThan(0)
        expect(await Fs.readFile("/proc/sys/kernel/osrelease", "utf8")).toMatch(/microsoft.*WSL2/i)
      }
      const selected = ProcessSandbox.select({ network: "none" }, ProcessSandbox.host())
      expect(ProcessSandbox.isUnenforceable(selected), JSON.stringify(selected)).toBe(false)
      expect(selected._tag).toBe(process.platform === "darwin" ? "seatbelt" : "bubblewrap")
    })

    it("executes declared outputs, restores cached bytes, and invalidates changed inputs", () =>
      fixture(async (root) => {
        const first = await execute(root, "declared")
        expect(first.ok, JSON.stringify(first)).toBe(true)
        expect(await Fs.readFile(Path.join(root, "out/result.txt"), "utf8")).toBe("declared input\n")
        await Fs.rm(Path.join(root, "out"), { recursive: true })
        const cached = await execute(root, "declared")
        expect(cached.ok, JSON.stringify(cached)).toBe(true)
        expect(cached.results.find((entry) => entry.label === "//:declared")?.status).toBe("hit")
        expect(await Fs.readFile(Path.join(root, "out/result.txt"), "utf8")).toBe("declared input\n")
        await write(root, "input.txt", "changed input\n")
        const changed = await execute(root, "declared")
        expect(changed.ok, JSON.stringify(changed)).toBe(true)
        expect(changed.results.find((entry) => entry.label === "//:declared")?.status).not.toBe("hit")
        expect(await Fs.readFile(Path.join(root, "out/result.txt"), "utf8")).toBe("changed input\n")
      }))

    it.each(["readDenied", "writeDenied"])(
      "enforces %s through the real CLI execution boundary",
      (target) =>
        fixture(async (root) => {
          const denied = await execute(root, target)
          expect(denied.ok).toBe(false)
          const result = denied.results.find((entry) => entry.label === `//:${target}`)
          expect(result?.error).toMatch(/private\.txt|declared (read|write) set/)
          expect(result?.error).not.toContain("sandbox_unenforceable")
          expect(JSON.stringify(denied)).not.toContain("undeclared contents")
          expect(await Fs.readFile(Path.join(root, "private.txt"), "utf8")).toBe("undeclared contents\n")
        })
    )

    it("runs declaration comparison confined and preserves the real workspace", () =>
      fixture(async (root) => {
        const changed = await execute(root, "compare")
        expect(changed.ok).toBe(false)
        expect(changed.results.find((entry) => entry.label === "//:compare")?.error).toMatch(/diff|change|result\.txt/)
        expect(await Fs.readFile(Path.join(root, "result.txt"), "utf8")).toBe("old result\n")
        await write(root, "result.txt", "declared input\n")
        const same = await execute(root, "compare")
        expect(same.ok, JSON.stringify(same)).toBe(true)
        expect(await Fs.readFile(Path.join(root, "result.txt"), "utf8")).toBe("declared input\n")
      }))
  })
}
