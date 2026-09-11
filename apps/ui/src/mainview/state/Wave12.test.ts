/*
 * Wave 12 — result claims are deterministic, and the last first-run polish.
 *
 * §1 is the load-bearing one: wave 11 pinned the tool result and the system
 * prompt, and the deployed model still wrote "The workflow
 * "summarize-open-issues" has been created and is now running" beside a card
 * truthfully reading Running. These tests assert the RENDERED turn, not the
 * model's intent — the exact wave-11 transcript is replayed through the real
 * controller and the lie must not be on screen.
 *
 * §2 (which loaded repository), §3 (a run the workspace never finishes) and
 * §4 (the residuals) are pinned the same way: through the real controller,
 * against a relay double speaking the shapes the receipts recorded.
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { claimsRunState, renderedRunTurnText, runLaunchCommandOf, toolResultLaunchedRun } from "./RunClaims"

const createAppController = scopedControllers()

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent = (): AgentPort => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settle = async (ticks = 12): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** Wait for a condition rather than a fixed sleep — a loaded machine still passes. */
const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (!condition()) throw new Error("condition never held")
}

const REPO = "codeplanesmithers/smithers-demo"
const OTHER_REPO = "codeplanesmithers/smithers-cloud"

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/** The same relay double wave 11 proved against, with the states §3/§4 need. */
const relay = (options: {
  readonly provision?: () => unknown
  readonly flows?: ReadonlyArray<{ flowId: string }>
} = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const state = {
    runStatus: "running" as string,
    turns: 0,
    calls: 0,
    launched: [] as Array<{ workflow: string; input: unknown; repo: string }>
  }
  const flows = options.flows ?? [{ flowId: "create-workflow" }, { flowId: "review-pr" }]
  let planned: { flowId: string; input: unknown } | undefined

  const procedure = (repo: string, name: string, payload: Record<string, unknown>): Response => {
    switch (name) {
      case "List":
        return json(200, {
          ok: true,
          payload: { _tag: "flows", items: flows.map((flow) => ({ flowId: flow.flowId, description: "" })) }
        })
      case "Plan": {
        const flowId = String(payload.flowId)
        if (!flows.some((entry) => entry.flowId === flowId)) {
          return json(200, { ok: false, error: { message: `Unknown workflow: ${flowId}` } })
        }
        planned = { flowId, input: payload.input }
        return json(200, {
          ok: true,
          payload: {
            planId: `plan-${flowId}`,
            flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        })
      }
      case "Run":
        state.launched.push({ workflow: planned?.flowId ?? "?", input: planned?.input, repo })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-w12" } })
      case "Cancel":
        state.runStatus = "cancelled"
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "c", runId: "run-w12" } })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string }
        if (selector._tag === "approvals") {
          return json(200, { ok: true, payload: { cursor: { projection: "approvals", runId: null, value: 0 }, rows: [] } })
        }
        return json(200, {
          ok: true,
          payload: {
            cursor: { projection: "run-summary", runId: "run-w12", value: 1 },
            rows: [{
              runId: "run-w12",
              flowId: state.launched.at(-1)?.workflow ?? "review-pr",
              status: state.runStatus,
              createdAt: 1,
              updatedAt: 2 + state.turns + state.calls,
              turns: state.turns,
              calls: state.calls,
              callsFailed: 0,
              editsAttempted: 0,
              editsSucceeded: 0,
              inputTokens: 0,
              outputTokens: 0,
              verdict: state.runStatus === "completed" ? "completed — done." : state.runStatus,
              diagnosis: "Verdict   done."
            }]
          }
        })
      }
      default:
        return json(200, { ok: false, error: { message: `no ${name}` } })
    }
  }

  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ path: absolute.pathname + absolute.search, method: init?.method ?? "GET", body })
      if (absolute.pathname === "/api/workflow/provision") {
        return json(200, options.provision?.() ?? { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        return procedure(String(body.repo), String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }

  return {
    services,
    calls,
    state,
    /** The run did some work: the summary's counters move. */
    advance: (turns: number, callCount: number) => {
      state.turns += turns
      state.calls += callCount
    }
  }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>, loaded: string[] = [REPO]) => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: loaded.map((fullName) => ({
      id: fullName,
      org: fullName.split("/")[0] ?? "",
      ownerKind: "user",
      name: fullName.split("/")[1] ?? "",
      head: null
    }))
  })
  await settle(2)
}

const runCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-trace" }> | undefined => {
  const card = store.collections.cards.get("flow-run-run-w12")
  return card?.kind === "run-trace" ? card : undefined
}

