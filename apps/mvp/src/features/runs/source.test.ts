import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { expect, test } from "vitest"
import { ShapeSource } from "@smthrs/effect-electric"
import { AuthStore, SESSION } from "../auth/store"
import { RepoStore } from "../repo/store"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { memberRunSource } from "./source"

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
