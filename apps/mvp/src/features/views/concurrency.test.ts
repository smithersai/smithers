import { readFileSync } from "node:fs"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Fiber, Layer, References } from "effect"
import ts from "typescript"
import { expect, test } from "vitest"
import { ConversationOwners } from "../conversations/owners"
import { SHOWING } from "./schema"
import { ViewsStore } from "./store"
import { show } from "./views"

// Every conversation's rows show: what concerns these tests is opening, never the data gate (owners.ts).
const everyConversation = Layer.succeed(ConversationOwners, ConversationOwners.of({
  mine: undefined as never,
  shown: undefined as never,
  ofShown: (rows) => Effect.succeed(rows as never),
}))
const storeLayer = ViewsStore.layer({ origin: "http://localhost:1" }).pipe(Layer.provide(Layer.merge(Persistence.memory, everyConversation)))

test("concurrent first opens share their collection and shown query", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* ViewsStore
    // Yield within initialization to exercise overlapping fibers even when storage is in memory.
    const collections = yield* Effect.all(
      Array.from({ length: 8 }, () => store.forConversation("branch").pipe(
        Effect.provideService(References.MaxOpsBeforeYield, 32),
      )),
      { concurrency: "unbounded" },
    )
    for (const collection of collections) expect(collection === collections[0]).toBe(true)
    const query = store.shownIn("branch")
    expect(query).toBeDefined()
    expect(yield* store.forConversation("branch")).toBe(collections[0])
    expect(store.shownIn("branch")).toBe(query)
  }).pipe(Effect.provide(storeLayer))))
})

test("a delayed earlier navigation cannot replace a later home navigation", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* ViewsStore
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    // Fault injection: delay opening at the Effect service boundary, retaining real collections and queries.
    const delayed = ViewsStore.of({ ...store, forConversation: (id) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return yield* store.forConversation(id)
      }) })
    const first = yield* show("earlier", "branch").pipe(
      Effect.provideService(ViewsStore, delayed), Effect.forkChild,
    )
    yield* Deferred.await(started)
    yield* show("latest").pipe(Effect.provideService(ViewsStore, delayed))
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    expect(store.showing.tanstack.get(SHOWING)).toMatchObject({ viewId: "latest", conversationId: null })
  }).pipe(Effect.provide(storeLayer))))
})

test("the app-opening helper owns its documentation", () => {
  const source = ts.createSourceFile("views.test.ts", readFileSync(new URL("./views.test.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find((statement) => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => declaration.name.getText(source) === "open"))!
  expect(ts.getJSDocCommentsAndTags(declaration).map((doc) => doc.getText(source)).join("\n"))
    .toContain("The app as `actor`")
})
