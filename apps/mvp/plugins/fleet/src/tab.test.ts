// The fleet's tab (plugins/fleet/src/tab.ts) over an injected host (TEST-7) whose queries answer the rows a test pushes,
// kept to the repository asked, as the core keeps them (src/plugins/plugins.vibe, `queryOf`).
import { Host } from "@smthrs/plugin"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, test, vi } from "vitest"
import { ACTIVE_STATUS, ALL, DEFAULT_SESSION_FILTERS } from "./GlobalFleetModel"
import { FLEET_NODES, MACHINES, RUNS, tab } from "./tab"

const widgets = { owner: "Acme", name: "Widgets" }

const hostWith = (refused: ReadonlyArray<string> = []) => {
  const rows = new Map<string, Array<{ readonly repo: string }>>([[RUNS, []], [MACHINES, []], [FLEET_NODES, []]])
  /** What the deployment-wide source says of itself, as the core's does (src/plugins/plugins.vibe `globalLive`). */
  const source = { availability: "loading" as "loading" | "unavailable" | "ready" }
  const say = (next: typeof source.availability) => {
    source.availability = next
    for (const listener of listeners) listener()
  }
  const listeners = new Set<() => void>()
  const asked: Array<unknown> = []
  const push = (name: string, ...added: Array<{ readonly repo: string }>) => {
    rows.set(name, [...rows.get(name)!, ...added])
    for (const listener of listeners) listener()
  }
  const layer = Layer.succeed(
    Host.PluginHost,
    Host.PluginHost.of({
      query: <R>(name: string, params?: Readonly<Record<string, string>>) =>
        refused.includes(name)
          ? Effect.fail(new Host.PluginRefused({ plugin: "fleet", reason: "invalid_fields", detail: name }))
          : Effect.sync(() => {
            asked.push({ query: name, params })
            return {
              current: () => rows.get(name)!.filter((row) => row.repo === params?.repo) as unknown as ReadonlyArray<R>,
              subscribe: (listener: () => void) => {
                listeners.add(listener)
                return () => void listeners.delete(listener)
              },
              ...(name === FLEET_NODES ? { availability: () => source.availability } : {}),
            }
          }),
      select: () => Effect.void,
      propose: () => Effect.void,
      dispatch: () => Effect.die("unused"),
      open: (view, repository) => Effect.sync(() => void asked.push({ open: view, repository })),
      events: () => Stream.empty,
    }),
  )
  return { layer, push, asked, listeners, say }
}

const withTab = <A>(host: ReturnType<typeof hostWith>, body: (built: Effect.Success<typeof tab>) => Promise<A>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(tab, (built) => Effect.promise(() => body(built)))).pipe(Effect.provide(host.layer)))

describe("the fleet's tab", () => {
  test("a repository's runs and machines, live, asked once with the repository lowercased; its link and open", async () => {
    const host = hostWith()
    await withTab(host, async (built) => {
      const runs = built.queries.runs(widgets)
      expect(built.queries.runs(widgets)).toBe(runs)
      await vi.waitFor(() => expect(runs.current()).toEqual({ _tag: "Ready", rows: [] }))
      host.push(RUNS, { repo: "acme/widgets" }, { repo: "octo/other" })
      expect(runs.current()).toEqual({ _tag: "Ready", rows: [{ repo: "acme/widgets" }] })
      const machines = built.queries.machines(widgets)
      host.push(MACHINES, { repo: "acme/widgets" })
      await vi.waitFor(() => expect(machines.current()).toEqual({ _tag: "Ready", rows: [{ repo: "acme/widgets" }] }))
      expect(host.asked.filter((each) => (each as { query?: string }).query !== undefined)).toEqual([
        { query: RUNS, params: { repo: "acme/widgets" } },
        { query: MACHINES, params: { repo: "acme/widgets" } },
      ])
      expect(built.actions.href(widgets)).toBe("/Acme/Widgets/-/fleet")
      built.actions.open(widgets)
      await vi.waitFor(() => expect(host.asked).toContainEqual({ open: "fleet/runs", repository: widgets }))
    })
    // The tab's scope closed: it follows nothing any more.
    expect(host.listeners.size).toBe(0)
  })

  test("a query the host refuses says so", async () => {
    await withTab(hostWith([MACHINES]), async (built) => {
      await vi.waitFor(() =>
        expect(built.queries.machines(widgets).current()).toEqual({ _tag: "Refused", reason: "invalid_fields" })
      )
    })
  })

  // Astra-D4-031: `Loading` and a withheld source both read as `Ready` with no rows, drawn "No hosts connected".
  test("a deployment-wide source is ready only once it delivered: loading and withheld rows are never no rows", async () => {
    const host = hostWith()
    await withTab(host, async (built) => {
      const nodes = built.queries.globalNodes()
      expect(built.queries.globalNodes()).toBe(nodes)
      await vi.waitFor(() => expect(host.listeners.size).toBe(1))
      // The first snapshot hasn't arrived.
      expect(nodes.current()).toEqual({ _tag: "Loading" })
      host.say("unavailable")
      expect(nodes.current()).toEqual({ _tag: "Refused", reason: "unavailable" })
      // Delivered, and holding nothing: the one state that is an empty fleet.
      host.say("ready")
      expect(nodes.current()).toEqual({ _tag: "Ready", rows: [] })
      host.say("unavailable")
      expect(nodes.current()).toEqual({ _tag: "Refused", reason: "unavailable" })
    })
  })

  // Neon-D4-014: the session filters are the tab's own state, read and written through it, never React's.
  test("the session filters start at active defaults, and each action changes its own facet and tells the view", async () => {
    await withTab(hostWith(), async (built) => {
      const filters = built.queries.filters
      expect(filters.current()).toEqual(DEFAULT_SESSION_FILTERS)
      expect(filters.current()).toEqual({
        host: ALL,
        harness: ALL,
        project: ALL,
        status: ACTIVE_STATUS,
        query: "",
        selectedSessionKey: null,
      })
      let told = 0
      const stop = filters.subscribe(() => { told++ })
      built.actions.filterHost("host-1")
      expect(filters.current()).toMatchObject({ host: "host-1", harness: ALL, project: ALL, status: ACTIVE_STATUS })
      built.actions.filterHarness("runner")
      expect(filters.current()).toMatchObject({ host: "host-1", harness: "runner" })
      built.actions.filterProject("smithersai/smithers")
      expect(filters.current()).toMatchObject({ project: "smithersai/smithers" })
      built.actions.filterStatus("idle")
      expect(filters.current()).toMatchObject({ status: "idle" })
      built.actions.filterQuery("electric")
      expect(filters.current()).toMatchObject({ query: "electric" })
      built.actions.selectSession("mbp:claude:1")
      expect(filters.current()).toMatchObject({ selectedSessionKey: "mbp:claude:1" })
      built.actions.filterHost(ALL)
      expect(filters.current()).toMatchObject({ host: ALL, harness: "runner" })
      built.actions.resetFilters()
      expect(filters.current()).toEqual({
        ...DEFAULT_SESSION_FILTERS,
        selectedSessionKey: "mbp:claude:1",
      })
      built.actions.selectSession(null)
      expect(filters.current().selectedSessionKey).toBeNull()
      expect(told).toBe(9)
      stop()
    })
  })
})
