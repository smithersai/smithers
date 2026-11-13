/**
 * `RspackRunner.ResolveLive` and `RspackRunner.BuildLive` answer the bundler
 * actions a target body calls, through a real in-memory Flow runtime. The
 * workspace provides no `@rsbuild/core`, so the real child refuses loudly
 * under the runner's default timeout, and the refusal reaches the caller as
 * the action's typed failure with the per-call scratch tree removed.
 */
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { layerNonInteractiveNodeServices } from "../src/engine.ts"
import { BuildLive, ResolveLive } from "../src/RspackRunner.ts"

let workspace: string
let scratch: string

beforeEach(async () => {
  workspace = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-layer-"))
  scratch = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rspack-layer-scratch-"))
  await Fs.writeFile(NodePath.join(workspace, "package.json"), `{"name":"empty","private":true}\n`)
  await Fs.writeFile(NodePath.join(workspace, "rsbuild.config.mjs"), "export default {}\n")
})

afterEach(async () => {
  await Fs.rm(workspace, { recursive: true, force: true })
  await Fs.rm(scratch, { recursive: true, force: true })
})

/** Runs one action call as a flow body against both runner layers, with no timeout configured. */
const run = (body: () => Node.Node<unknown, unknown, never>) => {
  const flow = Flow.make("rspack-runner-layer-test", {
    payload: {},
    success: Schema.Unknown,
    error: Schema.Unknown,
    body
  })
  const options = { workspaceRoot: workspace, scratchDirectory: scratch }
  const runtime = Layer.mergeAll(ResolveLive(options), BuildLive(options), Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerNonInteractiveNodeServices)
  )
  return Effect.runPromiseExit(
    flow.execute({}, { executionId: "rspack-runner-layer-test" }).pipe(
      Effect.provide(runtime)
    )
  )
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): { readonly _tag: string; readonly stderr: string } => {
  if (!Exit.isFailure(exit)) throw new Error("expected the flow to fail")
  const fail = Cause.findFail(exit.cause)
  if (Result.isSuccess(fail)) return fail.success.error as { readonly _tag: string; readonly stderr: string }
  throw new Error(`expected a typed failure: ${Cause.pretty(exit.cause)}`)
}

describe("RspackRunner action layers", () => {
  it("ResolveLive answers Bundler resolve with the runner's real refusal", async () => {
    const exit = await run(() =>
      BundlerTarget.Resolve.call({
        configPath: "rsbuild.config.mjs",
        entries: ["main.ts"],
        mode: "development"
      }) as Node.Node<unknown, unknown, never>
    )
    const failure = failureOf(exit)
    expect(failure._tag).toBe("smithers-build/ExecError")
    expect(failure.stderr).toContain("does not provide @rsbuild/core")
    expect(await Fs.readdir(scratch)).toEqual([])
  }, 120_000)

  it("BuildLive answers Bundler build with the runner's real refusal", async () => {
    const exit = await run(() =>
      BundlerTarget.Build.call({
        configPath: "rsbuild.config.mjs",
        environment: "web",
        mode: "production",
        env: {},
        outDirs: ["dist"]
      }) as Node.Node<unknown, unknown, never>
    )
    const failure = failureOf(exit)
    expect(failure._tag).toBe("smithers-build/ExecError")
    expect(failure.stderr).toContain("does not provide @rsbuild/core")
    expect(await Fs.readdir(scratch)).toEqual([])
  }, 120_000)
})
