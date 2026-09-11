import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import App from "../App"
import { SidebarRepositoryPicker } from "../Composer"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { backend, json, memoryStorage, nativeRepositories, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The composer's layout (will's brief, 2026-08-30): a header row above the box
 * holds the repository selector and where the repository lives (a local path,
 * or owner/repo on GitHub); inside the box the `+` (add files, a connector, a
 * flow, an agent) and the surface pill sit bottom-left. Every affordance is a
 * registered flow; every menu's open state is the session's.
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

const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const text = (node: Element | null): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim()

interface View {
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

const mount = (controller: AppControllerType, sidebar = false): View => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        {sidebar ? <SidebarRepositoryPicker /> : <App />}
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  const act = async (change: () => void): Promise<void> => {
    flushSync(change)
    await settled()
    flushSync(() => {})
  }
  return { host, act }
}

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

const byTestId = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const localController = async (harnesses: ReadonlyArray<unknown> = []) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, nativeRepositories, silentAgent, {
    bootstrap: localBootstrap,
    ...backend({
      "/api/harnesses": json(200, { harnesses }),
      "/api/repos": json(200, { repos: [] })
    })
  })
  await controller.loadHarnesses()
  await settled()
  return { store, controller }
}

describe("the composer header: the repository selector and where it lives", () => {
  test("no repository: the selector says Select a repo, no origin chip, and the chrome has no duplicate", async () => {
    const { controller } = await localController()
    const view = mount(controller)

    const trigger = byTestId(view.host, "composer-repo-trigger")
    expect(text(trigger)).toBe("Select a repo")
    expect(trigger?.dataset.connected).toBe("false")
    expect(trigger?.dataset.flow).toBe("connect")
    expect(byTestId(view.host, "repo-chip")).toBeNull()
    // The header holds the selector; the chrome bar no longer repeats it.
    expect(byTestId(view.host, "composer-header")?.contains(trigger)).toBe(true)
    expect(view.host.querySelector(".chrome-bar .repo-chip")).toBeNull()
    // The sidebar's Repos section offers the same one step when nothing is pinned, and nothing else binds repo.open there.
    const sidebarOpens = [...view.host.querySelectorAll(".chrome-bar [data-flow=\"repo.open\"]")]
    expect(sidebarOpens.map((el) => el.getAttribute("data-testid"))).toEqual(["repo-empty"])

    // Its menu offers the IDE's open-folder, through the registered flow.
    await view.act(() => trigger?.click())
    expect(controller.store.session().connectMenuOpen).toBe(true)
    const open = byTestId(view.host, "chrome-open-repo")
    expect(text(open)).toBe("Open local repository…")
    expect(open?.dataset.flow).toBe("repo.open")
    expect(controller.commands.find("repo.open")).toBeDefined()
  })

  test("a local repository: the selector names it and the origin chip shows the local path and branch", async () => {
    const { store, controller } = await localController()
    const view = mount(controller)

    await view.act(() => {
      void persisted(store, {
        type: "repos.loaded",
        actor: "system",
        repos: [{
          id: "smithers",
          path: "/Users/williamcory/smithers",
          name: "smithersai/smithers",
          git: { branch: "v1/rc0-migration", remote: "git@github.com:smithersai/smithers.git" },
          warnings: [],
          smithers: {
            detected: false,
            workspaceFile: null,
            declarationFiles: [],
            reason: "no WORKSPACE.ts",
            workspaces: []
          }
        }]
      })
    })
    await view.act(() => {})

    const selector = text(byTestId(view.host, "composer-repo-trigger"))
    expect(selector).toBe("smithersai/smithers")
    expect(byTestId(view.host, "composer-repo-trigger")?.dataset.connected).toBe("true")
    const chip = byTestId(view.host, "repo-chip")
    expect(chip?.dataset.origin).toBe("local")
    expect(chip?.title).toBe("/Users/williamcory/smithers")
    expect(text(chip?.querySelector(".composer-origin-name") ?? null)).toBe("~/smithers")
    expect(text(chip?.querySelector(".composer-origin-branch") ?? null)).toBe("· v1/rc0-migration")
    expect(text(chip)).toBe("~/smithers · v1/rc0-migration")
    expect(text(chip)).not.toContain("smithersai/smithers")
    expect(`${selector} ${text(chip)}`.match(/smithersai\/smithers/g)).toHaveLength(1)
  })

  test("a loaded GitHub repository: the origin chip does not repeat the selector's owner/repo", async () => {
    const { store, controller } = await localController()
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: null }]
    })
    await persisted(store, { type: "repo.selected", actor: "user", id: "smithersai/smithers" })
    const view = mount(controller)
    await view.act(() => {})

    expect(text(byTestId(view.host, "composer-repo-trigger"))).toBe("smithersai/smithers")
    const chip = byTestId(view.host, "repo-chip")
    expect(chip?.dataset.origin).toBe("cloud")
    expect(text(chip)).not.toContain("smithersai/smithers")
    expect(text(chip?.querySelector(".composer-origin-name") ?? null)).toBe("head")
  })

  test("a repository at its head: the origin chip reads `head @ <change id>` (lane piper step 4)", async () => {
    const { store, controller } = await localController()
    await persisted(store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: { bookmark: "main", changeId: "qupxosqw", commitId: "abc123" } }
      ]
    })
    await persisted(store, { type: "repo.selected", actor: "user", id: "will/flows" })
    const view = mount(controller)
    await view.act(() => {})

    expect(text(byTestId(view.host, "composer-repo-trigger"))).toBe("will/flows")
    const chip = byTestId(view.host, "repo-chip")
    expect(chip?.dataset.origin).toBe("cloud")
    expect(text(chip?.querySelector(".composer-origin-name") ?? null)).toBe("head @ qupxosqw")
  })

  test("a local working copy with a jj probe: the origin chip reads `~/path · N ahead of main`", async () => {
    const { store, controller } = await localController()
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
        id: "smithers",
        path: "/Users/williamcory/smithers",
        name: "smithers",
        git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
        jj: { changeId: "kxyz", commitId: "deadbeef", ahead: 3, bookmark: "main" },
        warnings: [],
        smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] }
      }]
    })
    await persisted(store, {
      type: "repo.selected",
      actor: "user",
      id: "smithersai/smithers#local:/Users/williamcory/smithers"
    })
    const view = mount(controller)
    await view.act(() => {})

    expect(text(byTestId(view.host, "composer-repo-trigger"))).toBe("smithersai/smithers · smithers")
    const chip = byTestId(view.host, "repo-chip")
    expect(chip?.dataset.origin).toBe("local")
    /* Lane change step 4: the probed checkout's pin rides the chip ahead of piper's ahead count. */
    expect(text(chip)).toBe("~/smithers · kxyz · deadbeef · 3 ahead of main")
  })

  test("a known revision pins `change#seq`; a newer one names itself only when both seqs are known", async () => {
    const { store, controller } = await localController()
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
        id: "smithers",
        path: "/Users/williamcory/smithers",
        name: "smithers",
        git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
        jj: { changeId: "kxyz", commitId: "deadbeef", ahead: 3, bookmark: "main" },
        warnings: [],
        smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] }
      }]
    })
    /* The changes collection knows kxyz at rev 2 of 5 (post-plue#450). */
    await persisted(store, {
      type: "change.loaded",
      actor: "system",
      change: {
        id: "smithersai/smithers#kxyz",
        repoId: "smithersai/smithers",
        changeId: "kxyz",
        commitId: "deadbeef",
        description: "pinned work",
        authorName: "will",
        timestamp: "2026-09-01T10:00:00Z",
        hasConflict: false,
        parentChangeIds: [],
        currentSeq: 2,
        revisionCount: 5
      }
    })
    await persisted(store, {
      type: "repo.selected",
      actor: "user",
      id: "smithersai/smithers#local:/Users/williamcory/smithers"
    })
    const view = mount(controller)
    await view.act(() => {})

    const chip = byTestId(view.host, "repo-chip")
    expect(text(chip)).toContain("kxyz#2")
    expect(text(chip)).toContain("rev 5 exists · view")
    const viewButton = [...(chip?.querySelectorAll("button") ?? [])].find((button) => button.dataset.flow === "change.view")
    expect(viewButton).toBeDefined()

    /* One seq unknown (today's DTO, plue#450): the bare change id, never a rev claim. */
    const plain = await localController()
    await persisted(plain.store, {
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "smithersai/smithers", org: "smithersai", ownerKind: "org", name: "smithers", head: { bookmark: "main", changeId: "qp", commitId: "c1" } }
      ]
    })
    await persisted(plain.store, {
      type: "repos.loaded",
      actor: "system",
      repos: [{
        id: "smithers",
        path: "/Users/williamcory/smithers",
        name: "smithers",
        git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
        jj: { changeId: "kxyz", commitId: "deadbeef", ahead: 3, bookmark: "main" },
        warnings: [],
        smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] }
      }]
    })
    await persisted(plain.store, {
      type: "repo.selected",
      actor: "user",
      id: "smithersai/smithers#local:/Users/williamcory/smithers"
    })
    const plainView = mount(plain.controller)
    await plainView.act(() => {})
    const plainChip = byTestId(plainView.host, "repo-chip")
    expect(text(plainChip)).toContain("kxyz")
    expect(text(plainChip)).not.toContain("#")
    expect(text(plainChip)).not.toContain("rev ")
  })
})

