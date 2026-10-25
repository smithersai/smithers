// Opening a branch's page (decision 0013 §1-§2, docs/features/branch-workspace.md#tracking-a-branch): the browser's own
// layer (`appLayer`) on a Node device whose engine leads, against ChatApi's real `POST /api/branches`
// (worker/branch/Branches.ts, src/test/chatApi.ts) over the compose Postgres and Electric. The forge is GitHub with no
// credential, and GitHub is scripted at the network (worker/test/branch.ts `gitHost`). `branch/track`'s client and step
// are also driven over an injected `fetch` for the answers ChatApi's route never gives a valid request: a body cut
// short, a stalled answer, 400 and 413 (test.faults-by-injection).
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Deferred, Effect, FiberHandle, Layer, Logger, Metric, Ref } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { dispatches } from "../../flows/dispatch"
import {
  type ChatApiOptions,
  failingWorker,
  nodeDevice,
  openTestApp,
  type TabOptions,
  TestChatApi,
} from "../../test/chatApi"
import { Auth } from "../auth/auth"
import { retry, wentOffline } from "../chat/actions"
import { Chat } from "../chat/chat"
import { BranchClient, TrackRefused } from "./api"
import { Branch } from "./branch"
import { BranchStore } from "./store"
import { openBranchPage } from "./navigation"
import { Terminal } from "../terminal/terminal"
import { TerminalStore } from "../terminal/store"
import { Coedit } from "../coedit/coedit"
import { CoeditStore } from "../coedit/store"
import { Presence } from "../presence/presence"
import { PresenceStore } from "../presence/store"
import { CONVERSATION_NAMESPACE } from "./contract"
import { BranchTrackRefused, BranchTrackUnavailable } from "./flows"
import { opens, reopens, tracks } from "./metrics"
import { requestTrack, stampOpen } from "./steps"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: flows on a fresh device's engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

const conversationOf = (branchId: string) =>
  Effect.runPromise(Uuid.v5(CONVERSATION_NAMESPACE, branchId).pipe(Effect.provide(WebCrypto.layer)))

/** The app on a ChatApi whose GitHub has `octo/hello`, with `main` (its default) and `feature/one`. */
const open = async (options: TabOptions = {}, chatApi: ChatApiOptions = {}) => {
  const runtime = openTestApp(options, chatApi)
  runtimes.push(runtime)
  const branch = await runtime.runPromise(Effect.service(Branch))
  const chat = await runtime.runPromise(Effect.service(Chat))
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  const { conversations: cache } = await runtime.runPromise(Effect.service(BranchStore))
  branch.queries.current.startSyncImmediate()
  chat.queries.place.startSyncImmediate()
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one") },
  })
  return {
    runtime,
    api,
    cache,
    actions: branch.actions,
    current: () => branch.queries.current.toArray[0],
    /** The conversation this tab shows and asks in: a branch's id, or `null` for the home one. */
    place: () => chat.queries.place.toArray[0]?.conversationId,
    /** The branch's rows Postgres holds for `octo/hello`. */
    rows: () =>
      runtime.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly name: string; readonly mode: string }>`
          SELECT name, mode FROM branches WHERE repo_id = 'github/octo/hello' ORDER BY name`))),
    opened: (outcome: string) => runtime.runSync(Metric.value(Metric.withAttributes(opens, { outcome }))).count,
    /** Branch pages opened offline that the browser coming back online reopened, or found abandoned. */
    reopens: (outcome: "reopened" | "abandoned") =>
      runtime.runSync(Metric.value(Metric.withAttributes(reopens, { outcome }))).count,
    dispatched: () =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(dispatches, { flow: "branch/track", door: "view", outcome: "done" })),
      ).count,
  }
}

const none = { owner: "", repo: "", name: "", status: "none", branchId: null, conversationId: null, mode: null, access: null }

