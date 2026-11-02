import { dom } from "./fixtures/dom"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Deferred, Effect, Stream } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { Branch } from "../src/features/branch/branch"
import { BranchProvider } from "../src/features/branch/components/BranchContext"
import { Chat } from "../src/features/chat/chat"
import { BranchPendingScreen } from "../src/screens/branch/BranchPendingScreen"
import { openTestApp } from "../src/test/chatApi"
import { FileTabsBar } from "../src/features/files/components/FileTabsBar"
import { FilesProvider } from "../src/features/files/components/FilesContext"
import { FilesStore } from "../src/features/files/store"
import { RepoStore } from "../src/features/repo/store"
import { RepoProvider } from "../src/features/repo/components/RepoContext"
import { nodeDevice } from "../src/test/chatApi"
import { openTab } from "../src/test/repoDevice"
import { testFile } from "../worker/test/harness"
import { repoHarness } from "../worker/test/repos"

Object.assign(globalThis, { self: dom, scrollTo: dom.scrollTo.bind(dom) })
afterAll(() => dom.happyDOM.close())
const server = testFile("files_navigation")
const base = "/octocat/Spoon-Knife/blob/main/"

test("persisted keyboard close survives the real repository route reopening", async ({ signal }) => {
  const h = await repoHarness(server)
  await h.seed("octocat", "Spoon-Knife")
  const device = nodeDevice()
  const host = { ...device.persistence!, coordinator: undefined }
  let write: Promise<void> | undefined
  let releaseWrite: (() => void) | undefined
  let entered = false
  let signalWriteEntered = () => {}
  const writeEntered = new Promise<void>((resolve) => { signalWriteEntered = resolve })
  const persistence = Persistence.layer({ ...host, open: async () => {
    const database = await host.open()
    return { ...database, execute: async <T>(sql: string, params?: ReadonlyArray<unknown>) => {
      if (write !== undefined) { entered = true; signalWriteEntered(); await write }
      return database.execute<T>(sql, params)
    } }
  } })
  let navigate: (path: string) => void = () => { throw new Error("router not ready") }
  const followerEntered = await Effect.runPromise(Deferred.make<void>())
  const followerReleased = await Effect.runPromise(Deferred.make<void>())
  let heldFollower = true
  const fileFollower = Effect.suspend(() => heldFollower
    ? Deferred.succeed(followerEntered, undefined).pipe(Effect.andThen(Deferred.await(followerReleased)))
    : Effect.void)
  const tab = await openTab({ origin: h.origin, fetch: h.fetch, persistence, fileFollower, navigate: (path) => navigate(path) })
  const store = await tab.runtime.runPromise(Effect.service(FilesStore))
  const repoStore = await tab.runtime.runPromise(Effect.service(RepoStore))
  const app = openTestApp({ sessionLifecycle: false })
  const chat = await app.runPromise(Effect.service(Chat))
  const branch = await app.runPromise(Effect.service(Branch))
  let releaseNavigation: (() => void) | undefined
  let navigation: Promise<void> | undefined
  const errors: Array<unknown> = []
  const container = document.createElement("div")
  document.body.append(container)
  const view = createRoot(container)
  try {
    await tab.runtime.runPromise(store.tabs.restored)
    for (const [path, L] of [["README.md", undefined], ["src/index.ts", "2-4"]] as const) {
      tab.repo.actions.openRoute("blob", { owner: "octocat", repo: "Spoon-Knife", ref: "main", _splat: path }, { L })
      // The route resolves before its independent tab follower runs. Await each collection's real receipt;
      // vi.waitFor's default one-second poll is no budget for admission, sync and SQLite under suite load.
      await tab.runtime.runPromise(repoStore.view.changes({ initial: true }).pipe(
        Stream.filter((changes) => changes.some((change) => change.value.revision === "main" && change.value.path === path)),
        Stream.runHead,
      ), { signal })
      if (heldFollower) {
        await Effect.runPromise(Deferred.await(followerEntered), { signal })
        // The resolved route is real while the independent file follower is still held: a view receipt alone is insufficient.
        expect(tab.tabs()).toEqual([])
        heldFollower = false
        await Effect.runPromise(Deferred.succeed(followerReleased, undefined))
      }
      await tab.runtime.runPromise(store.tabs.changes({ initial: true }).pipe(
        Stream.filter((changes) => changes.some((change) => change.value.path === path)),
        Stream.runHead,
      ), { signal })
      expect(tab.view().view).toMatchObject({ revision: "main", path })
      expect(tab.tabs().some((row) => row.path === path)).toBe(true)
    }
    const root = createRootRoute()
    const route = createRoute({
      getParentRoute: () => root,
      path: "/$owner/$repo/blob/$ref/$",
      beforeLoad: async ({ params, search, location }) => {
        tab.at(location.pathname)
        await tab.repo.actions.warmRoute("blob", params, search)
        await navigation
        tab.repo.actions.openRoute("blob", params, search)
      },
      validateSearch: (search) => ({ L: typeof search.L === "string" ? search.L : undefined }),
      component: FileTabsBar,
      pendingComponent: BranchPendingScreen,
    })
    const router = createRouter({ isServer: false, routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`${base}README.md`] }), defaultPendingMs: 1_000, defaultPendingMinMs: 0, defaultOnCatch: (error) => errors.push(error) })
    navigate = (href) => { void router.navigate({ href }) }
    await act(async () => {
      await router.load()
      view.render(createElement(RepoProvider, { value: tab.repo }, createElement(FilesProvider, { value: tab.files }, createElement(ChatProvider, { value: chat }, createElement(BranchProvider, { value: branch }, createElement(RouterProvider, { router }))))))
    })
    const readme = container.querySelector<HTMLElement>('[role=tab]')!
    readme.focus()
    const remaining = container.querySelectorAll<HTMLElement>('[role=tab]')[1]!
    write = new Promise<void>((resolve) => { releaseWrite = resolve })
    await act(async () => { readme.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })) })
    // A real durable dispatch may still be admitting after vi.waitFor's default one second.
    // Synchronize on SQLite reaching the held write; never navigate before its persistence receipt.
    await Effect.runPromise(Effect.promise(() => writeEntered).pipe(Effect.timeout("10 seconds")))
    expect(entered).toBe(true)
    expect(tab.lines("files.focus").map((line) => ({ phase: line.annotations.phase, reason: line.annotations.reason }))).toEqual([
      { phase: "requested", reason: "keyboard" }, { phase: "consumed", reason: "keyboard" },
    ])
    expect(device.stored("file-tabs")).toBe(2)
    expect(router.state.location.pathname).toBe(`${base}README.md`)
    navigation = new Promise<void>((resolve) => { releaseNavigation = resolve })
    await act(async () => { write = undefined; releaseWrite!() })
    // The real shared pending screen must render for a blob route, without
    // throwing and replacing the Suspense subtree (production's invariant).
    await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector("header")).not.toBeNull() }, { timeout: 3000 })
    await act(async () => { releaseNavigation!() })
    await vi.waitFor(() => expect(router.state.location.href).toBe(`${base}src/index.ts?L=2-4`))
    await vi.waitFor(() => expect(container.querySelectorAll('[role=tab]')).toHaveLength(1))
    expect(device.stored("file-tabs")).toBe(1)
    expect(container.querySelector('[role=tab]')).toBe(remaining)
    expect(document.activeElement).toBe(remaining)
    expect(tab.lines("files.focus").map((line) => ({ phase: line.annotations.phase, reason: line.annotations.reason }))).toContainEqual({ phase: "dropped", reason: "disconnected" })
    expect(errors).toEqual([])
  } finally {
    await Effect.runPromise(Deferred.succeed(followerReleased, undefined))
    write = undefined; releaseWrite?.(); releaseNavigation?.()
    await act(async () => view.unmount())
    container.remove()
    await tab.dispose()
    await app.dispose()
  }
})
