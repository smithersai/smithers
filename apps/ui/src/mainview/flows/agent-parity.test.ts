/*
 * The three-door law (apps/ui/AGENTS.md; docs/workbench-lanes/agent-parity.md):
 * every act is ONE flow with three doors — slash, button, agent. `userOnly`
 * is an enumerated exception for acts that are physically the human's
 * gesture or that the human alone may answer, and every such flow names its
 * reason in the registry. Consequential acts are agent-invocable WITH
 * `confirm`; they are never user-only because they are consequential.
 *
 * Will, 2026-09-03, after the agent said "I can't launch a Claude code
 * session": "anything we can do in the ui the agent should be able to do too".
 * This file is that rule as a gate: the allowlist below is every user-only
 * flow with its reason, and nothing else may be user-only.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { Harness, Repo } from "@smthrs/rpc/LocalApp"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { STORAGE_RECOVERY_USER_ONLY_REASON } from "../state/StorageRecoveryContract"
import { modelInvocable, nameOf } from "./registry"
import { PALETTE_ACTIONS_REASON, PALETTE_OPEN_REASON } from "./entries/palette"
import { PLUGINS_USER_ONLY_REASON } from "./entries/plugins"
import { WIKI_HEADING_USER_ONLY_REASON } from "./entries/wiki"

/**
 * Every user-only flow, with the reason the registry states. A flow user-only
 * for a reason not written here fails the gate; a flow written here that is
 * no longer user-only fails it too.
 */
const USER_ONLY_ALLOWLIST: Readonly<Record<string, string>> = {
  "storage.recovery.export": STORAGE_RECOVERY_USER_ONLY_REASON,
  "chat.send": "the composer is the human's; the model is already the turn, and sending would nest one",
  "chat.stop": "stopping the model's own turn is the human's Escape key",
  "chat.copy-message": "the clipboard write is the human's browser gesture",
  "flows": "a surface switch; the model lists flows with flow.list, which answers as an embedded card",
  "system.recommend": "the system's own refresh; a model must not steer what the human is offered next",
  "flow.repo.choose": "the answer to the which-repository card is the human's choice; a model must not provision on its guess",
  "card.maximize": "maximizing a card is the human's explicit act (THE EMBED LAW)",
  "card.minimize": "minimizing a card is the human's explicit act",
  "frame.back": "frame navigation is the human's browser gesture",
  "frame.forward": "frame navigation is the human's browser gesture",
  "frame.fork": "forking a frame is the human's browser gesture",
  "connector.remove.ask": "opens the human's confirm dialog; the act itself is connector.remove",
  "connector.remove.cancel": "a confirm-dialog answer is the human's",
  "wiki.delete.confirm": "a confirm-dialog answer is the human's",
  "wiki.delete.cancel": "a confirm-dialog answer is the human's",
  "wiki.heading": WIKI_HEADING_USER_ONLY_REASON,
  // The hidden world.* aliases (entries/world.ts) carry their wiki.* twins' reason.
  "world.delete.confirm": "a confirm-dialog answer is the human's",
  "world.delete.cancel": "a confirm-dialog answer is the human's",
  "auth.sign-in": "the GitHub OAuth redirect is the human's browser gesture; the agent renders the step with auth.prompt",
  "auth.sign-out": "dropping the human's session is theirs alone",
  "app.download": "a browser handoff the human clicks; the agent renders the step with app.download.prompt",
  "cloud.sign-in": "the Smithers Cloud browser login is the human's gesture on their account; the agent renders the step with cloud.prompt",
  "cloud.sign-out": "dropping the human's Smithers Cloud credential is theirs alone",
  "toast.dismiss": "dismissing a toast is the human's gesture",
  "tab.select": "focus is the human's",
  "tab.close.confirm": "a confirm-dialog answer is the human's",
  "tab.close.cancel": "a confirm-dialog answer is the human's",
  "tab.menu": "opening a menu is the human's gesture",
  "repo.select": "which pinned repository is active is the human's selection; an act names its working copy instead (tab.terminal [cwd])",
  "workspace.rename.edit": "opening the inline editor is the human's gesture; the agent names the workspace with workspace.rename",
  "composer.add": "opening the composer's menu is the human's gesture",
  "palette.open": PALETTE_OPEN_REASON,
  "plugins": PLUGINS_USER_ONLY_REASON,
  "palette.actions": PALETTE_ACTIONS_REASON,
  "target.filter": "the targets table's filter is the human's control; the agent lists targets with target.list",
  "target.select": "the targets table's row drawer is the human's control; the agent shows a target with target.open",
  "target.star": "starring is the human's own ranking of the table",
  "target.unstar": "starring is the human's own ranking of the table",
  "target.expand": "the targets table's grouped rows are the human's control",
  "target.pick": "picking a grouped row's members is the human's control",
  "target.run.set": "runs the members the human picked in the table; the agent runs a target by label with target.run",
  "target.graph.focus": "the graph drawer's own selection; the agent opens the graph focused with target.graph [label]",
  "target.graph.filter": "the graph canvas' own toolbar; the agent opens the graph focused with target.graph [label]",
  "target.run.scrub": "the replay slider is the human's gesture (time travel)",
  "target.source.open": "opens the declaration in the human's editor — a handoff off the app",
  "admin.reset": "destroys the whole store with no undo; the confirm dialog is the only door",
  "admin.reset.ask": "opens the human's confirm dialog for the reset",
  "admin.reset.cancel": "a confirm-dialog answer is the human's",
  "billing.upgrade": "external checkout with real money; the human clicks",
  "billing.portal": "the external billing portal; the human clicks",
  "admin.devtools": "the admin panel's presentation toggle",
  "debug.backend": "admin diagnostics; the agent must never reason about its engine",
  "debug.grants.reset": "revokes the chain's own session grants; the operator's act",
  "admin.grant.confirm": "a grant confirmation is the operator's own answer (approve:self)",
  "admin.grant.cancel": "a confirm-dialog answer is the human's",
  "approval.approve": "approvals belong to the human",
  "approval.deny": "approvals belong to the human",
  "admin.queue.approve": "approving an access request is the operator's own decision (approve:self)"
}

