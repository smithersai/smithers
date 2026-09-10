import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { PALETTES } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { agentToolSpecs, executeAgentToolCall } from "./agentTools"
import { visibleItems } from "./Commands"
import {
  matches,
  namespaceOf,
  namespacesOf,
  parseSubmit,
  recommendedNames,
  SLASH_MENU_CAP,
  slashItems,
  slashTree,
  SURFACE_FLOWS
} from "./registry"
import type { CommandState } from "./registry"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const freshController = async (bootstrap?: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, { bootstrap })
  }
}

const chatState: CommandState = {
  surface: "chat",
  typing: false,
  hasConnectors: false,
  admin: false,
  signedOut: false
}

describe("command registry pure model", () => {
  test("connect leads the recommendations until work is connected", () => {
    expect(recommendedNames(chatState)[0]).toBe("connect")
    expect(recommendedNames({ ...chatState, hasConnectors: true })[0]).toBe("wiki")
    expect(recommendedNames({ ...chatState, surface: "world" })[0]).toBe("chat")
    expect(recommendedNames({ ...chatState, typing: true })).toEqual(["chat.stop"])
  })

  test("signed-out, sign-in is the only step", () => {
    expect(recommendedNames({ ...chatState, signedOut: true })).toEqual(["auth.sign-in"])
    // Typing still outranks everything.
    expect(recommendedNames({ ...chatState, signedOut: true, typing: true })).toEqual(["chat.stop"])
  })

  test("slash filtering matches name and summary, case-insensitively", () => {
    const command = { name: "connect", summary: "Connect work to Smithers" }
    expect(matches(command, "con")).toBe(true)
    expect(matches(command, "WORK")).toBe(true)
    expect(matches(command, "zzz")).toBe(false)
    expect(matches(command, "")).toBe(true)
  })

  test("a needle that names a flow exactly leads the listing, ahead of a summary match", () => {
    // The shape of the real defect: /flows listed flow.list first, because
    // its summary reads "List the workflows on your workspace" and it is
    // declared earlier in the registry than the flow actually named `flows`.
    const commands = [
      { name: "flow.list", summary: "List the workflows on your workspace" },
      { name: "flows", summary: "List everything Smithers can do" }
    ]
    const items = slashItems(chatState, "flows", commands)
    expect(items.map((item) => item.flow.name)).toEqual(["flows", "flow.list"])
  })

  test("a name match outranks a summary-only match, even when the summary match is recommended", () => {
    const commands = [
      // `connect` is chatState's leading recommendation, and its summary
      // happens to carry the needle. A name match still leads.
      { name: "connect", summary: "Connect the repos you work in" },
      { name: "repos.import", summary: "Import one to the cloud" },
      { name: "repos.list", summary: "Show them" }
    ]
    expect(slashItems(chatState, "repos", commands).map((item) => item.flow.name)).toEqual([
      "repos.import",
      "repos.list",
      "connect"
    ])
  })

  test("an exact name outranks the recommendation, which still leads a bare /", () => {
    const commands = [
      { name: "connect", summary: "Connect work to Smithers" },
      { name: "keys", summary: "Your connected keys" }
    ]
    // connect is chatState's recommendation; naming keys beats it.
    expect(slashItems(chatState, "", commands)[0]?.flow.name).toBe("connect")
    const named = slashItems(chatState, "keys", commands)
    expect(named[0]?.flow.name).toBe("keys")
    expect(named[0]?.recommended).toBe(false)
    // Naming the recommendation itself keeps it flagged as one.
    expect(slashItems(chatState, "connect", commands)[0]).toEqual({
      flow: commands[0],
      recommended: true
    })
  })

  test("the exact match is never listed twice", () => {
    const commands = [
      { name: "connect", summary: "Connect work to Smithers" },
      { name: "connectors", summary: "Manage connectors" }
    ]
    const items = slashItems(chatState, "connect", commands)
    expect(items.map((item) => item.flow.name)).toEqual(["connect", "connectors"])
  })

  test("the slash listing puts the recommended command first", () => {
    const commands = [
      { name: "wiki", summary: "w" },
      { name: "connect", summary: "c" }
    ]
    const items = slashItems(chatState, "", commands)
    expect(items[0]?.flow.name).toBe("connect")
    expect(items[0]?.recommended).toBe(true)
    expect(items.filter((item) => item.recommended)).toHaveLength(2)
  })

  /*
   * §1.2: signed out, the listing offers only what works signed out. The
   * flows that need a session stay INVOKABLE — typing one defers through
   * sign-in (§6.2) — they are just not presented as available.
   */
  test("the signed-out listing offers nothing that needs a session", () => {
    const commands = [
      { name: "auth.sign-in", summary: "Sign in with GitHub" },
      { name: "auth.sign-out", summary: "Sign out", requires: ["signed-in"] },
      { name: "issues.create", summary: "Create an issue", requires: ["signed-in"] },
      { name: "wiki", summary: "What Smithers understands" }
    ]
    const signedOut = slashItems({ ...chatState, signedOut: true }, "", commands)
    expect(signedOut.map((item) => item.flow.name)).toEqual(["auth.sign-in", "wiki"])
    const signedIn = slashItems(chatState, "", commands)
    expect(signedIn.map((item) => item.flow.name)).toContain("issues.create")
  })

  describe("the slash menu caps at SLASH_MENU_CAP", () => {
    // 20 flows named a0..a19, all prefix-matching "a" and all containing "a".
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `a${index}`,
      summary: `Flow number ${index}`
    }))

    test("a bare / lists at most the cap, not every registered flow", () => {
      expect(many.length).toBeGreaterThan(SLASH_MENU_CAP)
      expect(slashItems(chatState, "", many).length).toBe(SLASH_MENU_CAP)
    })

    test("a prefix query is capped too — a prefix names a set, not a flow", () => {
      expect(slashItems(chatState, "a", many).length).toBe(SLASH_MENU_CAP)
    })

    test("a flow named outright is never cut", () => {
      const named = slashItems(chatState, "a19", many)
      expect(named.length).toBeLessThanOrEqual(SLASH_MENU_CAP)
      expect(named[0]?.flow.name).toBe("a19")
    })

    test("a recommendation survives the cap and still leads a bare /", () => {
      const withRecommendation = [{ name: "connect", summary: "Connect work to Smithers" }, ...many]
      const items = slashItems(chatState, "", withRecommendation)
      expect(items.length).toBe(SLASH_MENU_CAP)
      expect(items[0]?.flow.name).toBe("connect")
      expect(items[0]?.recommended).toBe(true)
    })

    test("recency ranks the remainder that gets in", () => {
      const recent = slashItems({ ...chatState, recent: ["a19", "a18"] }, "", many)
      expect(recent.length).toBe(SLASH_MENU_CAP)
      expect(recent.map((item) => item.flow.name)).toContain("a19")
      expect(recent.map((item) => item.flow.name)).toContain("a18")
    })
  })

  /*
   * §6.4 vs §5.7: `data-flows` on the app shell is the whole registry
   * manifest — hidden id-scoped actions included, because the agent's tool
   * catalog is not a secret — while `/flows` is what a person can ask for.
   * The two lists differ by exactly the hidden set and by nothing else.
   */
  /*
   * The namespace tree. A flow's namespace is its dotted head; the only bare
   * names are the four surface switches.
   */
  /*
   * Will renamed World to Wiki (2026-09-07). The wiki.* names are canonical
   * and the world.* names stay registered as hidden aliases, so a saved
   * transcript or a parked command still resolves while nothing lists them.
   */
  test("/wiki is the visible surface switch and /world its hidden alias", async () => {
    const { controller } = await freshController()
    const visibleNames = visibleItems(controller.commands).map((command) => command.name)
    expect(visibleNames).toContain("wiki")
    expect(visibleNames).toContain("wiki.new-note")
    expect(visibleNames.filter((name) => name === "world" || name.startsWith("world."))).toEqual([])
    for (const name of ["world", "world.new-note", "world.select", "world.delete", "world.delete.confirm", "world.delete.cancel"]) {
      const alias = controller.commands.find(name)
      expect(alias).toBeDefined()
      expect(alias?.metadata.hidden).toBe(true)
    }
    const rows = controller.slashTree("wi").map((row) => (row.kind === "flow" ? row.flow.name : row.kind === "namespace" ? `${row.namespace.id}/` : row.text))
    expect(rows).toContain("wiki")
    expect(rows).toContain("wiki.new-note")
    expect(rows.some((row) => row === "world" || row.startsWith("world"))).toBe(false)
    expect(controller.slashTree("world").filter((row) => row.kind === "flow").map((row) => row.kind === "flow" ? row.flow.name : "")).toEqual([])
    expect(parseSubmit("/world", controller.commands.all())).toEqual({ kind: "command", name: "world" })
  })

  test("every visible flow lives in a namespace, except the surface switches", async () => {
    const { controller } = await freshController()
    const orphans = visibleItems(controller.commands)
      .map((command) => command.name)
      .filter((name) => namespaceOf(name) === undefined && !SURFACE_FLOWS.includes(name) && name !== "tut")
    expect(orphans).toEqual([])
  })

  test("namespaces list only where a visible flow lives, in display order", () => {
    const commands = [
      { name: "chat", summary: "" },
      { name: "tab.terminal", summary: "" },
      { name: "appearance.theme", summary: "" },
      { name: "appearance.dark-mode", summary: "" },
      { name: "toast.dismiss", summary: "", hidden: true },
      { name: "zeta.one", summary: "" }
    ]
    expect(namespacesOf(commands).map((row) => [row.id, row.count])).toEqual([
      ["appearance", 2],
      ["tab", 1],
      ["zeta", 1]
    ])
    expect(namespacesOf(commands).find((row) => row.id === "appearance")?.label).toBe("Appearance")
  })

  test("a bare / is the tree's top level: recommendations, surfaces, then namespace rows", () => {
    const commands = [
      { name: "connect", summary: "Connect" },
      { name: "wiki", summary: "Wiki" },
      { name: "chat", summary: "Chat" },
      { name: "appearance.dark-mode", summary: "Toggle" },
      { name: "appearance.theme", summary: "Theme" },
      { name: "tab.terminal", summary: "Terminal" },
      { name: "chat.clear", summary: "Clear" }
    ]
    const rows = slashTree(chatState, "", commands)
    expect(rows.map((row) => (row.kind === "flow" ? row.flow.name : row.kind === "namespace" ? `${row.namespace.id}/` : row.text))).toEqual([
      "connect",
      "wiki",
      "chat",
      "chat/",
      "appearance/",
      "tab/"
    ])
    expect(rows[0]?.kind === "flow" && rows[0].recommended).toBe(true)
    // No loose leaf at the top: the toggle is reachable through its namespace.
    expect(rows.some((row) => row.kind === "flow" && row.flow.name === "appearance.dark-mode")).toBe(false)
  })

  test("a namespace head with the dot lists that branch, uncapped; any other text is the flat filter", () => {
    const many = Array.from({ length: SLASH_MENU_CAP + 4 }, (_, index) => ({
      name: `tab.flow-${index}`,
      summary: `Tab flow ${index}`
    }))
    const commands = [{ name: "chat", summary: "Chat" }, { name: "appearance.dark-mode", summary: "Toggle" }, ...many]
    const branch = slashTree(chatState, "tab.", commands)
    expect(branch).toHaveLength(many.length)
    expect(branch.every((row) => row.kind === "flow" && row.flow.name.startsWith("tab."))).toBe(true)
    // Typing part of a namespace offers it as a row above the flat matches.
    const partial = slashTree(chatState, "app", commands)
    expect(partial[0]).toEqual({
      kind: "namespace",
      namespace: { id: "appearance", label: "Appearance", summary: "Theme and colors" },
      count: 1
    })
    // A name known by heart still leads, exactly as the flat filter ranks it.
    const exact = slashTree(chatState, "appearance.dark-mode", commands)
    expect(exact[0]?.kind === "flow" && exact[0].flow.name).toBe("appearance.dark-mode")
    const fuzzy = slashTree(chatState, "dark", commands)
    expect(fuzzy.map((row) => (row.kind === "flow" ? row.flow.name : ""))).toEqual(["appearance.dark-mode"])
  })

  test("/flows and the data-flows manifest differ by exactly the hidden set", async () => {
    const { controller } = await freshController()
    const manifest = controller.commands.all().map((command) => command.name)
    const listed = visibleItems(controller.commands).map((command) => command.name)
    const hidden = controller.commands
      .all()
      .filter((command) => command.hidden === true)
      .map((command) => command.name)
    expect(hidden.length).toBeGreaterThan(0)
    expect(listed).toEqual(manifest.filter((name) => !hidden.includes(name)))
    expect(listed.some((name) => hidden.includes(name))).toBe(false)
  })

  test("parseSubmit resolves empty, bare command, args command, and prompt", () => {
    const commands = [
      { name: "world", summary: "w" },
      { name: "browser", summary: "b", args: "<url>" }
    ]
    expect(parseSubmit("", commands)).toEqual({ kind: "empty" })
    expect(parseSubmit("/", commands)).toEqual({ kind: "empty" })
    expect(parseSubmit("/world", commands)).toEqual({ kind: "command", name: "world" })
    expect(parseSubmit("/browser https://example.com", commands)).toEqual({
      kind: "command",
      name: "browser",
      args: "https://example.com"
    })
    expect(parseSubmit("/world with trailing text", commands)).toEqual({
      kind: "prompt",
      text: "/world with trailing text"
    })
    expect(parseSubmit("hello there", commands)).toEqual({ kind: "prompt", text: "hello there" })
  })

  describe("parseSubmit command boundary", () => {
    const commands = [
      { name: "goal", summary: "Set the goal", args: "<text>" },
      { name: "goal.show", summary: "Show the goal" },
      { name: "no-args", summary: "No arguments" }
    ]

    test.each(
      [
        ["", { kind: "empty" }],
        ["   \t\n", { kind: "empty" }],
        ["/", { kind: "empty" }],
        ["  /  ", { kind: "empty" }],
        ["/goal", { kind: "command", name: "goal" }],
        ["  /goal  ", { kind: "command", name: "goal" }],
        ["/goal.show", { kind: "command", name: "goal.show" }],
        ["/goal ship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\tship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\nship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\r\nship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal\u00a0ship it", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal   ship it   ", { kind: "command", name: "goal", args: "ship it" }],
        ["/goal first\nsecond", { kind: "command", name: "goal", args: "first\nsecond" }]
      ] as const
    )("parses %j", (input, expected) => {
      expect(parseSubmit(input, commands)).toEqual(expected)
    })

    test.each([
      "goal",
      "hello /goal",
      "//goal",
      "/Goal",
      "/GOAL",
      "/goal!",
      "/goal/child",
      "/goal..show",
      "/no-args surprise"
    ])("keeps %j as an agent prompt", (input) => {
      expect(parseSubmit(input, commands)).toEqual({ kind: "prompt", text: input.trim() })
    })

    /*
     * §23.5: flow SYNTAX that names no registered flow is the app's to
     * answer. Handing it to the model as prose is what made `/reset` on a
     * non-admin session run `retry`.
     */
    test.each([
      ["/unknown", "unknown"],
      ["/unknown words", "unknown"],
      ["/goal.show.more", "goal.show.more"],
      ["/reset", "reset"]
    ])("refuses %j by name instead of improvising", (input, name) => {
      expect(parseSubmit(input, commands)).toEqual({ kind: "unknown-command", name })
    })

    test("does not mutate the registry or depend on command order", () => {
      const reversed = [...commands].reverse()
      expect(parseSubmit("/goal.show", commands)).toEqual(parseSubmit("/goal.show", reversed))
      expect(commands.map((command) => command.name)).toEqual(["goal", "goal.show", "no-args"])
    })
  })
})

