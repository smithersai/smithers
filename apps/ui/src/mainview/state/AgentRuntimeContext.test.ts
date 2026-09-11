import { describe, expect, test } from "bun:test"
import { renderAgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { GUIDE_LAST_STEP, GUIDE_LESSONS } from "../onboarding/lessons"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { initialGuide } from "./AppState"
import { memoryStorage, recordingAgent, settled, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/** An agent double that records every turn request and ends the turn fast. */
describe("per-turn runtime context", () => {
  test("every turn carries a freshly derived context identifying the Smithers product", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("hey smithers what app am I in")
    await settled()

    expect(requests).toHaveLength(1)
    const context = requests[0]?.context
    expect(context?.version).toBe(1)
    expect(context?.product).toBe("smithers")
    expect(context?.surface).toBe("chat")
    expect(context?.connectors).toEqual([])
    expect(context?.limitations.some((line) => line.includes("Cannot see"))).toBe(true)
  })

  test("a state change between turns shows up in the next turn's context", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("first turn")
    await settled()
    controller.showConnectors()
    controller.send("second turn")
    await settled()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.context?.surface).toBe("chat")
    expect(requests[1]?.context?.surface).toBe("connectors")
    // Freshly derived, not cached: the revision moved with the surface change.
    const firstRevision = requests[0]?.context?.revision ?? 0
    expect(requests[1]?.context?.revision ?? 0).toBeGreaterThan(firstRevision)
    const firstCaptured = requests[0]?.context?.capturedAt ?? 0
    expect(requests[1]?.context?.capturedAt ?? 0).toBeGreaterThanOrEqual(firstCaptured)
  })

  test("the hidden context never enters the persisted visible transcript", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("what app am I in")
    await settled()

    expect(requests[0]?.context).toBeDefined()
    for (const message of store.collections.messages.values()) {
      expect(message.text).not.toContain("Runtime context")
      expect(message.text).not.toContain("running INSIDE the Smithers product")
      expect(message.reasoning ?? "").not.toContain("Runtime context")
    }
  })

  test("a tool-loop continuation leg rebuilds the context, it does not replay the first leg's", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    // Leg 1 asks for a command that mutates world state; leg 2 must SEE it.
    const agent: AgentPort = {
      available: true,
      startTurn: async (request) => {
        const leg = requests.length
        requests.push(request)
        queueMicrotask(() => {
          const frames: ReadonlyArray<AgentTurnFrame> = leg === 0
            ? [
              {
                runId: request.runId,
                type: "tool_call",
                call_id: "call_1",
                name: "commands",
                arguments: JSON.stringify({ action: "execute", name: "world.new-note" })
              },
              { runId: request.runId, type: "done", reason: "tool_call" }
            ]
            : [
              { runId: request.runId, type: "delta", kind: "text", text: "Noted." },
              { runId: request.runId, type: "done", reason: "stop" }
            ]
          for (const frame of frames) for (const listener of listeners) listener(frame)
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const controller = createAppController(store, unavailableRepositories, agent)

    controller.send("make me a note")
    await settled()
    await settled()

    expect(requests).toHaveLength(2)
    const before = requests[0]?.context
    const after = requests[1]?.context
    expect(before?.worldState.documentCount ?? -1).toBeGreaterThanOrEqual(0)
    expect(after?.worldState.documentCount ?? 0).toBe((before?.worldState.documentCount ?? 0) + 1)
    expect(after?.revision ?? 0).toBeGreaterThan(before?.revision ?? 0)
  })

  test("web limitations are honest about the native-only repository picker", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("connect my repo")
    await settled()

    const limitations = requests[0]?.context?.limitations ?? []
    expect(limitations.some((line) => line.includes("pure-web client cannot connect"))).toBe(true)
  })

  test("the selected repository rides the context, so a plain first message can be about it", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("what is this?")
    await settled()
    expect(requests[0]?.context?.activeRepository).toBeNull()
    expect(renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)).toContain("- Active repository: none selected.")

    // The landing page's `?repo=` boot path: the catalog row joins the inventory, then repo.select names it.
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "smithersai/smithers", org: "smithersai", ownerKind: "user", name: "smithers", head: null,
        summary: "A durable framework for agents to plan, run, and review code changes." }]
    })
    expect(await controller.selectRepo("smithersai/smithers")).toBeUndefined()
    controller.send("what does this repo do?")
    await settled()

    expect(requests[1]?.context?.activeRepository).toBe("smithersai/smithers")
    expect(requests[1]?.context?.activeRepositorySummary).toBe("A durable framework for agents to plan, run, and review code changes.")
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("- Active repository: smithersai/smithers.")
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("Selected repository description (public catalog): A durable framework")
  })

  test("Smithers is the first tab and sees every other one: the context lists the tabs and their status", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["local.terminal", "local.harnesses"],
        authFlow: "none",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    await store.dispatch({
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
    }).isPersisted.promise
    await store.dispatch({
      type: "tab.opened",
      actor: "user",
      tab: { id: "h1", kind: "harness", title: "Claude Code · ~", sessionId: "h1", harnessId: "claude", cwd: "~" }
    }).isPersisted.promise
    await store.dispatch({ type: "tab.selected", actor: "user", id: "main" }).isPersisted.promise

    controller.send("what is the agent doing")
    await settled()
    const tabs = requests[0]?.context?.tabs ?? []
    expect(tabs).toEqual([
      { id: "main", kind: "main", title: "Smithers", status: "open", active: true },
      {
        id: "h1",
        kind: "harness",
        title: "Claude Code · ~",
        harnessId: "claude",
        account: "will@codeplane.app",
        cwd: "~",
        status: "running",
        exitCode: null,
        active: false
      }
    ])
    expect(requests[0]?.context?.capabilities.some((line) => line.includes("tab.read"))).toBe(true)

    await store.dispatch({ type: "pty.exited", actor: "system", sessionId: "h1", code: 0 }).isPersisted.promise
    controller.send("and now?")
    await settled()
    expect(requests[1]?.context?.tabs?.[1]).toMatchObject({ status: "exited", exitCode: 0 })
  })

  /*
   * agent-parity.md: the agent tried /workspace.terminal, failed on the
   * missing cloud session, and ran /auth.prompt — GitHub, already connected —
   * because the context stated GitHub and never the Smithers Cloud session.
   */
  test("the native app's context states the Smithers Cloud session and names cloud.prompt when it is signed out", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["agent", "identity", "cloud", "cloud.pat", "cloud.terminal"],
        authFlow: "both",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null }).isPersisted.promise
    controller.send("launch a terminal")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "signed-out", username: null })
    const signedOut = renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)
    expect(signedOut).toContain("- Smithers Cloud: signed out (workspaces, changes and sync need it; cloud.prompt renders the sign-in button).")

    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: null }).isPersisted.promise
    controller.send("and now?")
    await settled()
    expect(requests[1]?.context?.cloud).toEqual({ state: "signed-in", username: "will" })
    expect(renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)).toContain("- Smithers Cloud: signed in as will.")

    await store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-in", username: "will", expiresAt: null, scopes: "degraded" }).isPersisted.promise
    controller.send("workspaces?")
    await settled()
    expect(requests[2]?.context?.cloud).toEqual({ state: "degraded", username: "will" })
  })

  test("on the web the GitHub sign-in is the Smithers Cloud sign-in, so the cloud line follows the identity", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "cloud",
        version: "test",
        buildSha: "cloud",
        capabilities: ["agent", "identity", "cloud"],
        authFlow: "redirect",
        sandbox: null
      }
    })
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "signed-out", username: null })
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
    controller.send("again")
    await settled()
    expect(requests[1]?.context?.cloud).toEqual({ state: "signed-in", username: "will" })
  })

  test("a host with no cloud door states the session unavailable", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests), {
      bootstrap: {
        apiVersion: 1,
        host: "local",
        version: "test",
        buildSha: "test",
        capabilities: ["local.terminal"],
        authFlow: "none",
        sandbox: { platform: "darwin", mode: "enforced" }
      }
    })
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.cloud).toEqual({ state: "unavailable", username: null })
    expect(renderAgentRuntimeContext(requests[0]?.context as AgentRuntimeContext)).toContain("- Smithers Cloud: unavailable on this host.")
  })

  test("alone, the context says so and offers no tab.read", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.tabs).toEqual([{ id: "main", kind: "main", title: "Smithers", status: "open", active: true }])
    expect(requests[0]?.context?.capabilities.some((line) => line.includes("tab.read"))).toBe(false)
  })

  /*
   * A message sent mid-tutorial is answered against the lesson transcript the
   * user has actually seen: the turn context carries the onboarding block
   * (lesson position + transcript) while the guide runs, and drops it once
   * the workspace step is reached.
   */
  test("the onboarding transcript rides the turn while the tutorial runs, and leaves when it is done", async () => {
    const store = await webStore()
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    // No guide at all (a session that never entered the tutorial): no block.
    controller.send("hi")
    await settled()
    expect(requests[0]?.context?.onboarding).toBeUndefined()

    await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 6 } }).isPersisted.promise
    controller.send("what is this?")
    await settled()
    const onboarding = requests[1]?.context?.onboarding
    expect(onboarding?.step).toBe(6)
    expect(onboarding?.stepCount).toBe(GUIDE_LESSONS.length)
    expect(onboarding?.transcript).toEqual(GUIDE_LESSONS.slice(0, 7))
    expect(onboarding?.transcript[6]).toBe("You can talk directly to me. Try it now.")
    const rendered = renderAgentRuntimeContext(requests[1]?.context as AgentRuntimeContext)
    expect(rendered).toContain(`the user is on lesson 7 of ${GUIDE_LESSONS.length}`)
    expect(rendered).toContain("onboarding.act finish")

    await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: GUIDE_LAST_STEP } }).isPersisted.promise
    controller.send("done with that")
    await settled()
    expect(requests[2]?.context?.onboarding).toBeUndefined()
  })
})
