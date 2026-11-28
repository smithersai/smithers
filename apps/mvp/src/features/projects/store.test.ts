import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Effect, Fiber, Layer, ManagedRuntime, Option, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { boundFetch } from "../../device/identity.vibe"
import { sqlite } from "../../test/deviceFixture"
import { repoAuthority } from "../../test/repoAuthority"
import { tempDirectory } from "../../test/tempDirectory"
import { AuthStore, SESSION } from "../auth/store.vibe"
import { replaceRole, RepoStore } from "../repo/store.vibe"
import { PROJECT_STATUS_ROUTE } from "./contract"
import { projectsLayer, ProjectsStore } from "./store.vibe"

const origin = "https://fixture.test"
const projectsTab = (fetch: typeof globalThis.fetch, persistence = Persistence.memory) => ManagedRuntime.make(
  projectsLayer({ origin }).pipe(
    Layer.provideMerge(Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch))),
    Layer.provideMerge(repoAuthority),
    Layer.provideMerge(AuthStore.layer),
    Layer.provide(persistence),
  ),
)
const requestUrl = (input: Parameters<typeof fetch>[0]) => new URL(input instanceof Request ? input.url : String(input))
const projectSummary = (project: string, openTodos: number) => ({
  project, access: "member", openTodos, needsAttention: 2, openPlanNodes: 0,
})

test("same-account authority changes clear private counts and confirmations retry refused reads", async () => {
  const project = "example/private"
  const member = projectSummary(project, 4)
  const restricted = { project, access: "restricted", openTodos: null, needsAttention: null, openPlanNodes: null }
  let response: Response | Promise<Response> = Response.json({ projects: [member] })
  let reads = 0
  const fetch: typeof globalThis.fetch = async (input) => {
    if (requestUrl(input).pathname !== PROJECT_STATUS_ROUTE) return Response.json({ projects: [project] })
    reads++
    return (await response).clone()
  }
  const runtime = projectsTab(fetch)
  try {
    const auth = await runtime.runPromise(AuthStore)
    const live = await runtime.runPromise(Effect.flatMap(ProjectsStore, (store) => store.open))
    const update = (role: "member" | "guest") => runtime.runPromise(auth.session.update(SESSION, (row) => {
      Object.assign(row, { status: "signed_in", personId: "one", role, roleConfirmed: true })
    }))
    const unsubscribe = live.subscribe(() => {})
    try {
      await update("member")
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([member]))

      const changing = Promise.withResolvers<Response>()
      response = changing.promise
      await update("guest")
      expect(live.current()[0]?.summaries).toEqual([])
      changing.resolve(Response.json({ projects: [restricted] }))
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([restricted]))

      response = new Response(null, { status: 401 })
      live.refresh("one")
      await vi.waitFor(() => expect(live.current()[0]).toMatchObject({ status: "unavailable", projects: [], summaries: [] }))
      const refused = reads
      response = Response.json({ projects: [restricted] })
      await runtime.runPromise(auth.sessionConfirmed)
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([restricted]))
      expect(reads).toBe(refused + 1)

      const stale = Promise.withResolvers<Response>()
      response = stale.promise
      live.refresh("one")
      await vi.waitFor(() => expect(reads).toBe(refused + 2))
      await runtime.runPromise(auth.sessionConfirmed)
      response = Response.json({ projects: [restricted] })
      stale.resolve(new Response(null, { status: 403 }))
      await vi.waitFor(() => expect(reads).toBe(refused + 3))
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([restricted]))
    } finally {
      unsubscribe()
    }
  } finally {
    await runtime.dispose()
  }
})

