import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import * as SmithersUi from "@smthrs/ui"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { openRequestedRepo } from "../RepoLink"
import { DOWNLOAD_URL } from "@smthrs/rpc/AppLinks"

/** A native release as the door tests see it; the product's constant is null until one carries an asset. */
const RELEASE_URL = "https://example.test/download"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { Repo } from "@smthrs/rpc/LocalApp"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController as AppControllerType, AppServices } from "../state/AppController"
import { repoKeyOf } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"

/*
 * The `+` menu (docs/LOCAL-APP.md "Tabs").
 *
 * Regression: the menu used to render INSIDE `.tab-strip`, which scrolls
 * horizontally. An `overflow-x: auto` container computes `overflow-y: auto`
 * too and clips every absolutely-positioned descendant, so the open menu was
 * cut to the strip's 28px and painted nothing below it — the trigger read
 * aria-expanded="true" while the human saw no menu. happy-dom does no layout,
 * so the pin is structural: the menu's DOM ancestry must hold no overflow
 * container, i.e. it is not a descendant of the strip. The e2e spec pins the
 * paint with elementFromPoint.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const localHarness = async (services: AppServices = {}): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    ...services,
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    },
    // A terminal tab attaches the PTY client; nothing listens here, so no socket is opened.
    socketUrl: () => undefined
  })
  return { store, controller }
}

/** The Worker's shell (docs/web-mode/PLAN.md §1): host `cloud`, capabilities from the table the server calls. */
const cloudHarness = async (services: AppServices = {}): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
    ...services,
    bootstrap: {
      apiVersion: 1,
      host: "cloud",
      version: "test",
      buildSha: "cloud",
      capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
      authFlow: "redirect",
      sandbox: null
    },
    socketUrl: () => undefined
  })
  return { store, controller }
}

const mount = (controller: AppControllerType): { host: HTMLElement; act: (change: () => void) => Promise<void> } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return {
    host,
    act: async (change) => {
      flushSync(change)
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
  }
}

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

describe("the + menu", () => {
  test("New agent replaces the initiating menu and its blocking backdrop with the form", async () => {
    const { store, controller } = await localHarness({
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 404 })
    })
    const { host, act } = mount(controller)
    try {
      await act(() => host.querySelector<HTMLButtonElement>("[data-testid=tab-add]")?.click())
      expect(host.querySelector(".tab-add-backdrop")).not.toBeNull()
      await act(() => host.querySelector<HTMLButtonElement>("[data-testid=tab-add-new-agent]")?.click())
      for (let tick = 0; tick < 100 && !store.collections.cards.has("form-agent.create"); tick += 1) await act(() => {})
      await act(() => {})
      expect(host.querySelector("[data-testid=flow-form-submit]")).not.toBeNull()
      expect(host.querySelector("[data-testid=tab-add-menu]")).toBeNull()
      expect(host.querySelector(".tab-add-backdrop")).toBeNull()
      expect(store.session().tabMenuOpen).toBe(false)
    } finally { controller.dispose() }
  })

  test("opens outside the scrolling list: Terminal first, then the agents", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [
        {
          id: "claude",
          displayName: "Claude Code",
          binary: "/opt/homebrew/bin/claude",
          version: "2.1.0",
          status: "signed-in",
          account: { email: "will@codeplane.app" },
          launch: { argv: ["claude"] }
        },
        {
          id: "gemini",
          displayName: "Gemini",
          binary: null,
          version: null,
          status: "unavailable",
          account: null,
          launch: { argv: ["gemini"] }
        }
      ]
    })
    const { host, act } = mount(controller)
    const trigger = host.querySelector<HTMLButtonElement>("[data-testid=tab-add]")
    expect(trigger).not.toBeNull()
    // The trigger is a sibling of the strip, never inside it.
    expect(trigger?.closest(".tab-strip")).toBeNull()
    await act(() => trigger?.click())
    const menu = host.querySelector<HTMLElement>("[data-testid=tab-add-menu]")
    expect(menu).not.toBeNull()
    expect(menu?.closest(".tab-strip")).toBeNull()
    expect(trigger?.getAttribute("aria-expanded")).toBe("true")
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])]
    expect(items.map((item) => item.getAttribute("data-flow"))).toEqual([
      "tab.terminal",
      // The six named roles (AgentRoles.ts) lead the Agents section, then the raw harnesses.
      "agent.role",
      "agent.role",
      "agent.role",
      "agent.role",
      "agent.role",
      "agent.role",
      "tab.harness",
      "tab.harness",
      // Agents as data (custom-agents.md): the last row opens the New agent form card.
      "agent.new"
    ])
    expect(items[0]?.textContent).toBe("Terminal")
    expect(items.at(-1)?.getAttribute("data-testid")).toBe("tab-add-new-agent")
    expect(items.at(-1)?.textContent).toBe("New agent…")
    expect(host.querySelector("[data-testid=tab-add-agents]")?.textContent).toBe("Agents")
    // Six role rows sit between Terminal and the first raw harness.
    expect(items[1]?.textContent).toContain("Orchestrator · Fable 5")
    expect(items[7]?.textContent).toContain("Claude Code")
    // The explainer's harness (OpenCode · Kimi) is absent from this fixture: disabled, with the reason.
    expect(items[2]?.disabled).toBe(true)
    expect(items[2]?.textContent).toContain("not installed")
    // The unavailable raw harness stays last and disabled.
    expect(items[8]?.disabled).toBe(true)
    // One Smithers: the menu offers no second conversation, and no tab.chat flow exists to open one.
    expect(host.querySelector("[data-testid=tab-add-chat]")).toBeNull()
    expect(controller.commands.find("tab.chat")).toBeUndefined()
    // The three-door law: every flow this menu binds is the agent's too (the launches confirm).
    const callable = new Set(controller.commands.callable().map((entry) => entry.binding.descriptor.name))
    for (const name of ["tab.terminal", "agent.role", "tab.harness", "agent.new"]) expect(callable.has(name)).toBe(true)
    expect(controller.commands.find("tab.terminal")?.metadata.confirm).toBeUndefined()
    expect(controller.commands.find("agent.role")?.metadata.confirm).toBeDefined()
    expect(controller.commands.find("tab.harness")?.metadata.confirm).toBeDefined()
  })

  test("the sidebar is vertical: the workspace heading first, the sessions below it, the chrome at the bottom of every session", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
    })
    const { host } = mount(controller)
    const bar = host.querySelector<HTMLElement>(".chrome-bar")
    expect(bar?.tagName).toBe("ASIDE")
    expect(host.querySelector("[data-testid=tab-strip]")?.getAttribute("aria-orientation")).toBe("vertical")
    // No "Smithers" row: the heading is the workspace, and the sessions are the only rows of their kind.
    expect(host.querySelector("[data-testid=tab-main]")).toBeNull()
    const heading = host.querySelector<HTMLElement>("[data-testid=workspace-heading]")
    expect(heading?.parentElement?.getAttribute("data-testid")).toBe("tab-strip")
    expect(heading?.previousElementSibling).toBeNull()
    expect(host.querySelector("[data-testid=workspace-name]")?.textContent).toBe("Workspace")
    const tabs = [...host.querySelectorAll<HTMLElement>(".tab")]
    expect(tabs.map((tab) => tab.getAttribute("data-kind"))).toEqual(["terminal"])
    expect(tabs[0]?.querySelector("[data-testid=tab-close-t1]")).not.toBeNull()
    // The `+` follows the list, inside the sidebar, outside the scrolling strip.
    const add = host.querySelector<HTMLElement>("[data-testid=tab-add]")
    expect(add?.closest(".chrome-bar")).toBe(bar)
    expect(add?.closest(".tab-strip")).toBeNull()
    // The theme toggle (and admin reset when present) live in the sidebar, so a terminal tab still shows them.
    const theme = host.querySelector<HTMLElement>('[data-flow="appearance.dark-mode"]')
    expect(theme?.closest(".chrome-bar")).toBe(bar)
    expect(store.session().activeTabId).toBe("t1")
    expect(host.querySelector<HTMLElement>("[data-testid=tab-body-main]")?.hidden).toBe(true)
    expect(theme?.closest("[hidden]")).toBeNull()
    // Focus order: the chrome comes after the tabs.
    const order = [...host.querySelectorAll<HTMLElement>(".chrome-bar [data-flow]")].map((el) => el.getAttribute("data-flow"))
    expect(order.indexOf("appearance.dark-mode")).toBeGreaterThan(order.indexOf("tab.menu"))
  })
  test("ArrowDown and ArrowUp walk the vertical tablist and select the tab reached", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "main" })
    const { host, act } = mount(controller)
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")]
    tabs[0]?.focus()
    const press = (key: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })
    await press("ArrowDown")
    expect(document.activeElement).toBe(tabs[1] ?? null)
    expect(store.session().activeTabId).toBe("t1")
    await press("ArrowDown")
    expect(document.activeElement).toBe(tabs[0] ?? null)
    expect(store.session().activeTabId).toBe("main")
    await press("End")
    expect(document.activeElement).toBe(tabs[1] ?? null)
    await press("ArrowUp")
    expect(document.activeElement).toBe(tabs[0] ?? null)
    expect(store.session().activeTabId).toBe("main")
  })

  test("Escape minimizes a card maximized with the pointer: focus moves to the button that replaced the one pressed", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "card.upsert",
      actor: "system",
      card: {
        id: "status-1",
        kind: "status",
        title: "Status",
        status: "active",
        createdAt: 1,
        ordinal: 0,
        payload: { progress: 0.5 }
      }
    })
    const { host, act } = mount(controller)
    const maximize = host.querySelector<HTMLButtonElement>("[data-testid=card-maximize-status-1]")
    await act(() => maximize?.click())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(store.session().maximizedCardId).toBe("status-1")
    const minimize = host.querySelector<HTMLButtonElement>("[data-testid=card-minimize-status-1]")
    expect(document.activeElement).toBe(minimize ?? null)
    await act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    expect(store.session().maximizedCardId).toBeNull()
    // The pointer path back: minimize hands focus to the maximize button that replaces it.
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=card-maximize-status-1]")?.click())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=card-minimize-status-1]")?.click())
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    expect(store.session().maximizedCardId).toBeNull()
    expect(document.activeElement).toBe(host.querySelector("[data-testid=card-maximize-status-1]"))
  })
})