describe("opening a branch", () => {
  test("tracking at once, then ready with its ids and mode; the tab shows and asks in its conversation", async () => {
    const tab = await open()
    expect(tab.current()).toMatchObject(none)

    const opening = tab.actions.open("octo", "hello", "feature/one")

    // The page renders tracking before anything waits.
    expect(tab.current()).toMatchObject({ owner: "octo", repo: "hello", name: "feature/one", status: "tracking", branchId: null })
    const branchId = await opening
    const conversationId = await conversationOf(branchId!)
    expect(tab.current()).toMatchObject({
      id: "current",
      owner: "octo",
      repo: "hello",
      name: "feature/one",
      status: "ready",
      branchId,
      conversationId,
      mode: "open",
      // Tracking a new branch makes it the person's own, private until they share it.
      access: "owner",
    })
    expect(tab.place()).toBe(conversationId)
    expect(tab.opened("ready")).toBe(1)
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }])

    // The repository's default branch is locked: changes reach it only by merge.
    await tab.actions.open("octo", "hello", "main")
    // The default branch is the team's: everyone in the repository edits it, and nobody owns it.
    expect(tab.current()).toMatchObject({ name: "main", status: "ready", mode: "locked", access: "edit" })
    expect(tab.place()).toBe(tab.current()?.conversationId)

    // Leaving shows the home conversation again.
    await tab.actions.leave()
    expect(tab.current()).toMatchObject(none)
    expect(tab.place()).toBeNull()

    // A branch the app tracks answers at once: GitHub isn't read again, and Postgres keeps one row.
    const reads = tab.api.branches.github.seen.length
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(tab.api.branches.github.seen).toHaveLength(reads)
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, { name: "main", mode: "locked" }])
    expect(tab.dispatched()).toBe(3)
  }, WITHIN)

  test("an answer that comes after the tab moved on, to another branch or home, isn't shown", async () => {
    const tab = await open()

    // Home before the branch is tracked: its answer leaves the tab at home.
    const left = tab.actions.open("octo", "hello", "feature/one")
    await tab.actions.leave()
    expect(await left).toBeUndefined()
    expect(tab.current()).toMatchObject(none)
    expect(tab.place()).toBeNull()

    // Another branch's page before the first answers: the tab shows the one it moved to.
    const first = tab.actions.open("octo", "hello", "feature/one")
    const second = tab.actions.open("octo", "hello", "main")
    expect(await first).toBeUndefined()
    const mainId = await second
    expect(tab.current()).toMatchObject({ name: "main", status: "ready", branchId: mainId, mode: "locked" })
    expect(tab.place()).toBe(tab.current()?.conversationId)
    expect(tab.opened("ready")).toBe(1)
    // Both were tracked: only showing them waited on the page.
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, { name: "main", mode: "locked" }])
  }, WITHIN)

  test("a name that can't be a branch or a repository, such as a commit's path, is missing and asks nobody", async () => {
    const tab = await open()

    for (const [owner, repo, ref] of [["octo", "hello", "a..b"], ["octo", "hello", ""], ["-octo", "hello", "main"]]) {
      expect(await tab.actions.open(owner!, repo!, ref!)).toBeUndefined()
      expect(tab.current()).toMatchObject({ owner, repo, name: ref, status: "missing", branchId: null, conversationId: null })
    }

    expect(tab.api.branches.github.seen).toEqual([])
    expect(tab.dispatched()).toBe(0)
    // Counted by the dispatch's outcome, which these never had.
    expect(tab.opened("missing")).toBe(0)
    expect(tab.place()).toBeNull()
  }, WITHIN)

  test("a branch GitHub doesn't have is missing, at once: a refusal isn't tried again", async () => {
    const tab = await open()
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/nope", conversationId: "deleted-conversation" }))

    expect(await tab.actions.open("octo", "hello", "nope")).toBeUndefined()

    expect(tab.current()).toMatchObject({ name: "nope", status: "missing", branchId: null, conversationId: null, mode: null })
    expect(tab.opened("missing")).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/nope")).toBe(false)
    // One read of the branch, never a second: the flow ended with the refusal.
    expect(tab.api.branches.github.seen.map(({ method, prefixes }) => [method, prefixes])).toEqual([
      ["POST", ["refs/heads/nope"]],
    ])
    expect(await tab.rows()).toEqual([])
    expect(tab.place()).toBeNull()
    expect(await tab.actions.open("octo", "hello", "unseen")).toBeUndefined()
    expect(tab.cache.tanstack.has("octo/hello/unseen")).toBe(false)
  }, WITHIN)

  test("ChatApi unavailable is tried again by the step's retry policy, and the branch is tracked once", async () => {
    const tab = await open()
    // GitHub's first answer never comes: ChatApi answers 503, and the step asks again 500 ms later.
    tab.api.branches.github.fail("POST", "throw")

    const branchId = await tab.actions.open("octo", "hello", "feature/one")

    expect(branchId).toEqual(expect.any(String))
    expect(tab.current()).toMatchObject({ status: "ready", branchId })
    expect(tab.api.branches.github.seen.map(({ method }) => method)).toEqual(["POST", "POST", "GET"])
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }])
  }, WITHIN)

  test.each<[string, Actor | null, string]>([
    ["signed out", null, "sign_in"],
    ["a Guest", { subject: { kind: "person", id: "person-guest" }, role: "guest" }, "forbidden"],
  ])("%s may not watch a branch: %s, and nothing is recorded", async (_who, actor, status) => {
    const tab = await open({}, { actor })
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "previous-conversation" }))

    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()

    expect(tab.current()).toMatchObject({ status, branchId: null, conversationId: null })
    expect(tab.opened(status)).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(false)
    expect(tab.api.branches.github.seen).toEqual([])
    expect(await tab.rows()).toEqual([])
  }, WITHIN)

  test("signed out, as sign-in's row says, the page says sign in without running branch/track", async () => {
    const tab = await open({}, { actor: null })
    const auth = await tab.runtime.runPromise(Effect.service(Auth))
    auth.queries.session.startSyncImmediate()
    await until(() => expect(auth.queries.session.toArray[0]?.status).toBe("signed_out"))
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "previous-conversation" }))

    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()

    expect(tab.current()).toMatchObject({ status: "sign_in", branchId: null, conversationId: null })
    expect(tab.opened("sign_in")).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(false)
    // Nothing went to ChatApi: no branch/track ran, so no POST /api/branches came back 401.
    for (const outcome of ["done", "failed", "error"]) {
      expect(tab.runtime.runSync(
        Metric.value(Metric.withAttributes(dispatches, { flow: "branch/track", door: "view", outcome })),
      ).count).toBe(0)
    }
    expect(await tab.rows()).toEqual([])
  }, WITHIN)

  test("offline, the page shows at once without waiting for an answer, and opens the branch again once the browser is back online", async () => {
    let reopened = 0
    const recovered = new AbortController()
    const tab = await open({ reopenRoute: () => { reopened++; recovered.abort() } })
    // ChatApi can't answer while the browser is offline: GitHub holds its answer, so the request never ends by itself.
    const release = tab.api.branches.github.hold()

    const opening = tab.actions.open("octo", "hello", "feature/one", recovered.signal)
    await until(() => expect(tab.api.branches.github.seen).toHaveLength(1))
    expect(tab.current()).toMatchObject({ status: "tracking" })
    await tab.runtime.runPromise(wentOffline)

    expect(await opening).toBeUndefined()
    expect(tab.current()).toMatchObject({ owner: "octo", repo: "hello", name: "feature/one", status: "offline", branchId: null })
    expect(tab.opened("offline")).toBe(1)
    expect(tab.place()).toBeNull()
    expect(reopened).toBe(0)

    // Back online, the route opens again, once; its loader then tracks the branch.
    release()
    await tab.runtime.runPromise(retry("online"))
    await until(() => expect(reopened).toBe(1))
    // Replacing the recovered navigation aborts its old signal; it is still one reopened attempt, never abandoned.
    expect(tab.reopens("abandoned")).toBe(0)
    const branchId = await tab.actions.open("octo", "hello", "feature/one")
    expect(tab.current()).toMatchObject({ status: "ready", branchId })

    // A branch opened while the browser is offline doesn't wait at all; leaving it before the browser is back stops the
    // route opening again.
    await tab.runtime.runPromise(wentOffline)
    expect(await tab.actions.open("octo", "hello", "main")).toBeUndefined()
    expect(tab.current()).toMatchObject({ name: "main", status: "offline" })
    await tab.actions.leave()
    await tab.runtime.runPromise(retry("online"))

    // So does its navigation's signal aborting: a newer navigation took over, or the page closed for another route.
    const closed = new AbortController()
    await tab.runtime.runPromise(wentOffline)
    expect(await tab.actions.open("octo", "hello", "main", closed.signal)).toBeUndefined()
    closed.abort()
    // Abandonment settles while still offline, even if no connection recovery or newer branch open ever occurs.
    await until(() => expect(tab.reopens("abandoned")).toBe(1))
    expect(reopened).toBe(1)
    await tab.runtime.runPromise(retry("online"))

    // Even when it aborts while the open still waits, before the browser goes offline.
    const hold = tab.api.branches.github.hold()
    const abandoned = new AbortController()
    const late = tab.actions.open("octo", "hello", "feature/two", abandoned.signal)
    await until(() => expect(tab.current()).toMatchObject({ name: "feature/two", status: "tracking" }))
    abandoned.abort()
    await tab.runtime.runPromise(wentOffline)
    expect(await late).toBeUndefined()
    await tab.runtime.runPromise(retry("online"))
    hold()
    // Both aborted pages are counted once, and neither opened its route.
    await until(() => expect(tab.reopens("abandoned")).toBe(2))
    expect(tab.reopens("reopened")).toBe(1)
    expect(reopened).toBe(1)
  }, WITHIN)

  test("a tab whose engine can't run fails to open the branch, and keeps the home conversation", async () => {
    const tab = await open({ host: nodeDevice({ engineWorker: failingWorker }) })
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "saved-conversation" }))

    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()

    expect(tab.current()).toMatchObject({ name: "feature/one", status: "failed", branchId: null })
    expect(tab.opened("failed")).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(true)
    expect(tab.place()).toBeNull()
  }, WITHIN)
})

