import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import * as EngineDriver from "@smthrs/opencode/EngineDriver"
import { Effect } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Project from "../src/Project.ts"
import * as Suggest from "../src/Suggest.ts"

const ports = vi.hoisted(() => ({
  invoke: vi.fn(),
  local: vi.fn(),
  query: vi.fn(),
  host: vi.fn(),
  doctorFromRegistry: vi.fn(),
  doctorFromControl: vi.fn(),
  sweep: vi.fn(),
  migrate: vi.fn(),
  update: vi.fn(),
  bug: vi.fn(),
  opencode: vi.fn(),
  serveHost: vi.fn(),
  initialize: vi.fn(),
  suggest: vi.fn(),
  isDirectory: vi.fn()
}))
vi.mock("../src/cli/ControlBridge.ts", async (load) => ({
  ...await load<typeof import("../src/cli/ControlBridge.ts")>(),
  invoke: ports.invoke,
  local: ports.local,
  query: ports.query,
  host: ports.host
}))
vi.mock("../src/commands/Doctor.ts", () => ({
  fromRegistry: ports.doctorFromRegistry,
  fromControl: ports.doctorFromControl
}))
vi.mock("../src/commands/Gc.ts", () => ({ sweep: ports.sweep }))
vi.mock("../src/commands/Migrate.ts", async (load) => ({
  ...await load<typeof import("../src/commands/Migrate.ts")>(),
  run: ports.migrate,
  // The report encoding is the migrate package's; this suite pins the routing.
  document: (report: unknown) => report
}))
vi.mock("../src/commands/Update.ts", () => ({ check: ports.update }))
vi.mock("../src/commands/Bug.ts", () => ({ submit: ports.bug }))
vi.mock("../src/commands/OpenCode.ts", async (load) => ({
  ...await load<typeof import("../src/commands/OpenCode.ts")>(),
  host: ports.opencode
}))
vi.mock("@smthrs/opencode/Serve", async (load) => ({
  ...await load<typeof import("@smthrs/opencode/Serve")>(),
  host: ports.serveHost
}))
vi.mock("../src/cli/Generate.ts", async (load) => ({
  ...await load<typeof import("../src/cli/Generate.ts")>(),
  initialize: ports.initialize
}))
vi.mock("../src/Suggest.ts", async (load) => ({
  ...await load<typeof import("../src/Suggest.ts")>(),
  run: ports.suggest,
  isDirectory: ports.isDirectory
}))

