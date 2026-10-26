import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Layer, Option } from "effect"
import { expect, test, vi } from "vitest"
import { openTestApp, TEST_REPOSITORY } from "../../test/chatApi"
import type { Session } from "../auth/schema"
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