/*
 * The Repos section (docs/LOCAL-APP.md "Tabs"): Smithers first, then every
 * pinned repository with its tabs nested under it, the active one
 * highlighted, and "No repository" for tabs opened with nothing open.
 */
describe("the sidebar's Repos section", () => {
  const repo = (id: string, name: string, path: string) => ({
    id,
    path,
    name,
    git: { branch: "main", remote: null },
    smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
    warnings: []
  })

  test("no repository: one Select a repo row bound to repo.open, and nothing nests", async () => {
    const { controller } = await localHarness()
    const { host } = mount(controller)
    const section = host.querySelector<HTMLElement>("[data-testid=repo-section]")
    expect(section).not.toBeNull()
    expect(section?.closest(".tab-strip")).not.toBeNull()
    const empty = host.querySelector<HTMLButtonElement>("[data-testid=repo-empty]")
    expect(empty?.getAttribute("data-flow")).toBe("repo.open")
    expect(empty?.textContent).toBe("Select a repo")
    expect(host.querySelector("[data-testid=repo-none]")).toBeNull()
    // The workspace heading is the first row, above the section.
    const strip = host.querySelector<HTMLElement>("[data-testid=tab-strip]")
    expect(strip?.firstElementChild?.getAttribute("data-testid")).toBe("workspace-heading")
  })

  test("opening a repository pins it as the active row; tabs nest under their repository", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "repos.loaded",
      actor: "system",
      repos: [repo("r1", "smithers", "/Users/will/smithers"), repo("r2", "force", "/Users/will/force")]
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · smithers", sessionId: "t1", cwd: "/Users/will/smithers", repoKey: "local:/Users/will/smithers" }
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t2", kind: "terminal", title: "Terminal · ~", sessionId: "t2", cwd: "~" }
    })
    const { host, act } = mount(controller)
    expect(host.querySelector("[data-testid=repo-empty]")).toBeNull()
    const smithers = host.querySelector<HTMLElement>("[data-testid=repo-local\\:\\/Users\\/will\\/smithers]")
    const force = host.querySelector<HTMLElement>("[data-testid=repo-local\\:\\/Users\\/will\\/force]")
    // Both opened in one read, nothing named yet: the first by name is the active row.
    expect(force?.dataset.active).toBe("true")
    expect(smithers?.dataset.active).toBe("false")
    expect(force?.querySelector('[data-flow="repo.select"]')?.getAttribute("aria-current")).toBe("true")
    expect(smithers?.querySelector('[data-flow="repo.select"]')?.getAttribute("aria-current")).toBeNull()
    // The terminal opened in smithers nests under smithers; the one opened in ~ sits under "No repository".
    expect(smithers?.querySelector(".repo-tabs [data-testid=tab-t1]")).not.toBeNull()
    expect(force?.querySelector(".repo-tabs .tab")).toBeNull()
    expect(host.querySelector("[data-testid=repo-none] [data-testid=tab-t2]")).not.toBeNull()
    // Each repo row carries its own `+` (the same tab menu, scoped) and an unpin, both registered flows.
    expect(force?.querySelector('[data-flow="tab.menu"]')?.getAttribute("data-testid")).toBe("repo-add-local:/Users/will/force")
    expect(force?.querySelector('[data-flow="repo.unpin"]')).not.toBeNull()
    // Choosing the other row makes it the active one: the sidebar and the composer's selector agree.
    await act(() => smithers?.querySelector<HTMLButtonElement>('[data-flow="repo.select"]')?.click())
    expect(store.session().activeRepoKey).toBe("local:/Users/will/smithers")
    expect(smithers?.dataset.active).toBe("true")
    expect(force?.dataset.active).toBe("false")
    expect(host.querySelector("[data-testid=composer-repo-trigger]")?.textContent).toContain("smithers")
    // Unpinning the active row forgets it; its tab falls under "No repository" and the other row takes over.
    await act(() => smithers?.querySelector<HTMLButtonElement>('[data-flow="repo.unpin"]')?.click())
    expect(host.querySelector("[data-testid=repo-local\\:\\/Users\\/will\\/smithers]")).toBeNull()
    expect(store.collections.pinnedRepos.get("local:/Users/will/smithers")).toBeUndefined()
    expect(host.querySelector("[data-testid=repo-none] [data-testid=tab-t1]")).not.toBeNull()
    expect(host.querySelector("[data-testid=composer-repo-trigger]")?.textContent).toContain("force")
  })

  test("ArrowDown walks tabs across repo groups, selecting each one reached", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, { type: "repos.loaded", actor: "system", repos: [repo("r1", "smithers", "/Users/will/smithers")] })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · smithers", sessionId: "t1", cwd: "/Users/will/smithers", repoKey: "local:/Users/will/smithers" }
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t2", kind: "terminal", title: "Terminal · ~", sessionId: "t2", cwd: "~" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "main" })
    const { host, act } = mount(controller)
    const tabs = [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")]
    expect(tabs.map((tab) => tab.dataset.tabId)).toEqual(["main", "t1", "t2"])
    tabs[0]?.focus()
    const press = (key: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      })
    await press("ArrowDown")
    expect(store.session().activeTabId).toBe("t1")
    await press("ArrowDown")
    expect(store.session().activeTabId).toBe("t2")
    await press("ArrowDown")
    expect(store.session().activeTabId).toBe("main")
  })
})

/*
 * The piper tree (ADR 0001, lane piper step 3): the cloud inventory renders
 * `org/ → repo → working copies`; selecting a repo row names `org/repo`,
 * selecting a copy row names `org/repo#copyId`; a local checkout whose remote
 * parses into the inventory nests under its repository instead of standing
 * alone. No mirror glyph — the backend has no mirror status yet.
 */
describe("the sidebar's piper tree", () => {
  const repo = (id: string, name: string, path: string, remote: string | null) => ({
    id,
    path,
    name,
    git: { branch: "main", remote },
    smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
    warnings: []
  })

  test("cloud repositories group under their org; repo and copy rows select the piper grammar", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: { bookmark: "main", changeId: "qupxosqw", commitId: "abc123" } },
        { id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null }
      ]
    })
    await persisted(store, {
      type: "workingcopies.workspaces.loaded",
      actor: "system",
      copies: [{ id: "ws-1", repoId: "will/flows", kind: "workspace", label: "fix-landings", workspaceId: "ws-1", state: "running" }]
    })
    const { host, act } = mount(controller)
    // One org header per org, the repo rows beneath; no mirror glyph anywhere.
    expect(host.querySelector("[data-testid=repo-org-will]")?.textContent).toBe("will/")
    expect(host.querySelector("[data-testid=repo-org-smithersai]")?.textContent).toBe("smithersai/")
    expect(host.querySelector("[data-testid=repo-will\\/flows]")).not.toBeNull()
    expect(host.querySelector("[data-testid=repo-smithersai\\/smithers]")).not.toBeNull()
    // The workspace copy nests under its repo, labelled `label · state`.
    const copy = host.querySelector<HTMLElement>("[data-testid=copy-ws-1]")
    expect(copy?.textContent).toContain("fix-landings · running")
    // Selecting the repo row names org/repo; selecting the copy row names org/repo#copyId.
    await act(() => host.querySelector<HTMLButtonElement>('[data-testid="repo-select-will\\/flows"]')?.click())
    expect(store.session().activeRepoKey).toBe("will/flows")
    await act(() => copy?.querySelector<HTMLButtonElement>("[data-flow=\"repo.select\"]")?.click())
    expect(store.session().activeRepoKey).toBe("will/flows#ws-1")
  })

  test("a local checkout whose remote parses into the inventory nests as `label · N ahead`", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: { bookmark: "main", changeId: "qp", commitId: "c1" } }
      ]
    })
    await persisted(store, {
      type: "repos.loaded",
      actor: "system",
      repos: [{
        ...repo("r1", "smithers", "/Users/will/smithers", "git@github.com:smithersai/smithers.git"),
        jj: { changeId: "kxyz", commitId: "deadbeef", ahead: 3, bookmark: "main" }
      }]
    })
    const { host } = mount(controller)
    // Not a standalone row: the checkout nests under smithersai/smithers with its ahead count.
    expect(host.querySelector("[data-testid=repo-local\\:\\/Users\\/will\\/smithers]")).toBeNull()
    const copy = host.querySelector<HTMLElement>("[data-testid=copy-local\\:\\/Users\\/will\\/smithers]")
    expect(copy).not.toBeNull()
    expect(copy?.textContent).toContain("smithers · 3 ahead")
    expect(copy?.closest("[data-testid=repo-smithersai\\/smithers]")).not.toBeNull()
  })
})

