// The fleet's tab (plugins/fleet/src/tab.ts) over an injected host (TEST-7) whose queries answer the rows a test pushes,
// kept to the repository asked, as the core keeps them (src/plugins/plugins.ts, `queryOf`).
import { Host } from "@smthrs/plugin"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, test, vi } from "vitest"
import { MACHINES, RUNS, tab } from "./tab"

const widgets = { owner: "Acme", name: "Widgets" }

const hostWith = (refused: ReadonlyArray<string> = []) => {
  const rows = new Map<string, Array<{ readonly repo: string }>>([[RUNS, []], [MACHINES, []]])
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
            }
          }),
      select: () => Effect.void,
      propose: () => Effect.void,
      dispatch: () => Effect.die("unused"),
      open: (view, repository) => Effect.sync(() => void asked.push({ open: view, repository })),
      events: () => Stream.empty,
    }),
  )
  return { layer, push, asked, listeners }
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
})