/** `BranchClient` over `fetch`, as the engine's host builds it: what one track answers, or its refusal. */
const client = (fetch: typeof globalThis.fetch, within?: "50 millis") =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(BranchClient), (branches) =>
      branches.track({ owner: "octo", name: "hello", ref: "feature/one" })).pipe(
        Effect.match({ onSuccess: (tracked) => tracked, onFailure: (refused) => refused }),
        Effect.provide(
          BranchClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
  )

const trackedBody = {
  branchId: "0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11",
  conversationId: "6a3c2d0e-8a8b-5c1f-9e0a-1d2b3c4d5e6f",
  repoId: "github/octo/hello",
  name: "feature/one",
  mode: "open",
  access: "owner",
  shared: false,
}

describe("the branch client", () => {
  test("posts the branch; 200 or 201 with the branch is tracked, and anything else is a TrackRefused", async () => {
    const posted: Array<{ readonly url: string; readonly body: unknown }> = []
    const recording: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      posted.push({ url: request.url, body: await request.json() })
      return Response.json(trackedBody, { status: 201 })
    }
    expect(await client(recording)).toEqual(trackedBody)
    expect(posted).toEqual([{ url: "http://chat.test/api/branches", body: { owner: "octo", name: "hello", ref: "feature/one" } }])
    expect(await client(async () => Response.json(trackedBody))).toEqual(trackedBody)

    expect(await client(() => Promise.reject(new TypeError("offline")))).toEqual(new TrackRefused({}))
    expect(await client(() => new Promise(() => {}), "50 millis")).toEqual(new TrackRefused({}))
    expect(await client(async () => Response.json({ code: "not_found" }, { status: 404 }))).toEqual(
      new TrackRefused({ status: 404, code: "not_found" }),
    )
    // A code the contract doesn't name, or no JSON at all, is still a refusal, by its status.
    expect(await client(async () => Response.json({ code: "teapot" }, { status: 418 }))).toEqual(
      new TrackRefused({ status: 418 }),
    )
    expect(await client(async () => new Response("busy", { status: 503 }))).toEqual(new TrackRefused({ status: 503 }))
    const cut = new ReadableStream({ start: (controller) => controller.error(new TypeError("cut")) })
    expect(await client(async () => new Response(cut, { status: 502 }))).toEqual(new TrackRefused({ status: 502 }))
    // A success outside the contract can't be shown: refused, by its status.
    expect(await client(async () => Response.json({ branchId: 1 }, { status: 200 }))).toEqual(
      new TrackRefused({ status: 200 }),
    )
  })
})