/*
 * The sidebar as a file tree (docs/workbench-lanes/sidebar-tree.md): a local
 * copy's caret expands its ROOT through the same route the files flows use,
 * one directory per fetch; the tree renders exactly what the route answered
 * (a `.git` entry like any other, the capped listing's truncated line, an
 * error verbatim, "empty" for nothing); a file click renders the existing
 * file card in the chat through files.read (THE EMBED LAW).
 */
describe("the sidebar's file tree", () => {
  const SMITHERS: Repo = {
    id: "repo-smithers",
    path: "/Users/will/smithers",
    name: "smithersai/smithers",
    git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
    warnings: [],
    smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: "smithers" }] }
  }
  const COPY = repoKeyOf(SMITHERS.path)
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  const treeHarness = async () => {
    const requests: Array<{ readonly repoId?: string; readonly path?: string }> = []
    const answers: Record<string, () => Response> = {
      "": () =>
        json(200, {
          kind: "dir",
          path: "",
          entries: [{ name: ".git", kind: "dir" }, { name: "boom", kind: "dir" }, { name: "packages", kind: "dir" }, { name: "README.md", kind: "file" }, { name: "zeta.txt", kind: "file" }]
        }),
      ".git": () => json(200, { kind: "dir", path: ".git", entries: [{ name: "HEAD", kind: "file" }], truncated: true }),
      "boom": () => json(500, { error: { code: "read_failed", message: "Could not list boom." } }),
      "packages": () => json(200, { kind: "dir", path: "packages", entries: [{ name: "ui", kind: "dir" }, { name: "PACKAGE.ts", kind: "file" }] }),
      "packages/ui": () => json(200, { kind: "dir", path: "packages/ui", entries: [] }),
      "README.md": () => json(200, { kind: "file", path: "README.md", size: 14, content: "# Local — hi\n", truncated: false, binary: false })
    }
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "http://local.test").pathname
        if (path !== "/api/repo/files") return json(404, { status: "error", message: `no stub for ${url}` })
        const body = JSON.parse(String(init?.body ?? "{}")) as { repoId?: string; path?: string }
        requests.push(body)
        const answer = answers[body.path ?? ""]
        return answer === undefined ? json(404, { error: { code: "path_not_found", message: `Path not found: ${body.path}` } }) : answer()
      }
    }
    const { store, controller } = await localHarness(services)
    await persisted(store, { type: "repos.loaded", actor: "system", repos: [SMITHERS] })
    return { store, controller, requests }
  }

  /** Click, then let the seam's fetch and its dispatch land before reading the DOM. */
  const settle = async (act: (change: () => void) => Promise<void>, change: () => void): Promise<void> => {
    await act(change)
    for (let tick = 0; tick < 4; tick += 1) await act(() => {})
  }

  const names = (root: Element | null, selector: string): Array<string | null | undefined> =>
    [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].map((el) => el.textContent)

  test("the caret expands the copy's root and every deeper directory loads on its own expand; a file click renders the file card in the chat", async () => {
    const { store, controller, requests } = await treeHarness()
    const { host, act } = mount(controller)
    const toggle = host.querySelector<HTMLButtonElement>(`[data-testid="repo-tree-toggle-${COPY}"]`)
    expect(toggle?.getAttribute("data-flow")).toBe("repo.tree")
    expect(toggle?.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector(`[data-testid="repo-tree-${COPY}"]`)).toBeNull()

    await settle(act, () => toggle?.click())
    expect(requests).toEqual([{ repoId: "repo-smithers", path: "" }])
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    const tree = host.querySelector<HTMLElement>(`[data-testid="repo-tree-${COPY}"]`)
    expect(tree).not.toBeNull()
    // Exactly the route's entries, dirs first, `.git` included: nothing filtered, nothing invented.
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual([".git", "boom", "packages"])
    expect(names(tree, "[data-slot=file-tree-file]")).toEqual(["README.md", "zeta.txt"])
    // Every row names its flow: directories are repo.tree, files are files.read.
    for (const dir of tree?.querySelectorAll("[data-slot=file-tree-dir-toggle]") ?? []) expect(dir.getAttribute("data-flow")).toBe("repo.tree")
    for (const file of tree?.querySelectorAll("[data-slot=file-tree-file]") ?? []) expect(file.getAttribute("data-flow")).toBe("files.read")
    expect([...host.querySelectorAll(".chrome-bar button")].every((button) => button.getAttribute("data-flow") !== null)).toBe(true)

    // A nested directory is one more fetch, rendered under its row; an empty one says so.
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-dir-${COPY}#packages"]`)?.click())
    expect(requests[1]).toEqual({ repoId: "repo-smithers", path: "packages" })
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual([".git", "boom", "packages", "ui"])
    expect(names(tree, "[data-slot=file-tree-file]")).toEqual(["PACKAGE.ts", "README.md", "zeta.txt"])
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-dir-${COPY}#packages/ui"]`)?.click())
    expect(host.querySelector(`[data-testid="repo-tree-state-${COPY}#packages/ui"]`)?.textContent).toBe("empty")

    // The capped listing shows the existing truncated line; a failure shows the route's message verbatim, in place.
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-dir-${COPY}#.git"]`)?.click())
    expect(tree?.querySelector("[data-slot=file-tree-footer]")?.textContent).toBe("Truncated — the directory holds more entries than the listing shows.")
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-dir-${COPY}#boom"]`)?.click())
    const failed = host.querySelector<HTMLElement>(`[data-testid="repo-tree-state-${COPY}#boom"]`)
    expect(failed?.textContent).toBe("Could not list boom.")
    expect(failed?.dataset.state).toBe("failed")

    // A file click is files.read <path> <repo>: the existing file card lands in the chat; the sidebar does not change.
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-file-${COPY}#README.md"]`)?.click())
    expect(requests.at(-1)).toEqual({ repoId: "repo-smithers", path: "README.md" })
    const card = store.collections.cards.get("file-repo-smithers-README.md")
    expect(card?.kind).toBe("file")
    expect(host.querySelector("[data-testid=transcript] .smithers-card[data-kind=file]")).not.toBeNull()
    expect(store.session().activeTabId).toBe("main")

    // Collapsing the root hides the tree and keeps every loaded row for the next expand (no fetch).
    const before = requests.length
    await settle(act, () => toggle?.click())
    expect(host.querySelector(`[data-testid="repo-tree-${COPY}"]`)).toBeNull()
    await settle(act, () => toggle?.click())
    expect(requests.length).toBe(before)
    expect(names(host.querySelector(`[data-testid="repo-tree-${COPY}"]`), ".sui-file-tree-dir-name")).toEqual([".git", "boom", "packages", "ui"])
  })

  /*
   * A cloud workspace copy (a box) on the web host: its caret is the same
   * repo.tree flow, the listing comes through the Worker's forward of the
   * box's files route, and a file click is workspace.file (the existing
   * workspace file card, titled with the box). A box that is not running says
   * its state at the root and asks the route nothing.
   */
  const BOX_ROW = {
    id: "ws-1",
    repoId: "will/flows",
    name: "fix-landings",
    targetBookmark: "main",
    status: "running" as const,
    provisioningStage: null,
    suspendedAt: null,
    createdAt: "2026-09-07T00:00:00Z"
  }
  const boxHarness = async (status: "running" | "starting") => {
    const requests: Array<string> = []
    const services: AppServices = {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const parsed = new URL(url, "http://cloud.test")
        const path = parsed.pathname
        // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this test's request.
        if (!path.endsWith("/contents/.smithers/factory.json")) requests.push(`${path}${parsed.search}`)
        const at = parsed.searchParams.get("path") ?? ""
        if (path === "/api/cloud/api/repos/will/flows/workspaces/ws-1/files") {
          if (at === "") return json(200, { path: "", entries: [{ name: "apps", path: "apps", type: "dir", size: 0 }, { name: "README.md", path: "README.md", type: "file", size: 6 }] })
          if (at === "apps") return json(200, { path: "apps", entries: [{ name: "ui", path: "apps/ui", type: "dir", size: 0 }] })
          return json(404, { status: "error", message: `no such path in ws-1: ${at}` })
        }
        if (path === "/api/cloud/api/repos/will/flows/workspaces/ws-1/files/content" && at === "README.md") {
          return json(200, { path: "README.md", content: "# Box\n", encoding: "utf-8", size: 6, truncated: false })
        }
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
    }
    const { store, controller } = await cloudHarness(services)
    await persisted(store, { type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null })
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: { bookmark: "main", changeId: "qupxosqw", commitId: "abc123" } }]
    })
    await persisted(store, { type: "workspaces.loaded", actor: "system", workspaces: [{ ...BOX_ROW, status }] })
    return { store, controller, requests }
  }

  test("a running box's caret expands the box's tree through its files route; a file click renders the workspace file card", async () => {
    const { store, controller, requests } = await boxHarness("running")
    expect(controller.commands.find("repo.tree")).toBeDefined()
    const { host, act } = mount(controller)
    const copyId = "workspace:ws-1"
    const toggle = host.querySelector<HTMLButtonElement>(`[data-testid="repo-tree-toggle-${copyId}"]`)
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute("data-flow")).toBe("repo.tree")
    expect(toggle?.getAttribute("aria-label")).toBe("Expand fix-landings")
    expect(host.querySelector(`[data-testid="repo-tree-${copyId}"]`)).toBeNull()

    await settle(act, () => toggle?.click())
    expect(requests).toEqual(["/api/cloud/api/repos/will/flows/workspaces/ws-1/files?path="])
    expect(toggle?.getAttribute("aria-expanded")).toBe("true")
    const tree = host.querySelector<HTMLElement>(`[data-testid="repo-tree-${copyId}"]`)
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual(["apps"])
    expect(names(tree, "[data-slot=file-tree-file]")).toEqual(["README.md"])
    // Directories are repo.tree; files on a box are workspace.file, never the repository read.
    for (const dir of tree?.querySelectorAll("[data-slot=file-tree-dir-toggle]") ?? []) expect(dir.getAttribute("data-flow")).toBe("repo.tree")
    for (const file of tree?.querySelectorAll("[data-slot=file-tree-file]") ?? []) expect(file.getAttribute("data-flow")).toBe("workspace.file")
    expect([...host.querySelectorAll(".chrome-bar button")].every((button) => button.getAttribute("data-flow") !== null)).toBe(true)

    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-dir-${copyId}#apps"]`)?.click())
    expect(requests[1]).toBe("/api/cloud/api/repos/will/flows/workspaces/ws-1/files?path=apps")
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual(["apps", "ui"])

    // The file click is workspace.file README.md ws-1: the workspace file card lands in the chat, titled with the box.
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-file-${copyId}#README.md"]`)?.click())
    expect(requests.at(-1)).toBe("/api/cloud/api/repos/will/flows/workspaces/ws-1/files/content?path=README.md")
    const card = store.collections.cards.get("workspace-file-ws-1-README.md")
    expect(card?.kind).toBe("file")
    expect(card?.title).toBe("README.md · fix-landings")
    expect(host.querySelector("[data-testid=transcript] .smithers-card[data-kind=file]")).not.toBeNull()
    expect(requests.some((request) => request.startsWith("/api/cloud/api/repos/will/flows/contents"))).toBe(false)
  })

  test("a starting box's caret says its state at the root, verbatim and in place, and asks the route nothing", async () => {
    const { controller, requests } = await boxHarness("starting")
    const { host, act } = mount(controller)
    const copyId = "workspace:ws-1"
    expect(host.querySelector(`[data-testid="copy-${copyId}"]`)?.textContent).toContain("fix-landings · starting")
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-tree-toggle-${copyId}"]`)?.click())
    const state = host.querySelector<HTMLElement>(`[data-testid="repo-tree-state-${copyId}#"]`)
    expect(state?.textContent).toBe("fix-landings (ws-1) is starting, not running; wait for it to settle (the workspace card tracks it).")
    expect(state?.dataset.state).toBe("failed")
    expect(requests).toEqual([])
  })

  /*
   * The shared read-only copy of a public repository (WorkspaceViews.ts): the
   * one virtual box every signed-out reader shares over the mirror. Its row
   * reads `<bookmark> · shared · read-only`, its caret lists through the
   * mirror's contents route (the same public read the files flows make), a
   * file click is files.read <path> <org/repo>, and no write door renders on
   * it: no `+`, no unpin. The chrome's Sign in line is the door a reader has.
   */
  const sharedHarness = async () => {
    const requests: Array<string> = []
    const contents = "/api/repos/smithersai/smithers/contents"
    const services: AppServices = {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const parsed = new URL(url, "http://cloud.test")
        const path = parsed.pathname
        if (!path.endsWith("/contents/.smithers/factory.json")) requests.push(`${path}${parsed.search}`)
        if (path === contents) {
          return json(200, [{ name: "apps", path: "apps", type: "dir", sha: "", size: 0 }, { name: "README.md", path: "README.md", type: "file", sha: "", size: 0 }])
        }
        if (path === `${contents}/apps`) return json(200, [{ name: "ui", path: "apps/ui", type: "dir", sha: "", size: 0 }])
        if (path === `${contents}/README.md`) return json(200, { name: "README.md", path: "README.md", type: "file", encoding: "utf-8", content: "# Shared\n", size: 9 })
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
    }
    const { store, controller } = await cloudHarness(services)
    await persisted(store, { type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null })
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: { bookmark: "main", changeId: null, commitId: null }, catalog: true }]
    })
    return { store, controller, requests }
  }

  test("signed out, the shared read-only copy is the catalog repository's one tab: its caret lists the mirror's contents, a file click is files.read, and no write door renders", async () => {
    const { store, controller, requests } = await sharedHarness()
    const { host, act } = mount(controller)
    const copyId = "shared:smithersai/smithers"
    const row = host.querySelector<HTMLElement>(`[data-testid="copy-${copyId}"]`)
    expect(row).not.toBeNull()
    expect(row?.querySelector(".repo-name")?.textContent).toBe("main · shared · read-only")
    expect(row?.querySelector('[data-flow="tab.menu"]')).toBeNull()
    expect(row?.querySelector('[data-flow="repo.unpin"]')).toBeNull()
    expect(host.querySelector("[data-testid=chrome-sign-in]")?.getAttribute("data-flow")).toBe("auth.sign-in")
    const toggle = host.querySelector<HTMLButtonElement>(`[data-testid="repo-tree-toggle-${copyId}"]`)
    expect(toggle?.getAttribute("data-flow")).toBe("repo.tree")
    expect(toggle?.getAttribute("aria-label")).toBe("Expand shared")

    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="copy-select-${copyId}"]`)?.click())
    await settle(act, () => toggle?.click())
    expect(requests).toEqual(["/api/repos/smithersai/smithers/contents"])
    const tree = host.querySelector<HTMLElement>(`[data-testid="repo-tree-${copyId}"]`)
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual(["apps"])
    expect(names(tree, "[data-slot=file-tree-file]")).toEqual(["README.md"])
    for (const dir of tree?.querySelectorAll("[data-slot=file-tree-dir-toggle]") ?? []) expect(dir.getAttribute("data-flow")).toBe("repo.tree")
    for (const file of tree?.querySelectorAll("[data-slot=file-tree-file]") ?? []) expect(file.getAttribute("data-flow")).toBe("files.read")
    expect([...host.querySelectorAll(".chrome-bar button")].every((button) => button.getAttribute("data-flow") !== null)).toBe(true)

    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-dir-${copyId}#apps"]`)?.click())
    expect(requests[1]).toBe("/api/repos/smithersai/smithers/contents/apps")
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual(["apps", "ui"])

    // The file click is the repository read the files flows make: the file card lands in the chat, addressed to the repository.
    await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-file-${copyId}#README.md"]`)?.click())
    for (let tick = 0; tick < 20 && !store.collections.cards.has("file-smithersai/smithers-README.md"); tick += 1) await act(() => {})
    expect(requests.at(-1)).toBe("/api/repos/smithersai/smithers/contents/README.md")
    const card = store.collections.cards.get("file-smithersai/smithers-README.md")
    expect(card?.kind).toBe("file")
    expect(card?.title).toBe("File · smithersai/smithers · README.md")
    // The shared copy has no VM: no box route is ever asked.
    expect(requests.some((request) => request.includes("/workspaces"))).toBe(false)
  })

  /*
   * The live outcome the shared copy exists for: a signed-out visitor opening
   * https://smithers.sh/smithersai/smithers. The boot act (RepoLink's
   * openRequestedRepo, which ControllerBoot runs for a `/owner/name` path)
   * selects the catalog row, reads the mirror's default bookmark and opens
   * the copy's root, so the sidebar paints `main · shared · read-only` over
   * the mirror's root with no click. The mirror answers a git tree's byte
   * order; the tree reads in the sidebar's own order.
   */
  test("a signed-out visit to /owner/name paints the shared copy expanded, over the mirror's root", async () => {
    const requests: Array<string> = []
    const contents = "/api/repos/smithersai/smithers/contents"
    const fetchImpl: NonNullable<AppServices["fetchImpl"]> = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://cloud.test").pathname
      if (!path.endsWith("/contents/.smithers/factory.json")) requests.push(path)
      if (path === "/api/public/repos") {
        return json(200, {
          repos: [{ name: "smithersai/smithers", title: "Smithers", url: "https://github.com/smithersai/smithers", summary: "Smithers turns a repository into a factory.", stats: null }]
        })
      }
      if (path === "/api/repos/smithersai/smithers") return json(200, { default_bookmark: "main" })
      if (path === contents) {
        return json(200, [
          { name: "CHANGELOG.md", path: "CHANGELOG.md", type: "file", sha: "", size: 0 },
          { name: "Cargo.lock", path: "Cargo.lock", type: "file", sha: "", size: 0 },
          { name: "README.md", path: "README.md", type: "file", sha: "", size: 0 },
          { name: "apps", path: "apps", type: "dir", sha: "", size: 0 }
        ])
      }
      return json(404, { status: "error", message: `no stub for ${url}` })
    }
    const { store, controller } = await cloudHarness({ fetchImpl })
    await persisted(store, { type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null })
    const { host, act } = mount(controller)
    const copyId = "shared:smithersai/smithers"

    await settle(act, () => void openRequestedRepo(controller, fetchImpl, "smithersai/smithers"))
    for (let tick = 0; tick < 40 && store.collections.repoTree.get(`${copyId}#`)?.state !== "loaded"; tick += 1) await act(() => {})

    const row = host.querySelector<HTMLElement>(`[data-testid="copy-${copyId}"]`)
    expect(row?.querySelector(".repo-name")?.textContent).toBe("main · shared · read-only")
    expect(host.querySelector<HTMLButtonElement>(`[data-testid="repo-tree-toggle-${copyId}"]`)?.getAttribute("aria-expanded")).toBe("true")
    const tree = host.querySelector<HTMLElement>(`[data-testid="repo-tree-${copyId}"]`)
    expect(names(tree, ".sui-file-tree-dir-name")).toEqual(["apps"])
    expect(names(tree, "[data-slot=file-tree-file]")).toEqual(["Cargo.lock", "CHANGELOG.md", "README.md"])
    // The catalog first, then the mirror: its repository document for the bookmark and its contents for the root. No box route: the shared copy has no VM.
    expect(requests[0]).toBe("/api/public/repos")
    expect(requests).toContain("/api/repos/smithersai/smithers")
    expect(requests).toContain(contents)
    expect(requests.some((request) => request.includes("/workspaces"))).toBe(false)
  })

  test("sessions nest under the copy after its files, labelled apart once the tree is open", async () => {
    const { store, controller } = await treeHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · smithers", sessionId: "t1", cwd: SMITHERS.path, repoKey: COPY }
    })
    const { host, act } = mount(controller)
    const group = [...host.querySelectorAll<HTMLElement>(".repo-group")].find((el) => el.dataset.testid === `repo-${COPY}`) ?? null
    expect(group).not.toBeNull()
    expect(group?.querySelector(".repo-sessions-label")).toBeNull()
    await settle(act, () => group?.querySelector<HTMLButtonElement>(`[data-flow="repo.tree"]`)?.click())
    const order = [...(group?.querySelectorAll<HTMLElement>(".repo-tree, .repo-sessions-label, .repo-tabs") ?? [])].map((el) => el.className)
    expect(order).toEqual(["repo-tree", "repo-sessions-label", "repo-tabs"])
    expect(group?.querySelector(".repo-sessions-label")?.textContent).toBe("sessions")
    expect(group?.querySelector(".repo-tabs [data-testid=tab-t1]")).not.toBeNull()
  })

  /*
   * The streaming hot path: a message delta re-renders the shell, and the
   * sidebar under it used to rebuild every copy's tree from the whole
   * repoTree collection on each one. The tree is derived once per change of
   * its rows, so the file tree keeps the very rows it was handed.
   */
  test("a message delta re-derives no copy's tree: the file tree keeps the rows it was handed", async () => {
    const fileTree = spyOn(SmithersUi, "FileTree")
    try {
      const { store, controller } = await treeHarness()
      const { host, act } = mount(controller)
      await settle(act, () => host.querySelector<HTMLButtonElement>(`[data-testid="repo-tree-toggle-${COPY}"]`)?.click())
      // The copy tree is the FileTree handed `directories`; the Wiki's note list is not.
      const handed = (): ReadonlyArray<ReadonlyArray<unknown>> =>
        fileTree.mock.calls.flatMap(([props]) => props.directories === undefined ? [] : [props.nodes])
      const rows = handed().at(-1)
      expect(rows).toEqual(["README.md", "zeta.txt"])
      if (rows === undefined) throw new Error("the copy tree was never handed its rows")
      fileTree.mockClear()

      await settle(act, () => store.dispatch({ type: "message.appended", actor: "system", text: "a delta beside the tree" }))

      expect(host.querySelector("[data-testid=transcript]")?.textContent).toContain("a delta beside the tree")
      for (const nodes of handed()) expect(nodes).toBe(rows)
    } finally {
      fileTree.mockRestore()
    }
  })
})

