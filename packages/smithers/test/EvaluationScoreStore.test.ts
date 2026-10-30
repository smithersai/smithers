import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Dialect from "@smthrs/database/Dialect"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { EngineStore } from "@smthrs/engine-store"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { CaseExecutor, Runner } from "@smthrs/evals"
import { RetryPolicy } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { NodeHost, NodeRuntime } from "@smthrs/platform-node"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import { Binding, Scorer, Scoring } from "@smthrs/scorers"
import * as ScoreStore from "@smthrs/scorers/ScoreStore"
import * as SqlScoreStore from "@smthrs/scorers/SqlScoreStore"
import { Deferred, Effect, Layer, Schedule } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const first = "2026-09-04T00:00:00.000Z"
const second = "2026-09-05T00:00:00.000Z"
const stepKey = "implementation-1"

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-evaluation-scores-"))
  roots.push(root)
  return root
}

const engineDatabase = (root: string) => join(root, ".flows", "engine.db")

/** Creates the project's real engine store, exactly as a run host does. */
const withEngineStore = async (root: string) => {
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(engineDatabase(root), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
}

const writeSuite = async (root: string, failure?: "scorer") => {
  const file = join(root, "evals", "exact.eval.mjs")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { Suite, CaseExecutor } from ${JSON.stringify(new URL("../agent/evals/src/index.ts", import.meta.url).href)}
import * as Flow from ${JSON.stringify(new URL("../flows/core/src/Flow.ts", import.meta.url).href)}
import * as Scorer from ${JSON.stringify(new URL("../agent/scorers/src/Scorer.ts", import.meta.url).href)}
import * as Binding from ${JSON.stringify(new URL("../agent/scorers/src/Binding.ts", import.meta.url).href)}
const target = ({ name: "evaluation-score-store-target" })
const scorer = Scorer.make({
  id: "evaluation-score-store/exact", version: "1", name: "exact",
  score: ({ output }) => ${
      failure === "scorer"
        ? "Effect.fail(new Error(\"judge unavailable\"))"
        : "Effect.succeed({ score: output, reason: \"complete result\" })"
    }
})
export const suite = {
  name: "stored/exact", concurrency: 1,
  cases: [{ name: "first", input: 0.75 }],
  bindings: [Binding.make({ scorer, appliesTo: target })]
}
export const executor = CaseExecutor.make((entry) =>
  Effect.succeed({ output: entry.input, stepKey: ${JSON.stringify(stepKey)}, latencyMs: 0, target }))
`
  )
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let output = ""
  let code = 0
  await createEvalCli().serve([...args, "--root", root, "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, output }
}

/** Reads observations back through the public ScoreStore service. */
const stored = (root: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(ScoreStore.ScoreStore), (store) => store.observations(stepKey)).pipe(
      Effect.provide(
        SqlScoreStore.layer.pipe(
          Layer.provide(
            DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: engineDatabase(root) })))
          )
        )
      )
    )
  )

describe("evaluation scoring over the project's engine store", () => {
  it("refuses an unsettled evaluation after a store failure and resumes its admitted identity", async () => {
    const root = await fixture()
    await writeSuite(root)
    const loaded = await Evaluation.load(root, "exact")
    let refused = 0
    let selected = 0
    const host = Layer.effect(
      Evaluation.Host,
      Effect.sync(() => {
        selected++
        return { bun: true }
      })
    )
    const storage = NodeRuntime.storage(engineDatabase(root), root).pipe(
      Layer.provideMerge(NodeHost.layerAt(root)),
      Layer.provideMerge(NodeCrypto.layer)
    )
    const faultyStorage = Layer.effect(
      AttemptStore.AttemptStore,
      Effect.map(AttemptStore.AttemptStore, (store) => ({
        ...store,
        put: () => {
          refused++
          return Effect.fail(
            new AttemptStore.AttemptStoreError({
              code: "persistence_failed",
              method: "put",
              message: "store unavailable",
              cause: undefined
            })
          )
        }
      }))
    ).pipe(Layer.provideMerge(storage))
    const engine = EngineStore.layer({
      owner: { hostId: "smithers-evaluation" },
      journalSource: "evaluation-store-failure",
      sweep: { host: "evaluation" }
    }).pipe(Layer.provideMerge(faultyStorage), Layer.provide(StepBoundary.layerUnsupported))
    const options = { root, runId: "unsettled", at: first }
    await expect(Evaluation.execute(loaded.suite, loaded.executor, options, { store: engine, host })).rejects
      .toMatchObject({
        code: "executor",
        message: "Evaluation has not settled; resume its run identity"
      })
    expect(refused).toBeGreaterThan(0)
    expect(selected).toBe(1)
    await expect(Evaluation.readRun(root, options.runId)).rejects.toMatchObject({ code: "eval_run_not_found" })
    const resumed = await Evaluation.execute(loaded.suite, loaded.executor, options)
    expect(resumed.observations).toMatchObject([{ kind: "score", score: 0.75 }])
    expect(await Evaluation.execute(loaded.suite, loaded.executor, options)).toEqual(resumed)
    expect(await stored(root)).toHaveLength(1)
  })

  it("records every run's observations in the engine store and reads earlier runs back", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root)

    const one = await serve(root, ["run", "exact", "--run-id", "one", "--at", first])
    expect(one.code, one.output).toBe(0)
    const afterOne = await stored(root)
    expect(afterOne).toHaveLength(1)

    const two = await serve(root, ["run", "exact", "--run-id", "two", "--at", second])
    expect(two.code, two.output).toBe(0)
    const artifact = await Evaluation.readRun(root, "two")
    const observations = await stored(root)
    expect(observations).toEqual([
      {
        kind: "score",
        targetStepKey: stepKey,
        scorerKey: artifact.observations[0]!.scorer,
        score: 0.75,
        reason: "complete result",
        at: Date.parse(first)
      },
      {
        kind: "score",
        targetStepKey: stepKey,
        scorerKey: artifact.observations[0]!.scorer,
        score: 0.75,
        reason: "complete result",
        at: Date.parse(second)
      }
    ])
    // The engine still opens its store after the score migrations ran in it.
    await withEngineStore(root)
  })

  it("records a repeated run identity once and still returns its observations", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root)
    const loaded = await Evaluation.load(root, "exact")
    const options = { root, runId: "repeat", at: first }
    let executions = 0
    const executor = CaseExecutor.make((entry) =>
      Effect.sync(() => {
        executions += 1
      }).pipe(
        Effect.andThen(loaded.executor.run(entry))
      )
    )
    const before = await Evaluation.execute(loaded.suite, executor, options)
    const after = await Evaluation.execute(loaded.suite, executor, options)
    expect(executions).toBe(1)
    expect(after).toEqual(before)
    expect(after.observations).toHaveLength(1)
    expect(await stored(root)).toHaveLength(1)
  })

  it("resumes interrupted scoring through the production evaluation flow and replays once", async () => {
    const root = await fixture()
    await writeSuite(root)
    const loaded = await Evaluation.load(root, "exact")
    const started = Deferred.makeUnsafe<void>()
    let interrupted = true
    let completed = 0
    const shared = Object.assign(Object.create(null), { label: "shared" })
    const graph = { values: [shared, shared, undefined, 1n, NaN, Infinity, -0], self: undefined as unknown }
    graph.self = graph
    const executor = CaseExecutor.make((entry) =>
      Effect.sync(() => {
        const input = entry.input as typeof graph
        expect(input.self).toBe(input)
        expect(input.values[0]).toBe(input.values[1])
        expect(input.values).toEqual(graph.values)
      }).pipe(Effect.andThen(loaded.executor.run({ ...entry, input: 0.75 })))
    )
    const suite = {
      ...loaded.suite,
      cases: [{ name: "graph", input: graph }],
      bindings: loaded.suite.bindings.map((binding) => ({
        ...binding,
        scorer: {
          ...binding.scorer,
          score: (input: Parameters<typeof binding.scorer.score>[0]) =>
            Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined)
              if (interrupted) yield* Effect.never
              const result = yield* binding.scorer.score(input)
              completed += 1
              return result
            })
        }
      }))
    }
    const options = { root, runId: "resume", at: first }
    const controller = new AbortController()
    const initial = Evaluation.execute(suite, executor, options, { signal: controller.signal })
      .then(
        (result) => new Error(`Evaluation ended before interruption: ${JSON.stringify(result)}`),
        (error: unknown) => error
      )
    await Promise.race([
      Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("5 seconds"))),
      initial.then((error) => {
        throw error
      })
    ])
    controller.abort()
    expect(await initial).toBeDefined()
    interrupted = false
    const resumed = await Evaluation.execute(suite, executor, { ...options, at: second })
    expect(await Evaluation.execute(suite, executor, options)).toEqual(resumed)
    expect(resumed.observations[0]!.at).toBe(first)
    expect(completed).toBe(1)
    expect(await stored(root)).toHaveLength(1)
  })

  it("preserves distinct target identities with the same name and scorer", async () => {
    const root = await fixture()
    const targets = [{ name: "same" }, { name: "same" }]
    const scorer = Scorer.make({ id: "same-name-targets", version: "1", score: () => Effect.succeed({ score: 1 }) })
    const suite = {
      name: "target-identity",
      concurrency: 1,
      cases: [{ name: "a", input: 0 }, { name: "b", input: 1 }],
      bindings: targets.map((target) => Binding.make({ scorer, appliesTo: target }))
    }
    const executor = CaseExecutor.make((entry) =>
      Effect.succeed({
        output: 1,
        stepKey: entry.name,
        latencyMs: 0,
        target: targets[entry.input as number]!
      })
    )
    const result = await Evaluation.execute(suite, executor, { root, runId: "targets", at: first })
    expect(result.cases.map((entry) => entry.observations.length)).toEqual([1, 1])
    expect(result.observations.map((observation) => observation.stepKey)).toEqual(["a", "b"])
  })

  it("retries a real score-store rejection under the same durable run identity", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root)
    await stored(root)
    await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* Dialect.trigger(sql, {
          name: "reject_evaluation_scores",
          table: "flows_scores",
          event: "BEFORE INSERT",
          reject: "score write refused"
        })
      }).pipe(
        Effect.provide(
          DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: engineDatabase(root) })))
        )
      )
    )
    const loaded = await Evaluation.load(root, "exact")
    const options = { root, runId: "store-failure", at: first }
    const controller = new AbortController()
    const initial = Evaluation.execute(loaded.suite, loaded.executor, options, { signal: controller.signal })
      .then(() => undefined, (error: unknown) => error)
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const runId = Scoring.jobIdentity(["evaluation", loaded.suite.name, options.runId])
          return yield* journal.entries({ runId: runId as never, limit: 1000 }).pipe(
            Effect.map((page) =>
              page.entries.some((entry) =>
                entry.eventType === "flows.engine.attempt-finished" &&
                (entry.payload as { readonly state?: unknown }).state === "failed"
              )
            ),
            Effect.repeat({ until: (failed) => failed, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("5 seconds")
          )
        }).pipe(
          Effect.provide(NodeRuntime.storage(engineDatabase(root), root)),
          Effect.provide(NodeServices.layer),
          Effect.provide(NodeCrypto.layer)
        )
      )
    } finally {
      controller.abort()
      expect(await initial).toBeDefined()
    }
    expect(await stored(root)).toHaveLength(0)
    await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* Dialect.dropTrigger(sql, "reject_evaluation_scores", "flows_scores")
      }).pipe(
        Effect.provide(
          DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: engineDatabase(root) })))
        )
      )
    )
    // Respect the engine's persisted backoff before replacing the runtime.
    await Effect.runPromise(Effect.sleep(RetryPolicy.transient.initialMs))
    const resumed = await Evaluation.execute(loaded.suite, loaded.executor, options)
    expect(await Evaluation.execute(loaded.suite, loaded.executor, options)).toEqual(resumed)
    expect(resumed.observations).toMatchObject([{ kind: "score", score: 0.75 }])
    expect(await stored(root)).toHaveLength(1)
  })

  it("records a failing scorer as an inconclusive observation", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root, "scorer")
    const result = await serve(root, ["run", "exact", "--run-id", "failed", "--at", first])
    expect(result.code).toBe(5)
    expect(result.output).toContain("eval_inconclusive")
    const observations = await stored(root)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ kind: "inconclusive", targetStepKey: stepKey, at: Date.parse(first) })
    expect(observations[0]!.reason).toContain("judge unavailable")
  })

  it("creates a durable engine store for project runs and keeps rootless evaluation inline", async () => {
    const root = await fixture()
    await writeSuite(root)
    const result = await serve(root, ["run", "exact", "--run-id", "inline", "--at", first])
    expect(result.code, result.output).toBe(0)
    expect((await Evaluation.readRun(root, "inline")).observations).toMatchObject([
      { kind: "score", score: 0.75, stepKey, at: first }
    ])
    expect(await readdir(join(root, ".flows"))).toContain("engine.db")
    const loaded = await Evaluation.load(root, "exact")
    const direct = await Evaluation.execute(loaded.suite, loaded.executor, { runId: "inline", at: first })
    expect(direct.observations).toEqual((await Evaluation.readRun(root, "inline")).observations)
    expect(await readdir(join(root, ".flows"))).toContain("engine.db")
  })

  it("fails the run without an artifact when the engine store cannot be opened", async () => {
    const root = await fixture()
    await mkdir(join(root, ".flows"), { recursive: true })
    await writeFile(engineDatabase(root), "not a database")
    await writeSuite(root)
    const result = await serve(root, ["run", "exact", "--run-id", "broken", "--at", first])
    expect(result.code).toBe(5)
    expect(result.output).toContain("eval_run_failed")
    expect(await readdir(join(root, ".flows"))).toEqual(["engine.db"])
  })

  it("scores a direct batch through the project's store-backed runner, or inline without a store", async () => {
    const root = await fixture()
    await withEngineStore(root)
    const batch = (layerRoot: string) =>
      Effect.runPromise(
        Effect.flatMap(Effect.service(Runner.Runner), (runner) =>
          runner.runBatch([{
            identity: Scoring.jobIdentity(["evaluation-batch", layerRoot]),
            observation: { targetStepKey: stepKey, scorerKey: "evaluation-batch/exact" },
            at: Date.parse(first),
            score: Effect.succeed({ score: 0.5 })
          }], { concurrency: 1 })).pipe(Effect.provide(Evaluation.scoring(layerRoot)))
      )
    expect(await batch(root)).toMatchObject([{ kind: "score", score: 0.5 }])
    expect(await stored(root)).toMatchObject([{ kind: "score", score: 0.5, scorerKey: "evaluation-batch/exact" }])
    const inline = await fixture()
    expect(await batch(inline)).toMatchObject([{ kind: "score", score: 0.5 }])
    expect(await readdir(inline)).toEqual([])
  })

  it("persists binding ground truth and context with the durable request", async () => {
    const root = await fixture()
    const target = { name: "evaluation-truth-target" }
    const scorer = Scorer.make({
      id: "evaluation-truth",
      version: "1",
      score: ({ output, groundTruth, context }) =>
        Effect.succeed({ score: output === groundTruth ? (context as { readonly weight: number }).weight : 0 })
    })
    const suite = {
      name: "truth",
      concurrency: 1,
      cases: [{ name: "seven", input: 7 }],
      bindings: [Binding.make({ scorer, appliesTo: target, groundTruth: 7, context: { weight: 0.25 } })]
    }
    const executor = CaseExecutor.make((entry) =>
      Effect.succeed({ output: entry.input, stepKey, latencyMs: 0, target })
    )
    const result = await Evaluation.execute(suite, executor, { root, runId: "truth", at: first })
    expect(result.observations).toMatchObject([{ kind: "score", score: 0.25 }])
  })

  it("refuses a request whose binding sampling cannot be recorded durably", async () => {
    const root = await fixture()
    await writeSuite(root)
    const loaded = await Evaluation.load(root, "exact")
    const suite = {
      ...loaded.suite,
      bindings: loaded.suite.bindings.map((binding) => ({ ...binding, sampling: { ratio: 5, seed: "" } as never }))
    }
    await expect(Evaluation.execute(suite, loaded.executor, { root, runId: "sampling", at: first })).rejects
      .toMatchObject({ code: "invalid_suite", message: "The recorded evaluation request is invalid" })
  })

  it("refuses to resume an admitted run whose scorer the suite no longer provides", async () => {
    const root = await fixture()
    await writeSuite(root)
    const loaded = await Evaluation.load(root, "exact")
    const started = Deferred.makeUnsafe<void>()
    const held = {
      ...loaded.suite,
      bindings: loaded.suite.bindings.map((binding) => ({
        ...binding,
        scorer: {
          ...binding.scorer,
          score: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        }
      }))
    }
    const options = { root, runId: "replaced", at: first }
    const controller = new AbortController()
    const initial = Evaluation.execute(held, loaded.executor, options, { signal: controller.signal })
      .then(() => new Error("Evaluation ended before interruption"), (error: unknown) => error)
    await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout("5 seconds")))
    controller.abort()
    expect(await initial).toBeDefined()
    const replaced = {
      ...loaded.suite,
      bindings: [Binding.make({
        scorer: Scorer.make({
          id: "evaluation-score-store/other",
          version: "1",
          score: () => Effect.succeed({ score: 1 })
        }),
        appliesTo: loaded.suite.bindings[0]!.appliesTo
      })]
    }
    const refusal = { code: "invalid_suite", message: expect.stringContaining("scorer is no longer available") }
    await expect(Evaluation.execute(replaced, loaded.executor, options)).rejects.toMatchObject(refusal)
    // The refusal is the run's durable outcome, not a transient one.
    await expect(Evaluation.execute(loaded.suite, loaded.executor, options)).rejects.toMatchObject(refusal)
    expect(await stored(root)).toHaveLength(0)
  })

  it("exposes the scoring composition from the public evaluation entry", async () => {
    const exported = await import("@smthrs/cli/evaluation/Evaluation")
    expect(exported.scoring).toBe(Evaluation.scoring)
  })
})