/** The policy table's agent rows (agent-parity.md): the args exercised and whether the act confirms. */
const AGENT_ROWS: ReadonlyArray<{ readonly name: string; readonly args?: string; readonly confirm: boolean }> = [
  { name: "runs.trace.filter", args: "run-1 failed", confirm: false },
  { name: "runs.trace.select", args: "run-1 frame-1", confirm: false },
  { name: "runs.trace.view", args: "run-1 turns", confirm: false },
  { name: "runs.trace.live", args: "run-1", confirm: false },
  { name: "runs.coding.select", args: "run-1 storage", confirm: false },
  { name: "chat.clear", confirm: true },
  { name: "tab.terminal", confirm: false },
  { name: "tab.harness", args: "claude", confirm: true },
  { name: "agent.role", args: "implementation", confirm: true },
  { name: "tab.card", args: "card-1", confirm: false },
  { name: "tab.close", args: "t1", confirm: true },
  { name: "repo.open", args: "/Users/will/force", confirm: true },
  { name: "repo.unpin", args: "local:/Users/will/smithers", confirm: true },
  { name: "repo.tree", args: "local:/Users/will/smithers", confirm: false },
  { name: "workspace.rename", args: "Force", confirm: false },
  { name: "target.run", args: "r1 //src:lint", confirm: true },
  { name: "target.run.pattern", args: "r1 ci //packages/...", confirm: true },
  { name: "target.open", args: "r1 //src:lint", confirm: false },
  { name: "change.pins", args: "c1 parent current", confirm: false },
  { name: "change.checks", args: "c1 1", confirm: false },
  { name: "workspace.facet", args: "ws-1 files", confirm: false },
  { name: "change.facet", args: "c1 diff", confirm: false },
  { name: "flow.run.retry", args: "card-1", confirm: true },
  { name: "cloud.prompt", confirm: false },
  /* Agents as data (custom-agents.md): listing and the form render cards; defining what spends money confirms. */
  { name: "agent.list", confirm: false },
  { name: "agent.new", confirm: false },
  { name: "agent.models", args: "codex", confirm: false },
  { name: "agent.create", args: "reviewer codex gpt-5.6-terra Reviews diffs", confirm: true },
  { name: "agent.edit", args: "explainer --purpose Explains briefly", confirm: true },
  { name: "agent.remove", args: "reviewer", confirm: true },
  /* Code intelligence (docs/code-intel/PLAN.md §4): reads against the local language server; none confirms. */
  { name: "code.hover", args: "src/index.ts:3:7", confirm: false },
  { name: "code.definition", args: "src/index.ts:3:17", confirm: false },
  { name: "code.diagnostics", args: "src/index.ts", confirm: false }
]

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