/*
 * The workspace heading (docs/workbench-lanes/sidebar-tree.md): its name is
 * the way back to the chat, the pencil renames it inline (Enter commits
 * through workspace.rename, Escape closes the editor), and it reads
 * "Workspace" until the user names it.
 */
describe("the workspace heading", () => {
  test("clicking the name selects the chat; the pencil opens an inline rename that Enter commits and Escape cancels", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · ~", sessionId: "t1", cwd: "~" }
    })
    const { host, act } = mount(controller)
    expect(store.session().activeTabId).toBe("t1")
    const heading = host.querySelector<HTMLElement>("[data-testid=workspace-heading]")
    expect(heading?.dataset.active).toBe("false")
    const name = host.querySelector<HTMLButtonElement>("[data-testid=workspace-name]")
    expect(name?.textContent).toBe("Workspace")
    expect(name?.getAttribute("data-flow")).toBe("tab.select")
    expect(name?.getAttribute("role")).toBe("tab")
    await act(() => name?.click())
    expect(store.session().activeTabId).toBe("main")
    expect(heading?.dataset.active).toBe("true")
    expect(host.querySelector<HTMLElement>("[data-testid=tab-body-main]")?.hidden).toBe(false)

    const pencil = host.querySelector<HTMLButtonElement>("[data-testid=workspace-rename]")
    expect(pencil?.getAttribute("data-flow")).toBe("workspace.rename.edit")
    await act(() => pencil?.click())
    const input = host.querySelector<HTMLInputElement>("[data-testid=workspace-name-input]")
    expect(input).not.toBeNull()
    expect(host.querySelector("[data-testid=workspace-name]")).toBeNull()
    await act(() => {
      if (input === null) return
      input.value = "Force"
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    })
    expect(store.session().workspaceName).toBe("Force")
    expect(host.querySelector("[data-testid=workspace-name-input]")).toBeNull()
    expect(host.querySelector("[data-testid=workspace-name]")?.textContent).toBe("Force")

    // Escape closes the editor and keeps the name.
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=workspace-rename]")?.click())
    const again = host.querySelector<HTMLInputElement>("[data-testid=workspace-name-input]")
    expect(again?.value).toBe("Force")
    await act(() => {
      if (again === null) return
      again.value = "Plue"
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    expect(host.querySelector("[data-testid=workspace-name-input]")).toBeNull()
    expect(store.session().workspaceName).toBe("Force")
    expect(host.querySelector("[data-testid=workspace-name]")?.textContent).toBe("Force")

    // A blank name is a refusal, not a rename: the editor stays, the name stays.
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=workspace-rename]")?.click())
    const blank = host.querySelector<HTMLInputElement>("[data-testid=workspace-name-input]")
    await act(() => {
      if (blank === null) return
      blank.value = "   "
      blank.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    })
    expect(store.session().workspaceName).toBe("Force")
    expect(host.querySelector("[data-testid=workspace-name-input]")).not.toBeNull()
  })

  test("nothing the sidebar, its menus, or its close confirm shows calls a session a tab", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "harnesses.loaded",
      actor: "system",
      harnesses: [{
        id: "claude",
        displayName: "Claude Code",
        binary: "/opt/homebrew/bin/claude",
        version: "2.1.0",
        status: "signed-in",
        account: { email: "will@codeplane.app" },
        launch: { argv: ["claude"] }
      }]
    })
    await persisted(store, {
      type: "repos.loaded",
      actor: "system",
      repos: [{
        id: "r1",
        path: "/Users/will/force",
        name: "force",
        git: { branch: "main", remote: null },
        smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
        warnings: []
      }]
    })
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "terminal", title: "Terminal · force", sessionId: "t1", cwd: "/Users/will/force", repoKey: "local:/Users/will/force" }
    })
    await persisted(store, { type: "tab.close.asked", actor: "user", id: "t1" })
    const { host, act } = mount(controller)
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=tab-add]")?.click())
    expect(host.querySelector("[data-testid=tab-add-menu]")).not.toBeNull()
    const visible: Array<string> = []
    const bar = host.querySelector<HTMLElement>(".chrome-bar")
    visible.push(bar?.textContent ?? "")
    for (const el of bar?.querySelectorAll<HTMLElement>("[aria-label], [title], [placeholder]") ?? []) {
      for (const attribute of ["aria-label", "title", "placeholder"]) {
        const value = el.getAttribute(attribute)
        if (value !== null) visible.push(value)
      }
    }
    expect(visible.filter((text) => /\btabs?\b/i.test(text))).toEqual([])
    // The words that replaced it.
    expect(host.querySelector("[data-testid=tab-add]")?.textContent).toBe("New session")
    expect(host.querySelector("[data-testid=repo-add-local\\:\\/Users\\/will\\/force]")?.getAttribute("aria-label")).toBe("New session in force")
    expect(host.querySelector("[data-testid=tab-close-t1]")?.getAttribute("title")).toBe("Close session")
    /*
     * The close confirm is a Radix dialog, which never portals under this
     * file's in-file happy-dom registration (Radix captures `document` at
     * module load; see bunfig preload notes in packages/smithers/ui). Its copy is
     * pinned at the source: every string the ConfirmDialog is given.
     */
    const bodies = readFileSync(fileURLToPath(new URL("./TabBodies.tsx", import.meta.url)), "utf8")
    const confirm = bodies.slice(bodies.indexOf("<ConfirmDialog"), bodies.indexOf("/>", bodies.indexOf("<ConfirmDialog")))
    // Flow ids (`tab.close.confirm`) are not copy: the brief keeps them; only prose is checked.
    const literals = [...confirm.matchAll(/(["'`])((?:(?!\1)[^\n])*)\1/g)]
      .map((match) => match[2] ?? "")
      .filter((text) => !/^[a-z][a-z.-]*$/.test(text))
    expect(literals.length).toBeGreaterThan(3)
    expect(literals.filter((text) => /\btabs?\b/i.test(text))).toEqual([])
    expect(confirm).toContain('confirmLabel="Close session"')
    expect(confirm).toContain('"this session"')
  })
})

