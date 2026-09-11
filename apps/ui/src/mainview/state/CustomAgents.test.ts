import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { AGENT_ROLES, AgentRoleSchema } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import type { Card } from "./AppState"
import { json } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * Agents as data, renderer side (docs/workbench-lanes/custom-agents.md): the
 * app-agents mirror loads from `GET /api/agents`; `agent.list` renders the
 * Agents card with the live availability; `agent.new` renders the generic
 * flow form (THE FORM LAW) for agent.create, whose draft lives in its payload
 * and whose fields commit through `form.set`; `agent.create` PUTs and
 * re-reads; `agent.edit` and
 * `agent.remove` do the same, a built-in refusing removal; a custom agent
 * appears in the `+` menu rule and in the orchestrator's roles paragraph. The
 * server is a recorder: it holds the list in memory and answers exactly what
 * the routes answer.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}

const repositories: NativeRepositories = { available: true, pickLocalRepository: async () => ({ status: "cancelled" }) }

const bootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["agent", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const harness = (overrides: Partial<Harness> & Pick<Harness, "id" | "status">): Harness => ({
  displayName: overrides.id,
  binary: overrides.status === "unavailable" ? null : `/usr/local/bin/${overrides.id}`,
  version: "1.0.0",
  account: null,
  launch: { argv: [overrides.id] },
  ...overrides
})

const HARNESSES: ReadonlyArray<Harness> = [
  harness({ id: "claude", displayName: "Claude Code", status: "signed-in", account: { email: "will@example.com" }, models: { suggestions: ["claude-fable-5"], listable: false } }),
  harness({ id: "codex", displayName: "Codex", status: "api-key", account: { label: "OPENAI_API_KEY" }, models: { suggestions: ["gpt-5.6-sol", "gpt-5.6-terra"], listable: false } }),
  harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "binary-only", models: { suggestions: ["kimi-for-coding/k3"], listable: true } }),
  harness({ id: "crush", displayName: "Crush", status: "api-key", account: { label: "OPENAI_API_KEY" } })
]

const settle = async (ticks = 6): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** The recorder: the agents store as the routes answer it, every PTY create, and every instructions string sent. */
const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const agents: Array<AgentRole> = [...AGENT_ROLES]
  const ptyBodies: Array<Record<string, unknown>> = []
  const puts: Array<{ id: string; body: Record<string, unknown> }> = []
  const launches: Array<StartAgentTurnRequest> = []
  let modelsCalls = 0
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      launches.push(request)
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (_listener: (frame: AgentTurnFrame) => void) => () => {}
  }
  const controller = createAppController(store, repositories, agent, {
    bootstrap,
    socketUrl: () => undefined,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "http://local.test").pathname
      const method = init?.method ?? "GET"
      if (path === "/api/harnesses") return json(200, { harnesses: HARNESSES })
      if (path === "/api/agents" && method === "GET") return json(200, { agents })
      const put = /^\/api\/agents\/([^/]+)$/.exec(path)
      if (put !== null && method === "PUT") {
        const id = put[1]!
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        puts.push({ id, body })
        if (body.harness === "crush") return json(400, { error: { code: "harness_no_model_flag", message: "Crush takes no model flag this app has verified, so an agent cannot be bound to a model on it." } })
        if (body.purpose === "refuse") return json(400, { error: { code: "refused", message: "The server refused this agent." } })
        const existing = agents.find((row) => row.id === id)
        const row = AgentRoleSchema.parse({
          id,
          ...body,
          delegates: (body.delegates as boolean | undefined) ?? existing?.delegates ?? false,
          builtin: existing?.builtin ?? false,
          createdAt: existing?.createdAt ?? 100,
          updatedAt: 101
        })
        if (existing === undefined) agents.push(row)
        else agents.splice(agents.indexOf(existing), 1, row)
        return json(existing === undefined ? 201 : 200, { agent: row })
      }
      if (put !== null && method === "DELETE") {
        const existing = agents.find((row) => row.id === put[1])
        if (existing === undefined) return json(404, { error: { code: "not_found", message: "no such agent" } })
        if (existing.builtin) return json(409, { error: { code: "builtin_agent", message: `${existing.label} is a built-in agent and cannot be removed` } })
        agents.splice(agents.indexOf(existing), 1)
        return json(200, { ok: true })
      }
      const models = /^\/api\/harnesses\/([^/]+)\/models$/.exec(path)
      if (models !== null) {
        modelsCalls += 1
        const id = models[1]
        if (id === "codex") return json(200, { harnessId: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], source: "suggestions" })
        if (id === "opencode-kimi") return json(200, { harnessId: "opencode-kimi", models: [], source: "list", reason: "opencode models kimi-for-coding exited 2: no credential" })
        return json(200, { harnessId: id, models: ["claude-fable-5"], source: "suggestions" })
      }
      if (path === "/api/pty" && method === "POST") {
        ptyBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json(200, { sessionId: `pty-${ptyBodies.length}` })
      }
      return json(404, { error: { code: "absent", message: `no stub for ${method} ${path}` } })
    }
  })
  await controller.loadHarnesses()
  await controller.loadAgents()
  await settle()
  return { store, controller, agents, ptyBodies, puts, launches, modelsCalls: () => modelsCalls }
}

