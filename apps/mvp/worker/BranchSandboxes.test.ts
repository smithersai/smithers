// The branch object's socket plumbing that needs no container (worker/BranchSandboxes.ts over
// worker/durable/SocketPumps.ts): the lapsed-lease notifier the object builds once, and the order a viewer is
// registered and its terminal started in. The object itself, over its real container, runs under `alchemy dev`.
import { Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { describe, expect, test } from "vitest"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { sourceText } from "../../../packages/repo-targets/test-utils/source-readers.mjs"
import * as SocketPumps from "./durable/SocketPumps.ts"

/** A renewal that dies is counted here, as the object logs it. */
const died = (causes: Array<string>) => () => Effect.sync(() => void causes.push("died"))

/** What the object's renewal reads from its own services: who built it. */
class Host extends Context.Service<Host, { readonly name: string }>()("@smthrs/mvp/test/BranchSandboxesHost") {}

describe("the object's lapsed-lease notifier", () => {
  test("is built once with the object's services and renews from a socket's event after the request that attached it ended", async () => {
    const scope = Effect.runSync(Scope.make())
    const ran: Array<string> = []
    let done = Deferred.makeUnsafe<void>()
    const renewDue = Effect.gen(function*() {
      ran.push((yield* Host).name)
      Deferred.doneUnsafe(done, Effect.void)
    })
    // The object's construction: the only place the renewal's services are given.
    const lapsed = await Effect.runPromise(
      SocketPumps.lapsedRenewals(renewDue, scope, died([])).pipe(Effect.provideService(Host, { name: "object" })),
    )
    // A first socket's request comes and goes, its own scope closed, before any frame lapses.
    await Effect.runPromise(Effect.scoped(Effect.provideService(Effect.void, Host, { name: "request-1" })))

    // A socket's own event, outside any effect: no runtime is handed in and none is captured per request.
    lapsed()
    await Effect.runPromise(Deferred.await(done))
    done = Deferred.makeUnsafe<void>()
    // A second socket, attached by another request, shares the one notifier.
    await Effect.runPromise(Effect.scoped(Effect.provideService(Effect.void, Host, { name: "request-2" })))
    lapsed()
    await Effect.runPromise(Deferred.await(done))

    expect(ran).toEqual(["object", "object"])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("a burst of frames on lapsed leases costs one renewal, and the next burst one more", async () => {
    const scope = Effect.runSync(Scope.make())
    let runs = 0
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let finished = Deferred.makeUnsafe<void>()
    const renewDue = Effect.gen(function*() {
      runs += 1
      Deferred.doneUnsafe(started, Effect.void)
      yield* Deferred.await(release)
    }).pipe(Effect.ensuring(Effect.sync(() => void Deferred.doneUnsafe(finished, Effect.void))))
    const lapsed = await Effect.runPromise(SocketPumps.lapsedRenewals(renewDue, scope, died([])))

    for (let frame = 0; frame < 50; frame++) lapsed()
    await Effect.runPromise(Deferred.await(started))
    for (let frame = 0; frame < 50; frame++) lapsed()
    Deferred.doneUnsafe(release, Effect.void)
    await Effect.runPromise(Deferred.await(finished))
    expect(runs).toBe(1)

    finished = Deferred.makeUnsafe<void>()
    lapsed()
    await Effect.runPromise(Deferred.await(finished))
    expect(runs).toBe(2)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("a renewal that dies doesn't stop the object's later renewals", async () => {
    const scope = Effect.runSync(Scope.make())
    let runs = 0
    let finished = Deferred.makeUnsafe<void>()
    const renewDue = Effect.suspend(() => (++runs === 1 ? Effect.die("renewal broke") : Effect.void)).pipe(
      Effect.ensuring(Effect.sync(() => void Deferred.doneUnsafe(finished, Effect.void))),
    )
    const deaths: Array<string> = []
    const lapsed = await Effect.runPromise(SocketPumps.lapsedRenewals(renewDue, scope, died(deaths)))

    lapsed()
    await Effect.runPromise(Deferred.await(finished))
    finished = Deferred.makeUnsafe<void>()
    lapsed()
    await Effect.runPromise(Deferred.await(finished))

    expect(runs).toBe(2)
    expect(deaths).toEqual(["died"])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("the object runs no Effect through a captured runtime and binds no unused clock", () => {
    const source = sourceText(new URL("./BranchSandboxes.ts", import.meta.url))
    for (const banned of ["runForkWith", "Effect.runFork", "Effect.runPromise", "Effect.runSync", "Effect.clockWith"]) {
      expect(source).not.toContain(banned)
      expect(sourceText(new URL("./durable/SocketPumps.ts", import.meta.url))).not.toContain(banned)
    }
    // The object's own notifier and registration order are the ones it attaches sockets with.
    expect(source).toContain("SocketPumps.lapsedRenewals(")
    expect(source).toContain("SocketPumps.attachRegistered(")
    // The fetch client is named only as the default of the client the hosting program injects (`live`, `gateLive`):
    // no handler provides its own.
    expect(source.match(/FetchHttpClient\.layer/g)).toHaveLength(2)
    expect(source.match(/http: ObjectHttp = FetchHttpClient\.layer/g)).toHaveLength(2)
  })
})

describe("attaching a socket", () => {
  test("registers the viewer before its terminal starts, so a terminal that ends at once removes its own entry", async () => {
    const scope = Effect.runSync(Scope.make())
    const attached = new Map<string, Fiber.Fiber<string>>()
    const seen: Array<string> = []
    let startedAtRegistration: boolean | undefined
    let started = false

    const fiber = await Effect.runPromise(SocketPumps.attachRegistered(
      (registered) =>
        // A terminal that closes immediately: it ends without ever suspending once it may start.
        Effect.andThen(registered, Effect.sync(() => {
          started = true
          seen.push(attached.has("socket") ? "registered" : "missing")
          return "closed"
        })).pipe(Effect.ensuring(Effect.sync(() => attached.delete("socket")))),
      (registering) => {
        startedAtRegistration = started
        attached.set("socket", registering)
      },
      scope,
    ))

    expect(await Effect.runPromise(Fiber.join(fiber))).toBe("closed")
    expect(startedAtRegistration).toBe(false)
    expect(seen).toEqual(["registered"])
    // Nothing is left behind for a socket that is gone.
    expect(attached.size).toBe(0)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("the registered pump stays interruptible, and interrupting it runs its release", async () => {
    const scope = Effect.runSync(Scope.make())
    const attached = new Map<string, Fiber.Fiber<never>>()
    const running = Deferred.makeUnsafe<void>()

    const fiber = await Effect.runPromise(SocketPumps.attachRegistered(
      (registered) =>
        Effect.andThen(registered, Effect.andThen(Deferred.succeed(running, undefined), Effect.never)).pipe(
          Effect.ensuring(Effect.sync(() => attached.delete("socket"))),
        ),
      (registering) => void attached.set("socket", registering),
      scope,
    ))
    await Effect.runPromise(Deferred.await(running))
    expect(attached.get("socket")).toBe(fiber)

    const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(attached.size).toBe(0)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

// worker/durable/SocketPumps.ts holds per-object waits, as worker/durable/SocketHost.ts does
// (worker/durable/boundary.test.ts): only the Durable Object that owns the sockets, and tests, may import it.
test("only the branch object imports the socket pump coordinators", () => {
  const root = import.meta.dirname
  const walk = (dir: string): Array<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full)
      return entry.name.endsWith(".ts") || entry.name.endsWith(".vibe") ? [full] : []
    })
  const importers = walk(root)
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".test.ts") && !file.includes("/test/") && !file.startsWith("durable/"))
    .filter((file) => /from\s+["'][^"']*durable\/SocketPumps/.test(sourceText(new URL(`./${file}`, import.meta.url))))
  expect(importers).toEqual(["BranchSandboxes.ts"])
})