/*
 * The download button (docs/web-mode/PLAN.md §3): the web app's one door to
 * the native app lives in the chrome that belongs to no session, rendered
 * exactly when the registry holds `app.download` — the cloud host — so native
 * chrome gains nothing. The click IS the flow: `window.open` needs the user's
 * gesture, which is why the button and not the model opens the page.
 */
describe("the chrome-actions footer's download button", () => {
  test("host cloud renders it bound to app.download, and the click opens the download page in a new tab", async () => {
    const { controller } = await cloudHarness({ downloadUrl: RELEASE_URL })
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-download]")
    expect(button).not.toBeNull()
    expect(button?.dataset.flow).toBe("app.download")
    expect(button?.textContent).toBe("Download the app")
    expect(button?.querySelector("svg")).not.toBeNull()
    expect(button?.closest("[data-testid=chrome-actions]")).not.toBeNull()
    // Below the sign-in door, above the theme corner (the plan's footer order).
    const order = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(order.indexOf("app.download")).toBeGreaterThan(order.indexOf("auth.sign-in"))
    expect(order.indexOf("app.download")).toBeLessThan(order.indexOf("appearance.dark-mode"))
    const opened: Array<ReadonlyArray<unknown>> = []
    const original = window.open
    window.open = ((...args: ReadonlyArray<unknown>) => {
      opened.push(args)
      return null
    }) as typeof window.open
    try {
      await act(() => button?.click())
    } finally {
      window.open = original
    }
    expect(opened).toEqual([[RELEASE_URL, "_blank", "noopener"]])
  })

  test("host cloud renders no download button while no native release carries an asset — the product default today", async () => {
    // 2026-09-02: the latest GitHub Release (v0.35.0) has no assets and no apps-v* release exists.
    expect(DOWNLOAD_URL).toBeNull()
    const { controller } = await cloudHarness()
    expect(controller.commands.find("app.download")).toBeDefined()
    expect(controller.downloadUrl).toBeNull()
    const { host } = mount(controller)
    expect(host.querySelector("[data-testid=chrome-download]")).toBeNull()
    expect(host.querySelector('[data-flow="app.download"]')).toBeNull()
    // The sign-in door is untouched by the missing download.
    expect(host.querySelector("[data-testid=chrome-sign-in]")).not.toBeNull()
  })

  test("host local renders no download button: the flow is not registered there", async () => {
    const { controller } = await localHarness()
    expect(controller.commands.find("app.download")).toBeUndefined()
    const { host } = mount(controller)
    expect(host.querySelector("[data-testid=chrome-download]")).toBeNull()
    expect(host.querySelector('[data-flow="app.download"]')).toBeNull()
  })
})