describe("the step", () => {
  /** `branch/track/request` over a client that answers `answer`: how it ended, and every record it left. */
  const step = async (answer: typeof globalThis.fetch, branch = "feature/one", create = false) => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
    const exit = await Effect.runPromise(
      requestTrack({ repo: "octo/hello", branch }, create).pipe(
        Effect.match({ onSuccess: (tracked) => ({ tracked }), onFailure: (failed) => ({ failed }) }),
        Effect.provide(
          BranchClient.layer({ origin: "http://chat.test", within: "50 millis" }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, answer)),
          ),
        ),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    const count = (outcome: string) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(tracks, { outcome })).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count
    return { exit, logs, count }
  }

  test("an unconfigured forge remains a final refusal with its own count", async () => {
    const result = await step(async () => Response.json({ code: "not_configured" }, { status: 503 }))
    expect(result.exit).toEqual({ failed: new BranchTrackRefused({ reason: "not_configured" }) })
    expect(result.count("not_configured")).toBe(1)
    expect(result.logs[0]).toMatchObject({ level: "WARN", annotations: { outcome: "not_configured", status: 503 } })
  })

  test("the explicit create request sends and records creation without logging the branch name", async () => {
    const posted: unknown[] = []
    const result = await step(async (input, init) => {
      posted.push(await new Request(input, init).json())
      return Response.json(trackedBody, { status: 201 })
    }, "private-create", true)
    expect(posted).toEqual([{ owner: "octo", name: "hello", ref: "private-create", create: true }])
    expect(result.exit).toEqual({ tracked: trackedBody })
    expect(result.count("tracked")).toBe(1)
    expect(result.logs[0]).toMatchObject({ level: "INFO", annotations: { create: true, outcome: "tracked" } })
    expect(JSON.stringify(result.logs)).not.toContain("private-create")
  })

  test.each<[number, BranchTrackRefused | BranchTrackUnavailable, string]>([
    [400, new BranchTrackRefused({ reason: "invalid" }), "invalid"],
    [413, new BranchTrackRefused({ reason: "invalid" }), "invalid"],
    [401, new BranchTrackRefused({ reason: "sign_in" }), "sign_in"],
    [403, new BranchTrackRefused({ reason: "forbidden" }), "forbidden"],
    [404, new BranchTrackRefused({ reason: "not_found" }), "not_found"],
    [503, new BranchTrackUnavailable(), "unavailable"],
    [409, new BranchTrackUnavailable(), "unavailable"],
  ])("ChatApi's %s is %s, counted and logged by its outcome and status", async (status, failure, outcome) => {
    const { exit, logs, count } = await step(async () => Response.json({ code: "x" }, { status }))

    expect(exit).toEqual({ failed: failure })
    expect(count(outcome)).toBe(1)
    expect(logs).toEqual([
      expect.objectContaining({
        level: "WARN",
        message: "branch.track",
        annotations: expect.objectContaining({ outcome, status, feature: "branch", durationMs: expect.any(Number) }),
      }),
    ])
  })

  test("ChatApi's 409 exists, a name the forge already has, is refused exists and never tried again; another 409 is unavailable", async () => {
    const exists = await step(async () => Response.json({ code: "exists" }, { status: 409 }))
    expect(exists.exit).toEqual({ failed: new BranchTrackRefused({ reason: "exists" }) })
    expect(exists.count("exists")).toBe(1)
    const locked = await step(async () => Response.json({ code: "locked" }, { status: 409 }))
    expect(locked.exit).toEqual({ failed: new BranchTrackUnavailable() })
  })

  test("tracked is counted and logged as Info; no answer at all is unavailable, with no status; never the branch's name", async () => {
    const sentinel = "feature/sentinel-41c9"
    const tracked = await step(async () => Response.json({ ...trackedBody, name: sentinel }, { status: 201 }), sentinel)
    expect(tracked.exit).toEqual({ tracked: { ...trackedBody, name: sentinel } })
    expect(tracked.count("tracked")).toBe(1)
    expect(tracked.logs).toEqual([
      expect.objectContaining({
        level: "INFO",
        message: "branch.track",
        annotations: expect.objectContaining({ outcome: "tracked", feature: "branch" }),
      }),
    ])
    expect(tracked.logs[0]!.annotations).not.toHaveProperty("status")

    const stalled = await step(() => new Promise(() => {}), sentinel)
    expect(stalled.exit).toEqual({ failed: new BranchTrackUnavailable() })
    expect(stalled.count("unavailable")).toBe(1)
    expect(stalled.logs[0]).toMatchObject({ level: "WARN", annotations: { outcome: "unavailable" } })
    expect(stalled.logs[0]!.annotations).not.toHaveProperty("status")

    expect(JSON.stringify([tracked.logs, stalled.logs])).not.toContain("sentinel")
  })
})


