import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { layer, replayOptions } from "../../src/cli/Host.vibe"
import { smthrsCommand, targetsDirectory } from "../../src/cli/Install.ts"
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
  it("finds the smthrs program and the targets package smithers-ci depends on", () => {
    const [node, script] = smthrsCommand()
    expect(node).toBe(process.execPath)
    expect(readFileSync(script!, "utf8")).toContain("#!/usr/bin/env node")
    expect(JSON.parse(readFileSync(join(targetsDirectory()!, "package.json"), "utf8")).name).toBe("@smthrs/targets")
  })

  it("falls back to the smthrs on the path, and to no targets package, when they are not installed", () => {
    expect(smthrsCommand(missing)).toEqual(["smthrs"])
    expect(targetsDirectory(missing)).toBeUndefined()
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
  it("gives the replay this install's smthrs and two reruns", async () => {
    const options = await Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        return yield* Options
      }),
      layer({})
    ))
    expect(options.smthrs).toEqual(smthrsCommand())
    expect(options.reruns).toBe(2)
  })

  it("links the targets package into a checkout, once", async () => {
    const checkout = directory()
    const options = await optionsOf(replayOptions(["smthrs"], targetsDirectory()))
    await Effect.runPromise(options.prepare(checkout))
    const manifest = join(checkout, "node_modules", "@smthrs", "targets", "package.json")
    expect(JSON.parse(readFileSync(manifest, "utf8")).name).toBe("@smthrs/targets")
    await Effect.runPromise(options.prepare(checkout))
    expect(existsSync(manifest)).toBe(true)
  })

  it("fails, naming the checkout, when it cannot link", async () => {
    const checkout = directory()
    writeFileSync(join(checkout, "node_modules"), "a file where the directory must go")
    const options = await optionsOf(replayOptions(["smthrs"], targetsDirectory()))
    const exit = await Effect.runPromiseExit(options.prepare(checkout))
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = await Effect.runPromise(Effect.flip(options.prepare(checkout)))
    expect(failure).toMatchObject({ code: "command-failed", part: "cli" })
    expect(failure.message).toContain(checkout)
  })

  it("fails when this install has no targets package", async () => {
    const options = await optionsOf(replayOptions(["smthrs"], undefined))
    const failure = await Effect.runPromise(Effect.flip(options.prepare(directory())))
    expect(failure).toEqual({
      code: "command-failed",
      message: "this install of smithers-ci has no @smthrs/targets package to give the checkout",
      part: "cli"
    })
  })
})
