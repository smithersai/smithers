/**
 * `release/build-packages` through the flow API: the real graph, the real layer and a
 * real child process running `build-release.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import Step, { argv, layer, Request } from "./flow.ts"

const run = (payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    Step.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(Step, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

/** The run failed as the module's typed exit, naming the module and nothing it printed. */
const assertModuleFailed = (exit: Exit.Exit<void, unknown>) => {
  assert.ok(Exit.isFailure(exit))
  const failure = JSON.stringify(exit.cause)
  assert.match(failure, /automation\/ModuleFailed/)
  assert.match(failure, /flows\/release\/build-release\.mjs/)
}

/** Runs `body` with `env` set (undefined unsets), restoring the previous values after. */
const withEnv = async <A>(env: Record<string, string | undefined>, body: () => Promise<A>) => {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  const assign = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assign(env)
  try {
    return await body()
  } finally {
    assign(previous)
  }
}

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(argv({ list: false }), [])
  assert.deepEqual(argv({ list: true }), ["--list"])
})

test("list prints the build order and builds nothing", async () => {
  const exit = await run({ list: true }, "release-build-list")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
})

test("a module that cannot start is a typed failure", async () => {
  // The module's own refusals all build first; a missing preload fails before it.
  const exit = await withEnv(
    { NODE_OPTIONS: "--require=/nonexistent/release-flow-preload.cjs" },
    () => run({ list: true }, "release-build-unstartable")
  )
  assertModuleFailed(exit)
})
