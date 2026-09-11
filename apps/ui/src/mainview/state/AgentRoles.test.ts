import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { smithersInstructions } from "./Instructions"
import { memoryStorage } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The named roles end to end: the `+` flows launch a role's harness through
 * the one PTY request (role id + task, never argv), the conversation records
 * the subagent with its role, `agent.explain` answers as a card on the
 * explainer role, and the orchestrator's instructions name only what this
 * host can launch. No real process or model is touched: the server and the
 * agent are recorders.
 */

const repositories: NativeRepositories = {
  available: true,
  pickLocalRepository: async () => ({ status: "cancelled" })
}

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
  harness({ id: "claude", displayName: "Claude Code", status: "signed-in", account: { email: "will@example.com" } }),
  harness({ id: "codex", displayName: "Codex", status: "signed-in", account: { email: "will@example.com" } }),
  harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "api-key", account: { label: "KIMI_API_KEY" } }),
  harness({ id: "opencode-cerebras", displayName: "OpenCode · Cerebras", status: "binary-only" })
]

const recordingAgent = () => {
  const launches: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      launches.push(request)
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const emit = (frame: AgentTurnFrame) => {
    for (const listener of listeners) listener(frame)
  }
  return { agent, launches, emit }
}

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const recorder = recordingAgent()
  const bodies: Array<Record<string, unknown>> = []
  let next = 0
  const controller = createAppController(store, repositories, recorder.agent, {
    bootstrap,
    socketUrl: () => undefined,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/api/harnesses")) return new Response(JSON.stringify({ harnesses: HARNESSES }), { status: 200 })
      if (url.endsWith("/api/pty") && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        next += 1
        return new Response(JSON.stringify({ sessionId: `pty-${next}` }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: { code: "absent", message: "no seam" } }), { status: 404 })
    }
  })
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [...HARNESSES] })
  return { store, controller, recorder, bodies }
}

describe("agent roles — launching", () => {
  test("agent.role launches the role's harness by role id and records the subagent with its role", async () => {
    const { store, controller, bodies } = await boot()
    controller.runCommand("agent.role", "implementation")
    await settle()
    expect(bodies.at(-1)).toMatchObject({ kind: "harness", harnessId: "codex", roleId: "implementation" })
    expect(bodies.at(-1)?.task).toBeUndefined()
    expect(store.collections.tabs.get("pty-1")).toMatchObject({
      kind: "harness",
      harnessId: "codex",
      roleId: "implementation",
      title: "Implementation · GPT-5.6 Sol · ~"
    })
    expect(store.collections.cards.get("agent-pty-1")).toMatchObject({
      kind: "agent",
      title: "Implementation · GPT-5.6 Sol",
      payload: { harnessId: "codex", roleId: "implementation", phase: "running" }
    })
  })

  test("agent.delegate hands the task to the role's CLI and the card names the task", async () => {
    const { store, controller, bodies } = await boot()
    controller.runCommand("agent.delegate", "trivial-implementation rename the flag to verbose")
    await settle()
    expect(bodies.at(-1)).toMatchObject({ roleId: "trivial-implementation", task: "rename the flag to verbose" })
    expect(store.collections.cards.get("agent-pty-1")?.payload).toMatchObject({
      roleId: "trivial-implementation",
      task: "rename the flag to verbose"
    })
    // The model may delegate, and may ask for a plain role launch: agent.role confirms (the three-door law).
    expect(controller.commands.find("agent.delegate")?.binding.descriptor.modelInvocable).toBe(true)
    expect(controller.commands.find("agent.role")?.binding.descriptor.modelInvocable).toBe(true)
    expect(controller.commands.find("agent.role")?.metadata.confirm).toBeDefined()
  })

  test("a role whose harness lacks a credential refuses with the reason, and an unknown role lists the roles", async () => {
    const { store, controller, bodies } = await boot()
    controller.runCommand("agent.role", "fast-ui")
    await settle()
    expect(bodies).toHaveLength(0)
    expect(store.collections.tabs.size).toBe(1)
    // A refused flow states its reason as a failed toast (ComposerRefusals.test.ts).
    const failed = () => [...store.collections.toasts.values()].filter((toast) => toast.status === "failed")
    expect(failed().at(-1)?.detail).toContain("Fast UI · Cerebras gpt-oss-120b is not available")
    controller.runCommand("agent.delegate", "poet write a haiku")
    await settle()
    // A well-formed id the agents store lacks is refused by the store's list (custom-agents.md), never by an enum.
    expect(failed().some((toast) => (toast.detail ?? "").includes("There is no agent named poet"))).toBe(true)
    expect(bodies).toHaveLength(0)
  })
})