describe("leaving a branch navigation", () => {
  test.each(["track", "join", "editor", "terminal"] as const)("a late %s answer cannot restore cleaned-up state", async (stage) => {
    const tab = await open()
    const real = await tab.runtime.runPromise(Effect.service(Branch))
    const terminal = await tab.runtime.runPromise(Effect.service(Terminal))
    const store = await tab.runtime.runPromise(Effect.service(PresenceStore))
    real.presence.queries.room.startSyncImmediate()
    terminal.queries.panel.startSyncImmediate()
    const reached = await tab.runtime.runPromise(Deferred.make<void>())
    const release = await tab.runtime.runPromise(Deferred.make<void>())
    // Fault injection into the Effect service: a real action completes, but its answer arrives after cleanup.
    const delay = <A>(answer: Promise<A>): Promise<A> => tab.runtime.runPromise(Effect.gen(function* () {
      const value = yield* Effect.promise(() => answer)
      yield* Deferred.succeed(reached, undefined)
      yield* Deferred.await(release)
      return value
    }))
    const faulty = Branch.of({
      ...real,
      actions: { ...real.actions, open: (...args) => stage === "track" ? delay(real.actions.open(...args)) : real.actions.open(...args) },
      presence: { ...real.presence, actions: { ...real.presence.actions,
        join: (id) => stage === "join" ? delay(real.presence.actions.join(id)) : real.presence.actions.join(id),
      } },
      coedit: { ...real.coedit, actions: { ...real.coedit.actions,
        showFile: (...args) => stage === "editor" ? delay(real.coedit.actions.showFile(...args)) : real.coedit.actions.showFile(...args),
      } },
    })
    const delayedTerminal = Terminal.of({ ...terminal, actions: { ...terminal.actions,
      showInBackground: (id, watching, shown, signal) => terminal.actions.showInBackground(
        id, watching,
        (terminalId) => stage === "terminal" ? delay(Promise.resolve(terminalId)).then(shown) : shown(terminalId),
        signal,
      ),
    } })
    const controller = new AbortController()
    const opening = openBranchPage(faulty, delayedTerminal, controller.signal,
      { owner: "octo", repo: "hello", ref: "feature/one" }, { terminal: "me" })
    try {
      await tab.runtime.runPromise(Deferred.await(reached))
      controller.abort()
      await real.presence.actions.leave()
      await real.coedit.actions.hideFiles()
      await terminal.actions.show(null)
    } finally {
      await tab.runtime.runPromise(Deferred.succeed(release, undefined))
    }
    await opening
    expect(real.presence.queries.room.toArray[0]).toMatchObject({ status: "idle", branchId: null })
    expect(terminal.queries.panel.toArray[0]).toMatchObject({ phase: "idle", branchId: null })
    expect(await tab.runtime.runPromise(Ref.get(store.where))).toBeNull()
  }, WITHIN)
})


