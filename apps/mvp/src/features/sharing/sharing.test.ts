// Sharing in the browser (decision 0013 §2 and §5, docs/features/branch-workspace.md#sharing): the browser's own layer
// (`appLayer`) on Node devices whose engines lead, two people's, against ChatApi's real `POST /api/branches/<id>/shares`
// and shares shape (worker/branch/Shares.ts, src/test/chatApi.ts) over the compose Postgres and Electric. Changes go
// through `branch/share` on the owner's engine; the dialog's list is the branch's, synced. `branch/share`'s client and
// step are also driven over an injected `fetch` for the answers a valid change never gets (test.faults-by-injection).
import { Deferred, Effect, Layer, Logger, type ManagedRuntime, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { asPerson, failingWorker, member, nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { FlowDispatch, type Dispatched } from "../../flows/dispatch"
import { change as changeSharing } from "./actions"
import { AuthStore, SESSION } from "../auth/store"
import { Branch } from "../branch/branch"
import { ShareClient, ShareRefused } from "./api"
import { SharingStore } from "./store"
import { BranchShareRefused, BranchShareUnavailable } from "./flows"
import { shares } from "./metrics"
import { kindOf, requestShare, shareFailure } from "./steps"
import { errorOf, generalOf, linkOf, OWNER, peopleOf } from "./view"
import type { ShareRow } from "./schema"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/**
 * A test's budget: two fresh devices' engines, each flow with its first start, and every change synced back, on a
 * machine running the whole suite at once.
 */
const WITHIN = 240_000

const ben: Actor = { subject: { kind: "person", id: "person-ben" }, role: "member", login: "ben" }

/** One person's device on `api`: their branch layer, and what their session row says. */
const device = async (runtime: ManagedRuntime.ManagedRuntime<Branch | AuthStore | SharingStore, unknown>, login: string) => {
  const branch = await runtime.runPromise(Effect.service(Branch))
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(SESSION, (row) => void Object.assign(row, { status: "signed_in", login, role: "member" })),
  )
  branch.sharing.queries.dialog.startSyncImmediate()
  branch.sharing.queries.shares.startSyncImmediate()
  branch.queries.current.startSyncImmediate()
  return {
    runtime,
    branch,
    actions: branch.sharing.actions,
    dialog: () => branch.sharing.queries.dialog.toArray[0],
    list: () =>
      branch.sharing.queries.shares.toArray.map((row) => ({ grantee: row.grantee, login: row.login, access: row.access })),
    current: () => branch.queries.current.toArray[0],
  }
}

/** The owner's device on a fresh ChatApi where Ben may sign in too, with GitHub's `octo/hello`; and Ben's device. */
const open = async () => {
  const runtime = openTestApp({}, { people: { ben } })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one"), "feature/two": shaOf("feature/two") },
  })
  const owner = await device(runtime, member.subject.id)
  const benRuntime = openTab(asPerson(api, "ben"))
  runtimes.push(benRuntime)
  const benDevice = await device(benRuntime, "ben")
  return { api, owner, ben: benDevice }
}

/** A dispatch whose reply is held back: a faulty service supplies the ordering the real engine cannot promise. */
const delayedChange = async (owner: Awaited<ReturnType<typeof device>>) => {
  const started = Effect.runSync(Deferred.make<void>())
  const reply = Effect.runSync(Deferred.make<Dispatched<"branch/share">>())
  const pending = owner.runtime.runPromise(changeSharing({ grantee: "person-ben", access: "view" }).pipe(
    Effect.provideService(FlowDispatch, FlowDispatch.of({
      dispatch: () => Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(reply)) as never,
    })),
  ))
  await owner.runtime.runPromise(Deferred.await(started))
  return async (result: Dispatched<"branch/share">) => {
    await owner.runtime.runPromise(Deferred.succeed(reply, result))
    await pending
  }
}