describe("the composer's + menu and surface pill", () => {
  test("+ opens a store-owned menu: Add files first, then a connector and an agent; the pill names the surface", async () => {
    const { store, controller } = await localController([{
      id: "claude",
      displayName: "Claude Code",
      binary: "/usr/local/bin/claude",
      version: "2.0.0",
      status: "signed-in",
      account: { email: "will@example.com" },
      launch: { argv: ["claude"] }
    }])
    const view = mount(controller)

    const add = byTestId(view.host, "composer-add")
    expect(add?.dataset.flow).toBe("composer.add")
    expect(controller.commands.find("composer.add")).toBeDefined()
    // Bottom-left: the + and the pill share the actions row, pill after +.
    const actions = view.host.querySelector(".composer-actions")
    expect(actions?.children[0]?.classList.contains("composer-add")).toBe(true)
    expect(actions?.children[1]?.classList.contains("composer-surfaces")).toBe(true)
    expect(text(byTestId(view.host, "composer-surface-trigger"))).toBe("Chat")

    expect(store.session().addMenuOpen).toBe(false)
    await view.act(() => add?.click())
    expect(store.session().addMenuOpen).toBe(true)
    const items = [...view.host.querySelectorAll<HTMLElement>("[data-testid=\"composer-add-menu\"] [role=\"menuitem\"]")]
    expect(items.map((item) => text(item))).toEqual([
      "Add files…",
      "New connector…",
      // The named roles (AgentRoles.ts): only the orchestrator's harness is installed in this fixture.
      "Orchestrator · Fable 5will@example.com",
      "Explainer · Kimi K3opencode-kimi is not installed",
      "Implementation · GPT-5.6 Solcodex is not installed",
      "Trivial implementation · GPT-5.6 Lunacodex is not installed",
      "UI · Kimi K3opencode-kimi is not installed",
      "Fast UI · Cerebras gpt-oss-120bopencode-cerebras is not installed",
      // The raw harness session, named like the sidebar's `+` names it; then the New agent form (custom-agents.md).
      "Claude Codewill@example.com",
      "New agent…"
    ])
    // The orchestrator's harness is installed, so its role row is enabled; the explainer's is not.
    expect(items[2]?.hasAttribute("disabled")).toBe(false)
    expect(items[3]?.hasAttribute("disabled")).toBe(true)
    expect(items[8]?.hasAttribute("disabled")).toBe(false)
    expect(items[9]?.hasAttribute("disabled")).toBe(false)
    expect(items.map((item) => item.dataset.flow)).toEqual([
      "files.add",
      "connector.add",
      ...Array<string>(6).fill("agent.role"),
      "tab.harness",
      "agent.new"
    ])
    // No Smithers Cloud on the local host: no flow.create, so no "New flow…" is offered.
    expect(controller.commands.find("flow.create")).toBeUndefined()

    // Add files… is honest about the host: no attach seam, one Smithers message, menu closed.
    await view.act(() => items[0]?.click())
    expect(store.session().addMenuOpen).toBe(false)
    await view.act(() => {})
    const messages = [...store.collections.messages.values()].map((message) => message.text)
    expect(messages.some((message) => message.startsWith("Attachments aren't available on this host yet"))).toBe(true)
  })

  test("Escape and an outside press close the + menu through the store", async () => {
    const { store, controller } = await localController()
    const view = mount(controller)

    await view.act(() => byTestId(view.host, "composer-add")?.click())
    expect(store.session().addMenuOpen).toBe(true)
    await view.act(() => {
      byTestId(view.host, "composer-add-menu")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      )
    })
    expect(store.session().addMenuOpen).toBe(false)

    await view.act(() => byTestId(view.host, "composer-add")?.click())
    expect(store.session().addMenuOpen).toBe(true)
    await view.act(() => {
      view.host.querySelector(".smithers-transcript")?.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    })
    expect(store.session().addMenuOpen).toBe(false)
  })

  test("the surface menu opens Wiki as an embedded card while the composer stays in chat", async () => {
    const { store, controller } = await localController()
    const view = mount(controller)

    await view.act(() => byTestId(view.host, "composer-surface-trigger")?.click())
    const items = [...view.host.querySelectorAll<HTMLElement>(".composer-surfaces [role=\"menuitem\"]")]
    expect(items.map((item) => item.dataset.flow)).toEqual(["chat", "connect", "wiki", "flows", "plugins"])
    await view.act(() => items[2]?.click())
    expect(store.session().surface).toBe("chat")
    expect(text(byTestId(view.host, "composer-surface-trigger"))).toBe("Chat")
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
  })

  /*
   * Ask 5 (will, 2026-09-02): "where it says connect chat and world an option
   * should also be flows which should allow us to look at flows". The entry is
   * a registered flow like the other three, and choosing it opens the pane.
   */
  test("choosing Flows opens the flows pane and the pill reads Flows", async () => {
    const { store, controller } = await localController()
    expect(controller.commands.find("flows")).toBeDefined()
    const view = mount(controller)

    await view.act(() => byTestId(view.host, "composer-surface-trigger")?.click())
    const items = [...view.host.querySelectorAll<HTMLElement>(".composer-surfaces [role=\"menuitem\"]")]
    await view.act(() => items[3]?.click())

    expect(store.session().surface).toBe("flows")
    expect(text(byTestId(view.host, "composer-surface-trigger"))).toBe("Flows")
    expect(view.host.querySelector(".flows-surface")).not.toBeNull()
  })

  /*
   * The pane is the flow.list card's own rows — one list, two mounts — so a
   * row's Run is the same flow.run binding it is in the transcript.
   */
  test("the flows pane renders the flow.list rows, each Run bound to flow.run", async () => {
    const { store, controller } = await localController()
    await persisted(store, {
      type: "card.upsert",
      actor: "user",
      card: {
        id: "workflow-list-acme/app",
        kind: "workflow-list",
        title: "Flows: acme/app",
        status: "active",
        createdAt: 1,
        ordinal: 4,
        payload: {
          repo: "acme/app",
          workflows: [
            { key: "review-pr", description: "Review an open PR" },
            { key: "release", description: null }
          ]
        }
      }
    })
    const view = mount(controller)
    await view.act(() => {
      store.dispatch({ type: "surface.changed", actor: "user", surface: "flows" })
    })

    const pane = view.host.querySelector<HTMLElement>(".flows-surface")
    expect(pane).not.toBeNull()
    const rows = [...(pane?.querySelectorAll<HTMLElement>(".workflow-list-row") ?? [])]
    expect(rows.map((row) => text(row.querySelector("strong")))).toEqual(["review-pr", "release"])
    expect(text(rows[0])).toContain("Review an open PR")
    expect(rows.map((row) => row.querySelector("button")?.dataset.flow)).toEqual(["flow.run", "flow.run"])
  })
})