/** The whole rendered turn, as the transcript holds it. */
const transcript = (store: Awaited<ReturnType<typeof webStore>>): string =>
  [...store.collections.messages.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((message) => message.text)
    .join("\n")

const scriptedToolAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: AgentPort; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  let step = 0
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        const frames = (steps[Math.min(step, steps.length - 1)] ?? (() => []))(request)
        step += 1
        queueMicrotask(() => {
          for (const frame of frames) {
            for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

/** The exact frames the canary turn produced, replayed. */
const WAVE11_LIE =
  "The workflow \"summarize-open-issues\" has been created and is now running on codeplanesmithers/smithers-demo."

describe("wave 12 §1 — the model may not narrate run state", () => {
  test("the wave-11 transcript replayed: the rendered turn contains no 'has been created'", async () => {
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({
            action: "execute",
            name: "flow.create",
            args: "a workflow that summarizes my open issues"
          })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: WAVE11_LIE },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("can you make me a smithers workflow that summarizes my open issues?")
    await settle(30)

    const rendered = transcript(store)
    // The lie is not on screen, in whole or in part.
    expect(rendered).not.toContain("has been created")
    expect(rendered).not.toContain("summarize-open-issues")
    // What IS on screen: the deterministic line, and the card beside it.
    expect(rendered).toContain("I started a create-workflow run — the run card shows its real progress.")
    expect(runCard(store)).toBeDefined()
    // The act line names the run the CLIENT started, from the machine ack.
    expect(rendered).toContain(`Smithers started a create-workflow run on ${REPO}`)
  })

  test("prose that claims nothing about the run is rendered untouched", async () => {
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        {
          type: "delta" as const,
          kind: "text" as const,
          text: "Approvals go to you, never to me."
        },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await settle(30)
    expect(transcript(store)).toContain("Approvals go to you, never to me.")
  })

  test("a slash-prefixed launch arms the gate exactly like the bare spelling", async () => {
    // ui-state-store/api-design/1: the tool schema accepts the catalog's
    // "/flow.create"; execution launched from it while the classifier read
    // the raw name and left the claim gate unarmed, so the lie rendered.
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: " /flow.create ", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: WAVE11_LIE },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await settle(30)
    const rendered = transcript(store)
    expect(rendered).not.toContain("has been created")
    expect(rendered).toContain("I started a create-workflow run — the run card shows its real progress.")
    expect(rendered).toContain(`Smithers started a create-workflow run on ${REPO}`)
    expect(runCard(store)).toBeDefined()
  })

  test("a preamble before the tool call is covered too — half a suppressed claim is still a claim", async () => {
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Creating that workflow for you now. " },
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [{ type: "done" as const, reason: "stop" as const }]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await settle(30)
    expect(transcript(store)).not.toContain("Creating that workflow for you now")
    expect(transcript(store)).toContain("I started a create-workflow run")
  })

  test("a turn that launched NOTHING leaves the model's words alone", async () => {
    // The substitution is armed by a real launch, not by the vocabulary: a
    // refusal (signed out, chooser route, unknown workflow) leaves nothing to
    // misdescribe, so suppressing prose there would be censorship, not truth.
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.run", args: "nope" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        {
          type: "delta" as const,
          kind: "text" as const,
          text: "There's no workflow called nope — nothing was started."
        },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("run nope")
    await settle(30)
    expect(transcript(store)).toContain("There's no workflow called nope — nothing was started.")
  })

  test("held-back whitespace still settles the turn — the composer never locks (review)", async () => {
    /*
     * Review pass: after a launch the model's text is BUFFERED, so a
     * continuation of nothing but whitespace left no answer message behind.
     * `message.response.completed` no-ops when that message is missing, so the
     * session's phase stayed `responding` forever and `send` refused every
     * later submit — a launch could brick the chat. The turn must settle, and
     * the honest report is the empty-response one that already exists.
     */
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "   \n " },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await waitFor(() => store.session().phase === "idle")
    expect(store.session().phase).toBe("idle")
    // The launch itself still happened and is stated by the client.
    expect(transcript(store)).toContain("Smithers started a create-workflow run")
  })

  test("a turn stopped mid-flight does not leave a claiming preamble standing (review)", async () => {
    /*
     * Review pass: the substitution only ran on the natural settle. A preamble
     * streamed BEFORE the tool call is already on screen, and stopping the turn
     * (or a leg that never starts) left it there — "Creating that workflow for
     * you now" surviving a stop is the wave-11 lie with a different ending.
     */
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Your workflow has been created. " },
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      // The continuation leg never answers: the human stops the turn instead.
      () => []
    ])
    const controller = createAppController(store, unavailableRepositories, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await waitFor(() => store.collections.cards.get("flow-run-run-w12") !== undefined)
    controller.stop()
    await settle(4)

    expect(transcript(store)).not.toContain("has been created")
    expect(transcript(store)).toContain("I started a create-workflow run")
    expect(store.session().phase).toBe("idle")
  })

  test("the detector, in isolation: the live lie is a claim; a launch ack arms it", () => {
    expect(claimsRunState(WAVE11_LIE)).toBe(true)
    expect(claimsRunState("The workflow is ready for you.")).toBe(true)
    expect(claimsRunState("It should be done shortly.")).toBe(true)
    expect(claimsRunState("Approvals go to you, never to me.")).toBe(false)
    expect(renderedRunTurnText("flow.create", WAVE11_LIE)).toBe(
      "I started a create-workflow run — the run card shows its real progress."
    )
    expect(
      runLaunchCommandOf("commands", JSON.stringify({ action: "execute", name: "flow.create", args: "x" }))
    ).toBe("flow.create")
    expect(
      runLaunchCommandOf("commands", JSON.stringify({ action: "execute", name: "/flow.create", args: "x" }))
    ).toBe("flow.create")
    expect(runLaunchCommandOf("commands", JSON.stringify({ action: "execute", name: "world" }))).toBeUndefined()
    expect(runLaunchCommandOf("commands", "not json")).toBeUndefined()
    expect(toolResultLaunchedRun("run-started workflow=create-workflow run=r1 repo=o/r")).toBe(true)
    expect(toolResultLaunchedRun("failed: run-started")).toBe(false)
  })
})

