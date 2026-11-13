/**
 * What execution does with a target whose tools an Install provides, once
 * that Install has settled: a target whose installation did not succeed, or
 * whose post-install plan no longer matches what was planned, fails by name.
 */
import * as Effect from "effect/Effect"
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import * as Runner from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const execFile = promisify(ChildProcess.execFile)
const roots: Array<string> = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await Fs.chmod(Path.join(root, "guarded"), 0o755).catch(() => undefined)
    await Fs.rm(root, { recursive: true, force: true })
  }
})

/** A pnpm workspace whose one dependency is a local tarball with a `fixture-command` bin. */
const fixture = async (source: string) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-install-refresh-")))
  roots.push(root)
  const version = (await execFile("pnpm", ["--version"])).stdout.trim()
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "install-refresh",
      private: true,
      type: "module",
      packageManager: `pnpm@${version}`,
      dependencies: { "fixture-tool": "file:./fixture-tool-1.0.0.tgz" }
    })
  )
  await write(
    root,
    "tool/package.json",
    JSON.stringify({ name: "fixture-tool", version: "1.0.0", bin: { "fixture-command": "bin.cjs" } })
  )
  await write(root, "tool/bin.cjs", "#!/usr/bin/env node\nconsole.log(\"FIXTURE_TOOL\")\n")
  await Fs.chmod(Path.join(root, "tool/bin.cjs"), 0o755)
  await write(root, "pnpm-workspace.yaml", "packages:\n  - .\nenableGlobalVirtualStore: false\n")
  await execFile("pnpm", ["pack", "--pack-destination", root], { cwd: Path.join(root, "tool") })
  await execFile("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root })
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("install-refresh", {
  repository: "git+https://example.invalid/install-refresh.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ${JSON.stringify(process.versions.node)} }),
  packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml"), workspaces: S.file("//pnpm-workspace.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
/** A rule with this name but unchecked attrs, so it can declare approval. */
const approved = (rule: string) =>
  Target.make(rule, { attrs: Schema.Unknown, kinds: ["build", "test"], implementation: () => Target.notImplemented(rule) })
void approved
${source}`
  )
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  return { root, options: { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:check"], jobs: 1 } }
}

type Options = Awaited<ReturnType<typeof fixture>>["options"]

/** Plans and executes with the given execution services. */
const execute = async (
  options: Options,
  services: Partial<typeof Runner.executionServicesLive> = {},
  extra: Partial<Parameters<typeof PackageExec.plan>[0]> = {}
) => {
  const runOptions = { ...options, ...extra }
  const planned = await PackageExec.plan(runOptions)
  const result = await Effect.runPromise(
    Runner.executeEffect(planned, runOptions).pipe(
      Effect.provideService(Runner.ExecutionServices, { ...Runner.executionServicesLive, ...services })
    )
  )
  return { planned, result, row: (label: string) => result.results.find((entry) => entry.label === label) }
}

/** An approval store that approves every revision, so only a moved revision refuses. */
const grantAll: NonNullable<Parameters<typeof PackageExec.plan>[0]["approvals"]> = { granted: async () => true }

describe("refreshing a target after its installation", () => {
  it("fails a suite whose member's installation did not succeed", async () => {
    const { options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const member = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [install] })
const check = S.Suite({ tests: [member] })
export const Package = S.Package({ targets: { member, check } })`)
    const { result, row } = await execute(options, {
      install: () => Effect.fail(new Error("install service unavailable"))
    })
    expect(result.ok).toBe(false)
    expect(row("//:member")).toMatchObject({ status: "skipped" })
    expect(row("//:check")).toMatchObject({
      status: "failed",
      error: "installation dependency has no successful execution receipt"
    })
  }, 120_000)

  it("fails the consumer with the post-install plan's error", async () => {
    const { root, options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [install, S.file("guarded/input.txt")] })
export const Package = S.Package({ targets: { check } })`)
    await write(root, "guarded/input.txt", "input\n")
    const { result, row } = await execute(options, {
      install: (...args) =>
        Runner.executionServicesLive.install(...args).pipe(
          Effect.tap(() => Effect.promise(() => Fs.chmod(Path.join(root, "guarded"), 0o000)))
        )
    })
    expect(result.ok).toBe(false)
    expect(row("//:check")?.status).toBe("failed")
    expect(row("//:check")?.error).toContain(
      `EACCES: permission denied, lstat '${Path.join(root, "guarded/input.txt")}'`
    )
  }, 120_000)

  it("fails the consumer when the installation leaves no node_modules behind", async () => {
    const { root, options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [install] })
export const Package = S.Package({ targets: { check } })`)
    const { result, row } = await execute(options, {
      install: (...args) =>
        Runner.executionServicesLive.install(...args).pipe(
          Effect.tap(() => Effect.promise(() => Fs.rm(Path.join(root, "node_modules"), { recursive: true })))
        )
    })
    expect(result.ok).toBe(false)
    expect(row("//:check")).toMatchObject({
      status: "failed",
      error: "node_modules binary not found: node_modules/.bin/fixture-tool (from S.NodeModule.Bin(\"fixture-tool\"))"
    })
  }, 120_000)

  it("fails an approved target whose revision moved when its tools were installed", async () => {
    const { options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = approved("Shell.Test")({ bin: S.NodeModule.Bin("fixture-tool"), data: [install], approval: "required" })
export const Package = S.Package({ targets: { check } })`)
    const { planned, result, row } = await execute(options, {}, { approvals: grantAll })
    // Planned before the install, the revision was approved; the installed bin is a new revision.
    expect(planned.nodes.get("//:check")?.refusal).toBeUndefined()
    expect(planned.nodes.get("//:check")?.approval).toMatch(/^[0-9a-f]{64}$/)
    expect(result.ok).toBe(false)
    expect(row("//:check")).toMatchObject({
      status: "failed",
      error: "approval required: target changed after installation"
    })
  }, 120_000)

  it("fails the consumer of a service whose revision moved when its tools were installed", async () => {
    const { options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const service = approved("Shell.Serve")({ bin: S.NodeModule.Bin("fixture-tool"), data: [install], approval: "required", readiness: { port: 1 } })
const check = S.Shell.Test({ shell: "true", services: [service], sandbox: "none" })
export const Package = S.Package({ targets: { service, check } })`)
    const { planned, result, row } = await execute(options, {}, { approvals: grantAll })
    expect(planned.nodes.get("//:check")?.refusal).toBeUndefined()
    expect(result.ok).toBe(false)
    expect(row("//:check")).toMatchObject({
      status: "failed",
      error: "service //:service: approval required: target changed after installation"
    })
  }, 120_000)

  it("replans after install over a digest index it cannot trust, and saves a sound one", async () => {
    const { root, options } = await fixture(`
const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
const check = S.Shell.Test({ bin: S.NodeModule.Bin("fixture-tool"), data: [install] })
export const Package = S.Package({ targets: { check } })`)
    const index = Path.join(root, ".flows/plan/file-digests.json")
    const { result, row } = await execute(options, {
      install: (...args) =>
        Runner.executionServicesLive.install(...args).pipe(
          Effect.tap(() => Effect.promise(() => Fs.writeFile(index, "not json")))
        )
    })
    expect(result.ok, JSON.stringify(result.results)).toBe(true)
    expect(row("//:check")?.status).toBe("ran")
    // The post-install plan ignored the corrupt index (its log is silenced) and wrote a whole one.
    expect(JSON.parse(await Fs.readFile(index, "utf8"))).toMatchObject({ format: "smthrs-file-digests/1" })
  }, 120_000)
})
