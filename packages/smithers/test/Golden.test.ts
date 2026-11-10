/**
 * Golden vectors for the published `--json` launch contract.
 *
 * Breaking this suite means the published machine-readable contract changed.
 * Update the fixture deliberately in the same commit as that contract change,
 * never merely to make a red test green.
 */
import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer } from "effect"
import { Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.vibe"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import { packageVersion } from "../src/Version.ts"
import jsonReceipts from "./fixtures/json-receipts.json" with { type: "json" }

interface Invocation {
  readonly value: unknown
  readonly exitCode: number
}

const runCommand = Command.runWith(cli, { version: packageVersion })

const invoke = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const before = (yield* TestConsole.logLines).length
  const exit = yield* Effect.exit(runCommand(args))
  if (Exit.isFailure(exit)) return yield* Effect.fail(Cause.squash(exit.cause))

  const lines = yield* TestConsole.logLines
  const text = lines.slice(before).map(String).join("\n")
  if (text.length === 0) {
    return yield* Effect.fail(new Error(`command produced no output: ${args.join(" ")}`))
  }
  const value = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new Error(`command produced invalid JSON: ${String(cause)}`)
  })
  return { value, exitCode: Output.exitCode(value) } satisfies Invocation
})

const demoFlow = {
  flowId: "demo/ship",
  description: "The fixture flow these cases plan and run",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
} as const

const testControl = TestControl.layer({ now: () => 0, flows: [demoFlow] })
const services = Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)

const compareKeys = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const placeholder = (key: string): string | undefined => {
  if (key === "runId") return "<run-id>"
  if (key === "receiptId") return "<receipt-id>"
  if (key === "requestId") return "<request-id>"
  if (key === "planId") return "<plan-id>"
  if (key === "idempotencyKey") return "<idempotency-key>"
  if (key.toLowerCase().endsWith("digest")) return "<digest>"
  if (/(?:At|AtMs|Timestamp)$/.test(key)) return "<timestamp>"
  return undefined
}

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, item]) => [key, placeholder(key) ?? normalize(item)])
    )
  }
  return value
}

describe("JSON receipt goldens", () => {
  it("matches the published launch receipt vectors", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const plan = yield* invoke(["--json", "plan", "demo/ship"])
        const approvalValue = (plan.value as { readonly approval?: unknown }).approval
        if (approvalValue === undefined) return yield* Effect.fail(new Error("plan emitted no approval payload"))
        const approval = JSON.stringify(approvalValue)
        const parked = yield* invoke(["--json", "run", approval])
        const approve = yield* invoke(["--json", "approve", approval, "--scope", "run"])
        const run = yield* invoke(["--json", "run", approval])
        const runId = (run.value as { readonly runId?: unknown }).runId
        if (typeof runId !== "string") return yield* Effect.fail(new Error("run emitted no identifier"))
        const cancel = yield* invoke(["--json", "cancel", runId])
        return { plan, parked, approve, run, cancel }
      }).pipe(
        Effect.provide(testControl),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    const document = normalize({
      plan: result.plan.value,
      parked: result.parked.value,
      approve: result.approve.value,
      run: result.run.value,
      cancel: result.cancel.value
    })

    // Completed and failed settlement require a live model seat. This vector
    // pins only receipts TestControl can reach without scripting settlement.
    expect(document).toEqual(jsonReceipts)
    expect(result.plan.exitCode).toBe(0)
    expect(result.parked.exitCode).toBe(3)
    expect(result.approve.exitCode).toBe(0)
    expect(result.run.exitCode).toBe(0)
    expect(result.cancel.exitCode).toBe(130)
  })
})
