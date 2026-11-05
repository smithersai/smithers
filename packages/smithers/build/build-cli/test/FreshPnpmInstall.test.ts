import { ProcessSandbox } from "@smthrs/platform-node"
import * as Exec from "@smthrs/targets/Exec"
import * as Manager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { runInstall } from "../src/engine.ts"
import * as Runner from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { runTarget } from "../src/TargetExecution.ts"
import { write } from "./helpers/WriteFile.ts"

const execFile = promisify(ChildProcess.execFile)
const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

// A real local package keeps the fresh-checkout regression independent of a registry.
// Its bin deliberately differs from its package name: resolution needs the installed manifest.
const fixture = async (source = "", confined = false) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "sm-b17-pnpm-")))
  roots.push(root)
  const version = (await execFile("pnpm", ["--version"])).stdout.trim()
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "fresh-pnpm-install",
      private: true,
      type: "module",
      packageManager: `pnpm@${version}`,
      dependencies: { "fixture-tool": "file:./fixture-tool-1.0.0.tgz" }
    })
  )
  await write(
    root,
    "tool/package.json",
    JSON.stringify({
      name: "fixture-tool",
      version: "1.0.0",
      bin: { "fixture-command": "bin.cjs" }
    })
  )
  await write(
    root,
    "tool/bin.cjs",
    `#!/usr/bin/env node
console.log("FRESH_PNPM_TOOL_EXECUTED")
`
  )
  await Fs.chmod(Path.join(root, "tool/bin.cjs"), 0o755)
  await write(
    root,
    "pnpm-workspace.yaml",
    `packages:
  - .
enableGlobalVirtualStore: false
verifyDepsBeforeRun: error
`
  )
  await execFile("pnpm", ["pack", "--pack-destination", root], { cwd: Path.join(root, "tool") })
  await execFile("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root })
  await Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("fresh-pnpm-install", {
  repository: "git+https://example.invalid/fresh-pnpm-install.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ${JSON.stringify(process.versions.node)} }),
  packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml"), workspaces: S.file("//pnpm-workspace.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
  ${confined ? "" : "sandboxes: S.Sandboxes({ default: S.Sandbox.None() })"}
})`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
${
      source ||
      "export const Package = S.Package({ targets: { install: S.Install({ lockfilePath: \"pnpm-lock.yaml\" }) } })"
    }`
  )
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:install"], jobs: 1 }
  const install = () =>
    runInstall(root, {
      toolchain: {
        manager: "pnpm",
        managerExecutable: "pnpm",
        managerVersion: version,
        runtime: "node",
        runtimeVersion: process.versions.node,
        runtimeExecutable: process.execPath
      }
    })
  return { root, options, install, version }
}

