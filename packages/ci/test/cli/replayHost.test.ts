import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { layer, modelEnvironment, replayOptions } from "../../src/cli/Host.vibe"
import { nodeProgram, smthrsCommand, smthrsWithToken } from "../../src/cli/Install.ts"
import { Options, Progress } from "../../src/replay/index.ts"
import { recorder } from "./repo.ts"

const made: Array<string> = []
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "smithers-ci-host-"))
  made.push(path)
  return path
}
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

const optionsOf = (provided: ReturnType<typeof replayOptions>) =>
  Effect.runPromise(Effect.provide(
    Effect.gen(function*() {
      return yield* Options
    }),
    Layer.provide(provided, NodeServices.layer)
  ))

const missing = (): string => {
  throw new Error("not installed")
}

describe("this install", () => {
  it("finds the smthrs program smithers-ci depends on", () => {
    const [node, script] = smthrsCommand()
    expect(node).toBe(process.execPath)
    expect(readFileSync(script!, "utf8")).toContain("#!/usr/bin/env node")
  })

  it("falls back to the smthrs on the path when it is not installed", () => {
    expect(smthrsCommand(missing)).toEqual(["smthrs"])
  })

  it("starts its smthrs with a shared cache's token through the program that reads it from a pipe", () => {
    const [node, starter, script] = smthrsWithToken() as readonly [string, string, string]
    expect(node).toBe(process.execPath)
    expect(readFileSync(starter, "utf8")).toContain("standard input")
    expect(script).toBe(smthrsCommand()[1])
    expect(smthrsWithToken(undefined, "/opt/node")?.[0]).toBe("/opt/node")
    // Without its own smthrs, or its own files, there is no such command.
    expect(smthrsWithToken(missing)).toBeUndefined()
    const onlySmthrs = (specifier: string): string =>
      specifier.startsWith("@smthrs/cli")
        ? smthrsCommand()[1]!.replace(/bin\/smithers\.mjs$/, "package.json")
        : missing()
    expect(smthrsWithToken(onlySmthrs)).toBeUndefined()
  })
})

describe("what fast mode's model is given", () => {
  it("is the variables the program reads for it and the short list, and no other variable of the person's", () => {
    expect(modelEnvironment({
      PATH: "/bin",
      HOME: "/home/me",
      USER: "me",
      TERM: "xterm",
      AI_GATEWAY_API_KEY: "a key",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      https_proxy: "http://proxy.example",
      SMITHERS_CACHE_TOKEN: "the cache's",
      GITHUB_TOKEN: "another program's",
      SSH_AUTH_SOCK: "/tmp/agent",
      UNSET: undefined
    })).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      USER: "me",
      TERM: "xterm",
      AI_GATEWAY_API_KEY: "a key",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      https_proxy: "http://proxy.example"
    })
  })
})

describe("the Node that runs smthrs", () => {
  const bun = { bun: "1.4.2" }

  /** A directory holding an executable file named `node`. */
  const withNode = (): string => {
    const path = directory()
    writeFileSync(join(path, "node"), "#!/bin/sh\n", { mode: 0o755 })
    return path
  }

  it("is this process under Node", () => {
    expect(nodeProgram("/nowhere", { node: "26.5.0" }, "/opt/node")).toBe("/opt/node")
  })

  it("is the first node on the path under Bun", () => {
    const [first, second] = [withNode(), withNode()]
    expect(nodeProgram(`${directory()}${delimiter}${first}${delimiter}${second}`, bun, process.execPath))
      .toBe(join(first, "node"))
  })

  it("is never the link to Bun that bunx puts on the path", () => {
    const self = join(withNode(), "node")
    const shim = directory()
    symlinkSync(self, join(shim, "node"))
    const real = withNode()
    expect(nodeProgram(shim, bun, self)).toBeUndefined()
    expect(nodeProgram(`${shim}${delimiter}${real}`, bun, self)).toBe(join(real, "node"))
  })

  it("is missing when the path has none", () => {
    expect(nodeProgram(directory(), bun, process.execPath)).toBeUndefined()
    expect(nodeProgram(undefined, bun, process.execPath)).toBeUndefined()
  })

  it("starts the smthrs of this install", () => {
    expect(smthrsCommand(undefined, "/opt/node")[0]).toBe("/opt/node")
  })
})

describe("what a replay is running", () => {
  const said = async (provided: Layer.Layer<never>) => {
    const sink = recorder()
    await Effect.runPromise(
      Effect.gen(function*() {
        const progress = yield* Progress
        yield* progress.say("2/5 3f2a1c9 baseline")
      }).pipe(Effect.provide(provided), Effect.provideService(Console.Console, sink.service as never))
    )
    return { stdout: sink.stdout(), stderr: sink.stderr() }
  }

  it("goes to standard error, one line each, and never to standard output", async () => {
    expect(await said(layer({}) as Layer.Layer<never>)).toEqual({
      stdout: "",
      stderr: "smithers-ci: 2/5 3f2a1c9 baseline\n"
    })
  })

  it("is silent when nothing provides it", async () => {
    expect(await said(Layer.empty)).toEqual({ stdout: "", stderr: "" })
  })
})

describe("how the program lets a replay run in a stranger's checkout", () => {
  it("gives the replay this install's smthrs and one rerun, where the command line names no number", async () => {
    const options = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        return yield* Options
      }),
      layer({})
    ))
    expect(options.smthrs).toEqual(smthrsCommand())
    expect(options.reruns).toBe(1)
    // The variables the program was started with, and the way its smthrs is given a token.
    expect(options.environment).toEqual({})
    expect(options.smthrsWithToken).toEqual(smthrsWithToken())
  })

  it("puts nothing into a checkout: smthrs finds the package the generated files import by itself", async () => {
    // An install step would find a linked package under `node_modules`, and remove it.
    const checkout = directory()
    const options = await optionsOf(replayOptions(["smthrs"]))
    await Effect.runPromise(options.prepare(checkout))
    expect(readdirSync(checkout)).toEqual([])
  })

  it("refuses a checkout, naming Node, when the machine has none", async () => {
    const checkout = directory()
    const options = await optionsOf(replayOptions(["node"], false))
    const failure = await Effect.runPromise(Effect.flip(options.prepare(checkout)))
    expect(failure).toEqual({
      code: "unsupported",
      message:
        "Replaying commits needs Node.js 22.19 or newer, and none is on the path. Install Node.js and run this again.",
      part: "cli"
    })
    expect(existsSync(join(checkout, "node_modules"))).toBe(false)
  })
})