const cardOf = <K extends Card["kind"]>(store: Awaited<ReturnType<typeof boot>>["store"], id: string, kind: K): Extract<Card, { kind: K }> | undefined => {
  const card = store.collections.cards.get(id)
  return card?.kind === kind ? (card as unknown as Extract<Card, { kind: K }>) : undefined
}

const failedToasts = (store: Awaited<ReturnType<typeof boot>>["store"]) =>
  [...store.collections.toasts.values()].filter((toast) => toast.status === "failed").map((toast) => toast.detail ?? "")

describe("custom agents — the mirror and the Agents card", () => {
  test("app-agents mirrors GET /api/agents, and agent.list renders every agent with the harness's live availability", async () => {
    const { store, controller } = await boot()
    expect([...store.collections.agents.keys()].sort()).toEqual([...AGENT_ROLES.map((role) => role.id)].sort())
    controller.runCommand("agent.list")
    await settle()
    const card = cardOf(store, "agents", "agents")
    expect(card?.payload.native).toBe(true)
    expect(card?.payload.agents.map((row) => row.id)).toEqual(AGENT_ROLES.map((role) => role.id))
    const byId = Object.fromEntries((card?.payload.agents ?? []).map((row) => [row.id, row]))
    expect(byId.orchestrator).toMatchObject({ harnessName: "Claude Code", available: true, account: "will@example.com", builtin: true })
    expect(byId.explainer).toMatchObject({ available: false, reason: "OpenCode · Kimi has no credential for Kimi K3" })
    expect(byId["fast-ui"]).toMatchObject({ available: false, reason: "opencode-cerebras is not installed" })
  })

  test("agent.new renders agent.create's generic form with the harness and model selects fed by the harness seam; form.set commits fields into the payload", async () => {
    const { store, controller, modelsCalls } = await boot()
    controller.runCommand("agent.new")
    await settle()
    const form = cardOf(store, "form-agent.create", "flow-form")
    expect(form?.payload).toMatchObject({ flow: "agent.create", via: "user", draft: {}, given: {} })
    expect(form?.payload.fields.map((field) => field.name)).toEqual(["id", "harness", "model", "purpose"])
    // The harness options are the seam's rows: credentialed ones pickable, the rest disabled with the reason (crush has no verified model flag).
    expect(form?.payload.fields[1]?.options).toEqual([
      { value: "claude", label: "Claude Code · will@example.com" },
      { value: "codex", label: "Codex · OPENAI_API_KEY" },
      { value: "opencode-kimi", label: "OpenCode · Kimi", disabled: true, reason: "no credential" },
      { value: "crush", label: "Crush · OPENAI_API_KEY", disabled: true, reason: "no verified model flag" }
    ])
    // Nothing is preselected: no harness, no model list yet, and no list command has run.
    expect(form?.payload.fields[2]?.options).toEqual([])
    expect(modelsCalls()).toBe(0)
    controller.runCommand("form.set", "form-agent.create id reviewer")
    controller.runCommand("form.set", "form-agent.create purpose Reviews diffs for correctness")
    await settle()
    controller.runCommand("form.set", "form-agent.create harness codex")
    await settle()
    controller.runCommand("form.set", "form-agent.create model gpt-5.6-terra")
    await settle()
    const filled = cardOf(store, "form-agent.create", "flow-form")
    expect(filled?.payload.draft).toEqual({ id: "reviewer", purpose: "Reviews diffs for correctness", harness: "codex", model: "gpt-5.6-terra" })
    // Picking the harness read its model list into the model field.
    expect(filled?.payload.fields[2]?.options?.map((option) => option.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    expect(modelsCalls()).toBe(1)
    // A harness the seam marked unpickable is refused with its reason.
    controller.runCommand("form.set", "form-agent.create harness crush")
    await settle()
    expect(failedToasts(store).some((detail) => detail.includes("Crush · OPENAI_API_KEY cannot be picked: no verified model flag"))).toBe(true)
    // A blank value clears the field.
    controller.runCommand("form.set", "form-agent.create purpose")
    await settle()
    expect(cardOf(store, "form-agent.create", "flow-form")?.payload.draft.purpose).toBeUndefined()
  })

  test("the form's Submit runs agent.create: it PUTs the agent, re-reads the mirror, settles the card, and the new agent is in the menu rule and the roles paragraph", async () => {
    const { store, controller, puts, launches, ptyBodies } = await boot()
    controller.runCommand("agent.new")
    await settle()
    for (const line of ["id reviewer", "harness codex", "model gpt-5.6-terra", "purpose Reviews diffs for correctness"]) {
      controller.runCommand("form.set", `form-agent.create ${line}`)
      await settle()
    }
    controller.runCommand("form.submit", "form-agent.create")
    await settle(10)
    expect(puts).toEqual([{
      id: "reviewer",
      body: {
        label: "Reviewer",
        purpose: "Reviews diffs for correctness",
        harness: "codex",
        model: { provider: "openai", id: "gpt-5.6-terra", label: "gpt-5.6-terra" }
      }
    }])
    expect(store.collections.agents.get("reviewer")).toMatchObject({ id: "reviewer", label: "Reviewer", builtin: false })
    const form = cardOf(store, "form-agent.create", "flow-form")
    expect(form?.status).toBe("acted")
    expect(form?.payload.error).toBeUndefined()
    // The Agents card, once shown, refreshes in place with the new row.
    controller.runCommand("agent.list")
    await settle()
    expect(cardOf(store, "agents", "agents")?.payload.agents.map((row) => row.id)).toEqual([...AGENT_ROLES.map((role) => role.id), "reviewer"])
    // The new agent delegates like a built-in: the launch goes by role id, the card names its purpose.
    controller.runCommand("agent.delegate", "reviewer review the retry")
    await settle()
    expect(ptyBodies.at(-1)).toMatchObject({ kind: "harness", harnessId: "codex", roleId: "reviewer", task: "review the retry" })
    expect(store.collections.cards.get(`agent-pty-${ptyBodies.length}`)?.payload).toMatchObject({ roleId: "reviewer", purpose: "Reviews diffs for correctness" })
    // And the orchestrator is told about it, and told how missing input is answered.
    await controller.send("hi")
    await settle(10)
    const instructions = launches.at(-1)?.instructions ?? ""
    expect(instructions).toContain("- reviewer (gpt-5.6-terra): Reviews diffs for correctness")
    expect(instructions).toContain("create and manage agents (agent.new, agent.create)")
    expect(instructions).toContain("it renders a form for the rest. Never ask the user to type arguments.")
  })

  test("agent.create refuses a taken id, a bad id, a flag-shaped model, and relays the server's refusal onto the form", async () => {
    const { store, controller, puts } = await boot()
    // One refusal at a time: a flow's failed toast is one row per flow, so a later refusal replaces an earlier one.
    controller.runCommand("agent.create", "ui codex gpt-5.6-terra")
    await settle()
    expect(failedToasts(store).at(-1)).toContain("An agent named ui already exists")
    controller.runCommand("agent.create", "Bad codex gpt-5.6-terra")
    await settle()
    expect(failedToasts(store).at(-1)).toContain("Bad is not an agent id")
    controller.runCommand("agent.create", "evil codex --yolo")
    await settle()
    expect(failedToasts(store).at(-1)).toContain("--yolo is not a model id")
    expect(puts).toEqual([])
    controller.runCommand("agent.new")
    await settle()
    for (const line of ["id crusher", "harness codex", "model gpt-5.6-terra", "purpose refuse"]) {
      controller.runCommand("form.set", `form-agent.create ${line}`)
      await settle()
    }
    controller.runCommand("form.submit", "form-agent.create")
    await settle(10)
    const form = cardOf(store, "form-agent.create", "flow-form")
    expect(form?.status).toBe("error")
    expect(form?.payload.error).toContain("The server refused this agent.")
    // The card carries the refusal; the human's Submit raised no toast of its own.
    expect(failedToasts(store).some((detail) => detail.includes("The server refused this agent."))).toBe(false)
  })

  test("agent.edit changes a built-in's model and purpose (its harness stays), agent.remove refuses a built-in and removes a custom agent", async () => {
    const { store, controller, puts, agents } = await boot()
    controller.runCommand("agent.edit", "explainer --model kimi-for-coding/k3 --purpose Explains, briefly.")
    await settle(10)
    expect(puts.at(-1)).toEqual({
      id: "explainer",
      body: {
        label: "Explainer",
        purpose: "Explains, briefly.",
        harness: "opencode-kimi",
        model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "kimi-for-coding/k3" },
        delegates: false
      }
    })
    expect(store.collections.agents.get("explainer")?.purpose).toBe("Explains, briefly.")
    controller.runCommand("agent.edit", "explainer")
    await settle()
    expect(failedToasts(store).some((detail) => detail.includes("needs --model"))).toBe(true)
    controller.runCommand("agent.remove", "explainer")
    await settle()
    expect(failedToasts(store).some((detail) => detail.includes("Explainer is a built-in agent and cannot be removed"))).toBe(true)
    expect(agents.some((row) => row.id === "explainer")).toBe(true)
    controller.runCommand("agent.create", "reviewer codex gpt-5.6-terra")
    await settle(10)
    expect(store.collections.agents.get("reviewer")).toBeDefined()
    controller.runCommand("agent.remove", "reviewer")
    await settle(10)
    expect(store.collections.agents.get("reviewer")).toBeUndefined()
    expect(agents.some((row) => row.id === "reviewer")).toBe(false)
    controller.runCommand("agent.remove", "ghost")
    await settle()
    expect(failedToasts(store).some((detail) => detail.includes("There is no agent named ghost"))).toBe(true)
  })

  test("agent.models renders the harness's list card, honest about a failed list", async () => {
    const { store, controller } = await boot()
    controller.runCommand("agent.models", "codex")
    controller.runCommand("agent.models", "opencode-kimi")
    await settle()
    expect(cardOf(store, "agent-models-codex", "agent-models")?.payload).toEqual({
      harnessId: "codex",
      displayName: "Codex",
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      source: "suggestions"
    })
    expect(cardOf(store, "agent-models-opencode-kimi", "agent-models")?.payload).toMatchObject({ models: [], reason: "opencode models kimi-for-coding exited 2: no credential" })
    controller.runCommand("agent.models", "ghost")
    await settle()
    expect(failedToasts(store).some((detail) => detail.includes("There is no harness with id ghost"))).toBe(true)
  })
})