test("signed-out sidebar loads public repositories and selects one without connection setup", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, { ...nativeRepositories, available: false }, silentAgent, {
    bootstrap: { ...localBootstrap, host: "cloud", capabilities: ["cloud"], authFlow: "redirect" },
    ...backend({ "/api/public/repos": json(200, { repos: [{ name: "smithersai/smithers" }] }) })
  })
  const view = mount(controller, true)
  await view.act(() => byTestId(view.host, "composer-repo-trigger")?.click())
  await settled()
  const menu = view.host.querySelector('[role="menu"]')
  expect(text(menu)).toContain("smithers")
  expect(text(menu)).not.toContain("Connect GitHub")
  expect(text(menu)).not.toContain("Sign in to Smithers Cloud")
  const choice = menu?.querySelector<HTMLButtonElement>('[data-flow="repo.select"]')
  expect(choice).not.toBeNull()
  await view.act(() => {
    choice?.focus()
    choice?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  })
  expect(view.host.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(byTestId(view.host, "composer-repo-trigger"))
  await view.act(() => byTestId(view.host, "composer-repo-trigger")?.click())
  await view.act(() => view.host.querySelector<HTMLButtonElement>('[data-flow="repo.select"]')?.click())
  expect(store.session().activeRepoKey).toBe("smithersai/smithers")
  expect(view.host.querySelector('[role="menu"]')).toBeNull()
  expect(text(byTestId(view.host, "composer-repo-trigger"))).toBe("smithersai/smithers")
  await controller.dispose()
})
