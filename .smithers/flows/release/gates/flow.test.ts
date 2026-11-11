/**
 * `release/gates` through the flow API: the real graph over the host's real
 * inventory, the real layer and an in-memory engine. The injected command
 * runner is the real one, launching a verifier per gate that checks the argv
 * against a disk journal and exits non-zero for the gates a case marks red.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { commandRunner, type RunCommand } from "../../release-support/io.ts"
import { releaseGateSetForHost } from "../release-gates.mjs"
import Step, { gateCalls, gateReceipt, layerWith, Request } from "./flow.ts"

const gates = releaseGateSetForHost()

const execute = (run: RunCommand, payload: typeof Request.Type, executionId: string) =>
  Effect.runPromiseExit(
    Step.execute(payload, { executionId }).pipe(
      Effect.provide(
        Interpreter.layerWithImplementations(Step, layerWith(run)).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

/** A runner whose every gate is a real child that journals its argv; the gates at `red` exit 1. */
const journal = async (t: TestContext, red: ReadonlyArray<number> = []) => {
  const root = await mkdtemp(join(import.meta.dirname, ".gates-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "attempted.json"), "[]")
  await writeFile(
    join(root, "verify.mjs"),
    `
import { readFileSync, writeFileSync } from "node:fs"
const attempted = JSON.parse(readFileSync("attempted.json", "utf8"))
const red = ${JSON.stringify(red)}.includes(attempted.length)
attempted.push(process.argv.slice(2))
writeFileSync("attempted.json", JSON.stringify(attempted))
process.exit(red ? 1 : 0)
`
  )
  const runner = commandRunner(root)
  const run: RunCommand = (command, args, options) =>
    runner(process.execPath, ["verify.mjs", command, ...args], options)
  const attempted = async () => JSON.parse(await readFile(join(root, "attempted.json"), "utf8")) as string[][]
  return { run, attempted }
}

const commands = (resultsDirectory?: string) =>
  gateCalls(gates, resultsDirectory).map((gate) => ["pnpm", "exec", "smthrs", ...gate.args])

test("each gate's call carries its name and arguments, with a results file only when asked", () => {
  const plain = gateCalls(gates)
  assert.deepEqual(plain.map((gate) => gate.name), gates.inventory.map((gate) => gate.name))
  assert.ok(plain.every((gate) => !gate.args.includes("--results-file")))
  const recorded = gateCalls(gates, "/results")
  const faults = recorded.find((gate) => gate.name === "Exclusive fault matrix")
  assert.deepEqual(faults?.args, [
    "test",
    "//packages/...:faults",
    "--jobs",
    "1",
    "--results-file",
    "/results/exclusive-fault-matrix.json",
    "--verbose"
  ])
  for (const gate of recorded) assert.equal(gate.args.at(-1), "--verbose")
})

test("every gate runs once, serially and in inventory order, and the run returns the receipt", async (t) => {
  const state = await journal(t)
  const exit = await execute(state.run, { resultsDirectory: "/results" }, "release-gates-green")
  assert.ok(Exit.isSuccess(exit), JSON.stringify(exit))
  assert.deepEqual(exit.value, gateReceipt(gates))
  assert.deepEqual(await state.attempted(), commands("/results"))
})

test("red gates do not stop later gates, and the run fails naming every red gate in order", async (t) => {
  const last = gates.inventory.length - 1
  const state = await journal(t, [1, last])
  const exit = await execute(state.run, {}, "release-gates-red")
  assert.deepEqual(await state.attempted(), commands(), "every gate ran after the first red one")
  assert.ok(Exit.isFailure(exit))
  const failure = JSON.stringify(exit.cause)
  assert.match(failure, /release\/GatesFailed/)
  assert.ok(
    failure.includes(JSON.stringify([gates.inventory[1]!.name, gates.inventory[last]!.name])),
    `the failure names exactly the red gates: ${failure}`
  )
})
