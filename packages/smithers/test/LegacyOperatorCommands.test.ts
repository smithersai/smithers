import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as MigrationLock from "@smthrs/migrate/flow/Lock"
import { ProcessSandbox } from "@smthrs/platform-node"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Agents from "../src/Agents.ts"
import { cli } from "../src/Command.ts"
import { CommandStatus } from "../src/internal/CommandStatus.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Ui from "../src/Ui.ts"
import { packageVersion } from "../src/Version.ts"
import { invokeCanonical } from "./fixtures/invokeCanonical.ts"
import { claudePath } from "./support/claude-cli.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smithers-legacy-operator-"))
  mkdirSync(join(root, "home"))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const invoke = async (args: Array<string>) => {
  if (args[0] === "suggest" || args[0] === "mcp") {
    const result = await invokeCanonical([...args, "--root", root, "--json"], {
      environment: { HOME: join(root, "home"), PATH: claudePath() }
    })
    const error = result.codes.some((code) => code !== 0 && code !== 130)
      ? JSON.parse(result.stdout) as { readonly message: string }
      : undefined
    return { ...result, exit: error === undefined ? Exit.void : Exit.fail(error), failure: error?.message }
  }
  const codes: Array<number> = []
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const exit = yield* Effect.exit(runCommand(args))
      const stdout = (yield* TestConsole.logLines).map(String).join("\n")
      const stderr = (yield* TestConsole.errorLines).map(String).join("\n")
      return { exit, stdout, stderr }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestControl.layer(), TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)
      ),
      Effect.provide(NodeServices.layer),
      Effect.provideService(Project.ProjectRoot, root),
      Effect.provideService(Project.MigrationRoot, root),
      Effect.provideService(CommandStatus, (code) => {
        codes.push(code)
      })
    )
  )
  return {
    ...result,
    codes,
    failure: Exit.isFailure(result.exit) ? String(Cause.squash(result.exit.cause)) : undefined
  }
}

