import * as Node from "@smthrs/plan/Node"
import { Smithers as S } from "@smthrs/targets"
import * as PackageManager from "@smthrs/targets/PackageManager"
import { PnpmWorkspace } from "@smthrs/targets/PnpmWorkspaceFile"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runTarget } from "../src/TargetExecution.ts"

const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await Fs.rm(root, { force: true, recursive: true })
  roots.clear()
})

interface Invocation {
  readonly name: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly secret: string | null
}

const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-target-toolchain-")))
  roots.add(root)
  const trace = Path.join(root, "invocations.jsonl")
  await Fs.writeFile(Path.join(root, "package.json"), "{\"name\":\"owned-toolchain-fixture\",\"private\":true}\n")
  const executable = async (name: string, version: string, program = "process.stdout.write('TOOL_EXECUTED\\n')") => {
    const path = Path.join(root, name)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(
      path,
      `#!${process.execPath}\n` +
        `const fs = require('node:fs')\n` +
        `const args = process.argv.slice(2)\n` +
        `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ name: ${
          JSON.stringify(name)
        }, args, cwd: process.cwd(), secret: process.env.TOOLCHAIN_TEST_SECRET ?? null }) + '\\n')\n` +
        `if (args.length === 1 && args[0] === '--version') process.stdout.write(${JSON.stringify(version + "\n")})\n` +
        `else { ${program} }\n`
    )
    await Fs.chmod(path, 0o755)
    return path
  }
  const invocations = async (): Promise<ReadonlyArray<Invocation>> => {
    try {
      return (await Fs.readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Invocation)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []
      throw cause
    }
  }
  const run = (target: Target.AnyTarget, attrs: unknown = Target.metadata(target).attrs) =>
    Effect.runPromiseExit(runTarget(root, ".flows", target, attrs, "owned-toolchain-target", []))
  return { root, executable, invocations, run }
}

const node = (version = process.versions.node, executable = process.execPath) =>
  Runtime.ResolvedNodeRuntime.make({ name: "node", version, executable })

const check = (packageManager: PackageManager.PackageManager) =>
  S.Typecheck({
    packageManager,
    srcs: [],
    deps: [],
    tsconfig: S.file("tsconfig.json"),
    buildMode: false,
    incremental: false
  })

const failure = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("expected the target to refuse")
  return Cause.squash(exit.cause)
}