describe("wave 12 §2 — flow.create asks WHICH loaded repo", () => {
  test("one loaded repo is not a question", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store, [REPO])

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    expect(said(outcome)).toContain("run-started")
    expect(store.collections.cards.get("workflow-repo")).toBeUndefined()
    expect(double.state.launched[0]?.repo).toBe(REPO)
  })

  test("an owner/repo argument targets it directly — slash and agent alike", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store, [REPO, OTHER_REPO])

    const outcome = await controller.commands.run("flow.create", `summarize my open issues ${OTHER_REPO}`)
    expect(said(outcome)).toContain(`repo=${OTHER_REPO}`)
    // The repo token is the target, NOT part of the description.
    expect(double.state.launched[0]).toMatchObject({
      workflow: "create-workflow",
      repo: OTHER_REPO,
      input: { prompt: "summarize my open issues" }
    })
    expect(store.collections.cards.get("workflow-repo")).toBeUndefined()
  })

  test("more than one loaded repo and no argument: the chooser-among-loaded, then one act creates it", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store, [REPO, OTHER_REPO])

    const asked = await controller.commands.run("flow.create", "summarize my open issues")
    expect(said(asked)).toContain("2 repositories")
    /*
     * Review pass: a QUESTION is not a failure. Live on canary the transcript
     * read "Smithers tried /flow.create — failed: You have 3
     * repositories…" beside the card that had just asked, correctly, which one.
     */
    expect(asked.status).toBe("executed")
    // EMBED LAW: the question is a card in the transcript, the surface stays.
    const card = store.collections.cards.get("workflow-repo")
    expect(card?.kind).toBe("workflow-repo")
    expect(card?.kind === "workflow-repo" && [...card.payload.repos].sort()).toEqual([OTHER_REPO, REPO].sort())
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")
    // Nothing was provisioned on a guess.
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)

    // ONE confirm: choosing IS the answer, and the create resumes with it.
    const chosen = await controller.commands.run("flow.repo.choose", OTHER_REPO)
    expect(said(chosen)).toContain(`repo=${OTHER_REPO}`)
    expect(double.state.launched[0]).toMatchObject({
      repo: OTHER_REPO,
      input: { prompt: "summarize my open issues" }
    })
    const answered = store.collections.cards.get("workflow-repo")
    expect(answered?.kind === "workflow-repo" && answered.payload.chosen).toBe(OTHER_REPO)
    expect(answered?.status).toBe("acted")

    // Review pass: a question is answered ONCE. A second act on the same card
    // (two clicks racing the state) may not launch the same workflow twice —
    // a launch is real work on the user's workspace.
    const again = await controller.commands.run("flow.repo.choose", OTHER_REPO)
    expect(said(again)).toContain("already answered")
    expect(double.state.launched).toHaveLength(1)
  })

  test("the model may not answer the human's question for them (review)", async () => {
    /*
     * Review pass: the card bindings were `hidden` but not `trigger:
     * "user"`, and hidden only keeps a command out of the tool CATALOG — the
     * commands tool executes anything by name that is not user-only. So the
     * model could have picked the repository itself, provisioning on ITS guess
     * against the very thing §2 exists for (wave 10 §2a: a deterministic
     * affordance must not route through the model). The trigger axis is what
     * makes that structural.
     *
     * Lane runs changed flow.run.stop's stance deliberately: stopping a run
     * is consequential rather than browser mechanics, so the model may ASK
     * (confirm turns its invocation into a confirmation message; nothing runs
     * until the human clicks). The three-door law (agent-parity.md) moved
     * flow.run.retry to the same stance — a retry spends, so it confirms —
     * while flow.repo.choose stays user-only: it is the human's ANSWER.
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store, [REPO, OTHER_REPO])

    await controller.commands.run("flow.create", "summarize my open issues")
    expect(store.collections.cards.get("workflow-repo")).toBeDefined()

    const refused = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.repo.choose", args: OTHER_REPO })
    })
    expect(refused).toContain("user-only")
    expect(refused).toContain("the human's choice")
    const retryAsked = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.run.retry", args: OTHER_REPO })
    })
    expect(retryAsked).toContain("asked the user to confirm")
    // A stop the model asks for is a question, never an act: nothing was cancelled.
    const asked = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.run.stop", args: "flow-run-run-1" })
    })
    expect(asked).toContain("confirm")
    expect(double.calls.some((call) => JSON.stringify(call.body).includes("\"Cancel\""))).toBe(false)
    // The question is still open and nothing was provisioned on the model's say-so.
    const card = store.collections.cards.get("workflow-repo")
    expect(card?.kind === "workflow-repo" && card.payload.chosen).toBeNull()
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)
    // The catalog never listed them either.
    const listed = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    expect(listed).not.toContain("flow.repo.choose")
    expect(listed).not.toContain("flow.run.stop")
  })
})

describe("wave 12 §3 — a run the workspace never finishes", () => {
  test("no progress for the bound: the card says it has gone quiet and the pump stops", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      // A bound the test can actually wait out; production is 10 minutes.
      workflowQuietMs: 25
    })
    await signIn(store)

    // The live shape exactly: the run keeps reading "running" and its
    // summary never says another word.
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "quiet")

    const card = runCard(store)
    expect(card?.payload.phase).toBe("quiet")
    expect(card?.payload.quietForMs).toBeGreaterThanOrEqual(25)

    // The pump stopped hammering: no further reads after it settled.
    const before = double.calls.filter((call) => call.path === "/api/workflow/rpc").length
    await settle(30)
    const after = double.calls.filter((call) => call.path === "/api/workflow/rpc").length
    expect(after).toBe(before)
  })

  test("real progress keeps the clock honest — a moving run never goes quiet", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      // Generous next to the emit cadence below: what is being pinned is
      // that progress RESETS the clock, not a race against the wall.
      workflowQuietMs: 1_000
    })
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    for (let step = 1; step <= 5; step += 1) {
      double.advance(1, 1)
      await settle(10)
    }
    expect(runCard(store)?.payload.phase).toBe("running")
  })

  test("the quiet card's two acts are registered commands: check again, or stop watching", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      ...double.services,
      workflowQuietMs: 25
    })
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "quiet")

    // Retry restarts the watch and says so in words.
    expect((await controller.commands.run("flow.run.retry", "flow-run-run-w12")).status).toBe("executed")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("Checking the run again")
    await settle(4)

    /*
     * Stop now stops the RUN: the rc.0 gateway relays a durable `Cancel`, so
     * the card can say the run was cancelled without claiming anything the
     * workspace did not do.
     */
    expect((await controller.commands.run("flow.run.stop", "flow-run-run-w12")).status).toBe("executed")
    await waitFor(() => runCard(store)?.payload.phase === "cancelled")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("Cancelled this run.")
    expect(
      double.calls.some((call) => (call.body as { procedure?: string } | undefined)?.procedure === "Cancel")
    ).toBe(true)
    const settledCalls = double.calls.filter((call) => call.path === "/api/workflow/rpc").length
    await settle(30)
    expect(double.calls.filter((call) => call.path === "/api/workflow/rpc").length).toBe(settledCalls)
  })
})

describe("wave 12 §4 — the residuals", () => {
  test("a watched repo with no Smithers Cloud counterpart gets its own honest line", async () => {
    const store = await webStore()
    const double = relay({
      provision: () => ({
        status: "no-cloud-repo",
        message: `${REPO} isn't on Smithers Cloud yet, so there is no workspace to provision for it.`
      })
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    expect(said(outcome)).toContain("isn't on Smithers Cloud yet")
    // Honest, and un-looped: one provision attempt, nothing launched.
    expect(double.calls.filter((call) => call.path === "/api/workflow/provision")).toHaveLength(1)
    expect(double.state.launched).toHaveLength(0)
  })
})
