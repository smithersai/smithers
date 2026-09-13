import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createTabsController } from "./tabs"
import type { ControllerContext } from "./context"

test("renderer boot preserves terminal/harness tabs, session identity and selected tab", async () => {
  const storage = memoryStorage()
  const first = await createAppStore({ kind: "localStorage", storage })
  for (const tab of [
    { id: "terminal", sessionId: "terminal", kind: "terminal", title: "Terminal", cwd: "~" },
    { id: "agent", sessionId: "agent", kind: "harness", harnessId: "codex", title: "Agent", cwd: "~" }
  ] as const) await first.dispatch({ type: "tab.opened", actor: "user", tab }).isPersisted.promise
  await first.dispatch({ type: "tab.close.asked", actor: "user", id: "agent" }).isPersisted.promise
  const reopened = await createAppStore({ kind: "localStorage", storage })
  expect(reopened.collections.tabs.get("terminal")).toMatchObject({ sessionId: "terminal", kind: "terminal" })
  expect(reopened.collections.tabs.get("agent")).toMatchObject({ sessionId: "agent", kind: "harness" })
  expect(reopened.session().activeTabId).toBe("agent")
  expect(reopened.session().pendingTabCloseId).toBeNull()
})

test("boot inventory restores unrecorded creates, retains exited tabs and never restarts missing sessions", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  for (const id of ["live", "exited", "missing"]) store.dispatch({
    type: "tab.opened", actor: "user", tab: { id, kind: "terminal", sessionId: id, title: id, cwd: "~" }
  })
  const requests: string[] = []
  const ctx = {
    store, baseUrl: "", commandActor: "system",
    boundedFetch: async (path: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${path}`)
      return Response.json(path === "/api/repos" ? { repos: [] } : { sessions: [
        { sessionId: "live", kind: "terminal", cwd: "/home", pid: 42, alive: true },
        { sessionId: "exited", kind: "terminal", cwd: "/home", pid: 43, alive: false, exitCode: 9 },
        { sessionId: "orphan", kind: "harness", harnessId: "codex", cwd: "/home", pid: 44, alive: true }
      ] })
    }
  } as unknown as ControllerContext
  await createTabsController(ctx).loadRepos()
  expect(store.collections.tabs.get("live")).not.toHaveProperty("exitCode")
  expect(store.collections.tabs.get("exited")).toMatchObject({ exitCode: 9 })
  expect(store.collections.tabs.get("missing")).toMatchObject({ exitCode: null })
  expect(store.collections.tabs.get("orphan")).toMatchObject({ kind: "harness", sessionId: "orphan" })
  expect(store.session().activeTabId).toBe("missing")
  expect(requests).toEqual(["GET /api/repos", "GET /api/pty"])
})
