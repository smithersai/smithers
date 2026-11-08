/**
 * `release/restore` through the flow API: the real graph, the real layer and a
 * real child process running `restore-release.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import { Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  assert.match(failure, /flows\/release\/restore-release\.mjs/)
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

/** Runs `body` in a fresh temporary directory, removed after. */
const inTemporary = async <A>(body: (directory: string) => Promise<A>) => {
  const directory = mkdtempSync(join(tmpdir(), "release-flow-"))
  try {
    return await body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const noSelection = { CANDIDATE_RUN_ID: undefined, CANDIDATE_ARTIFACT_ID: undefined, RELEASE_TAG: undefined }

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({ checkInputs: true }), ["--check-inputs"])
  assert.deepEqual(argv({ directory: "dist/release-packs" }), ["dist/release-packs"])
  assert.deepEqual(argv({}), [])
})

test("checkInputs takes no directory", () => {
  assert.ok(Exit.isFailure(Schema.decodeUnknownExit(Request)({ checkInputs: true, directory: "dist" })))
})

test("checkInputs accepts an empty selection: the run builds a new candidate", async () => {
  const exit = await withEnv(noSelection, () => run({ checkInputs: true }, "release-restore-inputs"))
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
})

test("a restore without an archived selection and tag is refused", async () => {
  await inTemporary(async (directory) => {
    const exit = await withEnv(noSelection, () => run({ directory }, "release-restore-unselected"))
    assertModuleFailed(exit)
  })
})

test("a half-given selection is refused when checked", async () => {
  const exit = await withEnv(
    { ...noSelection, CANDIDATE_RUN_ID: "10" },
    () => run({ checkInputs: true }, "release-restore-half")
  )
  assertModuleFailed(exit)
})