/*
 * The chrome buttons (factory design session 2026-09-07; every screen of
 * ~/Desktop/smithers-factory/factory-mocks.html shows them): exactly Wiki,
 * Dispatcher, Flows, Secrets, History, Account, in that order, under the
 * Sign in line and above the theme corner. Each is the button door of one
 * registered flow and renders exactly where that flow registers, so the
 * rendered row is the canonical list filtered by the registry and never a
 * seventh button, a renamed one, or an invented one.
 */
describe("the chrome buttons", () => {
  /** The canonical row: label, the registered flow the button runs, and its test id. */
  const CHROME = [
    { label: "Wiki", flow: "wiki", testid: "chrome-wiki" },
    { label: "Dispatcher", flow: "triggers.list", testid: "chrome-dispatcher" },
    { label: "Flows", flow: "flows", testid: "chrome-flows" },
    { label: "Secrets", flow: "secrets.list", testid: "chrome-secrets" },
    { label: "History", flow: "history.show", testid: "chrome-history" },
    { label: "Account", flow: "account.show", testid: "chrome-account" }
  ] as const

  /** Every `.chrome-action` in the footer that is one of the six, in DOM order. */
  const rendered = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLButtonElement>("[data-testid=chrome-actions] .chrome-action")].filter((button) =>
      CHROME.some((row) => row.testid === button.dataset.testid)
    )

  const signedOut = async (store: AppStore): Promise<void> => {
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
  }

  test("host cloud, signed out: all six render in the fixed order, each bound to a registered flow, under Sign in and above the theme toggle", async () => {
    const { store, controller } = await cloudHarness()
    await signedOut(store)
    const { host } = mount(controller)
    const buttons = rendered(host)
    expect(buttons.map((button) => button.textContent)).toEqual(["Wiki", "Dispatcher", "Flows", "Secrets", "History", "Account"])
    expect(buttons.map((button) => button.dataset.flow)).toEqual(CHROME.map((row) => row.flow))
    expect(buttons.map((button) => button.dataset.testid)).toEqual(CHROME.map((row) => row.testid))
    for (const button of buttons) {
      // Parity: the button names a registered flow and carries its icon; the slash door offers the same entry.
      expect(controller.commands.find(button.dataset.flow ?? "")).toBeDefined()
      expect(button.querySelector("svg")).not.toBeNull()
      expect(button.closest("[data-testid=chrome-actions]")).not.toBeNull()
    }
    // No word "workflow" reaches a person through the chrome.
    expect(host.querySelector<HTMLElement>("[data-testid=chrome-actions]")?.textContent?.toLowerCase()).not.toContain("workflow")
    // The Sign in line stands first; the theme toggle closes the footer; the six sit between them.
    const flows = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(flows[0]).toBe("auth.sign-in")
    expect(flows.at(-1)).toBe("appearance.dark-mode")
    expect(flows.slice(1, 7)).toEqual(CHROME.map((row) => row.flow))
    // The theme toggle is the corner's, not one of the six.
    expect(host.querySelector('[data-flow="appearance.dark-mode"]')?.closest(".chrome-corner")).not.toBeNull()
  })

  test("host cloud, signed in: the same six in the same order, the Sign in line gone", async () => {
    const { store, controller } = await cloudHarness()
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    const { host } = mount(controller)
    expect(rendered(host).map((button) => button.textContent)).toEqual(["Wiki", "Dispatcher", "Flows", "Secrets", "History", "Account"])
    expect(host.querySelector("[data-testid=chrome-sign-in]")).toBeNull()
    const flows = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(flows.slice(0, 6)).toEqual(CHROME.map((row) => row.flow))
    expect(flows.at(-1)).toBe("appearance.dark-mode")
  })

  test("host local: the row is the canonical list filtered by the registry, so only Wiki and Flows render, in that order", async () => {
    const { controller } = await localHarness()
    const registered = CHROME.filter((row) => controller.commands.find(row.flow) !== undefined)
    expect(registered.map((row) => row.label)).toEqual(["Wiki", "Flows"])
    const { host } = mount(controller)
    const buttons = rendered(host)
    expect(buttons.map((button) => button.textContent)).toEqual(["Wiki", "Flows"])
    expect(buttons.map((button) => button.dataset.flow)).toEqual(["wiki", "flows"])
    for (const row of CHROME) {
      if (registered.includes(row)) continue
      expect(host.querySelector(`[data-testid=${row.testid}]`)).toBeNull()
      expect(host.querySelector(`[data-flow="${row.flow}"]`)).toBeNull()
    }
  })

  test("Wiki, signed out, opens the Wiki pane beside the chat and touches no message; a second click returns to the chat", async () => {
    const { store, controller } = await cloudHarness()
    await signedOut(store)
    const { host, act } = mount(controller)
    const before = [...store.collections.messages.values()].map((message) => message.id)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-wiki]")
    expect(button?.dataset.flow).toBe("wiki")
    await act(() => button?.click())
    expect(store.session().surface).toBe("world")
    expect([...store.collections.messages.values()].map((message) => message.id)).toEqual(before)
    // The chrome stays visible with the pane open: every screen of the mock shows it.
    expect(rendered(host).map((b) => b.textContent)).toEqual(["Wiki", "Dispatcher", "Flows", "Secrets", "History", "Account"])
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=chrome-wiki]")?.click())
    expect(store.session().surface).toBe("chat")
  })

  test("Flows, signed out, opens the Flows pane and invents no flow rows: the list waits on sign-in", async () => {
    const { store, controller } = await cloudHarness({
      fetchImpl: async () => new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
    })
    await signedOut(store)
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-flows]")
    expect(button?.dataset.flow).toBe("flows")
    await act(() => button?.click())
    await act(() => {})
    expect(store.session().surface).toBe("flows")
    expect(host.querySelector('section[aria-label="Flows on your workspace"]')).not.toBeNull()
    // Honest state: no workspace was provisioned and no flow list card exists for a signed-out visitor.
    expect([...store.collections.cards.values()].filter((card) => card.kind === "workflow-list")).toHaveLength(0)
    expect(host.querySelector(".flows-content")?.children).toHaveLength(0)
  })
})