describe("§17.4 — no checkout is exposed to an MVP account", () => {
  test("an MVP session has no billing.upgrade or billing.portal at all", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "codeplanesmithers",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    const names = controller.commands.all().map((command) => command.name)
    expect(names).not.toContain("billing.upgrade")
    expect(names).not.toContain("billing.portal")
    // Absent, not hidden: invoking by name resolves exactly like a typo.
    expect((await controller.commands.run("billing.upgrade", "pro")).status).toBe("unknown-command")
    // The balance READ stays — knowing what you have is not a checkout.
    expect(names).toContain("billing.balance")
  })

  test("an admin session still has them, so the seam stays testable", async () => {
    const { store, controller } = await freshController()
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: true,
      scopesPlain: null
    })
    const names = controller.commands.all().map((command) => command.name)
    expect(names).toContain("billing.upgrade")
    expect(names).toContain("billing.portal")
  })
})

describe("command registry bindings", () => {
  test("bootstrap capabilities are the single registration gate for local and cloud flows", async () => {
    const local = await freshController({
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "local",
      capabilities: ["local.repositories", "local.targets", "local.terminal", "local.harnesses"],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    })
    const localNames = local.controller.commands.all().map((command) => command.name)
    expect(localNames).toContain("repo.open")
    expect(localNames).toContain("target.run")
    expect(localNames).toContain("tab.terminal")
    expect(localNames).not.toContain("auth.sign-in")
    expect(localNames).not.toContain("issues.list")
    expect(localNames).not.toContain("flow.run")
    expect(localNames).not.toContain("browser.open")

    const cloud = await freshController({
      apiVersion: 1,
      host: "cloud",
      version: "test",
      buildSha: "cloud",
      capabilities: ["agent", "identity", "cloud", "browser.read"],
      authFlow: "redirect",
      sandbox: null
    })
    const cloudNames = cloud.controller.commands.all().map((command) => command.name)
    expect(cloudNames).toContain("auth.sign-in")
    expect(cloudNames).toContain("issues.list")
    expect(cloudNames).toContain("flow.run")
    expect(cloudNames).toContain("browser.open")
    expect(cloudNames).not.toContain("repo.open")
    expect(cloudNames).not.toContain("target.run")
    expect(cloudNames).not.toContain("tab.terminal")
    const withoutBrowser = await freshController({
      apiVersion: 1, host: "cloud", version: "test", buildSha: "cloud",
      capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null
    })
    expect(withoutBrowser.controller.commands.all().map((command) => command.name)).not.toContain("browser.open")
    expect((await withoutBrowser.controller.commands.runForAgent("browser.open", "https://example.com")).status).toBe("unavailable")
    local.controller.dispose(); cloud.controller.dispose(); withoutBrowser.controller.dispose()
  })

  /*
   * The tool schema is model-facing documentation. An example name the model
   * copies has to be a name the registry answers, or the turn spends itself on
   * an unknown-command result; the example said "browser" while the registry
   * only ever declared "browser.open".
   */
  test("every example command name in the model tool schema is a registered flow", async () => {
    const { controller } = await freshController()
    const registered = new Set(controller.commands.all().map((command) => command.name))
    const strings = (value: unknown): ReadonlyArray<string> =>
      typeof value === "string"
        ? [value]
        : typeof value === "object" && value !== null
        ? Object.values(value as Record<string, unknown>).flatMap(strings)
        : []
    const examples = agentToolSpecs
      .flatMap((spec) => strings(spec))
      .flatMap((text) => [...text.matchAll(/e\.g\. "([^"]+)"/g)])
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
    expect(examples.length).toBeGreaterThan(0)
    expect(examples.filter((example) => !registered.has(example.replace(/^\//, "")))).toEqual([])
    controller.dispose()
  })

  test("every registered action executes through the one run path", async () => {
    const { store, controller } = await freshController()
    const names = controller.commands.all().map((command) => command.name)
    expect(names).toEqual([
      "connect",
      "wiki",
      "world",
      "flows",
      "plugins",
      "appearance.theme",
      "appearance.dark-mode",
      "chat.surfaces",
      "debug.verbose",
      "system.recommend",
      "chat",
      "chat.retry",
      "chat.stop",
      "chat.send",
      "chat.clear",
      "browser.open",
      "flow.create",
      "flow.repo.choose",
      "flow.run.stop",
      "flow.run.retry",
      "flow.list",
      "flow.run",
      "triggers.list",
      "triggers.register",
      "factory.show",
      "runs.list",
      "runs.open",
      "runs.resume",
      "runs.rerun",
      "runs.signal",
      "runs.steer",
      "runs.seat",
      "runs.thinking",
      "runs.tools",
      "runs.logs",
      "runs.steps",
      "runs.trace.filter",
      "runs.trace.select",
      "runs.coding.select",
      "runs.trace.view",
      "runs.trace.live",
      "runs.events",
      "flow.run.stop-all",
      "approvals.list",
      "approvals.open",
      "card.maximize",
      "card.minimize",
      "card.dismiss",
      "frame.back",
      "frame.forward",
      "frame.fork",
      "chat.copy-message",
      "approval.approve",
      "approval.deny",
      "connector.add",
      "connector.downgrade",
      "connector.remove.ask",
      "connector.remove",
      "connector.remove.cancel",
      "wiki.cloud",
      "wiki.cloud.open",
      "wiki.sync",
      "wiki.edit",
      "wiki.card.select",
      "wiki.card.view",
      "wiki.new-note",
      "wiki.select",
      "wiki.open",
      "wiki.backlinks",
      "wiki.graph",
      "wiki.heading",
      "wiki.delete",
      "wiki.delete.confirm",
      "wiki.delete.cancel",
      "world.new-note",
      "world.select",
      "world.delete",
      "world.delete.confirm",
      "world.delete.cancel",
      "auth.sign-in",
      "auth.prompt",
      "auth.sign-out",
      "auth.request-access",
      "account.show",
      "storage.recovery",
      "storage.recovery.export",
      "cloud.sign-in",
      "cloud.prompt",
      "cloud.sign-out",
      "toast.dismiss",
      "billing.balance",
      "repos.import",
      "issues.list",
      "issues.view",
      "issues.create",
      "issues.close",
      "issues.reopen",
      "issues.comment",
      "prs.list",
      "prs.view",
      "prs.create",
      "prs.land",
      "prs.review",
      // The repository welcome and its three answers, and the read-only feature sketch (controller/onboarding.ts).
      "repo.welcome",
      "repo.maintain",
      "repo.contribute",
      "repo.explore",
      "repo.home",
      "feature.prototype",
      // §17.4: billing.upgrade / billing.portal register in the ADMIN plugin
      // only — no checkout is exposed to an MVP account.
      "notifications.list",
      "notifications.read",
      "env.view",
      "env.set",
      "secrets.list",
      // The mythical history (design session 2026-09-07 §3): the read and its three refusing write doors.
      "history.show",
      "history.bootstrap",
      "history.amend",
      "history.fold",
      "branches.list",
      "files.list",
      "files.read",
      "code.hover",
      "code.definition",
      "code.diagnostics",
      // Lane sync: Linear and GitHub sync as actions (ADR 0005).
      "github.app",
      "github.app.open",
      "github.reconcile",
      "github.mirror-sync",
      "github.mirror.retry-ref",
      "repos.import.retry",
      "linear.connect",
      "linear.connect.open",
      "linear.connect.team",
      "linear.connect.repo",
      "linear.connect.confirm",
      "linear.sync",
      "linear.activity",
      "linear.disconnect",
      "sync.retry",
      "sync.ops.show-more",
      "sync.ops.load-older",
      "issues.link-linear",
      "issues.unlink-linear",
      // Lane citc: the cloud workspaces (ADR 0002).
      "workspace.list",
      "workspace.open",
      "workspace.view",
      "workspace.terminal",
      "workspace.suspend",
      "workspace.resume",
      "workspace.fork",
      "workspace.snapshot",
      "workspace.snapshot.delete",
      "workspace.snapshot.fork",
      "workspace.template",
      "workspace.sessions",
      "workspace.session.destroy",
      "workspace.delete",
      "workspace.facet",
      // Lane L3: the workspace facets plue#449 answers, and the sandbox egress audit.
      "workspace.files",
      "workspace.file",
      "workspace.services",
      "workspace.egress",
      // Lane L3b: the NixOS desktop (a minted credential, so confirmed) and the environment images.
      "workspace.desktop",
      "workspace.desktop.rotate",
      "workspace.images",
      "egress.session",
      "change.view",
      "change.diff",
      "change.land",
      "change.split-ready",
      "change.split",
      "change.resolve",
      "change.revert",
      "change.facet",
      "change.pins",
      "change.checks",
      "change.open-computer",
      "review.since-mine",
      "review.done",
      "review.ack",
      "review.reopen",
      "review.request",
      "review.unrequest",
      "findings.please-fix",
      "findings.not-useful",
      "chat.reload",
      "chat.commands",
      "tab.terminal",
      "tab.read",
      "tab.harness",
      "agent.role",
      "agent.delegate",
      "agent.explain",
      // Agents as data (docs/workbench-lanes/custom-agents.md).
      "agent.list",
      "agent.new",
      // THE FORM LAW (docs/workbench-lanes/flow-forms.md): the generic form card's acts.
      "form.set",
      "form.submit",
      "agent.create",
      "agent.edit",
      "agent.remove",
      "agent.models",
      "tab.card",
      "tab.select",
      "tab.close",
      "tab.close.confirm",
      "tab.close.cancel",
      "tab.menu",
      "repo.select",
      "repo.unpin",
      "repo.tree",
      "workspace.rename",
      "workspace.rename.edit",
      "composer.add",
      "files.add",
      "repo.open",
      "target.run",
      "target.run.pattern",
      "target.open",
      "target.filter",
      "target.select",
      "target.star",
      "target.unstar",
      "target.expand",
      "target.pick",
      "target.run.set",
      // The target-graph cards (docs/LOCAL-APP.md "Cards: target graph").
      "target.list",
      "target.graph",
      "target.graph.focus",
      "target.graph.filter",
      "target.timeline",
      "target.history",
      "target.runs.select",
      "target.run.scrub",
      "target.affected",
      "target.ci",
      "target.source.open",
      "smithers.who",
      "search.open",
      "search.files",
      "search.symbols",
      "search.text",
      "search.flows",
      "search.targets",
      "search.wiki",
      "search.history",
      "search.runs",
      "search.changes",
      "search.issues",
      "search.boxes",
      "search.secrets",
      "search.people",
      "palette.open",
      "palette.actions",
      "palette.recent",
      "plugins.list",
      "plugins.install",
      "plugins.remove",
      "tut",
      "debug.reset",
      "onboarding.act"
    ])

    expect((await controller.commands.run("connect")).status).toBe("executed")
    expect(store.session().surface).toBe("connectors")
    // Toggles toggle (§2c): invoking the open pane's command returns to chat.
    expect((await controller.commands.run("connect")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("wiki")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
    expect((await controller.commands.run("wiki")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    // The hidden `world` alias updates the same embedded Wiki card.
    expect((await controller.commands.run("world")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect([...store.collections.cards.values()].filter((card) => card.kind === "world")).toHaveLength(1)
    expect((await controller.commands.run("chat")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")

    const before = store.session().theme
    expect((await controller.commands.run("appearance.dark-mode")).status).toBe("executed")
    expect(store.session().theme).not.toBe(before)

    expect((await controller.commands.run("wiki.new-note")).status).toBe("executed")
    const note = [...store.collections.worldDocuments.values()].find((document) => document.path.startsWith("Untitled"))
    expect(note).toBeDefined()
    // §10.6: deleting ASKS. The question is the flow's whole effect; the
    // answer is an act of its own, from the composer as from the trash button.
    expect((await controller.commands.run("wiki.delete", note?.id ?? "")).status).toBe("executed")
    expect(store.session().pendingWorldDeleteId).toBe(note?.id ?? "")
    expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeDefined()
    expect((await controller.commands.run("wiki.delete.cancel")).status).toBe("executed")
    expect(store.session().pendingWorldDeleteId).toBeNull()
    expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeDefined()
    // The hidden world.* aliases ask and answer through the same state.
    expect((await controller.commands.run("world.delete", note?.id ?? "")).status).toBe("executed")
    expect((await controller.commands.run("wiki.delete.confirm")).status).toBe("executed")
    expect(store.collections.worldDocuments.get(note?.id ?? "")).toBeUndefined()
    expect(store.session().pendingWorldDeleteId).toBeNull()
    // Nothing waiting: answering is refused rather than guessing a target.
    expect((await controller.commands.run("wiki.delete.confirm")).status).toBe("failed")

    expect((await controller.commands.run("does-not-exist")).status).toBe("unknown-command")
    // THE FORM LAW: a flow run without its required input renders its form; no door answers with a usage sentence.
    const formed = await controller.commands.run("connector.remove")
    expect(formed).toEqual({ status: "form", flow: "connector.remove", cardId: "form-connector.remove", fields: ["connectorId"] })
    expect(store.collections.cards.get("form-connector.remove")?.kind).toBe("flow-form")
  })

  test("admin commands are ABSENT for a non-admin session, present for an admin", async () => {
    const { store, controller } = await freshController()
    const names = controller.commands.all().map((command) => command.name)
    // Not hidden — absent. A non-admin session's enumeration surface has no trace.
    expect(names.some((name) => name.startsWith("admin."))).toBe(false)
    expect((await controller.commands.run("admin.health")).status).toBe("unknown-command")
    // The reset affordance is admin-only too (§2): /admin.reset for a
    // non-admin renders the same unknown-command state as any typo.
    expect(names).not.toContain("admin.reset")
    expect((await controller.commands.run("admin.reset")).status).toBe("unknown-command")
    expect(controller.slashItems("admin.reset")).toHaveLength(0)
    // The agent tool's list carries no trace either.
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    expect(listed).not.toContain("admin.")
    expect(listed).not.toContain("admin.reset")

    // Flip the session to admin (as a validated identity.session.loaded would).
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: true,
      scopesPlain: null
    })
    const adminNames = controller.commands.all().map((command) => command.name)
    expect(adminNames).toContain("admin.allowlist.add")
    expect(adminNames).toContain("admin.allowlist.remove")
    expect(adminNames).toContain("admin.grant")
    expect(adminNames).toContain("admin.requests")
    expect(adminNames).toContain("admin.health")
    expect(adminNames).toContain("admin.reset")
    expect(adminNames).toContain("admin.reset.ask")
    expect(adminNames).toContain("admin.reset.cancel")
    expect(adminNames).toContain("admin.devtools")
    expect((await controller.commands.run("admin.reset.ask")).status).toBe("executed")
    expect(store.session().resetConfirmOpen).toBe(true)
    expect((await controller.commands.run("admin.reset.cancel")).status).toBe("executed")
    expect(store.session().resetConfirmOpen).toBe(false)
    // The debug reads compose the admin-only registry + trigger axis.
    expect(adminNames).toContain("debug.snapshot")
    expect(adminNames).toContain("debug.events")
    expect(adminNames).toContain("debug.seams")
  })

  test("the trigger axis: user-only commands are invisible to and uncallable by the agent", async () => {
    const { controller } = await freshController()
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    const parsed = JSON.parse(listed) as { commands: Array<{ name: string }> }
    const agentNames = parsed.commands.map((command) => command.name)
    // Browser mechanics never appear in the agent's tool catalog.
    for (
      const userOnly of [
        "chat.stop",
        "chat.send",
        "card.maximize"
      ]
    ) {
      expect(agentNames).not.toContain(userOnly)
    }
    expect(agentNames).toContain("connect")
    expect(agentNames).toContain("browser.open")

    // Asking for one anyway gets an honest tool-result error naming the
    // visible alternative — never a silent refusal, never an execution.
    const signIn = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "chat.send" })
    })
    expect(signIn).toContain("user-only")
    expect(signIn).toContain("answer with text instead")

    // Every listed flow is a tool call (flows/invocable.test.ts pins the invariant).
    const theme = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "appearance.theme" })
    })
    expect(theme).toBe("executed /appearance.theme")

    // The user-only guard never leaks into the user path: the human's own
    // invocation still executes.
    expect((await controller.commands.run("appearance.theme")).status).toBe("executed")
  })

  /*
   * Two commands, two axes: /theme wears a color palette and /dark-mode
   * flips light and dark. Neither is the other's alias — the toggle used to
   * hide behind /theme, and repurposing the name without promoting the
   * toggle would have left the light/dark control unreachable by name.
   */
  test("the color theme and the light/dark toggle are independent commands", async () => {
    const { store, controller } = await freshController()
    const toggle = controller.commands.find("appearance.dark-mode")
    expect(toggle?.metadata.hidden).toBeUndefined()
    // Listed, so the human can find the toggle in the slash menu.
    expect(controller.slashItems("dark-mode").map((item) => item.flow.name)).toContain("appearance.dark-mode")
    // The args hint is what makes `/appearance.theme <palette>` parse as an invocation.
    expect(controller.commands.find("appearance.theme")?.metadata.args).toBeDefined()

    // The default palette is night-owl, and every key round-trips.
    expect(store.session().palette).toBe("night-owl")
    for (const palette of PALETTES) {
      expect((await controller.commands.run("appearance.theme", palette)).status).toBe("executed")
      expect(store.session().palette).toBe(palette)
    }
    const last = PALETTES[PALETTES.length - 1]
    expect(store.session().palette).toBe(last)

    // An unknown key never rounds to the nearest palette: it fails honestly,
    // opens the picker (the list of valid answers IS the interface), and
    // leaves the current palette alone.
    const unknown = await controller.commands.run("appearance.theme", "dracula")
    expect(unknown.status).toBe("failed")
    if (unknown.status === "failed") expect(unknown.error).toContain("night-owl")
    expect(store.session().palette).toBe(last)
    const picker = () => store.collections.cards.get("theme-picker")
    expect(picker()?.kind).toBe("theme-picker")
    if (picker()?.kind === "theme-picker") {
      expect(picker()?.payload).toEqual({ selected: last })
    }

    // Bare /theme surfaces the picker card with the current palette marked.
    expect((await controller.commands.run("appearance.theme")).status).toBe("executed")
    expect(picker()?.kind).toBe("theme-picker")
    if (picker()?.kind === "theme-picker") {
      expect(picker()?.payload).toEqual({ selected: last })
    }

    // Choosing from the picker keeps its "current" mark honest.
    expect((await controller.commands.run("appearance.theme", PALETTES[0] ?? "night-owl")).status).toBe("executed")
    if (picker()?.kind === "theme-picker") {
      expect(picker()?.payload).toEqual({ selected: PALETTES[0] })
    }
    expect((await controller.commands.run("appearance.theme", last ?? "night-owl")).status).toBe("executed")

    // The axes never touch: the toggle flips the theme and nothing else.
    const before = store.session().theme
    expect((await controller.commands.run("appearance.dark-mode")).status).toBe("executed")
    expect(store.session().theme).not.toBe(before)
    expect(store.session().palette).toBe(last)
  })

  test("a bare /name typed into the composer runs the command, not a prompt", async () => {
    const { store, controller } = await freshController()
    controller.changeDraft("/world")
    controller.send(store.session().draft)
    const deadline = Date.now() + 2_000
    while (!store.collections.cards.has("world-embedded") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
    expect(store.session().surface).toBe("chat")
    expect(store.session().draft).toBe("")
    expect([...store.collections.messages.values()].some((m) => m.text === "/world")).toBe(false)
  })

  test("slashItems surfaces the recommended command first for a bare /", async () => {
    const { controller } = await freshController()
    const items = controller.slashItems("")
    expect(items[0]?.flow.name).toBe("connect")
    expect(items[0]?.recommended).toBe(true)
  })

  /*
   * The registered catalog, not a fixture: typing a whole flow name and
   * pressing Enter runs THAT flow. The composer's Enter takes the first item
   * of this listing, so first-ness is the whole contract. Every registered
   * name is checked, because the defect this pins was one name whose text
   * happened to appear inside another flow's summary.
   */
  test("every registered flow leads its own name's listing", async () => {
    const { controller } = await freshController()
    const listed = controller.commands.all().filter((command) => command.hidden !== true)
    // Not a vacuous pass: the whole registered catalog is under test.
    expect(listed.length).toBeGreaterThan(40)
    const misdirected = listed
      .map((command) => ({ typed: command.name, leads: controller.slashItems(command.name)[0]?.flow.name }))
      .filter((row) => row.leads !== row.typed)
    expect(misdirected).toEqual([])
  })

  test("the agent tool lists commands and executes them through the same path", async () => {
    const { controller } = await freshController()
    const listed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    const parsed = JSON.parse(listed) as {
      state: { surface: string }
      commands: Array<{ name: string }>
    }
    expect(parsed.state.surface).toBe("chat")
    expect(parsed.commands.some((command) => command.name === "connect")).toBe(true)
    expect(parsed.commands.some((command) => command.name === "connector.remove")).toBe(false)

    const executed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "connect" })
    })
    expect(executed).toBe("executed /connect")

    // The recovery is in the error: the dead-end "unknown-command: nope"
    // left the live model telling the USER to run the command instead of
    // retrying with a listed name in the same turn.
    const unknown = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "nope" })
    })
    expect(unknown).toBe(
      "unknown-command: nope — no command has that name; use the list action for every command callable right now"
    )
  })

  test("the model may spell a command the way the catalog does — /name resolves to name", async () => {
    /*
     * The generated capability section spells every command "/name", and
     * live on canary the model echoed that spelling into the tool call:
     * execute {"name":"/browser"} died as unknown-command and the turn
     * degraded into asking permission for the act it had been asked to do.
     * The agent boundary strips the catalog's slash exactly as the
     * composer's parseSubmit strips the human's; the registry's names stay
     * bare.
     */
    const { store, controller } = await freshController()
    const executed = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/connect" })
    })
    expect(executed).toBe("executed /connect")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("connect-embedded")?.kind).toBe("connect")

    // The slash spelling resolves through the alias and executes now that the
    // look-and-feel flows are model-invocable (flows/invocable.test.ts).
    const theme = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/appearance.dark-mode" })
    })
    expect(theme).toBe("executed /appearance.dark-mode")

    // A bare "/" names nothing.
    const empty = await executeAgentToolCall(controller.commands, {
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/" })
    })
    expect(empty).toBe("failed: the execute action requires a command name")
  })
})