/** Every host capability at once, so the gate covers every registerable flow. */
const EVERYTHING: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: [...RuntimeCapabilitySchema.options],
  authFlow: "both",
  sandbox: { platform: "darwin", mode: "enforced" }
}

/** The web host with every door it can grow: the flows scoped to `hosts: ["cloud"]` register only here. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }),
  authFlow: "redirect",
  sandbox: null
}

const repo = (id: string, name: string, path: string): Repo => ({
  id,
  path,
  name,
  git: { branch: "main", remote: null },
  smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "no WORKSPACE.ts", workspaces: [] },
  warnings: []
})

const HARNESSES: ReadonlyArray<Harness> = [
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
    id: "codex",
    displayName: "Codex",
    binary: "/opt/homebrew/bin/codex",
    version: "1.0.0",
    status: "signed-in",
    account: { email: "will@codeplane.app" },
    launch: { argv: ["codex"] }
  }
]

const settle = async (ticks = 6): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * The whole app under EVERYTHING as an admin (so the admin plugin registers),
 * signed in to GitHub (so the requirement axis never intercepts), with two
 * local repositories, a terminal tab, a card, and the harness table. The
 * server is a recorder: every PTY create and every folder pick is counted.
 */
const boot = async (bootstrap: AppBootstrap = EVERYTHING) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ptyBodies: Array<Record<string, unknown>> = []
  let picks = 0
  const repositories: NativeRepositories = {
    available: true,
    pickLocalRepository: async () => {
      picks += 1
      return { status: "cancelled" }
    }
  }
  const controller = createAppController(store, repositories, unavailableAgent, {
    bootstrap,
    socketUrl: () => undefined,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      if (path === "/api/harnesses") return json(200, { harnesses: HARNESSES })
      if (path === "/api/pty" && init?.method === "POST") {
        ptyBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json(200, { sessionId: `pty-${ptyBodies.length}` })
      }
      if (path === "/api/repo/files") return json(200, { kind: "dir", path: "", entries: [] })
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: true,
    scopesPlain: null
  })
  store.dispatch({
    type: "repos.loaded",
    actor: "system",
    repos: [repo("r1", "smithers", "/Users/will/smithers"), repo("r2", "force", "/Users/will/force")]
  })
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [...HARNESSES] })
  store.dispatch({
    type: "tab.opened",
    actor: "user",
    tab: { id: "t1", kind: "terminal", title: "Terminal · smithers", sessionId: "t1", cwd: "/Users/will/smithers", repoKey: "local:/Users/will/smithers" }
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: { id: "card-1", kind: "status", title: "Status", status: "active", createdAt: 1, ordinal: 0, payload: { progress: 0.5 } }
  })
  await settle()
  return { store, controller, ptyBodies, picks: () => picks }
}

/** The production agent door (turns.ts continueToolLeg): one tool call, run as actor smithers. */
const execute = (controller: Awaited<ReturnType<typeof boot>>["controller"], name: string, args?: string) =>
  controller.commands.executeForAgent({
    name: "commands",
    arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) })
  })

const messages = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal)

const confirmationFor = (store: AppStore, flow: string) =>
  messages(store).find((message) => message.action?.flow === flow)

const cloudSession = (store: AppStore, state: "signed-in" | "signed-out", username: string | null): void => {
  store.dispatch({ type: "cloud.session.loaded", actor: "system", state, username, expiresAt: null, scopes: null })
}

