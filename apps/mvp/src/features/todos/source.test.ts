import { ShapeSource } from "@smthrs/effect-electric"
import { Deferred, Effect, Layer, Option } from "effect"
import { expect, test, vi } from "vitest"
import { openTestApp, TEST_REPOSITORY } from "../../test/chatApi"
import type { Session } from "../auth/schema"
import { role as readRole } from "../repo/actions"
import { repoId } from "../repo/contract"
import { TodosStore } from "./store"
import { stackAccess } from "./source"

const id = "github/acme/repo"
const state = (status: Session["status"], role: Session["role"] = null): Session => ({ id: "session", status, role, login: null, available: true, restored: true, signingOut: false })
test("a stack needs Member authority on that repository, including the session's current role on its own", () => {
  expect(stackAccess(state("signed_out"), [], id)).toBe("sign_in")
  for (const status of ["loading", "unreachable"] as const) expect(stackAccess(state(status), [], id)).toBe("unknown")
  expect(stackAccess(state("signed_in", "admin"), [], id)).toBe("unknown")
  expect(stackAccess(state("signed_in", "admin"), [{ id, own: false, role: null }], id)).toBe("forbidden")
  expect(stackAccess(state("signed_in", "admin"), [{ id, own: false, role: "guest" }], id)).toBe("forbidden")
  expect(stackAccess(state("signed_in", "admin"), [{ id, own: true, role: null }], id)).toBe("allowed")
  expect(stackAccess(state("signed_in", null), [{ id, own: true, role: "admin" }], id)).toBe("forbidden")
  expect(stackAccess(state("signed_in", null), [{ id, own: false, role: "member" }], id)).toBe("allowed")
})

test("a real signed-out stack opens no TODO or prompt shape and learns access from the session", async () => {
  const requests: string[] = []
  const source: ShapeSource.Source = { request: (url, init) => Effect.suspend(() => {
    requests.push(new URL(url).pathname)
    return ShapeSource.fetchSource.request(url, init)
  }) }
  const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, { actor: null })
  try {
    const store = await runtime.runPromise(Effect.service(TodosStore))
    const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
    const key = repoId(owner, name)
    await runtime.runPromise(store.stackOf(key))
    await vi.waitFor(async () => expect(Option.getOrThrow(await runtime.runPromise(store.access.get(key))).status).toBe("sign_in"))
    await runtime.runPromise(Effect.sleep("100 millis"))
    expect(requests.filter((path) => path === "/api/shapes/todos" || path === "/api/shapes/todo-requests")).toEqual([])
  } finally { await runtime.dispose() }
}, 90_000)


test("a granted stack stays unknown until its real shape is applied", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const source: ShapeSource.Source = { ...ShapeSource.fetchSource, request: (url, init) => Effect.gen(function* () {
    if (new URL(url).pathname === "/api/shapes/todos") {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    }
    return yield* ShapeSource.fetchSource.request(url, init)
  }) }
  const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) })
  try {
    const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
    await runtime.runPromise(readRole(owner, name))
    const store = await runtime.runPromise(Effect.service(TodosStore))
    const key = repoId(owner, name)
    await runtime.runPromise(store.stackOf(key))
    await runtime.runPromise(Deferred.await(entered))
    expect(Option.getOrThrow(await runtime.runPromise(store.access.get(key))).status).toBe("unknown")
    await runtime.runPromise(Deferred.succeed(release, undefined))
    await vi.waitFor(async () => expect(Option.getOrThrow(await runtime.runPromise(store.access.get(key))).status).toBe("allowed"), { timeout: 30_000 })
  } finally {
    await runtime.runPromise(Deferred.succeed(release, undefined))
    await runtime.dispose()
  }
}, 90_000)