describe("sharing a branch", () => {
  test("the owner shares with Ben by login, to view then edit, opens the link to the repository, and removes him", async () => {
    const { owner, ben: benDevice } = await open()
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    expect(owner.current()).toMatchObject({ status: "ready", access: "owner" })
    // Ben may not open it until it is shared with him.
    expect(await benDevice.branch.actions.open("octo", "hello", "feature/one")).toBeUndefined()
    expect(benDevice.current()).toMatchObject({ status: "forbidden" })

    await owner.actions.open(branchId)
    expect(owner.dialog()).toMatchObject({ open: true, branchId, error: null, pending: [] })
    await owner.actions.add(" Ben ", "view")
    await until(() => expect(owner.list()).toEqual([{ grantee: "person-ben", login: "ben", access: "view" }]))
    expect(owner.dialog()).toMatchObject({ error: null, pending: [] })
    expect(await benDevice.branch.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(benDevice.current()).toMatchObject({ status: "ready", access: "view" })

    await owner.actions.set("person-ben", "edit")
    await until(() => expect(owner.list()).toEqual([{ grantee: "person-ben", login: "ben", access: "edit" }]))
    await owner.actions.set("repository", "view")
    await until(() => expect(owner.list()).toContainEqual({ grantee: "repository", login: null, access: "view" }))
    await owner.actions.set("person-ben", null)
    await until(() => expect(owner.list()).toEqual([{ grantee: "repository", login: null, access: "view" }]))
    // The link still lets Ben, a Member, view it.
    expect(await benDevice.branch.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(benDevice.current()).toMatchObject({ access: "view" })

    await owner.actions.close()
    expect(owner.dialog()).toMatchObject({ open: false })
  }, WITHIN)

  test("a login nobody signed in with says No such person; someone who isn't the owner is told No access", async () => {
    const { owner, ben: benDevice } = await open()
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await owner.actions.open(branchId)
    await owner.actions.add("nobody-here", "edit")
    expect(owner.dialog()).toMatchObject({ error: "no_person", pending: [] })
    expect(errorOf(owner.dialog()!)).toBe("No such person")
    // The next change clears it.
    await owner.actions.add("ben", "edit")
    expect(owner.dialog()).toMatchObject({ error: null })

    await benDevice.branch.actions.open("octo", "hello", "feature/one")
    await benDevice.actions.open(branchId)
    await benDevice.actions.add("person-member", "view")
    expect(benDevice.dialog()).toMatchObject({ error: "forbidden" })
    // Only the owner's shape has rows: Ben's list is empty.
    expect(benDevice.list()).toEqual([])
  }, WITHIN)

  test("a change ChatApi refuses as invalid, or one this tab can't run, says Couldn't share; opening at once opens one list", async () => {
    const { owner } = await open()
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await Promise.all([owner.actions.open(branchId), owner.actions.open(branchId)])
    // However many ask for one branch's list at once, the tab syncs it once.
    const other = crypto.randomUUID()
    const [first, second] = await owner.runtime.runPromise(
      Effect.flatMap(Effect.service(SharingStore), (store) =>
        Effect.all([store.shares(other), store.shares(other)], { concurrency: "unbounded" })),
    )
    expect(first).toBe(second)
    await owner.actions.add("-not-a-login-", "view")
    expect(owner.dialog()).toMatchObject({ error: "failed", pending: [] })
    expect(errorOf(owner.dialog()!)).toBe("Couldn't share")

    const stoppedRuntime = openTestApp({ host: nodeDevice({ engineWorker: failingWorker }) })
    runtimes.push(stoppedRuntime)
    const stopped = await device(stoppedRuntime, member.subject.id)
    await stopped.actions.open(crypto.randomUUID())
    await stopped.actions.add("ben", "view")
    expect(stopped.dialog()).toMatchObject({ error: "failed", pending: [] })
  }, WITHIN)

  test.each(["switch", "reopen", "overlap", "close"].flatMap((opening) =>
    [false, true].map((success) => ({ opening, success })),
  ))("a delayed sharing reply leaves the current dialog alone: $opening, success=$success", async ({ opening, success }) => {
    const { owner } = await open()
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await owner.actions.open(branchId)
    const older = await delayedChange(owner)
    let newer: Awaited<ReturnType<typeof delayedChange>> | undefined
    const done = { _tag: "Done", value: { txid: null } } as const
    try {
      if (opening !== "overlap") await owner.actions.close()
      if (opening === "switch") {
        const otherBranch = (await owner.branch.actions.open("octo", "hello", "feature/two"))!
        await owner.actions.open(otherBranch)
      }
      if (opening === "reopen") await owner.actions.open(branchId)
      if (opening !== "close") {
        newer = await delayedChange(owner)
        // An unrelated row's newer failure must survive too, while Ben's change remains pending.
        await owner.actions.add("nobody-here", "edit")
        expect(owner.dialog()).toMatchObject({ pending: ["person-ben"], error: "no_person" })
      }
      const current = owner.dialog()
      await older(success ? done : {
        _tag: "Failed",
        error: new BranchShareRefused({ reason: "forbidden" }),
      })
      expect(owner.dialog()).toEqual(current)
      if (newer !== undefined) {
        await newer(done)
        expect(owner.dialog()).toMatchObject({ pending: [], error: "no_person" })
      }
    } finally {
      await older(done)
      await newer?.(done)
    }
  }, WITHIN)

  test("a change with no dialog open asks nothing", async () => {
    const { owner, api } = await open()
    await owner.actions.add("ben", "view")
    expect(owner.dialog()).toMatchObject({ open: false, error: null, pending: [] })
    expect(api.branches.rooms.enforced).toEqual([])
  }, WITHIN)
})

describe("the dialog's view", () => {
  const row = (fields: Partial<ShareRow> & Pick<ShareRow, "grantee" | "access">): ShareRow => ({
    branchId: "b",
    login: fields.grantee,
    sharedBy: "owner",
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    ...fields,
  })

  test("the owner first, then everyone shared with by name; the link's access; the branch's link", () => {
    const list = [
      row({ grantee: "person-ben", login: "ben", access: "edit" }),
      row({ grantee: "repository", login: null, access: "view" }),
      row({ grantee: "person-gus", login: null, access: "view" }),
    ]
    expect(peopleOf(list, "maya")).toEqual([
      { id: OWNER, name: "maya", access: "owner" },
      { id: "person-ben", name: "ben", access: "edit" },
      { id: "person-gus", name: "person-gus", access: "view" },
    ])
    expect(peopleOf([], null)).toEqual([{ id: OWNER, name: OWNER, access: "owner" }])
    expect(generalOf(list)).toBe("view")
    expect(generalOf([])).toBe("restricted")
    expect(linkOf("https://smithers.sh", { owner: "octo", repo: "hello", name: "feature/one two" })).toBe(
      "https://smithers.sh/octo/hello/tree/feature/one%20two",
    )
    expect(errorOf({ error: null })).toBeUndefined()
    expect(errorOf({ error: "too_many" })).toBe("Too many people")
  })
})

describe("the share client and step", () => {
  /** `branch/share/request` over a client that answers `answer`: how it ended, and its records. */
  const step = async (answer: () => Promise<Response>, change = { login: "ben", access: "view" } as const) => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
    const exit = await Effect.runPromise(
      requestShare({ branchId: "0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11", change }).pipe(
        Effect.match({ onSuccess: (shared) => ({ shared }), onFailure: (failed) => ({ failed }) }),
        Effect.provide(
          ShareClient.layer({ origin: "http://chat.test", within: "50 millis" }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => answer())),
          ),
        ),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    const count = (change: string, outcome: string) =>
      Effect.runSync(Metric.value(Metric.withAttributes(shares, { change, outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      )).count
    return { exit, logs, count }
  }

  test.each<[number, string, BranchShareRefused | BranchShareUnavailable, string]>([
    [401, "authentication", new BranchShareRefused({ reason: "sign_in" }), "sign_in"],
    [403, "forbidden", new BranchShareRefused({ reason: "forbidden" }), "forbidden"],
    [404, "no_person", new BranchShareRefused({ reason: "no_person" }), "no_person"],
    [404, "not_found", new BranchShareRefused({ reason: "not_found" }), "not_found"],
    [409, "too_many", new BranchShareRefused({ reason: "too_many" }), "too_many"],
    [400, "invalid", new BranchShareRefused({ reason: "invalid" }), "invalid"],
    [413, "invalid", new BranchShareRefused({ reason: "invalid" }), "invalid"],
    [503, "unavailable", new BranchShareUnavailable(), "unavailable"],
  ])("ChatApi's %s %s is %s, counted and logged by kind and outcome", async (status, code, failure, outcome) => {
    const { exit, logs, count } = await step(async () => Response.json({ code }, { status }))
    expect(exit).toEqual({ failed: failure })
    expect(count("person", outcome)).toBe(1)
    expect(logs).toEqual([
      expect.objectContaining({
        level: "WARN",
        message: "branch.share",
        annotations: expect.objectContaining({ outcome, status, change: "person", feature: "sharing" }),
      }),
    ])
    expect(JSON.stringify(logs)).not.toContain("ben")
  })

  test("200 is shared; no answer, or one outside the contract, is unavailable or refused by its status", async () => {
    const shared = await step(async () => Response.json({ txid: 7 }), { grantee: "repository", access: null } as never)
    expect(shared.exit).toEqual({ shared: { txid: 7 } })
    expect(shared.count("link", "shared")).toBe(1)
    expect(shared.logs[0]).toMatchObject({ level: "INFO", annotations: { outcome: "shared" } })
    expect(shared.logs[0]!.annotations).not.toHaveProperty("status")

    const stalled = await step(() => new Promise(() => {}))
    expect(stalled.exit).toEqual({ failed: new BranchShareUnavailable() })
    const garbled = await step(async () => Response.json({ txid: "x" }))
    expect(garbled.exit).toEqual({ failed: new BranchShareUnavailable() })
    const cut = new ReadableStream({ start: (controller) => controller.error(new TypeError("cut")) })
    const broken = await step(async () => new Response(cut, { status: 502 }))
    expect(broken.exit).toEqual({ failed: new BranchShareUnavailable() })
    const offline = await step(() => Promise.reject(new TypeError("offline")))
    expect(offline.exit).toEqual({ failed: new BranchShareUnavailable() })
  })

  test("a refusal maps by status and code, and each change has its kind", () => {
    expect(shareFailure(new ShareRefused({ status: 404 }))).toEqual(new BranchShareRefused({ reason: "not_found" }))
    expect(shareFailure(new ShareRefused({}))).toEqual(new BranchShareUnavailable())
    expect(kindOf({ login: "ben", access: "view" })).toBe("person")
    expect(kindOf({ grantee: "repository", access: "edit" })).toBe("link")
    expect(kindOf({ grantee: "person-ben", access: null })).toBe("remove")
    expect(kindOf({ grantee: "person-ben", access: "edit" })).toBe("access")
  })
})