describe("legacy operator command contracts", () => {
  const copyProject = (name = "jsx-single") => {
    cpSync(fileURLToPath(new URL(`../migrate/test/fixtures/${name}/`, import.meta.url)), root, { recursive: true })
  }

  it.each(["scan", "plan"] as const)("runs a real migration %s and renders its report", async (mode) => {
    copyProject()
    const source = join(root, "simple-workflow.jsx")
    const before = readFileSync(source)
    const result = await invoke(["migrate", ...(mode === "scan" ? ["--scan"] : []), "--json"])
    expect(result.failure).toBeUndefined()
    expect(result.codes).toEqual([0])
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ mode, root, exitCode: 0 })
    expect(report.units.map((unit: { id: string }) => unit.id)).toEqual([
      "dependencies",
      "workflow:simple-workflow",
      "project"
    ])
    expect(report.inventory.length).toBeGreaterThan(0)
    expect(report.runState.verdict).toBe("clean")
    expect(readFileSync(source)).toEqual(before)
    const reportFile = join(root, ".smithers-migrate", "report.json")
    expect(existsSync(reportFile)).toBe(mode === "plan")
    if (mode === "plan") expect(JSON.parse(readFileSync(reportFile, "utf8"))).toEqual(report)
  })

  it("writes the migration report to the requested directory", async () => {
    copyProject()
    const target = join(root, "audit")
    const result = await invoke(["migrate", root, "--report-dir", "audit", "--json"])
    expect(result.failure).toBeUndefined()
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ root, mode: "plan", exitCode: 0 })
    expect(JSON.parse(readFileSync(join(target, "report.json"), "utf8"))).toEqual(report)
    expect(existsSync(join(root, ".smithers-migrate"))).toBe(false)
    expect(existsSync(join(root, ".smithers", "flows"))).toBe(false)
  })

  it.each([true, false])("parks a real unsafe migration (JSON: %s)", async (json) => {
    copyProject("plue-pack")
    const source = join(root, "package.json")
    const before = readFileSync(source)
    const result = await invoke([
      "migrate",
      "--apply",
      "--acknowledge-run-state",
      "--verify-unconfined",
      ...(json ? ["--json"] : [])
    ])
    expect(result.failure).toBeUndefined()
    expect(result.codes).toEqual([3])
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "unsafe-blocked",
        root,
        message: expect.stringContaining("--allow-unsafe")
      })
      expect(result.stderr).toContain("warning: --verify-unconfined")
    } else {
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("smithers-migrate:")
      expect(result.stderr).toContain("--allow-unsafe")
    }
    expect(readFileSync(source)).toEqual(before)
    expect(existsSync(join(root, ".smithers-migrate", "report.json"))).toBe(false)
  })

  it("warns about unconfined verification only for an apply that requested it", async () => {
    copyProject("plue-pack")
    const source = join(root, "package.json")
    const before = readFileSync(source)
    const applied = await invoke([
      "migrate",
      "--apply",
      "--acknowledge-run-state",
      "--verify-read",
      "package.json",
      "--verify-read",
      "vitest.config.ts",
      "--verify-unconfined",
      "--json"
    ])
    expect(applied.failure).toBeUndefined()
    expect(applied.codes).toEqual([3])
    expect(JSON.parse(applied.stdout)).toMatchObject({ code: "unsafe-blocked", root })
    expect(applied.stderr).toContain("smithers-migrate: warning: --verify-unconfined runs the install")
    const sandboxed = await invoke(["migrate", "--apply", "--acknowledge-run-state", "--json"])
    const confinement = ProcessSandbox.select({ network: "open" }, ProcessSandbox.host())
    if (ProcessSandbox.isUnenforceable(confinement)) {
      expect(sandboxed.failure).toContain("verification commands need a process sandbox")
    } else {
      expect(sandboxed.failure).toBeUndefined()
      expect(JSON.parse(sandboxed.stdout)).toMatchObject({ code: "unsafe-blocked", root })
    }
    expect(sandboxed.stderr).toBe("")
    const planned = await invoke(["migrate", "--verify-unconfined", "--json"])
    expect(planned.failure).toBeUndefined()
    expect(planned.stderr).toBe("")
    expect(readFileSync(source)).toEqual(before)
  })

  it("parks a competing migration without changing the real lock or project", async () => {
    const source = join(root, "package.json")
    writeFileSync(source, JSON.stringify({ name: "unmigrated", private: true }))
    const before = readFileSync(source)
    const held = await Effect.runPromise(
      MigrationLock.acquire({ root, reportDir: ".smithers-migrate" }).pipe(Effect.provide(NodeServices.layer))
    )
    const record = readFileSync(held.file)
    try {
      const result = await invoke(["migrate", "--apply", "--allow-no-vcs", "--verify-unconfined", "--json"])
      expect(result.failure).toBeUndefined()
      expect(result.codes).toEqual([3])
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "apply-in-progress",
        root,
        message: expect.stringContaining("another apply run"),
        details: expect.stringContaining("wait for that run")
      })
      expect(readFileSync(held.file)).toEqual(record)
      expect(readFileSync(source)).toEqual(before)
      expect(existsSync(join(root, ".smithers-migrate", "report.json"))).toBe(false)
    } finally {
      await Effect.runPromise(MigrationLock.release(held).pipe(Effect.provide(NodeServices.layer)))
    }
  })

  it("renders migration failure diagnostics from an invalid layout", async () => {
    copyProject()
    const result = await invoke(["migrate", "--report-dir", "../escape", "--json"])
    expect(result.failure).toContain("smithers-migrate:")
    expect(result.failure).toContain("report")
    expect(result.codes).toEqual([])
    expect(result.stdout).toBe("")
    expect(existsSync(join(root, ".smithers-migrate"))).toBe(false)
  })

  it("applies parsed migration options to a real selected unit and report directory", async () => {
    copyProject()
    const source = join(root, "simple-workflow.jsx")
    const before = readFileSync(source)
    const harmless = "node -e \"process.exit(0)\""
    const result = await invoke([
      "migrate",
      relative(process.cwd(), root),
      "--apply",
      "--seat",
      "unconfigured:test",
      "--allow-unsafe",
      "all",
      "--acknowledge-run-state",
      "--allow-no-vcs",
      "--keep-old-sources",
      "--unit",
      "dependencies",
      "--max-repair-rounds",
      "0",
      "--report-dir",
      "audit",
      "--flows-dir",
      "workflows",
      "--verify-install",
      harmless,
      "--verify-format",
      harmless,
      "--verify-typecheck",
      harmless,
      "--verify-typecheck",
      harmless,
      "--verify-test",
      harmless,
      "--verify-read",
      "package.json",
      "--verify-read",
      "vitest.config.ts",
      "--verify-unconfined",
      "--json"
    ])
    expect(result.failure).toBeUndefined()
    expect(result.codes).toEqual([1])
    const report = JSON.parse(result.stdout)
    expect(report).toMatchObject({ root, mode: "apply", exitCode: 1 })
    expect(report.units).toHaveLength(1)
    expect(report.units[0]).toMatchObject({ id: "dependencies", status: "failed", repairRounds: 0 })
    expect(JSON.parse(readFileSync(join(root, "audit", "report.json"), "utf8"))).toEqual(report)
    expect(existsSync(join(root, ".smithers-migrate", "report.json"))).toBe(false)
    expect(readFileSync(source)).toEqual(before)
  })

  it("preserves a real failed report status under quiet output", async () => {
    copyProject()
    const source = join(root, "simple-workflow.jsx")
    const before = readFileSync(source)
    const result = await invoke([
      "migrate",
      "--apply",
      "--allow-no-vcs",
      "--seat",
      "unconfigured:test",
      "--max-repair-rounds",
      "0",
      "--verify-unconfined",
      "--quiet"
    ])
    expect(result.failure).toBeUndefined()
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("Exit 1.")
    const report = JSON.parse(readFileSync(join(root, ".smithers-migrate", "report.json"), "utf8"))
    expect(report.exitCode).toBe(1)
    expect(report.units).toContainEqual(expect.objectContaining({ status: "failed", repairRounds: 0 }))
    expect(JSON.stringify(report)).toContain("No route is configured for the unconfigured provider")
    expect(readFileSync(source)).toEqual(before)
  })

  it("renders a real scan report under quiet output", async () => {
    copyProject("plue-pack")
    const result = await invoke(["migrate", "--scan", "--quiet"])
    expect(result.failure).toBeUndefined()
    expect(result.stdout).toContain(`smithers-migrate scan: ${root}`)
    expect(result.stdout).toContain("unsupported construct")
    const status = Number(/Exit (\d+)\./.exec(result.stdout)![1])
    expect(status).toBe(0)
    expect(result.codes).toEqual([status])
    expect(existsSync(join(root, ".smithers-migrate"))).toBe(false)
  })

  it.each([false, true])("scans the real suggestion directory (explicit path: %s)", async (explicit) => {
    const target = explicit ? join(root, "relative-project") : root
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "5.0.0" }
      })
    )
    writeFileSync(join(target, "vitest.config.ts"), "export default {}")
    const result = await invoke([
      "suggest",
      ...(explicit ? [relative(process.cwd(), target)] : []),
      "--seat",
      "openai:test",
      "--list"
    ])
    expect(result.failure).toBeUndefined()
    expect(result.codes).toEqual([0])
    const outcome = JSON.parse(result.stdout)
    expect(outcome).toMatchObject({ root: target, seat: "openai:test", status: "listed", implemented: [] })
    expect(outcome.suggestions).toContain("test-target")
    expect(outcome.documents).toContainEqual(expect.objectContaining({
      document: "suggestion",
      id: "test-target"
    }))
    expect(existsSync(join(target, ".smithers"))).toBe(false)
  })

  it("refuses a real non-directory before scanning suggestions", async () => {
    const path = join(root, "file")
    writeFileSync(path, "not a directory")
    const result = await invoke(["suggest", path, "--seat", "openai:test"])
    expect(result.failure).toContain("must be a directory")
    expect(result.codes).toEqual([2])
    expect(readFileSync(path, "utf8")).toBe("not a directory")
  })

  it("preserves actual suggestion cancellation as status 130", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
    writeFileSync(join(root, "vitest.config.ts"), "export default {}")
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    const ui = Ui.make({ output, interactive: false })
    const outcome = await Effect.runPromise(
      Suggest.run({
        root,
        seat: "openai:test",
        list: false,
        json: false,
        environment: {},
        homeDirectory: join(root, "home")
      }).pipe(Effect.provideService(Ui.Ui, {
        ...ui,
        interactive: true,
        pickSuggestion: () => Effect.succeed(Option.none())
      }))
    )
    expect(outcome).toMatchObject({ status: "cancelled", implemented: [] })
    expect(outcome.suggestions).toContain("agents-md")
    expect(Suggest.exitStatus(outcome)).toBe(130)
    expect(existsSync(join(root, ".smithers"))).toBe(false)
  })

  it.each([new Error("offline"), "offline"])(
    "turns update transport failure into an actionable error: %s",
    async (cause) => {
      const fetch = vi.fn().mockRejectedValue(cause)
      vi.stubGlobal("fetch", fetch)
      const result = await invoke(["update", "--json"])
      expect(result.failure).toContain(
        "Could not reach the npm registry. Check your network and retry."
      )
      expect(result.failure).not.toContain("offline")
      expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toMatchObject({
        _tag: "/cli/Refused",
        fault: "dependency",
        code: "registry_unreachable"
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(result.stdout).toBe("")
    }
  )

  it.each([
    ["an error status", new Response(JSON.stringify({ error: "Not found" }), { status: 404 })],
    ["a null document", new Response("null", { status: 200 })],
    ["an array document", new Response("[\"1.0.0\"]", { status: 200 })]
  ])("refuses an unusable registry answer instead of reporting current: %s", async (_label, response) => {
    // fetch is the network boundary; tests never reach the real registry.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
    const result = await invoke(["update", "--json"])
    expect(result.stdout).toBe("")
    expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toMatchObject({
      _tag: "/cli/Refused",
      fault: "dependency",
      code: "registry_unreachable"
    })
  })

  it("registers only the named agent and renders the complete result", async () => {
    const home = join(root, "home")
    const config = join(home, ".claude.json")
    writeFileSync(config, JSON.stringify({ theme: "light", mcpServers: { other: { command: "other" } } }))
    const result = await invoke(["mcp", "add", "--agent", "claude"])
    expect(result.failure).toBeUndefined()
    expect(JSON.parse(result.stdout)).toEqual([{ agent: "claude", path: config, status: "written" }])
    const document = JSON.parse(readFileSync(config, "utf8"))
    expect(document.theme).toBe("light")
    expect(document.mcpServers).toEqual({
      other: { command: "other" },
      smithers: Agents.launchCommand()
    })
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false)
    const repeated = await invoke(["mcp", "add", "--agent", "claude"])
    expect(JSON.parse(repeated.stdout)).toEqual([{ agent: "claude", path: config, status: "unchanged" }])
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual(document)
  })

  it("prints manual MCP setup guidance when real configurations are unusable", async () => {
    const home = join(root, "home")
    writeFileSync(join(home, ".claude.json"), "{broken")
    writeFileSync(join(home, ".codex"), "not a directory")
    const result = await invoke(["mcp", "add"])
    expect(result.failure).toContain("Could not register the MCP server")
    expect(result.stderr).toBe(`${Agents.manualInstructions(Agents.agents.map((agent) => agent.id))}\n`)
    expect(JSON.parse(result.stdout)).toEqual({
      code: "UnsupportedError",
      message: "Could not register the MCP server"
    })
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{broken")
    expect(readFileSync(join(home, ".codex"), "utf8")).toBe("not a directory")
  })
})
