import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect"
import { expect, test } from "vitest"
import { ShapeSource } from "@smthrs/effect-electric"
import { AuthStore, SESSION } from "../auth/store"
import { RepoStore } from "../repo/store"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { cloudRunList, memberRunSource } from "./source"

test("run authority follows the named repository, never a public receipt or a stale signed-in role", async () => {
  const runtime = ManagedRuntime.make(RepoStore.layer({ origin: "https://unused.test" }).pipe(
    Layer.provideMerge(AuthStore.layer), Layer.provideMerge(Persistence.memory),
    Layer.provide(Layer.succeed(ShapeSource.ShapeSource, { request: () => Effect.never })),
  ))
  try {
    const auth = await runtime.runPromise(Effect.service(AuthStore))
    const repos = await runtime.runPromise(Effect.service(RepoStore))
    for (const query of [auth.sessionState, repos.rolesState]) query.tanstack.startSyncImmediate()
    const source = memberRunSource(ShapeSource.fetchSource, Option.some(auth), Option.some(repos), "github/other/repo")
    // Requests blocked by authority can be interrupted without reaching any transport.
    const blocked = () => runtime.runPromise(source.request("https://unused.test", {}).pipe(Effect.timeoutOption("20 millis")))
    expect(await blocked()).toEqual(Option.none())
    await runtime.runPromise(repos.roles.insert({ id: "github/other/repo", own: false, role: null, readable: true }))
    expect(await blocked()).toEqual(Option.none())
    for (const status of ["loading", "unreachable", "signed_out", "signed_in"] as const) {
      await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = status; row.role = "admin" }))
      for (const own of [false, true]) for (const role of [null, "guest", "member", "maintainer", "admin"] as const) {
        await runtime.runPromise(repos.roles.update("github/other/repo", (row) => { row.own = own; row.role = role }))
        // An injected Effect transport reports invocation without network or response substitution.
        let requested = false
        const faulty: ShapeSource.Source = { request: () => Effect.sync(() => { requested = true }).pipe(Effect.andThen(Effect.never)) }
        const guarded = memberRunSource(faulty, Option.some(auth), Option.some(repos), "github/other/repo")
        await runtime.runPromise(guarded.request("https://unused.test", {}).pipe(Effect.timeoutOption("100 millis")))
        expect(requested).toBe(status === "signed_in" && (own || (role !== null && role !== "guest")))
      }
    }
    await runtime.runPromise(repos.roles.update("github/other/repo", (row) => { row.synced = false }))
    expect(await blocked()).toEqual(Option.none())
    for (const [a, r] of [[Option.none(), Option.some(repos)], [Option.some(auth), Option.none()]] as const) {
      expect(await runtime.runPromise(memberRunSource(ShapeSource.fetchSource, a, r, "missing").request("https://unused.test", {}).pipe(Effect.timeoutOption("20 millis")))).toEqual(Option.none())
    }
  } finally { await runtime.dispose() }
}, 60_000)

test("cloud history waits for authentication and never requests a visitor's index", async () => {
  const runtime = ManagedRuntime.make(AuthStore.layer.pipe(Layer.provide(Persistence.memory)))
  try {
    const auth = await runtime.runPromise(Effect.service(AuthStore))
    auth.sessionState.tanstack.startSyncImmediate()
    let reads = 0
    const read = Effect.sync(() => { reads++; return ["run"] })
    expect(await runtime.runPromise(cloudRunList(read, Option.some(auth)).pipe(Effect.timeoutOption("20 millis")))).toEqual(Option.none())
    expect(reads).toBe(0)
    for (const status of ["signed_out", "signed_in"] as const) {
      await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = status }))
      expect(await runtime.runPromise(cloudRunList(read, Option.some(auth)))).toEqual(status === "signed_in" ? ["run"] : [])
    }
    expect(reads).toBe(1)
    await runtime.runPromise(auth.session.update(SESSION, (row) => { row.status = "unreachable" }))
    expect(await runtime.runPromise(cloudRunList(read, Option.some(auth)).pipe(Effect.timeoutOption("20 millis")))).toEqual(Option.none())
    expect(reads).toBe(1)
    expect(await runtime.runPromise(cloudRunList(read, Option.none()))).toEqual(["run"])
    // A failed session service that ends without a row grants no network read.
    const ended = { ...auth, sessionState: { ...auth.sessionState, rows: Stream.empty } }
    expect(await runtime.runPromise(cloudRunList(read, Option.some(ended)))).toEqual([])
    expect(reads).toBe(2)
  } finally { await runtime.dispose() }
})