describe("fresh pnpm installations", () => {
  it.each([false, true])(
    "resolves an installed bin after its dependency succeeds (transitive=%s)",
    async (transitive) => {
      const { root, options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const ready = S.Shell.Test({ bin: S.Runtime.bin, args: ["-e", "process.exit(0)"], data: [install] })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [${transitive ? "ready" : "install"}] })
export const Package = S.Package({ targets: { check } })`)
      const runOptions = { ...options, verb: "test" as const, patterns: ["//:check"] }
      const planned = await PackageExec.plan(runOptions)
      expect(planned.nodes.get("//:check")?.refusal).toBeUndefined()
      await expect(Fs.access(Path.join(root, "node_modules"))).rejects.toThrow()
      const result = await PackageExec.execute(planned, runOptions)
      expect(result.ok, JSON.stringify(result.results)).toBe(true)
      expect(result.results.find((row) => row.label === "//:check")?.status).toBe("ran")
      const again = await PackageExec.run(runOptions)
      expect(again.ok, JSON.stringify(again.results)).toBe(true)
      expect(again.results.find((row) => row.label === "//:check")?.status).toBe("hit")
      expect(again.results.find((row) => row.label === "//:check")?.key)
        .toBe(result.results.find((row) => row.label === "//:check")?.key)
    }
  )

  it.each(["lint", "ci"] as const)("retains kind-specific attributes after install under %s", async (verb) => {
    const { options } = await fixture(`
import * as Target from "@smthrs/targets/Target"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Shell from "@smthrs/targets/Shell"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const Check = Target.make("Shell.Test", {
  attrs: Shell.TestAttrs,
  kinds: ["lint", "test"],
  attrsForKind: (kind, attrs) => kind === "lint"
    ? { ...attrs, args: ["-e", "process.exit(0)"] }
    : attrs,
  implementation: () => Effect.void
})
const check = Check({ bin: S.Runtime.bin, args: ["-e", "process.exit(99)"], data: [install] })
export const Package = S.Package({ targets: { install, check } })`)
    const lintOptions = { ...options, verb: "lint" as const, patterns: ["//:check"] }
    const planned = await PackageExec.plan(lintOptions)
    const result = await PackageExec.execute(planned, { ...lintOptions, verb })
    expect(result.ok, JSON.stringify(result.results)).toBe(true)
    expect(result.results.find((row) => row.label === "//:check")?.status).toBe("ran")
  })

  it("refuses a missing bin when an unrelated Install is selected", async () => {
    const { options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool") })
export const Package = S.Package({ targets: { install, check } })`)
    const planned = await PackageExec.plan({ ...options, patterns: ["//:install", "//:check"] })
    expect(planned.nodes.get("//:check")?.refusal).toContain("node_modules binary not found")
  })

  it("refuses a bin still missing after a successful Install", async () => {
    const { options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("absent-tool"), data: [install] })
export const Package = S.Package({ targets: { install, check } })`)
    const result = await PackageExec.run({ ...options, patterns: ["//:check"] })
    expect(result.results.find((row) => row.label === "//:install")?.status).toBe("ran")
    expect(result.results.find((row) => row.label === "//:check")?.error).toContain("node_modules binary not found")
    expect(result.ok).toBe(false)
  })

  it("skips the consumer when the install service fails", async () => {
    const { root, options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [install] })
export const Package = S.Package({ targets: { install, check } })`)
    const runOptions = { ...options, patterns: ["//:check"] }
    const planned = await PackageExec.plan(runOptions)
    const result = await Effect.runPromise(
      Runner.executeEffect(planned, runOptions).pipe(
        Effect.provideService(Runner.ExecutionServices, {
          ...Runner.executionServicesLive,
          install: () => Effect.fail(new Error("install service unavailable"))
        })
      )
    )
    expect(result.ok).toBe(false)
    expect(result.results.find((row) => row.label === "//:install")?.error).toContain("install service unavailable")
    expect(result.results.find((row) => row.label === "//:check")).toMatchObject({
      status: "skipped",
      blockedBy: "//:install"
    })
    await expect(Fs.access(Path.join(root, "node_modules"))).rejects.toThrow()
  })

  it("refuses new external installation authority after install", async () => {
    const { root, options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [install] })
export const Package = S.Package({ targets: { install, check } })`)
    const external = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "sm-b17-external-")))
    roots.push(external)
    const runOptions = { ...options, patterns: ["//:check"] }
    const planned = await PackageExec.plan(runOptions)
    const result = await Effect.runPromise(
      Runner.executeEffect(planned, runOptions).pipe(
        Effect.provideService(Runner.ExecutionServices, {
          ...Runner.executionServicesLive,
          install: (...args) =>
            Runner.executionServicesLive.install(...args).pipe(
              Effect.tap(() =>
                Effect.promise(async () => {
                  await Fs.rename(Path.join(root, "node_modules"), Path.join(external, "node_modules"))
                  await Fs.symlink(Path.join(external, "node_modules"), Path.join(root, "node_modules"), "dir")
                })
              )
            )
        })
      )
    )
    expect(result.ok).toBe(false)
    expect(result.results.find((row) => row.label === "//:check")?.error)
      .toContain("dependency installation changed since planning")
  })

  it("preserves an unchanged installed tree across fetch and link", async () => {
    const { root, install } = await fixture()
    await install()
    const bin = Path.join(root, "node_modules/.bin/fixture-command")
    const before = await Fs.stat(bin, { bigint: true })
    await install()
    const after = await Fs.stat(bin, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    expect((await execFile(bin)).stdout).toContain("FRESH_PNPM_TOOL_EXECUTED")
  })
})

// This action uses the same Exec service as Typecheck/Vitest, without replacing
// either the package manager or an installed tool with a scripted executable.
const StoreProbe = Target.make("B17.PnpmStoreProbe", {
  attrs: Schema.Struct({ packageManager: Manager.PackageManager }),
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: ({ packageManager }) =>
    Exec.runTool({ cwd: ".", argv: [packageManager.executable, "exec", "node", "probe.cjs"] })
})

const storeProbe = async (root: string, marker?: string) => {
  // Match the host's admitted program, including pnpm/action-setup's shell shim.
  // The alias itself need not be mounted inside an action's sandbox.
  const pnpm = ProcessSandbox.launcher("pnpm", process.env.PATH, [], root, ProcessSandbox.host()).program
  expect(Path.isAbsolute(pnpm)).toBe(true)
  await write(
    root,
    "probe.cjs",
    `
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
// Use the real selected manager; the sandbox intentionally hides ungranted PATH aliases.
const store = execFileSync(${JSON.stringify(pnpm)}, ["store", "path"], { encoding: "utf8" }).trim()
assert.ok(store.startsWith(${JSON.stringify(Path.join(root, ".flows/store/pnpm") + Path.sep)}), store)
assert.equal(process.env.pnpm_config_verify_deps_before_run, "false")
assert.equal(process.env.B17_DECLARED_ENV, ${JSON.stringify(marker)})
assert.throws(() => fs.writeFileSync(path.join(${JSON.stringify(root)}, "undeclared.txt"), "escape"),
  (error) => ["EROFS", "EPERM", "EACCES"].includes(error.code))
console.log("CONFINED_PNPM_STORE_OK")
`
  )
}

describe("confined pnpm consumers", () => {
  it("uses Install's store for native exec", async () => {
    const { root, options, install } = await fixture(
      `
const check = S.Shell.Test({
  bin: S.PackageManager.bin,
  args: ["exec", "node", "probe.cjs"],
  data: [S.file("//probe.cjs")]
})
export const Package = S.Package({ targets: { check } })`,
      true
    )
    await install()
    await storeProbe(root)
    const bin = Path.join(root, "node_modules/.bin/fixture-command")
    const before = await Fs.stat(bin, { bigint: true })
    const runOptions = { ...options, verb: "test" as const, patterns: ["//:check"] }
    const result = await PackageExec.run(runOptions)
    expect(result.ok, JSON.stringify(result.results)).toBe(true)
    expect(result.results.find((row) => row.label === "//:check")?.status).toBe("ran")
    const again = await PackageExec.run(runOptions)
    expect(again.results.find((row) => row.label === "//:check")?.status).toBe("hit")
    const after = await Fs.stat(bin, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    await expect(Fs.access(Path.join(root, "undeclared.txt"))).rejects.toThrow()
  })

  it.each([false, true])("uses Install's store for action exec (declared environment=%s)", async (declared) => {
    const { root, install, version } = await fixture("", true)
    await install()
    await storeProbe(root, declared ? "retained" : undefined)
    await Fs.mkdir(Path.join(root, ".flows/cache"), { recursive: true })
    const target = StoreProbe({
      packageManager: Manager.ResolvedPnpmPackageManager.make({
        name: "pnpm",
        executable: "pnpm",
        version,
        runtime: Runtime.ResolvedNodeRuntime.make({
          name: "node",
          version: process.versions.node,
          executable: process.execPath
        })
      })
    })
    const bin = Path.join(root, "node_modules/.bin/fixture-command")
    const before = await Fs.stat(bin, { bigint: true })
    const result = await Effect.runPromise(runTarget(
      root,
      ".flows",
      target,
      Target.metadata(target).attrs,
      "b17-confined-pnpm",
      [],
      undefined,
      declared
        ? {
          storePath: "/nix/store/test",
          hash: "test",
          closure: [],
          path: (process.env.PATH ?? "").split(Path.delimiter),
          variables: { B17_DECLARED_ENV: "retained" }
        }
        : undefined,
      {
        policy: undefined,
        reads: ["probe.cjs", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules"],
        writes: [".flows"],
        readOnly: [".flows/cache"]
      }
    ))
    expect(result).toMatchObject({ exitCode: 0, stdout: "CONFINED_PNPM_STORE_OK\n" })
    const after = await Fs.stat(bin, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    await expect(Fs.access(Path.join(root, "undeclared.txt"))).rejects.toThrow()
  })
})