/*
 * The Secrets button: the button door of secrets.list, in the chrome that
 * belongs to no session. It renders exactly where the registry holds
 * secrets.list (the cloud host), and its click runs the same registry entry
 * the /secrets.list slash runs, so the secrets card appears in the chat with
 * the repository's secret metadata and never a value. No settings page exists.
 */
describe("the chrome-actions footer's Secrets button", () => {
  const secretsHarness = async (): Promise<{ store: AppStore; controller: AppControllerType; listed: () => number }> => {
    let listed = 0
    const { store, controller } = await cloudHarness({
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "https://app.test").pathname
        if (path === "/api/repos/will/flows/agent-environment") {
          listed += 1
          return new Response(
            JSON.stringify({
              setup_script: "",
              env: [],
              secrets: [{ name: "NPM_TOKEN", hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-08-01T00:00:00Z" }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        }
        return new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
      }
    })
    return { store, controller, listed: () => listed }
  }

  test("host cloud renders it bound to secrets.list, and a signed-in click surfaces the secrets card with metadata only", async () => {
    const { store, controller, listed } = await secretsHarness()
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
    })
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-secrets]")
    expect(button).not.toBeNull()
    expect(button?.dataset.flow).toBe("secrets.list")
    expect(button?.textContent).toBe("Secrets")
    expect(button?.querySelector("svg")).not.toBeNull()
    expect(button?.closest("[data-testid=chrome-actions]")).not.toBeNull()
    // Above the theme corner, like the other footer doors.
    const order = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(order.indexOf("secrets.list")).toBeLessThan(order.indexOf("appearance.dark-mode"))
    // The slash door offers the same registry entry the button is bound to.
    const slashNames = controller.slashTree("secrets.list").flatMap((row) => (row.kind === "flow" ? [row.flow.name] : []))
    expect(slashNames).toContain("secrets.list")

    await act(() => button?.click())
    await act(() => {})
    expect(listed()).toBe(1)
    const card = host.querySelector<HTMLElement>('[data-kind="secrets"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector("[data-testid=secrets-scope]")?.textContent).toBe(
      "Repository secrets: every session in this repository may use them."
    )
    const row = card?.querySelector("[data-testid=secret-NPM_TOKEN]")
    expect(row?.textContent).toContain("NPM_TOKEN")
    expect(row?.textContent).toContain("registry.npmjs.org")
    expect(row?.textContent).toContain("authorization")
    expect(row?.textContent).toContain("2026-08-01")

    // The slash door runs the identical flow: the same card is re-surfaced, never a second one.
    await act(() => {
      expect(controller.runCommand("secrets.list")).toBe(true)
    })
    await act(() => {})
    expect(listed()).toBe(2)
    expect(host.querySelectorAll('[data-kind="secrets"]')).toHaveLength(1)
  })

  test("signed out, the button still stands and the click renders the sign-in step, never a secrets card", async () => {
    const { store, controller, listed } = await secretsHarness()
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-secrets]")
    expect(button).not.toBeNull()
    await act(() => button?.click())
    await act(() => {})
    // secrets.list requires sign-in: the run path parks it and renders the sign-in step; nothing is read and no row is invented.
    expect(listed()).toBe(0)
    expect(host.querySelector('[data-kind="secrets"]')).toBeNull()
    const prompt = [...host.querySelectorAll<HTMLButtonElement>('.message-cta[data-flow="auth.sign-in"]')]
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt.at(-1)?.textContent).toBe("Sign in with GitHub")
  })

  test("host local renders no Secrets button: secrets.list is not registered there", async () => {
    const { controller } = await localHarness()
    expect(controller.commands.find("secrets.list")).toBeUndefined()
    const { host } = mount(controller)
    expect(host.querySelector("[data-testid=chrome-secrets]")).toBeNull()
    expect(host.querySelector('[data-flow="secrets.list"]')).toBeNull()
  })
})

/*
 * The Dispatcher button (design session 2026-09-07: the chrome is Wiki,
 * Dispatcher, Flows, Secrets, History, Account). It is the button door of
 * triggers.list, in the chrome that belongs to no session, between Wiki and
 * Flows. It renders exactly where the registry holds triggers.list (the cloud host)
 * and its click runs the same registry entry the /triggers.list slash and the
 * Flows pane's Triggers button run, so the dispatcher card appears in the
 * chat with the repository's real rows and never an invented one.
 */
describe("the chrome-actions footer's Dispatcher button", () => {
  const dispatcherHarness = async (): Promise<{ store: AppStore; controller: AppControllerType; listed: () => number }> => {
    let listed = 0
    const { store, controller } = await cloudHarness({
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const parsed = new URL(url, "https://app.test")
        if (parsed.pathname === "/api/workflow/triggers" && parsed.searchParams.get("repo") === "will/flows") {
          listed += 1
          return new Response(
            JSON.stringify({
              status: "ok",
              repo: "will/flows",
              live: true,
              triggers: [{ id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "Europe/London", enabled: true }],
              webhooks: [{ name: "github", flowId: "implement" }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        }
        return new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
      }
    })
    return { store, controller, listed: () => listed }
  }

  test("host cloud renders it between Wiki and Flows bound to triggers.list, and a signed-in click surfaces the dispatcher card", async () => {
    const { store, controller, listed } = await dispatcherHarness()
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
    })
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-dispatcher]")
    expect(button).not.toBeNull()
    expect(button?.dataset.flow).toBe("triggers.list")
    expect(button?.textContent).toBe("Dispatcher")
    expect(button?.querySelector("svg")).not.toBeNull()
    expect(button?.closest("[data-testid=chrome-actions]")).not.toBeNull()
    // Right after Wiki, right before Flows, and above the theme corner, like the other footer doors.
    const order = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(order.indexOf("triggers.list")).toBe(order.indexOf("wiki") + 1)
    expect(order.indexOf("flows")).toBe(order.indexOf("triggers.list") + 1)
    expect(order.indexOf("triggers.list")).toBeLessThan(order.indexOf("appearance.dark-mode"))
    // The slash door offers the same registry entry the button is bound to.
    const slashNames = controller.slashTree("triggers.list").flatMap((row) => (row.kind === "flow" ? [row.flow.name] : []))
    expect(slashNames).toContain("triggers.list")

    await act(() => button?.click())
    await act(() => {})
    expect(listed()).toBe(1)
    const list = host.querySelector<HTMLElement>("[data-testid=trigger-list]")
    expect(list).not.toBeNull()
    const row = list?.querySelector("[data-trigger=nightly]")
    expect(row?.textContent).toContain("runs review")
    expect(row?.querySelector("[data-testid=trigger-state-nightly]")?.textContent).toBe("enabled · never fired")
    expect(list?.querySelector("[data-webhook=github]")?.textContent).toContain("runs implement")

    // The slash door runs the identical flow: the same card is re-surfaced, never a second one.
    await act(() => {
      expect(controller.runCommand("triggers.list")).toBe(true)
    })
    await act(() => {})
    expect(listed()).toBe(2)
    expect(host.querySelectorAll("[data-testid=trigger-list]")).toHaveLength(1)
  })

  test("host local renders no Dispatcher button: triggers.list is not registered there", async () => {
    const { controller } = await localHarness()
    expect(controller.commands.find("triggers.list")).toBeUndefined()
    const { host } = mount(controller)
    expect(host.querySelector("[data-testid=chrome-dispatcher]")).toBeNull()
    expect(host.querySelector('[data-flow="triggers.list"]')).toBeNull()
  })
})
/*
 * The Account button (factory mock 21, design session §6c): the button door of
 * account.show, in the chrome that belongs to no session. Signed in, its click
 * renders one read-only card of seam facts (login, allowlist answer, the
 * identity worker's scopes, the boxes the workspaces seam listed) with the
 * Sign out door and nothing else: no billing, usage or seat rows, because no
 * seam holds them. Signed out, the same flow renders the sign-in step, never
 * an empty account.
 */
