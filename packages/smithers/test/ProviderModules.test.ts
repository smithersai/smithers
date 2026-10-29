/** Optional SDK resolution fails through an Effect service, never a module mock. */
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Metric, Stream } from "effect"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { type Host, mainEffect } from "../src/cli/Entry.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import { ModuleLoader } from "../src/internal/ProviderModules.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { packageVersion } from "../src/Version.ts"
import { isolatedCli } from "./support/isolated-cli.ts"

const packageName = "@anthropic-ai/claude-agent-sdk"
const unavailable =
  "Claude Code needs @anthropic-ai/claude-agent-sdk, but the package could not be loaded. Repair the CLI installation."
const options = { model: "sonnet", executable: "/unused/claude", environment: {} }

const brokenLoader = () => {
  const requests: Array<string> = []
  return {
    requests,
    service: {
      load: (name: typeof packageName) =>
        Effect.suspend(() => {
          requests.push(name)
          // Raw loader diagnostics may contain host paths or user content.
          return Effect.fail(new Error("Cannot resolve module: fixture-private-detail"))
        })
    }
  }
}

const invocation = (argv: Array<string>, cwd: string, env: Host["env"] = { PATH: process.env.PATH }) => {
  const signals = new EventEmitter()
  const result = { stdout: "", stderr: "", status: 0 }
  const host: Host = {
    argv,
    cwd,
    env: { ...env, SMITHERS_AUDIENCE: "human" },
    stdout: {
      isTTY: true,
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
    on: (signal, listener) => {
      signals.on(signal, listener)
    },
    removeListener: (signal, listener) => {
      signals.removeListener(signal, listener)
    },
    setExitCode: (code) => {
      result.status = code
    }
  }
  return { host, result, signals }
}

const invoke = (argv: Array<string>, cwd: string, env?: Host["env"]) =>
  Effect.gen(function*() {
    const { host, result, signals } = invocation(argv, cwd, env)
    yield* mainEffect(host)
    expect(signals.eventNames()).toEqual([])
    return result
  })

describe("provider SDK isolation", () => {
  it("runs version and non-provider commands when the package is absent from the installation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-absent-sdk-"))
    const install = join(directory, "cli")
    const project = join(directory, "project")
    const run = promisify(execFile)
    try {
      await mkdir(project)
      // The whole graph is copied: every dependency link stays inside it.
      const packages = await isolatedCli(install, packageName)
      const env = {
        ...process.env,
        HOME: directory,
        NODE_PATH: "",
        SMITHERS_REMOTE: "",
        NODE_OPTIONS: process.env.NODE_OPTIONS?.includes("--no-experimental-webstorage")
          ? "--no-experimental-webstorage" :
          ""
      }
      await writeFile(join(install, "sdk-roots.json"), JSON.stringify(packages))
      const probe = await run(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import { createRequire } from "node:module"
        import { readFile } from "node:fs/promises"
        const packages = JSON.parse(await readFile("sdk-roots.json", "utf8"))
        for (const root of packages) {
          try {
            const found = createRequire(root + "/package.json").resolve("${packageName}")
            throw new Error("SDK still resolves to " + found)
          } catch (error) {
            if (error.code !== "MODULE_NOT_FOUND") throw error
          }
        }
        console.log(packages.length)
      `
      ], { cwd: install, env, timeout: 60_000 })
      expect(Number(probe.stdout)).toBe(packages.length)
      await expect(run(process.execPath, ["--input-type=module", "-e", `await import('${packageName}')`], {
        cwd: install,
        env,
        timeout: 60_000
      })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ERR_MODULE_NOT_FOUND") })
      const command = (args: Array<string>) =>
        run(process.execPath, [
          "--no-warnings",
          join(install, "bin/smithers.mjs"),
          ...args
        ], { cwd: project, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
      expect((await command(["--version"])).stdout.trim()).toBe(packageVersion)
      expect((await command(["--help"])).stdout).toContain("flow")
      expect((await command(["flow", "--help"])).stdout).toContain("start")
      const initialized = await command(["init", "absent-sdk", "--root", project, "--json"])
      expect(JSON.parse(initialized.stdout).flow.name).toBe("absent-sdk")
      const selected = await run(process.execPath, [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `
        import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"
        installEffectResolution()
        const { Effect, Logger } = await import("effect")
        const Claude = await import("./src/internal/ClaudeCode.ts")
        const error = await Effect.runPromise(Effect.flip(Claude.load({
          model: "sonnet", executable: "/unused/claude", environment: {}
        })).pipe(Effect.provideService(Logger.LogToStderr, true)))
        console.log(JSON.stringify({ code: error.code, message: error.message }))
      `
      ], { cwd: install, env, timeout: 60_000 })
      expect(JSON.parse(selected.stdout)).toEqual({ code: "no_route", message: unavailable })
      expect(selected.stderr).toContain("ERR_MODULE_NOT_FOUND")
      expect(selected.stderr).not.toContain(install)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it("keeps the SDK out of Claude Code's static runtime imports", async () => {
    const source = await readFile(new URL("../src/internal/ClaudeCode.ts", import.meta.url), "utf8")
    const parsed = ts.createSourceFile("ClaudeCode.ts", source, ts.ScriptTarget.Latest, true)
    const runtime = parsed.statements.filter((node) =>
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === packageName && node.importClause?.isTypeOnly !== true
    )
    expect(runtime).toEqual([])
  })

  it("runs version, flow help and a real non-provider command with an unresolvable SDK", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-lazy-sdk-"))
    const fault = brokenLoader()
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const version = yield* invoke(["--version"], directory)
          expect(version).toMatchObject({ status: 0, stderr: "" })
          expect(version.stdout.trim()).toBe(packageVersion)
          const help = yield* invoke(["flow", "--help"], directory)
          expect(help.status, help.stderr).toBe(0)
          expect(help.stdout).toContain("start")
          const command = yield* invoke(["init", "sdk-isolation", "--root", directory, "--json"], directory)
          expect(command.status, command.stdout + command.stderr).toBe(0)
          expect(JSON.parse(command.stdout).flow.name).toBe("sdk-isolation")
          expect(fault.requests).toEqual([])
          // A typo asks the configured Claude subscription to judge the
          // suggestion. This exercises provider selection through mainEffect's
          // actual nested CLI runtime, rather than a separate test Effect.
          yield* Effect.promise(() =>
            writeFile(
              join(directory, "claude"),
              "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}'\n",
              { mode: 0o755 }
            )
          )
          const selected = yield* invoke(["flwo"], directory, { PATH: directory })
          expect(selected.status).toBe(1)
          expect(selected.stdout).toContain("Could not ask Jev for a suggestion: unconfigured")
          expect(fault.requests).toEqual([packageName])
        }).pipe(Effect.provideService(ModuleLoader, fault.service))
      )
      expect(fault.requests).toEqual([packageName])
      expect(await readFile(join(directory, ".smithers/flows/sdk-isolation/flow.ts"), "utf8")).toContain(
        "sdk-isolation"
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("refuses only Claude Code with a typed, sanitized package requirement", async () => {
    const fault = brokenLoader()
    const failed = Metric.counter("smithers.cli.provider_sdk.failed")
    const before = Effect.runSync(Metric.value(failed)).count
    const error = await Effect.runPromise(
      Effect.flip(ClaudeCode.load(options)).pipe(Effect.provideService(ModuleLoader, fault.service))
    )
    expect(error).toMatchObject({ _tag: "flows/model/ModelError", code: "no_route", message: unavailable })
    expect(JSON.stringify(error)).not.toContain("fixture-private-detail")
    expect(Effect.runSync(Metric.value(failed)).count).toBe(before + 1)
    const seat = await Effect.runPromise(
      Effect.scoped(
        NodeControl.seatResolver(
          { OPENAI_API_KEY: "fixture-key" },
          RequestExecutor.RequestExecutor.of({
            execute: () => Effect.die("no model request expected")
          })
        ).resolve("openai:sol")
      ).pipe(
        Effect.provideService(ModuleLoader, fault.service)
      )
    )
    expect(seat.id).toBe("openai:sol")
    expect(fault.requests).toEqual([packageName])
  })

  it.each(
    [
      ...[
        "ERR_MODULE_NOT_FOUND",
        "MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_PACKAGE_IMPORT_NOT_DEFINED",
        "ERR_DLOPEN_FAILED",
        "ENOENT",
        "EACCES"
      ].map((code) => [Object.assign(new Error("private-loader-detail"), { code }), code] as const),
      [new SyntaxError("private-loader-detail"), "syntax_error"],
      [new TypeError("private-loader-detail"), "type_error"],
      [Object.assign(new Error("private-loader-detail"), { code: "private-loader-code" }), "module_error"],
      [
        Object.defineProperty({}, "code", {
          get: () => {
            throw new Error("private-loader-detail")
          }
        }),
        "module_error"
      ],
      ["private-loader-detail", "module_error"]
    ] as const
  )("warns with safe SDK failure metadata (%s)", async (cause, reason) => {
    const records: Array<unknown> = []
    await Effect.runPromise(
      Effect.flip(ClaudeCode.load(options)).pipe(
        Effect.provideService(ModuleLoader, { load: () => Effect.fail(cause) }),
        Effect.provide(Logger.layer([Logger.make((entry) => {
          records.push(entry.message)
        })], { mergeWithExisting: false }))
      )
    )
    const logged = JSON.stringify(records)
    expect(logged).toContain(unavailable)
    expect(logged).toContain(reason)
    expect(logged).not.toContain("private-loader-detail")
    expect(logged).not.toContain("private-loader-code")
  })

  it("reports an SDK requirement as judge configuration, preserving its typed message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-judge-sdk-"))
    const fault = brokenLoader()
    await writeFile(
      join(directory, "claude"),
      "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}'\n",
      { mode: 0o755 }
    )
    try {
      const error = await Effect.runPromise(
        Effect.flip(Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate({ state: {}, questions: {} }))).pipe(
          Effect.provide(NodeControl.layerSeatEvaluator({ PATH: directory })),
          Effect.provideService(
            RequestExecutor.RequestExecutor,
            RequestExecutor.RequestExecutor.of({
              execute: () => Effect.die("no network request expected")
            })
          ),
          Effect.provideService(ModuleLoader, fault.service)
        )
      )
      expect(error).toMatchObject({ code: "unconfigured", message: unavailable })
      expect(fault.requests).toEqual([packageName])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("preserves the module loader through the shared boundary used by suggest", async () => {
    const fault = brokenLoader()
    await expect(Bridge.run(ClaudeCode.load(options), {
      effectContext: Context.make(ModuleLoader, fault.service)
    })).rejects.toMatchObject({ code: "no_route", message: unavailable })
    expect(fault.requests).toEqual([packageName])
  })

  it("preserves the module loader while serve constructs its selected judge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-serve-sdk-"))
    const fault = brokenLoader()
    let stdout = ""
    let status = 0
    const evaluator = Layer.effect(Evaluator.Evaluator)(
      ClaudeCode.load(options).pipe(
        Effect.flatMap((model) =>
          Effect.andThen(
            Effect.sync(model.close),
            Effect.die(new Error("The injected provider fault did not reach serve"))
          )
        ),
        Effect.orDie
      )
    )
    try {
      await makeCli({
        evaluator,
        effectContext: Context.make(ModuleLoader, fault.service),
        environment: {}
      }).serve(["serve", "--root", directory, "--port", "0", "--quiet", "--json"], {
        env: {},
        stdout: (text) => {
          stdout += text
        },
        exit: (code) => {
          status = code
        }
      })
      expect(status, stdout).toBe(1)
      expect(stdout).toContain(unavailable)
      expect(fault.requests).toEqual([packageName])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("waits for command cleanup when the embedded host interrupts provider loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-interrupted-sdk-"))
    await writeFile(
      join(directory, "claude"),
      "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}'\n",
      { mode: 0o755 }
    )
    const { host, result, signals } = invocation(["flwo"], directory, { PATH: directory })
    let released = false
    try {
      await Effect.runPromise(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const pending = yield* mainEffect(host).pipe(
          Effect.provideService(ModuleLoader, {
            load: () =>
              Effect.acquireUseRelease(
                Deferred.succeed(entered, undefined),
                () => Effect.never,
                () =>
                  Effect.sync(() => {
                    released = true
                  })
              )
          }),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(pending)
        expect((yield* Fiber.await(pending))._tag).toBe("Failure")
      }))
      expect(released).toBe(true)
      expect(result.status).toBe(130)
      expect(signals.eventNames()).toEqual([])
      await Effect.runPromise(mainEffect({ ...host, argv: ["--version"] }))
      expect(result.status).toBe(0)
      expect(signals.eventNames()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("also reports a typed loader failure for the direct model constructor", async () => {
    const fault = brokenLoader()
    const model = ClaudeCode.make(options)
    expect(fault.requests).toEqual([])
    const error = await Effect.runPromise(
      Effect.flip(Stream.runDrain(model.stream({
        modelId: "sonnet",
        system: [],
        messages: [],
        tools: [],
        params: {}
      }))).pipe(Effect.provideService(ModuleLoader, fault.service))
    )
    expect(error).toMatchObject({ code: "no_route", message: unavailable })
    expect(fault.requests).toEqual([packageName])
    model.close()
  })

  it("loads the real SDK when building the provider without starting a session", async () => {
    const resolved = Metric.counter("smithers.cli.provider_sdk.resolved")
    const before = Effect.runSync(Metric.value(resolved)).count
    const model = await Effect.runPromise(ClaudeCode.load(options))
    expect(model.providerName).toBe("anthropic")
    expect(Effect.runSync(Metric.value(resolved)).count).toBe(before + 1)
    model.close()
  })

  it("does not load an SDK for an explicit host transport", async () => {
    const fault = brokenLoader()
    const model = await Effect.runPromise(
      ClaudeCode.load({
        ...options,
        start: () => {
          throw new Error("no session expected")
        }
      }).pipe(
        Effect.provideService(ModuleLoader, fault.service)
      )
    )
    expect(fault.requests).toEqual([])
    model.close()
  })
})
