import { dom } from "./fixtures/dom"
import { Deferred, Effect, Layer } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { RemoteRunsClient, RepoRunsFailed } from "../src/features/runs/api"
import { REFUSAL_WORDS } from "../src/features/runs/contract"
import { RepoFlowsView } from "../src/features/runs/components/RepoFlowsView"
import { RunsProvider } from "../src/features/runs/components/RunsContext"
import { Runs } from "../src/features/runs/runs"
import { FORM } from "../src/features/runs/schema"
import { RunsStore } from "../src/features/runs/store"
import { openTab, openTestApp, TestChatApi } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, customElements: dom.customElements, scrollTo: dom.scrollTo.bind(dom) })
afterAll(() => dom.happyDOM.close())

test.each(["unavailable", "rate_limited"] as const)("the Run card shows %s and retries its initial flow read", async (code) => {
  const server = openTestApp()
  const api = await server.runPromise(Effect.service(TestChatApi))
  const source = await server.runPromise(Effect.service(RemoteRunsClient))
  const retryRequested = Effect.runSync(Deferred.make<void>())
  const releaseRetry = Effect.runSync(Deferred.make<void>())
  let reads = 0
  // Only the flow-list read is faulty. Retrying holds its answer to expose the loading state.
  const device = openTab(api, { replace: Layer.succeed(RemoteRunsClient, { ...source,
    flows: () => Effect.gen(function* () {
      if (++reads > 1) {
        yield* Deferred.succeed(retryRequested, undefined)
        yield* Deferred.await(releaseRetry)
      }
      return yield* new RepoRunsFailed({ status: code === "unavailable" ? 503 : 429, code })
    }),
  }) })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    const { runs, store } = await device.runPromise(Effect.all({ runs: Effect.service(Runs), store: Effect.service(RunsStore) }))
    await act(async () => root.render(createElement(RunsProvider, { value: runs }, createElement(RepoFlowsView))))
    expect(container.querySelector(".repo-flows")).toBeNull()
    await device.runPromise(store.loadRepoFlows({ owner: "octo", name: "hello" }))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(REFUSAL_WORDS[code])
      expect(container.querySelector("button")?.textContent).toBe("Retry")
    })
    await act(async () => container.querySelector("button")!.click())
    await device.runPromise(Deferred.await(retryRequested))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector('.repo-flows[aria-busy="true"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(container.querySelector("button")).toBeNull()
    })
    expect(reads).toBe(2)
    await device.runPromise(Deferred.succeed(releaseRetry, undefined))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(REFUSAL_WORDS[code])
      expect(container.querySelector("button")?.textContent).toBe("Retry")
    })
    // Successful empty results hide the card; a populated result keeps its existing controls.
    await device.runPromise(store.form.update(FORM, (form) => { form.state = "ready"; form.refusal = null }))
    await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector(".repo-flows")).toBeNull() })
    await device.runPromise(store.form.update(FORM, (form) => { form.flows = [{ name: "ci", title: "CI" }] }))
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector("button")?.textContent).toBe("CI")
      expect(container.querySelector('[role="alert"]')).toBeNull()
    })
  } finally {
    await device.runPromise(Deferred.succeed(releaseRetry, undefined))
    await act(async () => root.unmount())
    container.remove()
    await device.dispose()
    await server.dispose()
  }
}, 60_000)