test("a second tab's refusal drops only that repository's counts and invalidates its pending summary", async () => {
  const refused = "example/private"
  const allowed = "example/other"
  const id = `github/${refused}`
  const roster = [refused, allowed]
  const first = projectSummary(refused, 4)
  const other = projectSummary(allowed, 5)
  const path = join(tempDirectory("mvp-projects-"), "device.sqlite")
  const device = crypto.randomUUID()
  const persistence = Persistence.layer({
    open: () => sqlite(path),
    make: (database, coordinator) => createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
    coordinator: () => new BrowserCollectionCoordinator({ dbName: device }),
  })
  let respond = (_url: URL) => Promise.resolve(Response.json({ projects: [first, other] }))
  let summaryReads = 0
  const runtime = projectsTab(async (input) => {
    const url = requestUrl(input)
    if (url.pathname !== PROJECT_STATUS_ROUTE) return Response.json({ projects: roster })
    summaryReads++
    return respond(url)
  }, persistence)
  const secondTab = ManagedRuntime.make(repoAuthority.pipe(Layer.provide(persistence)))
  try {
    const auth = await runtime.runPromise(AuthStore)
    const repos = await runtime.runPromise(RepoStore)
    await runtime.runPromise(Effect.all([auth.confirmed.restored, repos.refusalsKnown, repos.repositories.restored]))
    const live = await runtime.runPromise(Effect.flatMap(ProjectsStore, (store) => store.open))
    const noticed: unknown[] = []
    const unsubscribe = live.subscribe(() => noticed.push(live.current()[0]?.summaries))
    const grant = async () => {
      expect(await runtime.runPromise(repos.clearRefusal(id))).toBe(true)
      await runtime.runPromise(replaceRole(repos, { id, role: "member", own: false }))
      expect(repos.visible.tanstack.get(id)?.show).toBe(true)
    }
    try {
      await runtime.runPromise(auth.session.update(SESSION, (row) => {
        Object.assign(row, { status: "signed_in", personId: "one", role: "member", roleConfirmed: true })
      }))
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([first, other]))
      const remote = await secondTab.runPromise(RepoStore)
      await secondTab.runPromise(Effect.all([remote.refusalsKnown, remote.repositories.restored]))
      const refuseElsewhere = async () => {
        await secondTab.runPromise(remote.refuse(id))
        await vi.waitFor(() => expect(repos.visible.tanstack.get(id)?.show).toBe(false))
      }

      await refuseElsewhere()
      expect(live.current()[0]).toMatchObject({ personId: "one", projects: roster, summaries: [other] })
      expect(noticed.at(-1)).toEqual([other])
      await grant()
      expect(live.current()[0]?.summaries).toEqual([other])

      const late = Promise.withResolvers<Response>()
      const freshOther = projectSummary(allowed, 8)
      respond = (url) => url.searchParams.get("after") === allowed
        ? late.promise
        : Promise.resolve(Response.json({ projects: [freshOther], nextAfter: allowed }))
      live.refresh("one")
      await vi.waitFor(() => expect(summaryReads).toBe(3))
      expect(live.current()[0]).toMatchObject({ status: "ready", projects: roster, summaries: [freshOther], summariesPending: true })
      await refuseElsewhere()
      await grant()
      late.resolve(Response.json({ projects: [projectSummary(refused, 7)] }))
      await vi.waitFor(() => expect(live.current()[0]).toMatchObject({
        personId: "one", projects: roster, summariesPending: false, summaries: [freshOther],
      }))

      respond = () => Promise.resolve(Response.json({ projects: [first, freshOther] }))
      live.refresh("one")
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([first, freshOther]))
    } finally {
      unsubscribe()
    }
  } finally {
    await secondTab.dispose()
    await runtime.dispose()
  }
})

test("a stale credential from the bound summary transport hides the roster and form until session confirmation", async () => {
  const project = "example/private"
  const summary = projectSummary(project, 4)
  const ready = () => Response.json({ projects: [summary] })
  let response = ready()
  const runtime = projectsTab(boundFetch(async (input) =>
    requestUrl(input).pathname === PROJECT_STATUS_ROUTE ? response.clone() : Response.json({ projects: [project] }),
  { origin, principal: () => "one" }))
  try {
    const auth = await runtime.runPromise(AuthStore)
    const live = await runtime.runPromise(Effect.flatMap(ProjectsStore, (store) => store.open))
    const unsubscribe = live.subscribe(() => {})
    const check = runtime.runFork(Stream.runHead(auth.checksAsked))
    try {
      await runtime.runPromise(auth.session.update(SESSION, (row) => {
        Object.assign(row, { status: "signed_in", personId: "one", role: "member", roleConfirmed: true })
      }))
      await vi.waitFor(() => expect(live.current()[0]?.summaries).toEqual([summary]))

      response = new Response(null, { status: 503 })
      live.refresh("one")
      await vi.waitFor(() => expect(live.current()[0]).toMatchObject({
        personId: "one", status: "ready", projects: [project], summaries: [], summariesPending: false,
      }))

      response = new Response(null, { status: 503, headers: { "x-smithers-credential": "stale" } })
      live.refresh("one")
      await vi.waitFor(() => expect(live.current()[0]).toMatchObject({ status: "unavailable", projects: [], summaries: [] }))
      expect(live.current()[0]?.personId).toBeUndefined()
      expect(Option.isSome(await runtime.runPromise(Fiber.join(check)))).toBe(true)

      response = ready()
      live.refresh("one")
      expect(live.current()[0]?.personId).toBeUndefined()
      await runtime.runPromise(auth.sessionConfirmed)
      await vi.waitFor(() => expect(live.current()[0]).toMatchObject({ personId: "one", projects: [project], summaries: [summary] }))
    } finally {
      await runtime.runPromise(Fiber.interrupt(check))
      unsubscribe()
    }
  } finally {
    await runtime.dispose()
  }
})