describe("the chrome-actions footer's Account button", () => {
  const accountHarness = async (): Promise<{ store: AppStore; controller: AppControllerType; scopesRead: () => number }> => {
    let scopesRead = 0
    const { store, controller } = await cloudHarness({
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "https://app.test").pathname
        if (path === "/api/auth/scopes") {
          scopesRead += 1
          return new Response(
            JSON.stringify({
              provider: "github",
              requestedScopes: ["read:user", "repo"],
              scopes: [
                { scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." },
                { scope: "repo", plain: "Read access to your repositories.", why: "The connector." }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        }
        return new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
      }
    })
    return { store, controller, scopesRead: () => scopesRead }
  }

  const signedIn = async (store: AppStore): Promise<void> => {
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
  }

  test("signed in, the click renders the seam-backed rows, the Sign out door, and nothing else", async () => {
    const { store, controller, scopesRead } = await accountHarness()
    await signedIn(store)
    // The workspaces seam has listed boxes in two repositories: both are the person's.
    await persisted(store, {
      type: "workspaces.loaded",
      actor: "system",
      workspaces: [
        { id: "ws-2", repoId: "will/flows", name: "epic-librarian", targetBookmark: null, status: "running", provisioningStage: null, suspendedAt: null, createdAt: null },
        { id: "ws-1", repoId: "acme/viem", name: "main", targetBookmark: null, status: "suspended", provisioningStage: null, suspendedAt: null, createdAt: null }
      ]
    })
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-account]")
    expect(button).not.toBeNull()
    expect(button?.dataset.flow).toBe("account.show")
    expect(button?.textContent).toBe("Account")
    expect(button?.closest("[data-testid=chrome-actions]")).not.toBeNull()
    // Signed in, the chrome offers Account, not the sign-in line.
    expect(host.querySelector("[data-testid=chrome-sign-in]")).toBeNull()
    const order = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(order.indexOf("secrets.list")).toBeLessThan(order.indexOf("account.show"))
    expect(order.indexOf("account.show")).toBeLessThan(order.indexOf("appearance.dark-mode"))
    // The slash door offers the same registry entry the button is bound to.
    const slashNames = controller.slashTree("account.show").flatMap((row) => (row.kind === "flow" ? [row.flow.name] : []))
    expect(slashNames).toContain("account.show")

    await act(() => button?.click())
    await act(() => {})
    expect(scopesRead()).toBe(1)
    const card = host.querySelector<HTMLElement>('[data-kind="account"]')
    expect(card).not.toBeNull()
    expect(card?.getAttribute("aria-label")).toBe("Account · @will")
    expect(card?.querySelector("[data-testid=account-login]")?.textContent).toBe("GitHubConnected as @will")
    expect(card?.querySelector("[data-testid=account-access]")?.textContent).toBe("AccessAllowed")
    expect(card?.querySelector('[data-testid="account-scope-read:user"]')?.textContent).toBe("read:userSee your GitHub profile.")
    expect(card?.querySelector("[data-testid=account-scope-repo]")?.textContent).toBe("repoRead access to your repositories.")
    // Boxes list across repositories, sorted by repository then name.
    const boxes = [...(card?.querySelectorAll<HTMLElement>("[data-testid^=account-box-]") ?? [])].map((row) => row.textContent)
    expect(boxes).toEqual(["acme/viemmainsuspended", "will/flowsepic-librarianrunning"])
    // Exactly the seam-backed rows: two identity rows, two scopes, two boxes.
    expect(card?.querySelectorAll("tbody tr")).toHaveLength(6)
    const signOut = card?.querySelector<HTMLButtonElement>('[data-flow="auth.sign-out"]')
    expect(signOut?.textContent).toBe("Sign out")
    expect(card?.querySelectorAll(".world-card-list button")).toHaveLength(1)
    // No billing, usage, seat or invented rows.
    for (const banned of ["$", "Usage", "Seats", "Runs", "box-hours", "Notifications", "Remembered"]) {
      expect(card?.textContent).not.toContain(banned)
    }

    // The agent door reads the same facts back, so the model never guesses who is signed in.
    const outcome = await controller.commands.runForAgent("account.show")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : "").toBe(
      "account: @will; access allowed; 2 GitHub scope(s); 2 box(es) listed"
    )
    // The same card is re-surfaced, never a second one.
    await act(() => {})
    expect(host.querySelectorAll('[data-kind="account"]')).toHaveLength(1)
  })

  test("signed in with no scopes answer and no boxes listed, those sections are absent, not empty", async () => {
    const { store, controller } = await cloudHarness({
      fetchImpl: async () => new Response(JSON.stringify({ status: "error" }), { status: 404, headers: { "content-type": "application/json" } })
    })
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    await persisted(store, { type: "identity.access.requested", actor: "user" })
    const { host, act } = mount(controller)
    await act(() => host.querySelector<HTMLButtonElement>("[data-testid=chrome-account]")?.click())
    await act(() => {})
    const card = host.querySelector<HTMLElement>('[data-kind="account"]')
    expect(card?.querySelector("[data-testid=account-access]")?.textContent).toBe("AccessRequested, waiting on an answer")
    expect(card?.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(card?.textContent).not.toContain("GitHub scopes")
    expect(card?.textContent).not.toContain("Boxes")
  })

  test("signed out, the click renders the sign-in step, never an empty account", async () => {
    const { store, controller } = await accountHarness()
    await persisted(store, {
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    const { host, act } = mount(controller)
    // Signed out, both doors stand: the direct sign-in line and Account.
    expect(host.querySelector("[data-testid=chrome-sign-in]")).not.toBeNull()
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-account]")
    expect(button).not.toBeNull()
    await act(() => button?.click())
    await act(() => {})
    expect(host.querySelector('[data-kind="account"]')).toBeNull()
    const prompt = [...host.querySelectorAll<HTMLButtonElement>('.message-cta[data-flow="auth.sign-in"]')]
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt.at(-1)?.textContent).toBe("Sign in with GitHub")
    const outcome = await controller.commands.runForAgent("account.show")
    expect(outcome).toEqual({ status: "executed", value: "signed out: the sign-in step is in the chat" })
  })

  test("host local renders no Account button: account.show needs an identity seam", async () => {
    const { controller } = await localHarness()
    expect(controller.commands.find("account.show")).toBeUndefined()
    const { host } = mount(controller)
    expect(host.querySelector("[data-testid=chrome-account]")).toBeNull()
    expect(host.querySelector('[data-flow="account.show"]')).toBeNull()
  })
})
/*
 * The History button: the button door of history.show, in the chrome that
 * belongs to no session (design session 2026-09-07: Wiki, Dispatcher, Flows,
 * Secrets, History, Account). It renders where the registry holds
 * history.show (the cloud host), its click runs the same registry entry the
 * /history.show slash runs, and the card appears in the chat signed out,
 * because the mythical history is a public mirror read.
 */
describe("the chrome-actions footer's History button", () => {
  const historyHarness = async (): Promise<{ store: AppStore; controller: AppControllerType; feedReads: () => number }> => {
    let feedReads = 0
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    const change = (changeId: string, commitId: string, description: string, parents: ReadonlyArray<string>) => ({
      change_id: changeId, commit_id: commitId, description, timestamp: "2026-09-07T00:00:00Z", parent_change_ids: parents
    })
    const { store, controller } = await cloudHarness({
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "https://app.test").pathname
        if (path === "/api/repos/will/flows") return answer({ default_bookmark: "main" })
        if (path === "/api/repos/will/flows/git/refs") {
          return answer([{ ref: "refs/heads/main", object: { sha: "aaa3000000000000000000000000000000000003", type: "commit" } }])
        }
        if (path === "/api/repos/will/flows/changes") {
          feedReads += 1
          return answer({
            items: [
              change("c-m3", "aaa3000000000000000000000000000000000003", "third", ["c-m2"]),
              change("c-m2", "aaa2000000000000000000000000000000000002", "second", ["c-m1"]),
              change("c-m1", "aaa1000000000000000000000000000000000001", "first", [])
            ],
            next_cursor: ""
          })
        }
        return answer({ status: "error" }, 404)
      }
    })
    return { store, controller, feedReads: () => feedReads }
  }

  test("host cloud renders it between Secrets and Account bound to history.show, and a signed-out click surfaces the honest empty state with its one door", async () => {
    const { store, controller, feedReads } = await historyHarness()
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
    })
    const { host, act } = mount(controller)
    const button = host.querySelector<HTMLButtonElement>("[data-testid=chrome-history]")
    expect(button).not.toBeNull()
    expect(button?.dataset.flow).toBe("history.show")
    expect(button?.textContent).toBe("History")
    expect(button?.querySelector("svg")).not.toBeNull()
    expect(button?.closest("[data-testid=chrome-actions]")).not.toBeNull()
    const order = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(order.indexOf("history.show")).toBe(order.indexOf("secrets.list") + 1)
    expect(order.indexOf("account.show")).toBe(order.indexOf("history.show") + 1)
    expect(order.indexOf("history.show")).toBeLessThan(order.indexOf("appearance.dark-mode"))
    const slashNames = controller.slashTree("history.show").flatMap((row) => (row.kind === "flow" ? [row.flow.name] : []))
    expect(slashNames).toContain("history.show")

    await act(() => button?.click())
    for (let tick = 0; tick < 50 && !store.collections.cards.has("history-will/flows"); tick += 1) await act(() => {})
    await act(() => {})
    // The mirror exposes no commit count (335fa4a763): the empty state never walks the change feed to estimate one.
    expect(feedReads()).toBe(0)
    const card = host.querySelector<HTMLElement>('[data-kind="history"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector("[data-testid=history-empty]")?.textContent).toBe("No mythical history yet.")
    const door = card?.querySelector<HTMLElement>("[data-testid=history-bootstrap]")
    expect(door?.dataset.flow).toBe("history.bootstrap")
    // The one door is the only button in the empty state; no fold or amend door is invented.
    expect(card?.querySelectorAll("[data-flow^=history]").length).toBe(1)
    controller.dispose()
  })
})