describe("agent roles — the explainer", () => {
  test("agent.explain runs one side turn on the explainer role and streams into an embedded card", async () => {
    const { store, controller, recorder } = await boot()
    controller.runCommand("agent.explain", "why is packages/smithers/flows/jj/wasm not a regular file")
    await settle()
    const launch = recorder.launches.at(-1)
    expect(launch).toBeDefined()
    expect(launch).toMatchObject({ purpose: "explain", role: "explainer" })
    expect(launch?.tools).toBeUndefined()
    expect(launch?.messages).toEqual([{ role: "user", content: "why is packages/smithers/flows/jj/wasm not a regular file" }])
    expect(launch?.instructions).toContain("Explainer")
    // The conversation's own phase never moves for a side turn.
    expect(store.session().phase).toBe("idle")
    const cardId = `explain-${launch?.runId ?? ""}`
    expect(store.collections.cards.get(cardId)).toMatchObject({ kind: "explain", payload: { phase: "asking", answer: "" } })
    recorder.emit({ runId: launch?.runId ?? "", type: "delta", kind: "text", text: "It is a directory " })
    recorder.emit({ runId: launch?.runId ?? "", type: "delta", kind: "text", text: "of build output." })
    recorder.emit({ runId: launch?.runId ?? "", type: "done", reason: "stop" })
    await settle()
    const card = store.collections.cards.get(cardId)
    expect(card).toMatchObject({ status: "acted", payload: { phase: "answered", answer: "It is a directory of build output." } })
    // Honest attribution: what was asked for, never a claim about who answered.
    expect(card?.kind === "explain" ? card.payload.answeredBy : "").toContain("asked for the Explainer role (Kimi K3)")
  })

  test("a refused or empty explanation lands as a failed card, and a blank ask is refused before any turn", async () => {
    const { store, controller, recorder } = await boot()
    controller.runCommand("agent.explain", "this")
    await settle()
    const launch = recorder.launches.at(-1)
    recorder.emit({ runId: launch?.runId ?? "", type: "done", error: "upstream refused" })
    await settle()
    expect(store.collections.cards.get(`explain-${launch?.runId ?? ""}`)).toMatchObject({
      status: "error",
      payload: { phase: "failed", error: "upstream refused" }
    })
    const before = recorder.launches.length
    controller.runCommand("agent.explain", "   ")
    await settle()
    expect(recorder.launches.length).toBe(before)
  })
})

describe("agent roles — the orchestrator's instructions", () => {
  test("the conversation is the orchestrator: it is told each role, its model, and which ones this host cannot launch", () => {
    const prompt = smithersInstructions([], {
      host: "native",
      github: { connected: false, login: null, repositories: null },
      localRepositories: [],
      localRepositoriesAvailable: true
    }, [
      { id: "orchestrator", label: "Orchestrator", purpose: "Delegates.", model: "Fable 5", available: true, reason: "" },
      { id: "explainer", label: "Explainer", purpose: "Explains things very well.", model: "Kimi K3", available: true, reason: "" },
      {
        id: "fast-ui",
        label: "Fast UI",
        purpose: "Fast, cheap UI iterations.",
        model: "Cerebras gpt-oss-120b",
        available: false,
        reason: "OpenCode · Cerebras has no credential for Cerebras gpt-oss-120b"
      }
    ])
    expect(prompt).toContain("You are the ORCHESTRATOR role")
    expect(prompt).toContain("agent.delegate <role> <task>")
    expect(prompt).toContain("- explainer (Kimi K3): Explains things very well.")
    expect(prompt).toContain("- fast-ui (Cerebras gpt-oss-120b): Fast, cheap UI iterations. — NOT available here: OpenCode · Cerebras has no credential")
    // The orchestrator is not listed as something to delegate to.
    expect(prompt).not.toContain("- orchestrator (")
  })

  test("without local harnesses the instructions carry no role section at all", () => {
    const prompt = smithersInstructions([], {
      host: "native",
      github: { connected: false, login: null, repositories: null },
      localRepositories: [],
      localRepositoriesAvailable: false
    })
    expect(prompt).not.toContain("ORCHESTRATOR")
  })
})
