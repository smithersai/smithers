import { Deferred, Effect, Layer, ManagedRuntime } from "effect"
import { expect, test } from "vitest"
import { repoAuthority } from "../../test/repoAuthority"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { BranchTrackRefused, BranchTrackUnavailable } from "../branch/flows"
import { RepoStore } from "../repo/store"
import { runAction } from "./actions.vibe"
import { CURRENT } from "./rows"
import { HomeStore } from "./store.vibe"

// A home opened without the optional feature stores still exposes usable empty live blocks.
test("standalone homes have empty issues, sync, runs, stack and access blocks", async () => {
  const runtime = ManagedRuntime.make(HomeStore.layer.pipe(Layer.provide(repoAuthority), Layer.provide(Persistence.memory)))
  try {
    const store = await runtime.runPromise(Effect.service(HomeStore))
    expect(await runtime.runPromise(Effect.all([store.noItems, store.noSyncs, store.runs, store.noTodos, store.noAccess].map((query) => query.toArray)))).toEqual([[], [], [], [], []])
    expect((await runtime.runPromise(store.current.toArray))[0]?.owner).toBe("")
    await runtime.runPromise(store.homes.insert({ key: "repo@sha", state: "absent", sections: [], contributors: "role", skipped: 0, reason: null }))
    await runtime.runPromise(store.curated.insert({ key: "repo", state: "absent", defaultBranch: "main", sections: [] }))
    expect(await runtime.runPromise(store.homes.get("repo@sha"))).toMatchObject({ value: { state: "absent" } })
    expect(await runtime.runPromise(store.curated.get("repo"))).toMatchObject({ value: { defaultBranch: "main" } })

    await runtime.runPromise(store.files.insert({ key: "repo@sha:README.md", repoId: "repo", home: "repo@sha", path: "README.md", state: "text", text: "Home" }))
    expect(await runtime.runPromise(store.files.get("repo@sha:README.md"))).toMatchObject({ value: { text: "Home" } })

    await runtime.runPromise(store.current.delete(CURRENT))
    expect(await runtime.runPromise(store.homeState.toArray)).toEqual([])
  } finally {
    await runtime.dispose()
  }
})


test.each([
  [new BranchTrackRefused({ reason: "forbidden" }), "forbidden"],
  [new BranchTrackUnavailable(), "unavailable"],
])("a refused home action clears its running state and keeps the reason (%s)", async (error, reason) => {
  const runtime = ManagedRuntime.make(HomeStore.layer.pipe(Layer.provide(repoAuthority), Layer.provide(Persistence.memory)))
  try {
    const store = await runtime.runPromise(Effect.service(HomeStore))
    await runtime.runPromise(store.current.update(CURRENT, (row) => {
      row.owner = "acme"; row.name = "widgets"; row.repoId = "repo"
    }))
    const result = await runtime.runPromise(runAction("branch.new", "maya").pipe(
      Effect.provideService(FlowDispatch, { dispatch: () => Effect.succeed({ _tag: "Failed", error }) as never }),
    ))
    expect(result).toBeUndefined()
    expect(await runtime.runPromise(store.current.get(CURRENT))).toMatchObject({ value: { running: [], failure: reason } })
  } finally {
    await runtime.dispose()
  }
})


test.each(["failed", "done"] as const)("an action finishing after navigation cannot change the new repository or navigate back (%s)", async (outcome) => {
  const runtime = ManagedRuntime.make(HomeStore.layer.pipe(Layer.provide(repoAuthority), Layer.provide(Persistence.memory)))
  try {
    const store = await runtime.runPromise(Effect.service(HomeStore))
    const started = Deferred.makeUnsafe<void>()
    const finish = Deferred.makeUnsafe<void>()
    await runtime.runPromise(store.current.update(CURRENT, (row) => {
      row.owner = "acme"; row.name = "one"; row.repoId = "one"
    }))
    const pending = runtime.runPromise(runAction("branch.new", "maya").pipe(
      Effect.provideService(FlowDispatch, { dispatch: () => Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(finish)
        return outcome === "done"
          ? { _tag: "Done", value: { name: "maya/new-branch" } }
          : { _tag: "Failed", error: new BranchTrackRefused({ reason: "forbidden" }) }
      }) as never }),
    ))
    await runtime.runPromise(Deferred.await(started))
    await runtime.runPromise(store.current.update(CURRENT, (row) => {
      row.repoId = "two"; row.running = ["branch.new"]; row.failure = null
    }))
    await runtime.runPromise(Deferred.succeed(finish, undefined))
    expect(await pending).toBeUndefined()
    expect(await runtime.runPromise(store.current.get(CURRENT))).toMatchObject({ value: { running: ["branch.new"], failure: null } })
  } finally { await runtime.dispose() }
})


test("a refusal removes only that repository's home, curated answer and Markdown files", async () => {
  const runtime = ManagedRuntime.make(HomeStore.layer.pipe(Layer.provideMerge(repoAuthority), Layer.provide(Persistence.memory)))
  try {
    const [store, repos] = await runtime.runPromise(Effect.all([HomeStore, RepoStore]))
    for (const id of ["acme/widgets", "acme/other"]) {
      const key = `${id}@sha`
      await runtime.runPromise(store.homes.insert({ key, state: "absent", sections: [], contributors: "role", skipped: 0, reason: null }))
      await runtime.runPromise(store.curated.insert({ key: id, state: "absent", defaultBranch: "main", sections: [] }))
      await runtime.runPromise(store.files.insert({ key: `${key}:README.md`, repoId: id, home: key, path: "README.md", state: "text", text: id }))
    }

    await runtime.runPromise(repos.refuse("acme/widgets"))
    await runtime.runPromise(repos.wiped("acme/widgets"))

    const [homes, curated, files] = await runtime.runPromise(Effect.all([
      store.homes.toArray, store.curated.toArray, store.files.toArray,
    ]))
    expect(homes.map((row) => row.key)).toEqual(["acme/other@sha"])
    expect(curated.map((row) => row.key)).toEqual(["acme/other"])
    expect(files.map((row) => row.repoId)).toEqual(["acme/other"])
  } finally {
    await runtime.dispose()
  }
})

test("an engine refusal clears the action without a destination", async () => {
  const runtime = ManagedRuntime.make(HomeStore.layer.pipe(Layer.provide(repoAuthority), Layer.provide(Persistence.memory)))
  try {
    const store = await runtime.runPromise(Effect.service(HomeStore))
    await runtime.runPromise(store.current.update(CURRENT, (row) => {
      row.owner = "acme"
      row.name = "widgets"
      row.repoId = "acme/widgets"
    }))

    const failure = new DispatchFailed({ flow: "branch/create", reason: "unavailable" })
    const destination = await runtime.runPromise(runAction("branch.new", null).pipe(
      Effect.provideService(FlowDispatch, { dispatch: () => Effect.fail(failure) }),
    ))

    expect(destination).toBeUndefined()
    expect(await runtime.runPromise(store.current.get(CURRENT))).toMatchObject({
      value: { running: [], failure: "unavailable" },
    })
  } finally {
    await runtime.dispose()
  }
})