describe("the three-door law", () => {
  test("every user-only flow is in the allowlist with its reason, and the allowlist holds nothing else", async () => {
    // Both hosts, so a flow scoped to one of them (app.download is the web's) is gated too.
    const native = await boot()
    const web = await boot(WEB)
    const userOnly = [...native.controller.commands.entries(), ...web.controller.commands.entries()]
      .filter((entry) => !modelInvocable(entry))
    const found = Object.fromEntries(
      userOnly.map((entry) => [nameOf(entry), entry.metadata.userOnlyReason]).sort(([left], [right]) => String(left).localeCompare(String(right)))
    )
    const expected = Object.fromEntries(Object.entries(USER_ONLY_ALLOWLIST).sort(([left], [right]) => left.localeCompare(right)))
    expect(found).toEqual(expected)
    // The admin plugin registered, so the admin rows above were really checked.
    expect(userOnly.some((entry) => nameOf(entry) === "admin.reset")).toBe(true)
  })

  test("every agent row of the policy table is invocable through the tool; a confirm row yields the confirm card, never a refusal", async () => {
    const { store, controller, ptyBodies } = await boot()
    const tabsBefore = store.collections.tabs.size
    for (const row of AGENT_ROWS) {
      const result = await execute(controller, row.name, row.args)
      expect(`${row.name}: ${result}`).not.toContain("is user-only")
      expect(`${row.name}: ${result}`).not.toStartWith(`${row.name}: unknown-command`)
      if (!row.confirm) continue
      expect(`${row.name}: ${result}`).toContain("asked the user to confirm")
      const confirmation = confirmationFor(store, row.name)
      expect(`${row.name} confirmation`).toBe(`${row.name} ${confirmation === undefined ? "missing" : "confirmation"}`)
      expect(confirmation?.action?.args).toBe(row.args)
    }
    // A confirm row performed nothing: no harness or target launched, no tab closed, no pin dropped.
    expect(ptyBodies.filter((body) => body.kind === "harness")).toEqual([])
    expect(store.collections.tabs.get("t1")).toBeDefined()
    expect(store.collections.pinnedRepos.get("local:/Users/will/smithers")).toBeDefined()
    // The no-confirm rows acted: a terminal opened in the active working copy, the card is a tab, the workspace is named.
    expect(ptyBodies.filter((body) => body.kind === "terminal")).toHaveLength(1)
    expect(store.collections.tabs.size).toBe(tabsBefore + 2)
    expect(store.collections.tabs.get("card-card-1")?.kind).toBe("card")
    expect(store.session().workspaceName).toBe("Force")
  })

  test("tab.terminal [cwd] opens in the named open working copy; an unknown cwd is refused with the open ones listed", async () => {
    const { store, controller, ptyBodies } = await boot()
    expect(await execute(controller, "tab.terminal", "/Users/will/force")).toBe("executed /tab.terminal")
    expect(ptyBodies.at(-1)).toMatchObject({ kind: "terminal", repoId: "r2" })
    expect(store.collections.tabs.get("pty-1")).toMatchObject({ kind: "terminal", cwd: "/Users/will/force", title: "Terminal · force" })
    // The id and the name resolve the same copy.
    expect(await execute(controller, "tab.terminal", "r1")).toBe("executed /tab.terminal")
    expect(ptyBodies.at(-1)).toMatchObject({ repoId: "r1" })
    const refused = await execute(controller, "tab.terminal", "/nope")
    expect(refused).toStartWith("failed: ")
    expect(refused).toContain("/nope")
    expect(refused).toContain("/Users/will/smithers")
    expect(refused).toContain("/Users/will/force")
    expect(ptyBodies).toHaveLength(2)
  })

  test("repo.open without a path refuses the agent by name — the folder dialog stays the human's", async () => {
    const { store, controller, picks } = await boot()
    const result = await execute(controller, "repo.open")
    expect(result).toStartWith("failed: ")
    expect(result).toContain("path")
    expect(confirmationFor(store, "repo.open")).toBeUndefined()
    expect(picks()).toBe(0)
    // The human's door still opens the dialog.
    expect((await controller.commands.run("repo.open")).status).toBe("executed")
    expect(picks()).toBe(1)
    // With a path the agent's ask becomes the confirm card, and nothing opens until the click.
    expect(await execute(controller, "repo.open", "/Users/will/plue")).toContain("asked the user to confirm")
    expect(confirmationFor(store, "repo.open")?.action).toEqual({ flow: "repo.open", args: "/Users/will/plue", label: "Confirm: open the local repository at /Users/will/plue" })
    expect(picks()).toBe(1)
  })

  test("cloud.prompt renders the Smithers Cloud sign-in step; signed in it says so", async () => {
    const { store, controller } = await boot()
    cloudSession(store, "signed-out", null)
    await settle(2)
    expect(await execute(controller, "cloud.prompt")).toBe("executed /cloud.prompt")
    const step = confirmationFor(store, "cloud.sign-in")
    expect(step?.action).toEqual({ flow: "cloud.sign-in", label: "Sign in to Smithers Cloud" })
    expect(step?.role).toBe("smithers")
    cloudSession(store, "signed-in", "will")
    await settle(2)
    expect(await execute(controller, "cloud.prompt")).toBe("executed /cloud.prompt")
    expect(messages(store).at(-1)?.text).toBe("Smithers Cloud is already signed in as will.")
  })

  test("a cloud flow refused for the missing session names cloud.prompt to the agent, and /cloud.sign-in to the human", async () => {
    const { store, controller } = await boot()
    cloudSession(store, "signed-out", null)
    await settle(2)
    const agent = await execute(controller, "workspace.terminal")
    expect(agent).toStartWith("failed: Sign in to Smithers Cloud first")
    expect(agent).toContain("cloud.prompt")
    expect(agent).not.toContain("/cloud.sign-in")
    const human = await controller.commands.run("workspace.terminal")
    expect(human).toEqual({ status: "failed", error: "Sign in to Smithers Cloud first — /cloud.sign-in." })
  })

  test("a user-only refusal quotes the registry's reason and the agent's door", async () => {
    const { controller } = await boot()
    const focus = await execute(controller, "tab.select", "1")
    expect(focus).toBe(`failed: /tab.select is user-only — ${USER_ONLY_ALLOWLIST["tab.select"]}`)
    const cloud = await execute(controller, "cloud.sign-in")
    expect(cloud).toContain(USER_ONLY_ALLOWLIST["cloud.sign-in"])
    expect(cloud).toContain("invoke cloud.prompt, which renders that button in the chat")
    // The typed agent door answers the same text.
    const typed = await controller.commands.runForAgent("auth.sign-in")
    expect(typed).toEqual({ status: "failed", error: `failed: /auth.sign-in is user-only — ${USER_ONLY_ALLOWLIST["auth.sign-in"]} — invoke auth.prompt, which renders that button in the chat` })
  })

  test("the + menu's flows are the agent's flows: tab.terminal, agent.role and tab.harness are callable", async () => {
    const { controller } = await boot()
    const callable = new Set(controller.commands.callable().map(nameOf))
    for (const name of ["tab.terminal", "agent.role", "tab.harness", "repo.open", "tab.card", "agent.new", "agent.list", "agent.create", "form.set", "form.submit", "card.dismiss"]) {
      expect(callable.has(name)).toBe(true)
    }
    // And listed: the slash menu and the prompt's catalog show them.
    const disclosed = new Set(controller.commands.disclosed().map((descriptor) => descriptor.name))
    for (const name of ["tab.terminal", "agent.role", "tab.harness", "repo.open", "cloud.prompt", "agent.list", "agent.new", "agent.create", "agent.edit", "agent.remove", "agent.models"]) {
      expect(disclosed.has(name)).toBe(true)
    }
    expect(disclosed.has("flow.run.retry")).toBe(false)
    // The form card's acts (THE FORM LAW) are hidden from the catalog and callable, like every id-scoped card act.
    for (const name of ["form.set", "form.submit", "card.dismiss"]) expect(disclosed.has(name)).toBe(false)
  })

  test("agent.delegate and agent.role accept a custom id: the launch goes by role id, and the confirm card names it", async () => {
    const { store, controller, ptyBodies } = await boot()
    const reviewer = {
      id: "reviewer",
      label: "Reviewer",
      purpose: "Reviews diffs.",
      model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      harness: "codex" as const,
      delegates: false,
      builtin: false,
      createdAt: 1,
      updatedAt: 1
    }
    store.dispatch({ type: "agents.loaded", actor: "system", agents: [...(await import("@smthrs/rpc/AgentRoles")).AGENT_ROLES, reviewer] })
    await settle(2)
    expect(await execute(controller, "agent.delegate", "reviewer review the retry")).toContain("asked the user to confirm")
    expect(ptyBodies).toHaveLength(0)
    expect(confirmationFor(store, "agent.delegate")?.action?.args).toBe("reviewer review the retry")
    expect((await controller.commands.run("agent.delegate", "reviewer review the retry")).status).toBe("executed")
    expect(ptyBodies.at(-1)).toMatchObject({ kind: "harness", harnessId: "codex", roleId: "reviewer", task: "review the retry" })
    expect(store.collections.cards.get("agent-pty-1")?.payload).toMatchObject({ roleId: "reviewer", purpose: "Reviews diffs." })
    expect(await execute(controller, "agent.role", "reviewer")).toContain("asked the user to confirm")
    expect(confirmationFor(store, "agent.role")?.action?.args).toBe("reviewer")
    // An id the store lacks is refused by the store's list, not an enum.
    const refused = await controller.commands.run("agent.delegate", "poet write a haiku")
    expect(refused.status).toBe("failed")
    if (refused.status !== "failed") throw new Error("The unknown agent must be refused")
    expect(refused.error).toContain("There is no agent named poet")
    expect(refused.error).toContain("reviewer")
  })
})
