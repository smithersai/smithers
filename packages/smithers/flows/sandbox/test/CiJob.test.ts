/**
 * `ci/job` on the memory engine, over a test machine that records what it was
 * asked and answers each command's exit code from a table: the only stand-in.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CiJob } from "../src/index.ts"

const target: CiJob.Target = {
  run: "ci:delivery-1",
  repo: "acme/widgets",
  sha: "a".repeat(40),
  ref: "refs/heads/main"
}

interface Asked {
  readonly checkouts: Array<string>
  readonly runs: Array<string>
  readonly released: Array<string>
}

/** A machine whose checkout is exact unless `wrongCommit`, and whose command `run` exits with `exits[run]` (0 unless set). */
const machine = (
  options: {
    readonly exits?: Readonly<Record<string, number>>
    readonly timedOut?: ReadonlyArray<string>
    readonly output?: { readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
    readonly wrongCommit?: boolean
    readonly unavailable?: boolean
  } = {}
) => {
  const asked: Asked = { checkouts: [], runs: [], released: [] }
  const layer = Layer.succeed(
    CiJob.Machine,
    CiJob.Machine.of({
      checkout: (at, job) =>
        options.unavailable === true
          ? Effect.fail(new CiJob.MachineUnavailable())
          : Effect.sync(() => {
            asked.checkouts.push(`${at.run}:${job}@${at.sha}`)
            return options.wrongCommit !== true
          }),
      run: (at, job, index, step) =>
        Effect.sync(() => {
          asked.runs.push(`${at.run}:${job}#${index}:${step.run}`)
          return {
            ...(options.output === undefined ? {} : { output: options.output }),
            exitCode: options.exits?.[step.run] ?? 0,
            timedOut: options.timedOut?.includes(step.run) === true
          }
        }),
      release: (at, job) => Effect.sync(() => void asked.released.push(`${at.run}:${job}`))
    })
  )
  return { asked, layer }
}

const host = <ROut>(machineLayer: Layer.Layer<CiJob.Machine>, ...flows: ReadonlyArray<Flow.Any>) =>
  Layer.mergeAll(
    CiJob.layer,
    Interpreter.layer(CiJob.CiJob),
    ...flows.map((flow) => Interpreter.layer(flow as never) as Layer.Layer<ROut>)
  ).pipe(
    Layer.provide(machineLayer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

const job = (name: string, ...runs: ReadonlyArray<string>): CiJob.Job => ({
  name,
  steps: runs.map((run, index) => ({ name: `step-${index}`, run }))
})

describe("ci/job", () => {
  it.effect("checks the commit out, runs each step in order and settles passed", () => {
    const box = machine()
    return Effect.gen(function*() {
      const exit = yield* CiJob.CiJob.execute({ target, job: job("build", "node --version", "pnpm --version") }, {
        executionId: "job-passed"
      }).pipe(Effect.exit)
      expect(exit).toEqual(Exit.succeed({
        outcome: "passed",
        steps: [
          { name: "checkout", outcome: "passed", exitCode: null },
          { name: "step-0", outcome: "passed", exitCode: 0 },
          { name: "step-1", outcome: "passed", exitCode: 0 }
        ]
      }))
      expect(box.asked).toEqual({
        checkouts: [`ci:delivery-1:build@${"a".repeat(40)}`],
        runs: ["ci:delivery-1:build#0:node --version", "ci:delivery-1:build#1:pnpm --version"],
        released: ["ci:delivery-1:build"]
      })
    }).pipe(Effect.provide(host(box.layer)))
  })

  it.effect("fails at the first step that exits non-zero and skips the rest without running them", () => {
    const box = machine({ exits: { "pnpm lint": 2 } })
    return Effect.gen(function*() {
      const exit = yield* CiJob.CiJob.execute({ target, job: job("lint", "pnpm lint", "pnpm test") }, {
        executionId: "job-failed"
      }).pipe(Effect.exit)
      expect(exit).toEqual(Exit.succeed({
        outcome: "failed",
        steps: [
          { name: "checkout", outcome: "passed", exitCode: null },
          { name: "step-0", outcome: "failed", exitCode: 2 },
          { name: "step-1", outcome: "skipped", exitCode: null }
        ]
      }))
      expect(box.asked.runs).toEqual(["ci:delivery-1:lint#0:pnpm lint"])
      expect(box.asked.released).toEqual(["ci:delivery-1:lint"])
    }).pipe(Effect.provide(host(box.layer)))
  })

  it.effect("fails a step that ran past its time, with no exit code", () => {
    const box = machine({ timedOut: ["sleep 900"] })
    return Effect.gen(function*() {
      const exit = yield* CiJob.CiJob.execute({ target, job: job("slow", "sleep 900") }, { executionId: "job-slow" })
        .pipe(Effect.exit)
      expect(exit).toEqual(Exit.succeed({
        outcome: "failed",
        steps: [
          { name: "checkout", outcome: "passed", exitCode: null },
          { name: "step-0", outcome: "failed", exitCode: null }
        ]
      }))
    }).pipe(Effect.provide(host(box.layer)))
  })

  it.effect("runs no step when the machine holds another commit", () => {
    const box = machine({ wrongCommit: true })
    return Effect.gen(function*() {
      const exit = yield* CiJob.CiJob.execute({ target, job: job("build", "make") }, { executionId: "job-wrong" })
        .pipe(Effect.exit)
      expect(exit).toEqual(Exit.succeed({
        outcome: "failed",
        steps: [
          { name: "checkout", outcome: "failed", exitCode: null },
          { name: "step-0", outcome: "skipped", exitCode: null }
        ]
      }))
      expect(box.asked.runs).toEqual([])
    }).pipe(Effect.provide(host(box.layer)))
  })

  it.effect("a machine that never answers fails the job, and the machine is still released", () => {
    const box = machine({ unavailable: true })
    return Effect.gen(function*() {
      const running = yield* Effect.forkChild(
        CiJob.CiJob.execute({ target, job: job("build", "make") }, { executionId: "job-gone" }).pipe(Effect.exit)
      )
      // Past the retry policy's 30 minutes.
      for (let minute = 0; minute < 40; minute++) yield* TestClock.adjust("1 minute")
      const exit = yield* Fiber.join(running)
      expect(exit).toEqual(Exit.succeed({
        outcome: "failed",
        steps: [{ name: "machine", outcome: "failed", exitCode: null }]
      }))
      expect(box.asked.released).toEqual(["ci:delivery-1:build"])
    }).pipe(Effect.provide(host(box.layer)))
  })

  it("refuses a job with no steps, a bad name or a target that isn't a commit", () => {
    const decode = Schema.decodeUnknownExit(Schema.Struct(CiJob.CiJob.payloadSchema.fields))
    expect(Exit.isFailure(decode({ target, job: { name: "x", steps: [] } }))).toBe(true)
    expect(Exit.isFailure(decode({ target, job: { name: "../x", steps: [{ name: "a", run: "true" }] } }))).toBe(true)
    expect(Exit.isFailure(decode({ target: { ...target, sha: "main" }, job: job("x", "true") }))).toBe(true)
    expect(Exit.isSuccess(decode({ target, job: job("x", "true") }))).toBe(true)
  })

  it.effect("two jobs run as two child runs; one exiting 1 settles failed while its sibling settles passed", () => {
    const box = machine({ exits: { "exit 1": 1 } })
    const node = CiJob.make("node", { steps: [{ name: "version", run: "node --version" }] })
    const broken = CiJob.make("broken", { steps: [{ name: "fail", run: "exit 1" }] })
    const Pipeline = Flow.make("ci/test-pipeline", {
      payload: { target: CiJob.Target },
      success: Schema.Struct({ node: CiJob.Result, broken: CiJob.Result }),
      body: Node.capture(
        {},
        ({ target }: { readonly target: CiJob.Target }) =>
          Node.all({ node: node.call(target), broken: broken.call(target) })
      )
    })
    return Effect.gen(function*() {
      const exit = yield* Pipeline.execute({ target }, { executionId: "pipeline" }).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      const settled = (exit as Exit.Success<{ node: CiJob.Result; broken: CiJob.Result }>).value
      expect(settled.node.outcome).toBe("passed")
      expect(settled.broken.outcome).toBe("failed")
      expect(box.asked.checkouts.sort()).toEqual([
        `ci:delivery-1:broken@${"a".repeat(40)}`,
        `ci:delivery-1:node@${"a".repeat(40)}`
      ])
    }).pipe(Effect.provide(host(box.layer, Pipeline)))
  })
})

it.effect("keeps command output in the sealed step result rather than diagnostic logs", () => {
  const output = { stdout: "v26.0.0\n", stderr: "warning\n", truncated: true }
  const box = machine({ output, exits: { node: 1 } })
  return Effect.gen(function*() {
    const result = yield* CiJob.CiJob.execute({ target, job: job("version", "node") }, { executionId: "job-output" })
    expect(result.steps.at(-1)).toEqual({ name: "step-0", outcome: "failed", exitCode: 1, output })
  }).pipe(Effect.provide(host(box.layer)))
})

it.effect("verbose commands cannot clip their own or later step records", () => {
  const box = machine({
    output: { stdout: "\u0000".repeat(64 * 1024), stderr: "é".repeat(64 * 1024), truncated: false }
  })
  const runs = Array.from({ length: 32 }, (_, i) => ({ name: `${i}`.padEnd(64, "a"), run: "verbose" }))
  return Effect.gen(function*() {
    const result = yield* CiJob.CiJob.execute({ target, job: { name: "verbose", steps: runs } }, {
      executionId: "job-bounded-output"
    })
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(16 * 1024)
    expect(result.steps.slice(0, -1).every((step) => step.output === undefined)).toBe(true)
    const output = result.steps.at(-1)!.output!
    expect(output.stdout.length).toBeGreaterThan(0)
    expect(output.stderr.length).toBeGreaterThan(0)
    expect(output.truncated).toBe(true)
  }).pipe(Effect.provide(host(box.layer)))
})

it.effect("command output records mark truncation independently for each stream", () => {
  return Effect.gen(function*() {
    for (
      const [index, output] of [
        { stdout: "small", stderr: "small", truncated: false },
        { stdout: "", stderr: "x".repeat(64 * 1024), truncated: false },
        { stdout: "", stderr: "", truncated: false }
      ].entries()
    ) {
      const box = machine({ output })
      const result = yield* CiJob.CiJob.execute({ target, job: job("streams", "print") }, {
        executionId: `job-streams-${index}`
      })
        .pipe(Effect.provide(host(box.layer)))
      expect(result.steps.at(-1)!.output!.truncated).toBe(index === 1)
      expect(result.steps.at(-1)!.output!.stdout).toBe(output.stdout)
    }
  })
})