describe.skipIf(process.platform === "win32")("target toolchain enforcement", () => {
  it("refuses a mismatching manager before the real compiler command can run", async () => {
    const f = await fixture()
    const executable = await f.executable("pnpm", "11.25.0")
    const target = check(S.PackageManager.Pnpm({
      version: "11.21.0",
      runtime: S.Runtime.Node({ version: ">=22.19.0", executable: process.execPath }),
      executable
    }))
    expect(failure(await f.run(target))).toMatchObject({
      _tag: "smithers-build/PackageManagerError",
      code: "environment_mismatch",
      message: "this host runs pnpm 11.25.0, and the workspace declares 11.21.0"
    })
    expect((await f.invocations()).map((entry) => entry.args)).toEqual([["--version"]])
  })

  it("runs a compiler only after both exact runtime and manager pins match", async () => {
    const f = await fixture()
    const executable = await f.executable("pnpm", "11.25.0")
    const target = check(PackageManager.ResolvedPnpmPackageManager.make({
      name: "pnpm",
      version: "11.25.0",
      executable,
      runtime: node()
    }))
    const exit = await f.run(target)
    expect(exit).toMatchObject({ _tag: "Success", value: { exitCode: 0, stdout: "TOOL_EXECUTED\n" } })
    expect((await f.invocations()).map((entry) => entry.args)).toEqual([
      ["--version"],
      ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"]
    ])
  })

  it("enforces a runtime-only NodeBinary pin without invoking a package manager", async () => {
    const f = await fixture()
    const output = Path.join(f.root, "ran.json")
    await Fs.writeFile(
      Path.join(f.root, "entry.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.versions.node))\n`
    )
    const binary = (runtime: Runtime.Runtime) =>
      S.NodeBinary({ runtime, entry: S.file("entry.cjs"), args: [], srcs: [], deps: [] })
    expect(failure(await f.run(binary(node("999.0.0"))))).toMatchObject({
      _tag: "smithers-build/RuntimeError",
      code: "unsatisfied"
    })
    await expect(Fs.readFile(output)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await f.run(binary(node()))).toMatchObject({ _tag: "Success", value: { exitCode: 0 } })
    expect(JSON.parse(await Fs.readFile(output, "utf8"))).toBe(process.versions.node)
    expect(await f.invocations()).toEqual([])
  })

  it("refuses an unsupported runtime range before executing a NodeTest entry", async () => {
    const f = await fixture()
    const executable = await f.executable("node", process.versions.node)
    const target = S.NodeTest({
      runtime: node("^22.0.0", executable),
      runner: S.entrypoint(S.file("entry.cjs")),
      srcs: [],
      deps: []
    })
    expect(failure(await f.run(target))).toMatchObject({
      _tag: "smithers-build/RuntimeError",
      code: "unsupported_requirement"
    })
    expect((await f.invocations()).map((entry) => entry.args)).toEqual([["--version"]])
  })

  it("probes the same relative executable and cwd while withholding declared secrets", async () => {
    const f = await fixture()
    await f.executable(
      "project/tools/node",
      process.versions.node,
      `const result = require('node:child_process').spawnSync(${
        JSON.stringify(process.execPath)
      }, args, { stdio: 'inherit' }); process.exit(result.status ?? 91)`
    )
    await Fs.writeFile(
      Path.join(f.root, "project/entry.cjs"),
      "process.stdout.write(process.env.TOOLCHAIN_TEST_SECRET + '\\n')\n"
    )
    const target = S.NodeBinary({
      runtime: node(process.versions.node, "./tools/node"),
      entry: S.file("//project/entry.cjs"),
      args: [],
      srcs: [],
      deps: [],
      cwd: "project",
      env: {
        PATH: `tools${Path.delimiter}${Path.dirname(process.execPath)}`,
        TOOLCHAIN_TEST_SECRET: "declared-tool-value"
      }
    })
    expect(await f.run(target)).toMatchObject({ _tag: "Success", value: { stdout: "declared-tool-value\n" } })
    const observed = await f.invocations()
    expect(observed.map((entry) => entry.args)).toEqual([["--version"], ["entry.cjs"]])
    expect(observed.map((entry) => entry.cwd)).toEqual([Path.join(f.root, "project"), Path.join(f.root, "project")])
    expect(observed.map((entry) => entry.secret)).toEqual([null, "declared-tool-value"])
  })

  it("probes a package manager in the same package directory as its compiler", async () => {
    const f = await fixture()
    await f.executable("project/pnpm", "11.25.0")
    const target = check(S.PackageManager.Pnpm({ version: "11.25.0", runtime: node(), executable: "./pnpm" }))
    expect(await f.run(target, { ...Target.metadata(target).attrs as object, cwd: "project" }))
      .toMatchObject({ _tag: "Success", value: { exitCode: 0 } })
    const observed = await f.invocations()
    expect(observed.map((entry) => entry.args)).toEqual([
      ["--version"],
      ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"]
    ])
    expect(observed.map((entry) => entry.cwd)).toEqual([Path.join(f.root, "project"), Path.join(f.root, "project")])
  })

  it("checks Vitest's selected custom Bun without probing the replaced Node or pnpm", async () => {
    const f = await fixture()
    const executable = await f.executable("bun", "1.4.1")
    const runtime = S.Runtime.Bun({ version: "1.4.1", executable })
    const packageManager = PackageManager.ResolvedPnpmPackageManager.make({
      name: "pnpm",
      version: "11.21.0",
      executable: "/must-not-probe-pnpm",
      runtime: node("999.0.0", "/must-not-probe-node")
    })
    const target = S.Vitest({
      runtime,
      packageManager,
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      coverage: false,
      passWithNoTests: false
    })
    expect(await f.run(target)).toMatchObject({ _tag: "Success", value: { stdout: "TOOL_EXECUTED\n" } })
    expect((await f.invocations()).map((entry) => entry.args)).toEqual([
      ["--version"],
      ["x", "vitest", "run", "--environment", "node", "--coverage.enabled=false"]
    ])
  })

  it("holds an explicit Bun package-manager executable override to its pin", async () => {
    const f = await fixture()
    const interpreter = await f.executable("runtime-bun", "1.4.1")
    const manager = await f.executable("manager-bun", "1.4.0")
    const target = check(S.PackageManager.BunPackages({
      runtime: S.Runtime.Bun({ version: "1.4.1", executable: interpreter }),
      executable: manager
    }))
    expect(failure(await f.run(target))).toMatchObject({ _tag: "smithers-build/RuntimeError", code: "unsatisfied" })
    expect((await f.invocations()).map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "runtime-bun", args: ["--version"] },
      { name: "manager-bun", args: ["--version"] }
    ])
  })

  it("validates target attrs and the pure plan before any version probe", async () => {
    const f = await fixture()
    const executable = await f.executable("pnpm", "11.25.0")
    const target = check(S.PackageManager.Pnpm({ version: "11.25.0", runtime: node(), executable }))
    failure(await f.run(target, { ...Target.metadata(target).attrs as object, buildMode: "invalid" }))
    const broken = Target.make("RefusedPlan", {
      attrs: Schema.Struct({ runtime: Runtime.Runtime }),
      kinds: ["build"],
      implementation: () => {
        throw new Error("owned pure plan refused")
      }
    })({ runtime: node(process.versions.node, executable) })
    expect(failure(await f.run(broken))).toMatchObject({ message: "owned pure plan refused" })
    expect(await f.invocations()).toEqual([])
  })

  it("keeps non-JavaScript targets and pure configuration generators independent of installed tools", async () => {
    const f = await fixture()
    const pure = Target.make("NoJavaScriptTools", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      success: Schema.String,
      implementation: () => Node.succeed("pure")
    })({})
    expect(await f.run(pure)).toMatchObject({ _tag: "Success", value: "pure" })
    const generator = PnpmWorkspace({
      packageManager: S.PackageManager.Pnpm({
        version: "11.21.0",
        runtime: node("999.0.0"),
        executable: "/must-not-probe"
      }),
      packages: ["packages/*"],
      mode: "write"
    })
    expect(await f.run(generator)).toMatchObject({ _tag: "Success" })
    expect(await Fs.readFile(Path.join(f.root, "pnpm-workspace.yaml"), "utf8")).toContain("packages/*")
    expect(await f.invocations()).toEqual([])
  })

  it("refuses an escaped target cwd before a runtime probe", async () => {
    const f = await fixture()
    const executable = await f.executable("node", process.versions.node)
    const target = S.NodeBinary({
      runtime: node(process.versions.node, executable),
      entry: S.file("entry.cjs"),
      args: [],
      srcs: [],
      deps: [],
      cwd: "../outside"
    })
    expect(failure(await f.run(target))).toMatchObject({ message: "path leaves the workspace: ../outside" })
    expect(await f.invocations()).toEqual([])
  })
})