describe("cancelling in-flight branch actions", () => {
  test.each(["terminal", "editor"] as const)("a pending %s action is interrupted before it can restore state", async (stage) => {
    const tab = await open()
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const reached = await tab.runtime.runPromise(Deferred.make<void>())
    const release = await tab.runtime.runPromise(Deferred.make<void>())
    const wait = Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(release))
    const terminalStore = await tab.runtime.runPromise(Effect.service(TerminalStore))
    const coeditStore = await tab.runtime.runPromise(Effect.service(CoeditStore))
    const terminal = await tab.runtime.runPromise(Terminal.make.pipe(Effect.provideService(TerminalStore, {
      ...terminalStore,
      terminals: (id) => Effect.andThen(wait, terminalStore.terminals(id)),
    })))
    const coedit = await tab.runtime.runPromise(Coedit.make.pipe(Effect.provideService(CoeditStore, {
      ...coeditStore,
      open: (of) => Effect.andThen(wait, coeditStore.open(of)),
    })))
    const controller = new AbortController()
    const pending = stage === "terminal"
      ? terminal.actions.show(branchId, undefined, controller.signal)
      : coedit.actions.showFile(branchId, "README.md", controller.signal)
    // Observe rejection immediately: aborting a real Effect rejects its Promise with interruption.
    const settled = pending.then(() => "completed", () => "interrupted")
    await tab.runtime.runPromise(Deferred.await(reached))
    controller.abort()
    await terminal.actions.show(null)
    await coedit.actions.hideFiles()
    await tab.runtime.runPromise(Deferred.succeed(release, undefined))
    expect(await settled).toBe("interrupted")
    expect(await tab.runtime.runPromise(terminalStore.panel.toArray)).toMatchObject([{ branchId: null, phase: "idle" }])
    expect((await tab.runtime.runPromise(coeditStore.texts.toArray)).filter((row) => row.kind === "file" && row.shown)).toEqual([])
  }, WITHIN)
})


