/**
 * `release/rehearsal` through the flow API: the real graph, the real layer and a
 * real child process running `release-rehearsal.mjs`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
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
  assert.match(failure, /flows\/release\/release-rehearsal\.mjs/)
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

const checkout = fileURLToPath(new URL("../../../..", import.meta.url))

test("the payload maps to the module's argument array", () => {
  assert.deepEqual(argv({}), [])
  assert.deepEqual(
    argv({
      tag: "v1.0.0-rc.0",
      workflow: "w.yml",
      job: "publish",
      only: ["Pack", "Smoke"],
      skip: ["Install"],
      node: ["26.4.0=/opt/node/bin"],
      runnerTemp: "/tmp/runner",
      transcript: "t.json",
      log: "r.log",
      publish: true,
      keepGoing: true
    }),
    [
      "--tag",
      "v1.0.0-rc.0",
      "--workflow",
      "w.yml",
      "--job",
      "publish",
      "--only",
      "Pack",
      "--only",
      "Smoke",
      "--skip",
      "Install",
      "--node",
      "26.4.0=/opt/node/bin",
      "--runner-temp",
      "/tmp/runner",
      "--transcript",
      "t.json",
      "--log",
      "r.log",
      "--publish",
      "--keep-going"
    ]
  )
})

/** Rehearses a one-step workflow whose step runs `command`; returns the run and its step statuses. */
const rehearse = (command: string, executionId: string) =>
  inTemporary(async (directory) => {
    const workflow = join(directory, "workflow.yml")
    writeFileSync(
      workflow,
      ["name: Release", "jobs:", "  publish:", "    steps:", "      - name: Only", `        run: ${command}`, ""].join(
        "\n"
      )
    )
    const transcript = join(directory, "transcript.json")
    const exit = await run({
      workflow: relative(checkout, workflow),
      runnerTemp: join(directory, "runner"),
      transcript
    }, executionId)
    const steps = JSON.parse(readFileSync(transcript, "utf8")).steps.map((step: { status: string }) => step.status)
    return { exit, steps }
  })

test("a passing step rehearses green", async () => {
  const { exit, steps } = await rehearse("true", "release-rehearsal-green")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(Exit.isFailure(exit) ? exit.cause : undefined))
  assert.deepEqual(steps, ["passed"])
})

test("a failing step fails the rehearsal as a typed failure", async () => {
  const { exit, steps } = await rehearse("exit 3", "release-rehearsal-red")
  assertModuleFailed(exit)
  assert.deepEqual(steps, ["failed"])
})