const directory = mkdtempSync(join(tmpdir(), "smithers-root-commands-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const healthy = { root: "/fixture", checks: [] }
const failing = { root: "/fixture", checks: [{ id: "node", level: "fail", message: "too old" }] }
const cleanSweep = { olderThan: "12h", dryRun: false, reports: [], failures: [] }
const migrated = { exitCode: 0, units: [] }

beforeEach(() => {
  ports.invoke.mockReset().mockResolvedValue({ result: "invoked" })
  // The runners execute the typed operation they were handed, so a test sees
  // exactly what the handler passed to the command module.
  ports.local.mockReset().mockImplementation((operation: Effect.Effect<unknown>) => Effect.runPromise(operation))
  ports.query.mockReset().mockImplementation((operation: Effect.Effect<unknown>) => Effect.runPromise(operation))
  ports.doctorFromRegistry.mockReset().mockReturnValue(Effect.succeed(healthy))
  ports.doctorFromControl.mockReset().mockReturnValue(Effect.succeed(healthy))
  ports.sweep.mockReset().mockReturnValue(Effect.succeed(cleanSweep))
  ports.migrate.mockReset().mockReturnValue(
    Effect.succeed({ _tag: "Reported", report: migrated, reportDirectory: "/r" })
  )
  ports.update.mockReset().mockReturnValue(
    Effect.succeed({ current: "1.0.0", available: undefined, tag: undefined, upToDate: true, install: undefined })
  )
  ports.bug.mockReset().mockReturnValue(Effect.succeed({ reported: true, endpoint: "https://bug.invalid" }))
  ports.host.mockReset().mockResolvedValue({ result: "hosting" })
  ports.initialize.mockReset().mockResolvedValue({ result: "initialized" })
  ports.suggest.mockReset().mockReturnValue(Effect.succeed({ status: "listed", implemented: [] }))
  ports.isDirectory.mockReset().mockReturnValue(true)
})

const invoke = async (args: Array<string>, overrides: RuntimeConfig = {}) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const config: RuntimeConfig = {
    environment: {},
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    exit: (code) => {
      result.codes.push(code)
    },
    ...overrides
  }
  const presentation = Audience.fromArguments(args, {
    env: config.environment,
    stdout: config.stdout?.isTTY,
    stderr: config.stderr?.isTTY
  })
  const runtime = { ...config, presentation }
  await makeCli(runtime).serve(Audience.incurArguments(args, presentation), {
    env: config.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return { ...result, config: runtime }
}

describe("unified root command dispatch", () => {
  it("keeps help/schema inert across every root command", async () => {
    for (const command of ["init", "doctor", "serve", "opencode", "gc", "suggest", "migrate", "update", "bug"]) {
      const result = await invoke([command, "--help"])
      expect(result.codes).not.toContain(1)
      expect(result.stdout).toContain(command)
    }
    expect(ports.invoke).not.toHaveBeenCalled()
    expect(ports.local).not.toHaveBeenCalled()
    expect(ports.query).not.toHaveBeenCalled()
    expect(ports.host).not.toHaveBeenCalled()
    expect(ports.initialize).not.toHaveBeenCalled()
    expect(ports.suggest).not.toHaveBeenCalled()
  })

  it("passes explicit initialization names, resolved roots and caller environment", async () => {
    const environment = { INIT_MARKER: "caller" }
    const result = await invoke(["init", "sample", "--root", "relative-project", "--json"], { environment })
    expect(ports.initialize).toHaveBeenCalledExactlyOnceWith(resolve("relative-project"), "sample", environment)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ result: "initialized" })
    expect(output.cta.commands.map((action: { command: string }) => action.command)).toEqual([
      "smthrs targets --root relative-project",
      "smthrs flow list --root relative-project"
    ])
    expect(result.codes).not.toContain(1)
  })

  it("derives omitted initialization arguments from the current project", async () => {
    await invoke(["init", "--json"], { environment: undefined })
    expect(ports.initialize).toHaveBeenCalledExactlyOnceWith(process.cwd(), expect.any(String), process.env)
    expect(ports.initialize.mock.calls[0]![1].length).toBeGreaterThan(0)
  })

  it("routes local doctor through the project runner with explicit connection options", async () => {
    const result = await invoke(["doctor", "--root", "/fixture", "--quiet", "--json"])
    expect(ports.local).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { root: "/fixture", quiet: true },
      result.config
    )
    expect(ports.query).not.toHaveBeenCalled()
    expect(ports.doctorFromRegistry).toHaveBeenCalledExactlyOnceWith({ credential: undefined, environment: {} })
    expect(ports.invoke).not.toHaveBeenCalled()
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject(healthy)
    expect(output.cta.commands.map((action: { command: string }) => action.command))
      .toEqual(["smthrs info --root /fixture"])
    expect(result.codes).not.toContain(1)
  })

  it("routes remote doctor through the selected control transport", async () => {
    const result = await invoke(["doctor", "--remote", "https://fixture.invalid", "--credential", "k", "--json"])
    expect(ports.query).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { remote: "https://fixture.invalid", credential: "k", quiet: false },
      result.config
    )
    expect(ports.local).not.toHaveBeenCalled()
    expect(ports.doctorFromControl).toHaveBeenCalledExactlyOnceWith({ credential: "k", environment: {} })
    expect(JSON.parse(result.stdout)).toMatchObject(healthy)
  })

  it("keeps a failing doctor report available to scripts on its nonzero exit", async () => {
    ports.doctorFromRegistry.mockReturnValue(Effect.succeed(failing))
    const result = await invoke(["doctor", "--json"])
    expect(result.codes).toEqual([1])
    expect(JSON.parse(result.stdout)).toMatchObject(failing)
  })

  it("routes update through the project runner and prints the rendered sentence", async () => {
    const result = await invoke(["update", "--root", "/fixture", "--quiet", "--json"])
    expect(ports.local).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { root: "/fixture", quiet: true },
      result.config
    )
    expect(ports.update).toHaveBeenCalledExactlyOnceWith({ credential: undefined, environment: {} })
    expect(JSON.parse(result.stdout)).toBe("@smthrs/cli 1.0.0 is current.")
    expect(result.codes).not.toContain(1)
  })

  it("starts hosting with explicit connection credentials before environment fallback", async () => {
    const result = await invoke([
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--listen",
      "--credential",
      "explicit-fixture",
      "--json"
    ], { environment: { SMITHERS_API_KEY: "environment-fixture" } })
    expect(ports.host).toHaveBeenCalledExactlyOnceWith(
      { host: "127.0.0.1", port: 0, listen: true, credential: "explicit-fixture" },
      expect.objectContaining({ credential: "explicit-fixture", port: 0, listen: true }),
      result.config
    )
    expect(JSON.parse(result.stdout)).toEqual({ result: "hosting" })
  })

  it("uses the supplied environment credential and binding defaults", async () => {
    await invoke(["serve", "--json"], { environment: { SMITHERS_API_KEY: "environment-fixture" } })
    expect(ports.host.mock.calls[0]![0]).toMatchObject({ credential: "environment-fixture", listen: false })
    expect(ports.host.mock.calls[0]![0].port).toBeGreaterThan(0)
  })

  it("routes opencode flags to the server host with the directory argument", async () => {
    const result = await invoke([
      "opencode",
      "/tmp/served",
      "--port",
      "4097",
      "--hostname",
      "127.0.0.1",
      "--cors",
      "https://one.test",
      "--cors",
      "https://two.test",
      "--seat",
      "cerebras:gpt-oss-120b",
      "--max-frames",
      "7",
      "--scripted",
      "--json"
    ], { environment: { OPENCODE_SERVER_PASSWORD: "pw" } })
    expect(ports.opencode).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        directory: "/tmp/served",
        port: 4097,
        hostname: "127.0.0.1",
        listen: false,
        cors: ["https://one.test", "https://two.test"],
        seat: "cerebras:gpt-oss-120b",
        maxFrames: 7,
        scripted: true
      }),
      { credential: undefined, environment: { OPENCODE_SERVER_PASSWORD: "pw" } },
      expect.objectContaining({ port: 4097, scripted: true }),
      result.config
    )
    expect(result.codes).not.toContain(1)
  })

  it("keeps opencode's defaults and refuses --remote before hosting", async () => {
    await invoke(["opencode", "--json"])
    expect(ports.opencode.mock.calls[0]![0]).toMatchObject({
      directory: undefined,
      port: 4096,
      hostname: "127.0.0.1",
      listen: false,
      cors: [],
      maxFrames: 40,
      scripted: false
    })
    // The interactive budget is visible in the help.
    const help = await invoke(["opencode", "--help"])
    expect(help.stdout).toMatch(/--max-frames <number>\s+.*\(default: 40\)/)
    ports.opencode.mockRestore()
    const { host } = await vi.importActual<typeof import("../src/commands/OpenCode.ts")>("../src/commands/OpenCode.ts")
    await expect(
      host(
        { port: 4096, hostname: "127.0.0.1", listen: false, cors: [], maxFrames: 100, scripted: true },
        { credential: undefined, environment: {} },
        { remote: "https://control.example", quiet: true }
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("--remote") })
    await expect(
      host(
        { port: 4096, hostname: "127.0.0.1", listen: false, cors: [], maxFrames: 100, scripted: false },
        { credential: undefined, environment: {} },
        { quiet: true }
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("--scripted") })
    await expect(
      host(
        { port: 4096, hostname: "0.0.0.0", listen: false, cors: [], maxFrames: 100, scripted: true },
        { credential: undefined, environment: {} },
        { quiet: true }
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("--listen") })
  })

  /**
   * The keyless start, which is the whole defect this case was written for.
   * The harness fails a run whose completion nothing judged, so a server
   * with no evaluator answers a conversation and breaks on the first real
   * task. The verb refuses at startup instead, exits 2 like any other
   * mistyped invocation, and opens no socket. `--scripted` runs no model,
   * so it starts on the same keyless environment.
   */
  it("refuses a keyless start before it serves, and still replays the scripted turn", async () => {
    const opencode = await vi.importActual<typeof import("../src/commands/OpenCode.ts")>(
      "../src/commands/OpenCode.ts"
    )
    ports.opencode.mockImplementation(opencode.host)
    const refused = await invoke(["opencode", "--json"], { environment: { CEREBRAS_API_KEY: "seat-key" } })
    expect(refused.codes).toContain(2)
    // Printed word for word: the redactor eats the token after a name that
    // ends in KEY and is punctuated with a colon, so the refusal is not.
    expect(refused.stdout + refused.stderr).toContain(EngineDriver.noEvaluator)
    expect(ports.serveHost).not.toHaveBeenCalled()

    ports.serveHost.mockImplementation(() => Effect.void)
    const scriptedDirectory = mkdtempSync(join(tmpdir(), "smithers-opencode-scripted-"))
    const before = process.cwd()
    try {
      const replayed = await invoke(["opencode", scriptedDirectory, "--scripted", "--json"])
      expect(replayed.codes).not.toContain(2)
      expect(ports.serveHost.mock.calls.at(-1)![0]).toMatchObject({ seat: "scripted:demo" })
    } finally {
      process.chdir(before)
      rmSync(scriptedDirectory, { recursive: true, force: true })
    }
  })

  it("hands the frame budget to the server as well as the engine", async () => {
    ports.opencode.mockRestore()
    const { host } = await vi.importActual<typeof import("../src/commands/OpenCode.ts")>("../src/commands/OpenCode.ts")
    const directory = mkdtempSync(join(tmpdir(), "smithers-opencode-cli-"))
    const before = process.cwd()
    ports.serveHost.mockImplementation(() => Effect.void)
    const written: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    try {
      const serve = () =>
        host(
          { directory, port: 4096, hostname: "127.0.0.1", listen: false, cors: [], maxFrames: 7, scripted: true },
          { credential: undefined, environment: {} },
          { quiet: true }
        )
      // A clean directory: the guard runs before the driver creates the database.
      await serve()
      expect(existsSync(join(directory, ".smithers", "opencode.sqlite"))).toBe(true)
      // The next boot finds the database and still says nothing about 0.x state.
      await serve()
    } finally {
      stderr.mockRestore()
      process.chdir(before)
      rmSync(directory, { recursive: true, force: true })
    }
    expect(written.filter((line) => line.includes("0.x state"))).toEqual([])
    expect(ports.serveHost).toHaveBeenCalledTimes(2)
    expect(ports.serveHost.mock.calls[0]![0]).toMatchObject({ directory, seat: "scripted:demo", maxFrames: 7 })
    // The scripted seat has no price; a starter seat's price rides along the same way.
    expect(ports.serveHost.mock.calls[0]![0]).toHaveProperty("pricing", undefined)
  })

  it("resolves the opencode seat, bind and engine host from the options and the environment", async () => {
    const opencode = await vi.importActual<typeof import("../src/commands/OpenCode.ts")>(
      "../src/commands/OpenCode.ts"
    )
    // An empty --seat and an empty SMITHERS_SEAT are both "not named", so the
    // first provider key the environment sets decides the seat.
    expect(opencode.seatOf({ seat: "" }, { SMITHERS_SEAT: "", CEREBRAS_API_KEY: "key" }))
      .toBe("cerebras:gpt-oss-120b")
    expect(opencode.seatOf({ seat: undefined }, { SMITHERS_SEAT: "anthropic:claude-sonnet-4-5" }))
      .toBe("anthropic:claude-sonnet-4-5")
    expect(opencode.seatOf({ seat: "openai:gpt-5.6-sol" }, { SMITHERS_SEAT: "gemini:gemini-2.5-pro" }))
      .toBe("openai:gpt-5.6-sol")
    // An exported but empty key is no key.
    expect(opencode.seatOf({ seat: undefined }, { CEREBRAS_API_KEY: "" })).toBeUndefined()
    const options = { port: 4096, hostname: "127.0.0.1", listen: false, cors: [], maxFrames: 100, scripted: true }
    expect(opencode.bind(options, { OPENCODE_SERVER_PASSWORD: "pw", OPENCODE_SERVER_USERNAME: "ada" }))
      .toMatchObject({
        port: 4096,
        hostname: "127.0.0.1",
        listen: false,
        credentials: { username: "ada", password: "pw" }
      })
    expect(opencode.bind(options, {}).credentials).toBeUndefined()
    // The engine host is three layers over the served directory. Building the
    // description opens no database and spawns nothing.
    expect(Object.keys(opencode.nodeHost(directory, {}))).toEqual(["platform", "seats", "registry"])
  })

  it("reads the opencode environment from the runtime, then the globals, then the process", async () => {
    ports.opencode.mockRestore()
    const { host } = await vi.importActual<typeof import("../src/commands/OpenCode.ts")>("../src/commands/OpenCode.ts")
    const served = mkdtempSync(join(tmpdir(), "smithers-opencode-cli-"))
    const before = process.cwd()
    ports.serveHost.mockImplementation(() => Effect.void)
    const options = {
      directory: served,
      port: 4096,
      hostname: "127.0.0.1",
      listen: false,
      cors: [],
      maxFrames: 7,
      scripted: true
    }
    const credentials = () => ports.serveHost.mock.calls.at(-1)![0].bind.credentials
    try {
      // The runtime environment the bridge supplies wins over the globals.
      await host(options, { credential: undefined, environment: {} }, { quiet: true }, {
        environment: { OPENCODE_SERVER_PASSWORD: "runtime" }
      })
      expect(credentials()).toEqual({ username: "opencode", password: "runtime" })
      // With neither, the process environment answers.
      vi.stubEnv("OPENCODE_SERVER_PASSWORD", "process")
      await host(options, { credential: undefined }, { quiet: true })
      expect(credentials()).toEqual({ username: "opencode", password: "process" })
      // No directory argument serves the working directory.
      process.chdir(served)
      const cwd = process.cwd()
      await host({ ...options, directory: undefined }, { credential: undefined }, { quiet: true })
      expect(ports.serveHost.mock.calls.at(-1)![0]).toMatchObject({ directory: cwd })
      // Without --scripted the durable engine driver serves the turns, and
      // the preflight wants the gateway key the harness judges completions
      // with; the process environment answers for both.
      const engineDirectory = mkdtempSync(join(tmpdir(), "smithers-opencode-engine-"))
      vi.stubEnv("AI_GATEWAY_API_KEY", "vck_fixture")
      try {
        await host({ ...options, directory: engineDirectory, scripted: false, seat: "cerebras:gpt-oss-120b" }, {
          credential: undefined
        }, { quiet: true })
        expect(ports.serveHost.mock.calls.at(-1)![0]).toMatchObject({ seat: "cerebras:gpt-oss-120b" })
      } finally {
        rmSync(engineDirectory, { recursive: true, force: true })
      }
    } finally {
      vi.unstubAllEnvs()
      process.chdir(before)
      rmSync(served, { recursive: true, force: true })
    }
  })

  it("ends with the shutdown line and no failure when a signal stops the server", async () => {
    ports.opencode.mockRestore()
    const { host } = await vi.importActual<typeof import("../src/commands/OpenCode.ts")>("../src/commands/OpenCode.ts")
    const directory = mkdtempSync(join(tmpdir(), "smithers-opencode-cli-"))
    const before = process.cwd()
    const written: Array<string> = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const options = {
      directory,
      port: 4096,
      hostname: "127.0.0.1",
      listen: false,
      cors: [],
      maxFrames: 7,
      scripted: true
    }
    const globals = { credential: undefined, environment: {} }
    try {
      // SIGINT and SIGTERM both abort the runtime signal; the verb ends the
      // way the operator asked, with nothing but the shutdown line.
      ports.serveHost.mockImplementation(() => Effect.never)
      const controller = new AbortController()
      const serving = host(options, globals, { quiet: false }, { signal: controller.signal })
      await vi.waitFor(() => expect(ports.serveHost).toHaveBeenCalledTimes(1))
      controller.abort(new Error("smthrs interrupted by SIGTERM"))
      await expect(serving).resolves.toBeUndefined()
      expect(written).toEqual([expect.stringContaining(`Serving ${directory}`), `Stopped serving ${directory}.\n`])
      // A quiet host says nothing either way.
      written.length = 0
      const quiet = new AbortController()
      const serve = host(options, globals, { quiet: true }, { signal: quiet.signal })
      await vi.waitFor(() => expect(ports.serveHost).toHaveBeenCalledTimes(2))
      quiet.abort(new Error("smthrs interrupted by SIGINT"))
      await expect(serve).resolves.toBeUndefined()
      expect(written).toEqual([])
      // A server that fails still reports the failure.
      ports.serveHost.mockImplementation(() => Effect.fail(new Error("the socket is taken")))
      await expect(host(options, globals, { quiet: true })).rejects.toMatchObject({ message: "the socket is taken" })
    } finally {
      stderr.mockRestore()
      process.chdir(before)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(["-1", "65536", "1.5"])("rejects invalid port %s before acquiring a host", async (port) => {
    const result = await invoke(["serve", `--port=${port}`, "--json"])
    expect(result.codes.some((code) => code !== 0)).toBe(true)
    expect(ports.host).not.toHaveBeenCalled()
  })

  it.each([false, true])("preserves garbage collection cutoff and dry-run=%s", async (dryRun) => {
    const result = await invoke([
      "gc",
      "--root",
      directory,
      "--older-than",
      "12h",
      ...(dryRun ? ["--dry-run"] : []),
      "--json"
    ])
    expect(ports.local).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ olderThan: "12h", dryRun }),
      result.config
    )
    expect(ports.sweep).toHaveBeenCalledExactlyOnceWith({ olderThan: "12h", dryRun }, {
      credential: undefined,
      environment: {}
    })
    expect(JSON.parse(result.stdout)).toMatchObject(cleanSweep)
    expect(result.codes).not.toContain(1)
  })

  it("keeps a partial sweep report available to scripts on its nonzero exit", async () => {
    const partial = { ...cleanSweep, failures: [{ path: "/db", message: "locked" }] }
    ports.sweep.mockReturnValue(Effect.succeed(partial))
    const result = await invoke(["gc", "--root", directory, "--json"])
    expect(result.codes).toEqual([1])
    expect(JSON.parse(result.stdout)).toMatchObject(partial)
  })

  it.each(["gc", "migrate"])("refuses remote %s before dispatch", async (command) => {
    const result = await invoke([command, "--remote", "https://fixture.invalid", "--json"])
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("requires the host")
    expect(ports.local).not.toHaveBeenCalled()
    expect(ports.query).not.toHaveBeenCalled()
  })

  it("passes migration booleans, numbers, repeated lists and names as typed options", async () => {
    const result = await invoke([
      "migrate",
      "/source",
      "--root",
      directory,
      "--scan",
      "--allow-no-vcs",
      "--max-repair-rounds",
      "0",
      "--report-dir",
      "/reports",
      "--verify-typecheck",
      "tsc --noEmit",
      "--verify-typecheck",
      "tsc -p test",
      "--json"
    ])
    expect(ports.local).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ root: directory, scan: true }),
      result.config
    )
    expect(ports.migrate).toHaveBeenCalledExactlyOnceWith({
      target: "/source",
      scan: true,
      apply: false,
      seat: undefined,
      allowUnsafe: undefined,
      acknowledgeRunState: false,
      allowNoVcs: true,
      keepOldSources: false,
      unit: undefined,
      maxRepairRounds: 0,
      reportDir: "/reports",
      flowsDir: undefined,
      verifyInstall: undefined,
      verifyFormat: undefined,
      verifyTypecheck: ["tsc --noEmit", "tsc -p test"],
      verifyTest: undefined
    }, { credential: undefined, environment: {} })
    expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0, units: [] })
    expect(result.codes).toEqual([0])
  })

  it("targets the 0.x root when no positional path is given", async () => {
    await invoke(["migrate", "--json"])
    expect(ports.migrate.mock.calls[0]![0]).toMatchObject({ target: Project.legacyRoot(undefined, process.cwd()) })
  })

  it("exits 3 with the parked document when a migration gate refuses", async () => {
    ports.migrate.mockReturnValue(Effect.succeed({
      _tag: "Parked",
      code: "run-state-blocked",
      message: "runs are live",
      root: "/source",
      details: "finish them"
    }))
    const result = await invoke(["migrate", "/source", "--json"])
    expect(result.codes).toEqual([3])
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "run-state-blocked",
      message: "runs are live",
      root: "/source",
      details: "finish them"
    })
    expect(JSON.parse(result.stdout)).not.toHaveProperty("_tag")
  })

  it.each([undefined, "run-123"])("preserves bug summary words and optional run attribution (%s)", async (run) => {
    await invoke(["bug", "first", "second", ...(run === undefined ? [] : ["--run", run]), "--json"])
    expect(ports.query).toHaveBeenCalledOnce()
    expect(ports.bug).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ summary: "first second", runId: run, yes: false, dryRun: false }),
      { credential: undefined, environment: {} }
    )
  })

  it.each([
    ["--yes"],
    ["--dry-run"],
    ["--yes", "--dry-run"]
  ])("forwards explicit bug consent and preview flags (%j)", async (...flags) => {
    const result = await invoke(["bug", "a failure", ...flags, "--json"])
    expect(result.codes).not.toContain(1)
    expect(ports.bug.mock.calls[0]![0]).toMatchObject({
      summary: "a failure",
      yes: flags.includes("--yes"),
      dryRun: flags.includes("--dry-run")
    })
    expect(JSON.parse(result.stdout)).toMatchObject({ reported: true, endpoint: "https://bug.invalid" })
  })

  it("previews the bug endpoint and payload on the session stderr even under quiet", async () => {
    ports.bug.mockImplementation((options: { preview: (line: string) => Effect.Effect<void> }) =>
      Effect.andThen(options.preview("https://bug.invalid"), options.preview("{\"summary\":\"a failure\"}"))
        .pipe(Effect.as({ reported: false, endpoint: "https://bug.invalid", payload: {} }))
    )
    const result = await invoke(["bug", "a failure", "--dry-run", "--quiet", "--json"])
    expect(result.stderr).toBe("https://bug.invalid\n{\"summary\":\"a failure\"}\n")
    expect(JSON.parse(result.stdout)).toMatchObject({ reported: false })
  })

  it("redacts bridge failure credentials in structured command errors", async () => {
    ports.local.mockRejectedValue(new Error("Authorization: Bearer private-fixture"))
    const result = await invoke(["doctor", "--json"])
    expect(result.codes).toContain(1)
    expect(result.stdout).toContain("[REDACTED_TOKEN]")
    expect(result.stdout + result.stderr).not.toContain("private-fixture")
  })

  it("refuses a non-directory suggestion path before constructing the agent task", async () => {
    ports.isDirectory.mockReturnValue(false)
    const result = await invoke(["suggest", "./missing", "--json"])
    expect(result.codes).toContain(2)
    expect(result.stdout).toContain("must be a directory")
    expect(ports.suggest).not.toHaveBeenCalled()
  })

  it("collects structured suggestion documents in order and preserves cancellation exit status", async () => {
    ports.suggest.mockImplementation((options: Suggest.Options) =>
      Effect.sync(() => {
        options.emit?.(JSON.stringify({ document: "suggestion", id: "first" }))
        options.emit?.(JSON.stringify({ document: "outcome", status: "cancelled" }))
        return { status: "cancelled", implemented: [] }
      })
    )
    const result = await invoke(["suggest", "./fixture", "--list", "--seat", "fixture:model", "--json"])
    expect(ports.suggest.mock.calls[0]![0]).toMatchObject({
      root: resolve("fixture"),
      list: true,
      seat: "fixture:model",
      json: true
    })
    expect(JSON.parse(result.stdout)).toEqual({
      status: "cancelled",
      implemented: [],
      documents: [{ document: "suggestion", id: "first" }, { document: "outcome", status: "cancelled" }]
    })
    expect(result.codes).toContain(130)
  })

  it("leaves human suggestion output to the task and resolves an omitted path from root", async () => {
    const result = await invoke(["suggest", "--root", directory, "--audience", "human", "--silent"], {
      exit: undefined,
      stdout: { isTTY: true, columns: 80, write: () => {} }
    })
    expect(ports.suggest.mock.calls[0]![0]).toMatchObject({ root: directory, json: false, list: false })
    expect(result.stdout).not.toContain("documents")
  })
})
