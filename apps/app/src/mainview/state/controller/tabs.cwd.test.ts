import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Harness, Repo } from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { createTabsController } from "./tabs"

/*
 * Regression: a Claude Code tab launched with no repository open started in
 * `~` and its tab read "Claude Code" as if it sat in the repository. The
 * PTY request carries the open repository's id so the server starts the
 * process there, and the tab's title names where it actually runs.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const repo: Repo = {
  id: "repo-1",
  path: "/Users/u/smithers",
  name: "smithers",
  git: { branch: "main", remote: null },
  warnings: [],
  smithers: { detected: true, workspaceFile: null, declarationFiles: [], reason: "", workspaces: [] }
}

const claude: Harness = {
  id: "claude",
  displayName: "Claude Code",
  binary: "/usr/local/bin/claude",
  version: "1.0.0",
  status: "signed-in",
  account: { email: "will@example.com" },
  launch: { argv: ["claude"] }
}

const setup = async (deleteSession?: (url: string) => Promise<Response>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const bodies: Array<Record<string, unknown>> = []
  let next = 0
  const ctx = {
    store,
    commandActor: "user",
    baseUrl: "http://local",
    boundedFetch: async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && deleteSession !== undefined) return deleteSession(_url)
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      next += 1
      return new Response(JSON.stringify({ sessionId: `pty-${next}` }), { status: 200 })
    },
    errorMessageOf: async (_response: Response, fallback: string) => fallback,
    unref: () => {}
  } as unknown as ControllerContext
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [claude] })
  return { store, ctx, bodies, tabs: createTabsController(ctx) }
}

describe("where a process tab runs", () => {
  test("with no repository open the request carries no repoId and the tab says ~", async () => {
    const { store, bodies, tabs } = await setup()
    await tabs.openTerminalTab()
    await tabs.openHarnessTab("claude")
    expect(bodies.map((body) => body.repoId)).toEqual([undefined, undefined])
    expect(store.collections.tabs.get("pty-1")).toMatchObject({ kind: "terminal", title: "Terminal · ~", cwd: "~" })
    expect(store.collections.tabs.get("pty-2")).toMatchObject({ kind: "harness", title: "Claude Code · ~", cwd: "~" })
  })

  test("with a repository open the request carries its repoId and the tab names it", async () => {
    const { store, bodies, tabs } = await setup()
    store.dispatch({ type: "repos.loaded", actor: "system", repos: [repo] })
    await tabs.openTerminalTab()
    await tabs.openHarnessTab("claude")
    expect(bodies.map((body) => body.repoId)).toEqual(["repo-1", "repo-1"])
    expect(store.collections.tabs.get("pty-1")).toMatchObject({ title: "Terminal · smithers", cwd: "/Users/u/smithers" })
    expect(store.collections.tabs.get("pty-2")).toMatchObject({ title: "Claude Code · smithers", cwd: "/Users/u/smithers" })
  })
})

describe("closing a process tab", () => {
  for (const kind of ["terminal", "harness"] as const) {
    for (const failure of ["HTTP 500", "transport error"] as const) {
      test(`${kind}: ${failure} preserves the tab and confirmation for a retry`, async () => {
        const urls: string[] = []
        const { store, tabs } = await setup(async (url) => {
          urls.push(url)
          if (urls.length > 1) return new Response(null, { status: 204 })
          if (failure === "transport error") throw new Error("connection lost")
          return new Response(null, { status: 500 })
        })
        if (kind === "terminal") await tabs.openTerminalTab()
        else await tabs.openHarnessTab("claude")
        await tabs.closeTab("pty-1")
        expect(urls).toHaveLength(0)
        const error = await tabs.confirmTabClose()
        expect(store.collections.tabs.has("pty-1")).toBe(true)
        expect(store.session().pendingTabCloseId).toBe("pty-1")
        expect(store.session().activeTabId).toBe("pty-1")
        expect(error).toContain("Could not terminate")
        expect(error).toContain(failure === "HTTP 500" ? "500" : "connection lost")
        expect(error).toContain("close again to retry")
        expect(await tabs.confirmTabClose()).toBeUndefined()
        expect(urls).toEqual(["http://local/api/pty/pty-1", "http://local/api/pty/pty-1"])
        expect(store.collections.tabs.has("pty-1")).toBe(false)
        expect(store.session().pendingTabCloseId).toBeNull()
      })
    }

    test(`${kind}: an exited session retries cleanup and accepts confirmed absence`, async () => {
      let attempts = 0
      const { store, tabs } = await setup(async () => new Response(null, { status: ++attempts === 1 ? 500 : 404 }))
      if (kind === "terminal") await tabs.openTerminalTab()
      else await tabs.openHarnessTab("claude")
      tabs.notePtyExit("pty-1", 0)
      const error = await tabs.closeTab("pty-1")
      expect(store.collections.tabs.has("pty-1")).toBe(true)
      expect(error).toContain("Could not terminate")
      expect(await tabs.closeTab("pty-1")).toBeUndefined()
      expect(attempts).toBe(2)
      expect(store.collections.tabs.has("pty-1")).toBe(false)
    })
  }

  test("a cloud terminal detaches without deleting its session", async () => {
    let attempts = 0
    const { store, tabs } = await setup(async () => {
      attempts += 1
      throw new Error("must not delete a cloud session")
    })
    store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "cloud", kind: "terminal", title: "Cloud terminal", sessionId: "cloud-session", workspaceId: "workspace-1" }
    })
    await tabs.closeTab("cloud")
    expect(await tabs.confirmTabClose()).toBeUndefined()
    expect(attempts).toBe(0)
    expect(store.collections.tabs.has("cloud")).toBe(false)
  })
})
