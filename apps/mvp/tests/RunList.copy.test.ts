import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useSearch } from "@tanstack/react-router"
import { Effect, Layer, ManagedRuntime } from "effect"
import { act, createElement, Fragment } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { RunsProvider } from "../src/features/runs/components/RunsContext"
import { FlowSummaryView } from "../src/features/runs/components/FlowSummaryView"
import { RunListView } from "../src/features/runs/components/RunListView"
import { runsSearch } from "../src/features/runs/page"
import { RunsNavigation } from "../src/features/runs/actions"
import { Runs } from "../src/features/runs/runs"
import { RunsStore } from "../src/features/runs/store"
import { VIEW } from "../src/features/runs/schema"
import { openTab, openTestApp, TestChatApi } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
afterAll(() => dom.happyDOM.close())

test("run tables render product words, precise durations, filtering and expansion from real collections", async () => {
  const server = openTestApp()
  const api = await server.runPromise(Effect.service(TestChatApi))
  const device = openTab(api)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let close = async () => {}
  try {
    // Build the actual run store and actions over this device's real services.
    const runtime = ManagedRuntime.make(Runs.layer.pipe(
      Layer.provideMerge(RunsStore.layer({ origin: api.origin })),
      Layer.provide(Layer.succeed(RunsNavigation, { navigate: (path) => { void router.navigate({ to: path as never }) } })),
      Layer.provide(Layer.succeedContext(await device.context())),
    ))
    close = () => runtime.dispose()
    const runs = await runtime.runPromise(Effect.service(Runs))
    const store = await runtime.runPromise(Effect.service(RunsStore))
    const routeRoot = createRootRoute({ component: Outlet })
    const route = createRoute({ getParentRoute: () => routeRoot, path: "/app/runs", validateSearch: runsSearch,
      component: function Tables() {
        const search = useSearch({ from: "/app/runs" })
        return createElement(Fragment, null, createElement(FlowSummaryView, { flow: search.flow }), createElement(RunListView, search))
      },
    })
    const router = createRouter({ isServer: false, routeTree: routeRoot.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/app/runs"] }) })
    await router.load()
    await act(async () => root.render(createElement(RunsProvider, { value: runs }, createElement(RouterProvider, { router }))))
    expect(container.querySelector("table")).toBeNull()
    await device.runPromise(store.view.update(VIEW, (row) => { row.listLoaded = true; row.cloudLoaded = true }))
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("No runs yet") })
    await device.runPromise(store.runs.insert([
      { id: "ci-run", flow: "ci", status: "completed", cancelRequested: false, createdAtMs: 1000, startedAtMs: 1000, finishedAtMs: 2500, seq: 1 },
      { id: "custom", flow: "My flow", status: "running", cancelRequested: false, createdAtMs: 1001, startedAtMs: 1001, finishedAtMs: null, seq: 0 },
    ]))
    await device.runPromise(store.cloudRuns.insert({ runId: "todo:copy", kind: "todo", flow: "todo", status: "completed", cancelRequested: false,
      createdAtMs: 1000, startedAtMs: 1000, finishedAtMs: 2000, trigger: "commit", branch: "refs/heads/feature/a", actor: "you", repo: "octo/hello" }))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelectorAll('table[aria-label="Runs"] tbody tr')).toHaveLength(3)
      expect(container.textContent).toContain("CI")
      expect(container.textContent).toContain("TODO")
      expect(container.textContent).toContain("My flow")
      expect(container.textContent).toContain("Passed")
      expect(container.textContent).toContain("95% under")
      expect(container.textContent).toContain("Started by")
      expect(container.textContent).toContain("1.5 s")
      expect(container.textContent).toContain("feature/a")
      expect(container.textContent).not.toContain("Cloud")
      expect(container.textContent).not.toContain("refs/heads/")
    })
    await act(async () => { await router.navigate({ to: "/app/runs", search: { flow: "ci", open: "ci-run" } }) })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector('[aria-current="true"]')?.textContent).toContain("CI")
      expect(container.querySelector('[data-run-details="ci-run"]')).not.toBeNull()
    })
    await act(async () => { await router.navigate({ to: "/app/runs", search: { flow: "missing" } }) })
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("No runs yet") })
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await close()
    await device.dispose()
    await server.dispose()
  }
}, 60_000)
