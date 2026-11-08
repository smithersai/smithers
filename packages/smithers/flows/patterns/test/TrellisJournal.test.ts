/**
 * A declared trellis on the real durable engine, over a SQLite file.
 *
 * Each authored plan is its own trampoline round, handed off through the
 * journal. A runtime that goes away inside a plan round, and a second runtime
 * that reopens the same database file, comes back at that round: the settled
 * author call and the settled leaves replay from the journal, and only the
 * leaf that never settled runs again. A refused plan settles as a typed
 * `TrellisError` the journal can encode, with its residue intact.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as Node from "@smthrs/plan/Node"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Trellis from "../src/Trellis.ts"

const step = Action.make("trellis-journal/step", {
  payload: { role: Schema.String, payload: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown
})

const opaque = Schema.optionalKey(Schema.Unknown)

const roleFlow = (role: string, fields: Schema.Struct.Fields) =>
  Flow.make(`trellis-journal/${role}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ role }, (payload: unknown) => step.call({ role, payload }))
  })

const trellis = Trellis.make({
  author: roleFlow("author", { prompt: opaque }),
  leaf: roleFlow("leaf", { goal: opaque, seat: opaque, path: opaque }),
  envelope: { fuel: 2, depth: 2, fanout: 2 }
})

const plan: Trellis.Plan = { sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "trellis", changeId: "trellis" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * One engine incarnation over the shared stores, living in `scope`: closing
 * the scope is the process going away mid-run.
 */
const incarnation = (scope: Scope.Scope, implementation: Layer.Layer<any, any, any>) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "trellis-journal" },
      journalSource: "trellis-journal-test",
      isAlive: () => Effect.succeed(false)
    }).pipe(Scope.provide(scope))
    return yield* Layer.buildWithScope(
      Layer.mergeAll(implementation, Interpreter.layer(trellis)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      ) as Layer.Layer<any, never, any>,
      scope
    )
  })

const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A fresh SQLite file for one case. */
const database = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "trellis-journal-"))
  directories.push(directory)
  return join(directory, "engine.sqlite")
}

/**
 * Runs `body` in its own runtime over the durable stores in `filename`, with
 * real SQLite and real Node crypto. Two calls over one file are two processes
 * sharing a database: everything the first kept in memory is gone.
 */
const durable = <A, E>(filename: string, body: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(body).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(filename)),
      Effect.provide(NodeCrypto.layer)
    ) as Effect.Effect<A, E, never>
  )

describe("Trellis journal", () => {
  it("resumes a plan round in a new runtime without re-authoring or re-running settled leaves", async () => {
    const calls: Array<string> = []
    let life = 0
    const implementation = (stalled: Deferred.Deferred<void> | undefined) =>
      step.toLayer(({ payload, role }) =>
        Effect.suspend((): Effect.Effect<unknown> => {
          if (role === "author") return Effect.sync(() => (calls.push(`author@${life}`), plan))
          const { goal } = payload as Trellis.Leaf
          calls.push(`${goal}@${life}`)
          // In the first runtime `b` never finishes: the runtime goes away under it.
          if (goal === "b" && stalled !== undefined) {
            return Effect.andThen(Deferred.succeed(stalled, undefined), Effect.never)
          }
          return Effect.succeed(goal.toUpperCase())
        })
      )
    const filename = database()

    life = 1
    await durable(
      filename,
      Effect.gen(function*() {
        const stalled = yield* Deferred.make<void>()
        const first = yield* Scope.make()
        const before = yield* incarnation(first, implementation(stalled))
        yield* Effect.forkChild(
          trellis.execute({ input: { prompt: "ship it" } }, { executionId: "trellis-crash" }).pipe(
            Effect.provideContext(before),
            Effect.exit
          )
        )
        yield* Deferred.await(stalled)
        yield* Scope.close(first, Exit.void)
      })
    )

    life = 2
    const observed = await durable(
      filename,
      Effect.gen(function*() {
        const after = yield* incarnation(yield* Effect.scope, implementation(undefined))
        return yield* trellis.execute({ input: { prompt: "ship it" } }, { executionId: "trellis-crash" }).pipe(
          Effect.provideContext(after)
        )
      })
    )

    expect(observed).toEqual({ rounds: [{ plan, result: ["A", "B"] }], remaining: 0 })
    // The plan was authored once and `a` settled once, in the first runtime;
    // the second replayed both from the file and ran only the leaf that never
    // settled.
    expect(calls).toEqual(["author@1", "a@1", "b@1", "b@2"])
  })

  it("settles a leaf's own tagged error as that error, not a defect, whether the leaf is a flow or an action", async () => {
    class Throttled extends Schema.TaggedError<Throttled>()("trellis-journal/Throttled", { seconds: Schema.Number }) {}
    const work = Action.make("trellis-journal/work", {
      payload: { goal: opaque, seat: opaque, path: opaque },
      success: Schema.Unknown,
      error: Throttled
    })
    const wrapped = Flow.make("trellis-journal/typed-leaf", {
      payload: { goal: opaque, seat: opaque, path: opaque },
      success: Schema.Unknown,
      error: Throttled,
      body: (leaf: { readonly goal?: unknown; readonly seat?: unknown; readonly path?: unknown }) => work.call(leaf)
    })
    for (const leaf of [wrapped, work]) {
      const typed = Trellis.make<Action.Requirement<"trellis-journal/step" | "trellis-journal/work">>({
        author: roleFlow("author", { prompt: opaque }),
        leaf,
        envelope: { fuel: 1, depth: 1, fanout: 1 }
      })
      const implementation = Layer.mergeAll(
        step.toLayer(() => Effect.succeed({ agent: { goal: "a" } })),
        work.toLayer(() => Effect.fail(new Throttled({ seconds: 3 }))),
        Interpreter.layer(typed)
      )
      const failure = await durable(
        database(),
        Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "trellis-journal" },
            journalSource: "trellis-journal-test",
            isAlive: () => Effect.succeed(false)
          })
          const context = yield* Layer.build(
            implementation.pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            ) as Layer.Layer<any, never, any>
          )
          return yield* typed.execute({ input: { prompt: "ship it" } }, { executionId: "trellis-typed" }).pipe(
            Effect.provideContext(context),
            Effect.flip
          )
        })
      )

      expect(failure).toBeInstanceOf(Throttled)
      expect(failure).toMatchObject({ seconds: 3 })
    }
  })

  it("settles a refused plan as a TrellisError the journal encodes, residue included, and replays it", async () => {
    const invalid = { sequence: [{ agent: { goal: "" } }] }
    const implementation = step.toLayer(({ role }) =>
      role === "author" ? Effect.succeed(invalid) : Effect.die("a refused plan runs no leaf")
    )
    const filename = database()
    const settle = () =>
      durable(
        filename,
        Effect.gen(function*() {
          const context = yield* incarnation(yield* Effect.scope, implementation)
          return yield* trellis.execute({ input: { prompt: "ship it" } }, { executionId: "trellis-refused" }).pipe(
            Effect.provideContext(context),
            Effect.flip
          )
        })
      )

    for (const failure of [await settle(), await settle()]) {
      expect(failure).toBeInstanceOf(Trellis.TrellisError)
      expect(failure).toMatchObject({
        code: "invalid_plan",
        path: "root.sequence[0].agent.goal",
        cause: {
          rounds: [],
          remaining: 2,
          refusals: [{
            code: "invalid_plan",
            path: "root.sequence[0].agent.goal",
            message: "agent.goal must be a non-empty string"
          }]
        }
      })
    }
  })
})