test("cancelling a room join while the previous connection is closing cannot rejoin", async () => {
  const tab = await open()
  const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
  const store = await tab.runtime.runPromise(Effect.service(PresenceStore))
  const presence = await tab.runtime.runPromise(Effect.service(Presence))
  const started = await tab.runtime.runPromise(Deferred.make<void>())
  const closing = await tab.runtime.runPromise(Deferred.make<void>())
  const release = await tab.runtime.runPromise(Deferred.make<void>())
  // A real attached fiber whose finalizer waits, as a slow socket teardown does.
  await tab.runtime.runPromise(FiberHandle.run(store.attached, Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.andThen(Deferred.succeed(closing, undefined), Deferred.await(release)))
    yield* Deferred.succeed(started, undefined)
    yield* Effect.never
  }).pipe(Effect.scoped)))
  await tab.runtime.runPromise(Deferred.await(started))
  const controller = new AbortController()
  const settled = presence.actions.join(branchId, controller.signal).then(() => "completed", () => "interrupted")
  await tab.runtime.runPromise(Deferred.await(closing))
  controller.abort()
  const leaving = presence.actions.leave()
  await tab.runtime.runPromise(Deferred.succeed(release, undefined))
  await leaving
  expect(await settled).toBe("interrupted")
  expect(await tab.runtime.runPromise(store.room.toArray)).toMatchObject([{ branchId: null, status: "idle" }])
}, WITHIN)


