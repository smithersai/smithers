/**
 * An unnamed board's tag across the change from its card count to its card
 * ids (R2-Astra-D1-008).
 *
 * The count-era tag of a two-card board is `kanban(…, items=2, …)`. The first
 * id-era tag of a board whose one card is `2` was the same text, so a run the
 * old build parked could resume on the other board. The id-era tag is now
 * versioned, and the old tag is registered only through
 * `Kanban.legacyAliases`, which refuses two boards that shared it.
 *
 * The restart case runs on the real durable engine over a SQLite file, with
 * both the alias and the colliding board registered.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
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
import * as Kanban from "../src/Kanban.vibe"
import { PatternError } from "../src/PatternError.ts"

const work = Action.make("kanban-legacy/work", {
  payload: { column: Schema.String, item: Schema.Unknown, previous: Schema.optionalKey(Schema.Unknown) },
  success: Schema.Unknown,
  error: Schema.Unknown
})

const columns = [{ name: "triage", flow: work }]

/** The board the count-era build registered: two cards. */
const original = Kanban.make({ columns, items: [{ id: "a" }, { id: "b" }], concurrency: 1 })
/** A board whose one card is `2`: the count-era tag of `original`, once. */
const singleton = Kanban.make({ columns, items: [{ id: "2" }], concurrency: 1 })

/** What the build before the remediation tagged `original`. */
const countEraTag = "kanban(columns=triage, items=2, concurrency=1)[kanban-legacy/work, ]"

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "kanban-legacy", changeId: "kanban-legacy" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const database = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "kanban-legacy-"))
  directories.push(directory)
  return join(directory, "engine.sqlite")
}

/** One runtime over the durable stores in `filename`; two calls are two processes sharing a database. */
const durable = <A, E>(filename: string, body: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(body).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(filename)),
      Effect.provide(NodeCrypto.layer)
    ) as Effect.Effect<A, E, never>
  )

/** One engine incarnation in `scope`, with every flow in `boards` registered. */
const incarnation = (
  scope: Scope.Scope,
  implementation: Layer.Layer<any, any, any>,
  boards: ReadonlyArray<Kanban.KanbanFlow<any>>
) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "kanban-legacy" },
      journalSource: "kanban-legacy-test",
      isAlive: () => Effect.succeed(false)
    }).pipe(Scope.provide(scope))
    return yield* Layer.buildWithScope(
      Layer.mergeAll(implementation, ...boards.map((board) => Interpreter.layer(board as never))).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      ) as Layer.Layer<any, never, any>,
      scope
    )
  })

describe("Kanban tags across the count-to-ids change", () => {
  it("versions the tag, so a one-card board named `2` is not the count-era two-card board", () => {
    expect(singleton._tag).toBe("kanban@2(columns=triage, items=2, concurrency=1)[kanban-legacy/work, ]")
    expect(original._tag).toBe("kanban@2(columns=triage, items=a,b, concurrency=1)[kanban-legacy/work, ]")
    expect(singleton._tag).not.toBe(countEraTag)
    expect(original._tag).not.toBe(singleton._tag)
  })

  it("gives a board one alias under its count-era tag, and a named board none", () => {
    const named = Kanban.make({ name: "sprint", columns, items: [{ id: "a" }, { id: "b" }], concurrency: 1 })
    const aliases = Kanban.legacyAliases([original, named, original])

    expect(aliases.map((alias) => alias._tag)).toEqual([countEraTag, original._tag.replace("kanban@2", "kanban")])
    for (const boards of [[original, singleton], [singleton, original]]) {
      expect(() => Kanban.legacyAliases(boards)).toThrow(countEraTag)
    }
    // An alias is a board under its old name: it has no alias of its own.
    expect(Kanban.legacyAliases(aliases)).toEqual([])
  })

  it("builds the count-era tag the old build built: plain values, with no quoting", () => {
    const board = Kanban.make({
      columns: [{ name: "to do", flow: work }, { name: "done", flow: work }],
      items: [{ id: "a" }],
      concurrency: 3,
      onComplete: work
    })

    expect(Kanban.legacyAliases([board]).map((alias) => alias._tag)).toEqual([
      "kanban(columns=to do,done, items=1, concurrency=3)[kanban-legacy/work, kanban-legacy/work, kanban-legacy/work]",
      "kanban(columns=\"to do\",done, items=a, concurrency=3)[kanban-legacy/work, kanban-legacy/work, kanban-legacy/work]"
    ])
  })

  it("refuses two boards that shared one count-era tag instead of registering either", () => {
    const other = Kanban.make({ columns, items: [{ id: "c" }, { id: "d" }], concurrency: 1 })
    let thrown: unknown
    try {
      Kanban.legacyAliases([original, other])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(PatternError)
    expect((thrown as PatternError).code).toBe("invalid_decorator")
    expect((thrown as PatternError).message).toContain(countEraTag)
    expect((thrown as PatternError).message).toContain(original._tag)
    expect((thrown as PatternError).message).toContain(other._tag)
  })

  it("refuses a flow Kanban.make did not declare", () => {
    expect(() => Kanban.legacyAliases([work as never])).toThrow(PatternError)
  })

  it.each(Kanban.legacyAliases([original]))("resumes the historical $_tag on its original cards", async (alias) => {
    const calls: Array<string> = []
    let life = 0
    const implementation = (stalled: Deferred.Deferred<void> | undefined) =>
      work.toLayer(({ item }) =>
        Effect.suspend((): Effect.Effect<unknown> => {
          const { id } = item as Kanban.Item
          calls.push(`${id}@${life}`)
          // In the first runtime `b` never finishes: the runtime goes away under it.
          if (id === "b" && stalled !== undefined) {
            return Effect.andThen(Deferred.succeed(stalled, undefined), Effect.never)
          }
          return Effect.succeed(id.toUpperCase())
        })
      )
    const filename = database()

    // The old build: the board is registered under its count-era tag only.
    life = 1
    await durable(
      filename,
      Effect.gen(function*() {
        const stalled = yield* Deferred.make<void>()
        const first = yield* Scope.make()
        const before = yield* incarnation(first, implementation(stalled), [alias!])
        yield* Effect.forkChild(
          alias!.execute({ input: "sprint" }, { executionId: "kanban-parked" }).pipe(
            Effect.provideContext(before),
            Effect.exit
          )
        )
        yield* Deferred.await(stalled)
        yield* Scope.close(first, Exit.void)
      })
    )

    // The new build registers both current boards and the alias. The `2`
    // board is registered last, so a tag it shared would resolve to it.
    life = 2
    const observed = await durable(
      filename,
      Effect.gen(function*() {
        const after = yield* incarnation(yield* Effect.scope, implementation(undefined), [original, alias!, singleton])
        return yield* alias!.execute({ input: "sprint" }, { executionId: "kanban-parked" }).pipe(
          Effect.provideContext(after)
        )
      })
    )

    expect(observed).toEqual({
      board: { a: { triage: "A" }, b: { triage: "B" } },
      completed: ["a", "b"],
      failed: [],
      iterations: 1
    })
    // `a` settled once, in the first runtime; the second ran only `b`, and
    // never the `2` card.
    expect(calls).toEqual(["a@1", "b@1", "b@2"])
  })
})
