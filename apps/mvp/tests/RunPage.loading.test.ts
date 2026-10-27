import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { ShapeSource } from "@smthrs/effect-electric"
import { Deferred, Effect, Layer } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { ACTIONS_SHAPE_ROUTE } from "../src/features/actions/contract"
import { REMOTE_RUN_SHAPE_ROUTE } from "../src/features/runs/contract"
import { RemoteRunsClient } from "../src/features/runs/api"
import { RunsProvider } from "../src/features/runs/components/RunsContext"
import { Repo } from "../src/features/repo/repo"
import { Runs } from "../src/features/runs/runs"
import type { Inspection } from "../src/features/runs/schema"
import { ActionRunScreen } from "../src/screens/actions/ActionRunScreen"
import { nodeDevice, openTab, openTestApp, TestChatApi } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  ResizeObserver: dom.ResizeObserver,
})
afterAll(() => dom.happyDOM.close())

// Real repository list and run, Postgres, Electric, collections, React and the production route's beforeLoad.
// Faulty inspection and shape services independently hold their real answers until explicitly released.
test("a reloaded run shows its frame and persisted header within five seconds while inspection and sync are held, then fills live", async () => {
  const server = openTestApp()
  const api = await server.runPromise(Effect.service(TestChatApi))
  const pending = Effect.runSync(Deferred.make<void>())
  const requested = Effect.runSync(Deferred.make<void>())
  const shapePending = Effect.runSync(Deferred.make<void>())
  const shapeRequested = Effect.runSync(Deferred.make<void>())
  const shapeSource = await server.runPromise(Effect.service(ShapeSource.ShapeSource))
  const source = await server.runPromise(Effect.service(RemoteRunsClient))
  const host = nodeDevice()
  const seed = openTab(api, { host })
  const device = openTab(api, { host, replace: Layer.mergeAll(Layer.succeed(ShapeSource.ShapeSource, { ...shapeSource,
    request: (url, init) => Effect.gen(function* () {
      if ([REMOTE_RUN_SHAPE_ROUTE, ACTIONS_SHAPE_ROUTE].includes(new URL(url).pathname)) {
        yield* Deferred.succeed(shapeRequested, undefined)
        yield* Deferred.await(shapePending)
      }
      return yield* shapeSource.request(url, init)
    }),
  }), Layer.succeed(RemoteRunsClient, { ...source,
    inspect: (id, options) => Effect.gen(function* () {
      yield* Deferred.succeed(requested, undefined)
      yield* Deferred.await(pending)
      return yield* source.inspect(id, options)
    }),
  })) })
  const container = document.createElement("div")
  document.body.append(container)
  const view = createRoot(container)
  const runId = await Effect.runPromise(api.remote.repoRun("ci"))
  await Effect.runPromise(api.remote.start(runId, { label: "visible", pauseMs: 0, hold: true }))
  try {
    await Effect.runPromise(api.remote.ready(runId))
    const seedRuns = await seed.runPromise(Effect.service(Runs))
    // Seed through the same repository authority read as the production route.
    await (await seed.runPromise(Effect.service(Repo))).actions.role("octo", "hello")
    seedRuns.queries.repoRuns.startSyncImmediate()
    await seedRuns.actions.openRepoRuns("octo", "hello")
    await vi.waitFor(() => expect(host.stored("repo-runs:octo/hello")).toBe(1), { timeout: 30_000 })
    await seed.dispose()
    // This fresh tab opens the deep link directly; it never visits the repository list.
    const runs = await device.runPromise(Effect.service(Runs))
    // Every repository route asks who the person is on its repository (router.tsx `enterRepo`, decision 0079).
    const repo = await device.runPromise(Effect.service(Repo))
    const { router: appRouter } = await import("../src/router")
    const root = createRootRoute({ component: Outlet })
    const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/actions/runs/$runId", component: ActionRunScreen,
      beforeLoad: appRouter.routesById["/$owner/$repo/actions/runs/$runId"].options.beforeLoad,
    })
    const router = createRouter({ isServer: false, routeTree: root.addChildren([route]),
      context: { runs, repo }, history: createMemoryHistory({ initialEntries: [`/octo/hello/actions/runs/${encodeURIComponent(runId)}`] }),
    })
    let loaded = false
    const startedAt = performance.now()
    const loading = router.load().then(() => { loaded = true })
    act(() => { view.render(createElement(RunsProvider, { value: runs }, createElement(RouterProvider, { router }))) })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(Effect.runSync(Deferred.isDone(requested))).toBe(true)
      expect(Effect.runSync(Deferred.isDone(shapeRequested))).toBe(true)
      expect(loaded).toBe(true)
      expect(container.querySelector('main[aria-label="Run"]')).not.toBeNull()
      expect(container.querySelector("h1")?.textContent).toBe("ci")
      expect(container.querySelector('a')?.textContent).toBe("Runs")
      expect(router.state.status).toBe("idle")
    }, { timeout: 5_000, interval: 10 })
    expect(performance.now() - startedAt).toBeLessThan(5_000)
    expect(Effect.runSync(Deferred.isDone(pending))).toBe(false)
    await Effect.runPromise(Deferred.succeed(pending, undefined))
    await loading
    await vi.waitFor(async () => {
      await act(async () => {})
      const page = runs.queries.page.toArray[0]?.page
      expect(page?.state).toBe("read")
      expect((page?.inspection as Inspection).run.runId).toBe(runId)
      expect(container.textContent).toContain("Steps")
    }, { timeout: 30_000 })
    expect(Effect.runSync(Deferred.isDone(shapePending))).toBe(false)
    await Effect.runPromise(Deferred.succeed(shapePending, undefined))
    await Effect.runPromise(api.remote.release(runId))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect((runs.queries.page.toArray[0]?.page.inspection as Inspection)?.run.status).toBe("completed")
    }, { timeout: 30_000 })
  } finally {
    await Effect.runPromise(Deferred.succeed(pending, undefined))
    await Effect.runPromise(Deferred.succeed(shapePending, undefined))
    await act(async () => view.unmount())
    container.remove()
    await device.dispose()
    await seed.dispose()
    await Effect.runPromise(api.remote.release(runId))
    await server.dispose()
  }
}, 90_000)