test("a branch page handles missing branches, editor locations, aborts and action failures", async () => {
  const tab = await open()
  const branch = await tab.runtime.runPromise(Effect.service(Branch))
  const terminal = await tab.runtime.runPromise(Effect.service(Terminal))
  const presence = await tab.runtime.runPromise(Effect.service(PresenceStore))
  terminal.queries.panel.startSyncImmediate()
  const params = { owner: "octo", repo: "hello", ref: "feature/one" }
  const absent = { owner: "", repo: "", ref: "" }
  await openBranchPage(branch, terminal, AbortSignal.abort(), params, {})
  expect(tab.current()).toMatchObject(none)

  await openBranchPage(branch, terminal, new AbortController().signal, absent, {})
  expect(terminal.queries.panel.toArray[0]).toMatchObject({ branchId: null, phase: "idle" })
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toBeNull()

  // The real terminal clears its panel, but the route is cancelled before its answer arrives.
  const abortAfterShow = (controller: AbortController) => Terminal.of({
    ...terminal,
    actions: { ...terminal.actions, show: async (...args) => {
      const answer = await terminal.actions.show(...args)
      controller.abort()
      return answer
    } },
  })
  for (const of of [absent, params]) {
    const controller = new AbortController()
    await openBranchPage(branch, abortAfterShow(controller), controller.signal, of, {})
    expect(controller.signal.aborted).toBe(true)
    expect(await tab.runtime.runPromise(Ref.get(presence.where))).toBeNull()
  }

  await openBranchPage(branch, terminal, new AbortController().signal, params, {})
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toEqual({ view: "code", path: "" })
  await openBranchPage(branch, terminal, new AbortController().signal, params, { edit: "README.md" })
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toEqual({ view: "edit", path: "README.md" })

  const failure = new Error("branch action failed")
  const failing = Branch.of({ ...branch, actions: { ...branch.actions,
    open: () => tab.runtime.runPromise(Effect.fail(failure)),
  } })
  await expect(openBranchPage(failing, terminal, new AbortController().signal, params, {})).rejects.toBe(failure)
  const controller = new AbortController()
  const cancelled = Branch.of({ ...branch, actions: { ...branch.actions,
    open: () => tab.runtime.runPromise(Effect.andThen(Effect.sync(() => controller.abort()), Effect.fail(failure))),
  } })
  await expect(openBranchPage(cancelled, terminal, controller.signal, params, {})).resolves.toBeUndefined()
  await branch.presence.actions.leave()
  await branch.coedit.actions.hideFiles()
  await terminal.actions.show(null)
}, WITHIN)

test("an open's time is the page's when it gave one, else the clock's now, which the stamp step records once", async () => {
  expect(await Effect.runPromise(stampOpen({ repo: "octo/hello", branch: "main", openedAt: 5 })))
    .toEqual({ repo: "octo/hello", branch: "main", openedAt: 5 })
  const now = await Effect.runPromise(stampOpen({ repo: "octo/hello", branch: "main" }))
  expect(Math.abs(now.openedAt - Date.now())).toBeLessThan(5_000)
})
