import { ShapeSource } from "@smthrs/effect-electric"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { expect, test, vi } from "vitest"
import { nodeDevice, openTab, openTestApi, openTestApp, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import type { Session } from "../auth/schema"
import { role as readRole } from "../repo/actions"
import { repoId } from "../repo/contract"
import { AuthStore } from "../auth/store"
import { Repo } from "../repo/repo"
import { RepoStore } from "../repo/store"
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

// Production, 2026-11-02: an Admin's Stack page read "Members can make TODOs." for 15 minutes after one role answer
// failed. A role ChatApi couldn't answer is unavailable, never a denial; ChatApi's own 401 and 403 are answers.
test("a role answer that failed is unavailable; a 401 reads sign in and a 403 forbidden", () => {
  for (const failure of ["unavailable", "rate_limited", "github_unavailable"]) {
    expect(stackAccess(state("signed_in", "admin"), [{ id, own: false, role: null, failure }], id)).toBe("unavailable")
  }
  expect(stackAccess(state("signed_in", "admin"), [{ id, own: false, role: null, refused: "authentication" }], id)).toBe("sign_in")
  expect(stackAccess(state("signed_in", "admin"), [{ id, own: false, role: null, refused: "forbidden" }], id)).toBe("forbidden")
})

// Astra on 55f0c161: a 403 followed by a failed session refresh read `unknown`, which rendered the retained TODOs.
test("a refusal stays through a session that can't answer; only a signed-out session says otherwise", () => {
  for (const status of ["loading", "unreachable"] as const) {
    expect(stackAccess(state(status), [{ id, own: false, role: null, refused: "forbidden" }], id)).toBe("forbidden")
    expect(stackAccess(state(status), [{ id, own: false, role: null, refused: "authentication" }], id)).toBe("sign_in")
    // No refusal: a pending check is unknown, and a failed network keeps the role this tab holds. Never a denial.
    expect(stackAccess(state(status), [{ id, own: false, role: "member" }], id)).toBe(status === "loading" ? "unknown" : "allowed")
  }
  expect(stackAccess(state("signed_out"), [{ id, own: false, role: null, refused: "forbidden" }], id)).toBe("sign_in")
})

test("a real signed-out stack opens no TODO or prompt shape and learns access from the session", async ({ onTestFailed }) => {
  const requests: string[] = []
  const source: ShapeSource.Source = { request: (url, init) => Effect.suspend(() => {
    requests.push(new URL(url).pathname)
    return ShapeSource.fetchSource.request(url, init)
  }) }
  const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, { actor: null })
  const started = Date.now()
  const observations: Array<{ elapsedMs: number; session: string; access: string }> = []
  onTestFailed(() => console.error("todo.signed_out", JSON.stringify({ observations,
    todoShapes: requests.filter(path => path === "/api/shapes/todos").length,
    promptShapes: requests.filter(path => path === "/api/shapes/todo-requests").length })))
  try {
    const store = await runtime.runPromise(Effect.service(TodosStore))
    const auth = await runtime.runPromise(Effect.service(AuthStore))
    const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
    const key = repoId(owner, name)
    await runtime.runPromise(store.stackOf(key))
    await vi.waitFor(async () => {
      const access = Option.getOrThrow(await runtime.runPromise(store.access.get(key))).status
      const session = auth.session.tanstack.get("session")?.status ?? "absent"
      const last = observations.at(-1)
      if (last === undefined || last.session !== session || last.access !== access) observations.push({ elapsedMs: Date.now() - started, session, access })
      expect(access).toBe("sign_in")
    }, { timeout: 30_000 })
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

/** A tab on a real ChatApi whose `/role` answers fail as `failures` say, in order (status 0 passes), then answer. */
const failingRole = async (failures: Array<{ readonly status: number; readonly retryAfter?: string; readonly body?: unknown }>, host?: ReturnType<typeof nodeDevice>) => {
  const server = openTestApi()
  const api = await server.runPromise(Effect.service(TestChatApi))
  const asked: Array<number> = []
  const tab = openTab({
    ...api,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.endsWith("/role")) {
        asked.push(Date.now())
        const failure = failures.shift()
        if (failure?.status === 200) {
          return new Response(JSON.stringify(failure.body), { status: 200, headers: { "content-type": "application/json" } })
        }
        if (failure !== undefined && failure.status !== 0) {
          return new Response(JSON.stringify({ code: failure.status === 403 ? "forbidden" : failure.status === 401 ? "authentication" : "unavailable" }), {
            status: failure.status,
            headers: { "content-type": "application/json", ...(failure.retryAfter === undefined ? {} : { "retry-after": failure.retryAfter }) },
          })
        }
      }
      return api.fetch(request)
    },
  }, host === undefined ? {} : { host })
  const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
  await vi.waitFor(async () => {
    const sessions = await tab.runPromise(Effect.flatMap(AuthStore, (auth) => auth.session.toArray))
    expect(sessions[0]?.status).toBe("signed_in")
  }, { timeout: 15_000 })
  return { tab, asked, owner, name, key: repoId(owner, name), dispose: async () => { await tab.dispose(); await server.dispose() } }
}

test("a stack whose role read answered 503 reads unavailable, and Try again recovers it", async () => {
  const { tab, owner, name, key, asked, dispose } = await failingRole([{ status: 503 }])
  try {
    await tab.runPromise(readRole(owner, name))
    const store = await tab.runPromise(Effect.service(TodosStore))
    await tab.runPromise(store.stackOf(key))
    await vi.waitFor(async () => expect(Option.getOrThrow(await tab.runPromise(store.access.get(key))).status).toBe("unavailable"), { timeout: 5_000 })
    // Nothing asks again by itself.
    await new Promise((done) => setTimeout(done, 2_500))
    expect(asked).toHaveLength(1)
    // Try again: the page calls role once.
    ;(await tab.runPromise(Effect.service(Repo))).actions.role(owner, name)
    await vi.waitFor(async () => expect(Option.getOrThrow(await tab.runPromise(store.access.get(key))).status).toBe("allowed"), { timeout: 15_000 })
  } finally { await dispose() }
}, 90_000)

test.each([[401, "authentication", "sign_in"], [403, "forbidden", "forbidden"]] as const)("an answer, then a %i, leaves nothing of the answer", async (status, refused, reads) => {
  const { tab, owner, name, key, dispose } = await failingRole([{ status: 0 }, { status }])
  try {
    await tab.runPromise(readRole(owner, name))
    const repos = await tab.runPromise(Effect.service(RepoStore))
    expect(Option.getOrThrow(await tab.runPromise(repos.roles.get(key)))).toMatchObject({ own: true })
    await tab.runPromise(readRole(owner, name))
    const row = Option.getOrThrow(await tab.runPromise(repos.roles.get(key)))
    expect(row).toMatchObject({ role: null, own: false, refused })
    for (const field of ["readable", "workspaceRole", "synced", "failure"] as const) expect(row[field]).toBeUndefined()
    const session = (await tab.runPromise(Effect.flatMap(AuthStore, (auth) => auth.session.toArray)))[0]!
    expect(stackAccess(session, [row], key)).toBe(reads)
  } finally { await dispose() }
}, 90_000)

// Codex review of 54e03f49: a refusal ChatApi gave is no answer to keep: the next route that asks may reuse only a
// role it answered, so access that came back is read again.
test("a stored 403 isn't reused: the next route that asks reads the role again and recovers", async () => {
  const { tab, owner, name, key, asked, dispose } = await failingRole([{ status: 403 }])
  try {
    await tab.runPromise(readRole(owner, name))
    const store = await tab.runPromise(Effect.service(TodosStore))
    await tab.runPromise(store.stackOf(key))
    await vi.waitFor(async () => expect(Option.getOrThrow(await tab.runPromise(store.access.get(key))).status).toBe("forbidden"), { timeout: 5_000 })
    // A route within the repository asks with reuse, as enterRepo does.
    await tab.runPromise(readRole(owner, name, true))
    expect(asked).toHaveLength(2)
    await vi.waitFor(async () => expect(Option.getOrThrow(await tab.runPromise(store.access.get(key))).status).toBe("allowed"), { timeout: 15_000 })
  } finally { await dispose() }
}, 90_000)

// Astra on 11855d97: a failed network said nothing of the person, yet hid every TODO. Only a reached server that couldn't
// verify the session does.
test("a stack shows what the device kept on a failed network, and nothing once a server couldn't verify", () => {
  const down = state("unreachable", "admin")
  const reached = { ...down, unverifiable: true }
  const member = { id, own: false, role: "member" } as const
  expect(stackAccess(down, [member], id)).toBe("allowed")
  expect(stackAccess(reached, [member], id)).toBe("unverified")
  expect(stackAccess(state("loading"), [member], id)).toBe("unknown")
})

// Astra on c64fd4bc: after a refusal, a role read can answer 200 with no role and no public read. That grants nothing,
// so the refusal stands and the gate stays closed. Astra on b978c783: `own` says the repository is the deployment's own
// (worker/home/Api.ts), never that this person may read it, so it grants nothing either.
test.each([
  { role: null, own: false, readable: false },
  { role: null, own: true, readable: false },
  { role: null, own: true },
])("a role answer that grants nothing keeps the repository refused: %o", async (body) => {
  const { tab, owner, name, key, dispose } = await failingRole([{ status: 403 }, { status: 200, body }])
  try {
    await tab.runPromise(readRole(owner, name))
    const repos = await tab.runPromise(Effect.service(RepoStore))
    expect(repos.isRefused(key)).toBe(true)
    await tab.runPromise(readRole(owner, name))
    expect(repos.isRefused(key)).toBe(true)
    expect(Option.getOrThrow(await tab.runPromise(repos.roles.get(key))).refused).toBe("forbidden")
  } finally { await dispose() }
}, 90_000)

// Astra on c64fd4bc: a stack read as a Member, then left, then opened again offline, hid its TODOs. A failed network says
// nothing new, so the answer this tab already had stands.
test("a role read that fails on the network keeps the answer this tab already had", async () => {
  const { tab, owner, name, key, dispose } = await failingRole([{ status: 0 }, { status: 503 }])
  try {
    await tab.runPromise(readRole(owner, name))
    const repos = await tab.runPromise(Effect.service(RepoStore))
    const answered = Option.getOrThrow(await tab.runPromise(repos.roles.get(key)))
    expect(answered.failure).toBeUndefined()
    await tab.runPromise(readRole(owner, name))
    expect(Option.getOrThrow(await tab.runPromise(repos.roles.get(key)))).toMatchObject({ role: answered.role, own: answered.own })
    expect(Option.getOrThrow(await tab.runPromise(repos.roles.get(key))).failure).toBeUndefined()
  } finally { await dispose() }
}, 90_000)
