/*
 * Lane runs — the run lifecycle beyond launch, through the real controller
 * against a relay double speaking the wire's own shapes.
 *
 * Pinned here: the run inbox (runs.list, its filters, and the honest by=
 * refusal — the wire records no launcher), opening a run as a card, the
 * lifecycle acts (resume, rerun with its launch input or the honest refusal,
 * signal, the steer family), the facets (transcript with follow, the
 * verbose-gated events tab), the trace's reader gestures, stop-all, and the
 * approvals inbox, including the `inboxCardId:requestId` decision routing
 * that lets a human decide a gate whose own approval card never landed.
 */
import type { StorageApi } from "@tanstack/db"
import { CODING_PLAN } from "../cards/fixtures/CodingPlan"
import { preparedCodingJournal } from "../cards/fixtures/CodingJournal"
import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import { runCardInScope, approvalCardIdFor } from "./RunReference"
import { gatewayRunContextFor } from "./RepoContext"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"

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

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (!condition()) throw new Error("condition never held")
}

const REPO = "codeplanesmithers/smithers-demo"

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

interface SummarySpec {
  readonly runId: string
  readonly flowId: string
  readonly status: string
  readonly waitingReason?: string
  readonly lineageId?: string
  readonly steeringPending?: number
  readonly createdAt?: number
  readonly turns?: number
  readonly calls?: number
}

const summaryRow = (spec: SummarySpec) => ({
  runId: spec.runId,
  flowId: spec.flowId,
  status: spec.status,
  createdAt: spec.createdAt ?? 1,
  updatedAt: 2,
  ...(spec.waitingReason === undefined ? {} : { waitingReason: spec.waitingReason }),
  ...(spec.lineageId === undefined ? {} : { lineageId: spec.lineageId }),
  ...(spec.steeringPending === undefined ? {} : { steeringPending: spec.steeringPending }),
  turns: spec.turns ?? 0,
  calls: spec.calls ?? 0,
  callsFailed: 0,
  editsAttempted: 0,
  editsSucceeded: 0,
  inputTokens: 0,
  outputTokens: 0,
  verdict: spec.status,
  diagnosis: "Verdict   done."
})

const approvalRow = (runId: string, requestId: string, title: string) => ({
  runId,
  requestId,
  title,
  request: { question: title },
  payload: {
    target: {
      _tag: "Node",
      runId,
      requestId,
      digest: "sha256:test",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "run",
    idempotencyKey: `approve:${requestId}`
  },
  requestedAt: 1500,
  status: "pending"
})

/** A relay double that speaks every selector and procedure the lane rides. */
const relay = (options: {
  readonly runs?: ReadonlyArray<SummarySpec>
  readonly approvals?: ReadonlyArray<ReturnType<typeof approvalRow>>
  readonly transcriptLines?: ReadonlyArray<
    { runId: string; sequence: number; turn: number; at: number; kind: string; text: string }
  >
  readonly events?: ReadonlyArray<Record<string, unknown>>
  readonly refusals?: Readonly<Record<string, string>>
} = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const state = {
    launched: [] as Array<{ workflow: string; input: unknown; repo: string }>,
    resumed: [] as Array<{ runId: string; reason?: string }>,
    signaled: [] as Array<{ runId: string; signal: unknown }>,
    steered: [] as Array<{ runId: string; message: Record<string, unknown> }>,
    cancelled: [] as Array<{ runId: string; reason?: string }>,
    submitted: [] as Array<{ approval: unknown; decision: string }>
  }
  let runCounter = 0
  let planned: { flowId: string; input: unknown } | undefined

  const rowsAnswer = (projection: string, rows: ReadonlyArray<unknown>): Response =>
    json(200, { ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows } })

  const procedure = (repo: string, name: string, payload: Record<string, unknown>): Response => {
    const refusal = options.refusals?.[name]
    if (refusal !== undefined) return json(200, { ok: false, error: { message: refusal } })
    switch (name) {
      case "List":
        return json(200, {
          ok: true,
          payload: { _tag: "flows", items: [{ flowId: "review-pr", description: "" }] }
        })
      case "Plan":
        planned = { flowId: String(payload.flowId), input: payload.input }
        return json(200, {
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: planned.flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        })
      case "Run": {
        runCounter += 1
        state.launched.push({ workflow: planned?.flowId ?? "?", input: planned?.input, repo })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: `run-${runCounter}` } })
      }
      case "Resume":
        state.resumed.push({ runId: String(payload.runId), reason: payload.reason as string | undefined })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "re" } })
      case "Signal":
        state.signaled.push({ runId: String(payload.runId), signal: payload.signal })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "s" } })
      case "Steer":
        state.steered.push({ runId: String(payload.runId), message: payload.message as Record<string, unknown> })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "st" } })
      case "Cancel":
        state.cancelled.push({ runId: String(payload.runId), reason: payload.reason as string | undefined })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "c" } })
      case "Approval.Submit": {
        // The seam sends the envelope spread flat beside the decision.
        const { decision, ...approval } = payload
        state.submitted.push({ approval, decision: String(decision) })
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      }
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string; runId?: string }
        switch (selector._tag) {
          case "workspace-runs":
            return rowsAnswer("workspace-runs", (options.runs ?? []).map(summaryRow))
          case "run-summary": {
            const spec = (options.runs ?? []).find((run) => run.runId === selector.runId)
            // The control plane counts the steers it holds for the run, so the summary reports them once a Steer landed.
            const steeringPending = state.steered.filter((steer) => steer.runId === selector.runId).length
            return rowsAnswer(
              "run-summary",
              spec === undefined ? [] : [summaryRow(spec.steeringPending === undefined && steeringPending > 0 ? { ...spec, steeringPending } : spec)]
            )
          }
          case "approvals": {
            const rows = (options.approvals ?? []).filter((row) =>
              selector.runId === undefined || row.runId === selector.runId
            )
            return rowsAnswer("approvals", rows)
          }
          case "transcript":
            return rowsAnswer("transcript", options.transcriptLines ?? [])
          case "run-events": {
            const after = payload.after as { value: number; offset: number } | undefined
            let offset = 0
            const events = options.events ?? []
            return rowsAnswer("run-events", events.filter((event, i) => {
              offset = i > 0 && events[i - 1]?.sequence === event.sequence ? offset + 1 : 0
              return after === undefined || Number(event.sequence) > after.value ||
                (event.sequence === after.value && offset > after.offset)
            }))
          }
          default:
            return rowsAnswer(String(selector._tag), [])
        }
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
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not this test's request.
      if (absolute.pathname.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      calls.push({ path: absolute.pathname + absolute.search, method: init?.method ?? "GET", body })
      if (absolute.pathname === "/api/workflow/provision") {
        return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        return procedure(String(body.repo), String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }

  return { services, calls, state }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>, loaded: Array<string> = [REPO]) => {
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

const runListCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-list" }> | undefined => {
  const card = store.collections.cards.get(`run-list-${REPO}`)
  return card?.kind === "run-list" ? card : undefined
}

const inboxCard = (
  store: Awaited<ReturnType<typeof webStore>>
): Extract<Card, { kind: "approvals-inbox" }> | undefined => {
  const card = store.collections.cards.get(`approvals-inbox-${REPO}`)
  return card?.kind === "approvals-inbox" ? card : undefined
}

describe("runs.list — the run inbox", () => {
  test("lists the workspace's runs as a card, filtered and sorted newest first", async () => {
    const store = await webStore()
    const double = relay({
      runs: [
        { runId: "run-old", flowId: "review-pr", status: "completed", createdAt: 1, turns: 4, calls: 9 },
        { runId: "run-new", flowId: "deploy", status: "parked", waitingReason: "approval", createdAt: 5, turns: 1, calls: 2 },
        { runId: "run-mid", flowId: "review-pr", status: "accepted", createdAt: 3 }
      ]
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const listed = await controller.commands.run("runs.list")
    expect(said(listed)).toContain("3 runs")
    const card = runListCard(store)
    expect(card?.payload.runs.map((run) => run.runId)).toEqual(["run-new", "run-mid", "run-old"])
    // The parked run names its wait; the accepted one names the executor convention.
    expect(card?.payload.runs[0]).toMatchObject({ waiting: "approval" })
    expect(card?.payload.runs[1]).toMatchObject({ waiting: "executor" })
    expect(card?.payload.runs[2]?.waiting).toBeUndefined()
    expect(double.calls.some((call) =>
      JSON.stringify(call.body).includes("\"workspace-runs\"")
    )).toBe(true)

    const filtered = await controller.commands.run("runs.list", "parked")
    expect(said(filtered)).toContain("1 run")
    expect(runListCard(store)?.payload.runs.map((run) => run.runId)).toEqual(["run-new"])
    expect(runListCard(store)?.payload.status).toBe("parked")
  })

  test("by= refuses honestly — the wire records no launcher — and asks nothing", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "running" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const before = double.calls.length
    const refused = await controller.commands.run("runs.list", "by=octocat")
    expect(said(refused)).toContain("no by=")
    expect(double.calls.length).toBe(before)
    expect(runListCard(store)).toBeUndefined()
  })

  test("signed-out is the identity guard's refusal, not a workspace call", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    const refused = await controller.commands.run("runs.list")
    expect(said(refused)).toContain("Sign in with GitHub first")
    expect(double.calls).toHaveLength(0)
  })
})

describe("runs.open / resume / signal / steer — the run's acts", () => {
  test("runs.open materializes the run's card from its summary", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-9", flowId: "deploy", status: "running" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const opened = await controller.commands.run("runs.open", "run-9")
    expect(said(opened)).toContain("run-opened run=run-9")
    const card = store.collections.cards.get("flow-run-run-9")
    expect(card?.kind === "run-trace" && card.payload.workflow).toBe("deploy")
    expect(card?.kind === "run-trace" && card.payload.repo).toBe(REPO)
  })

  test("runs.open names the miss honestly", async () => {
    const store = await webStore()
    const double = relay({ runs: [] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    const opened = await controller.commands.run("runs.open", "run-absent")
    expect(said(opened)).toContain("no run run-absent")
  })

  test("runs.resume sends the control Resume with an idempotency key", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-2", flowId: "review-pr", status: "parked", waitingReason: "quota" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const resumed = await controller.commands.run("runs.resume", "run-2")
    expect(said(resumed)).toContain("resume-requested run=run-2")
    expect(double.state.resumed).toEqual([{ runId: "run-2", reason: undefined }])
  })

  test("a resume refusal crosses as the flow's error", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-2", flowId: "review-pr", status: "completed" }],
      refusals: { Resume: "Terminal: the run is completed" }
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    const resumed = await controller.commands.run("runs.resume", "run-2")
    expect(resumed.status).toBe("failed")
    expect(said(resumed)).toContain("Terminal: the run is completed")
  })

  test("runs.signal parses the JSON payload; invalid JSON refuses without a call", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-3", flowId: "deploy", status: "parked", waitingReason: "event" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const sent = await controller.commands.run("runs.signal", `run-3 deploy-done {"ok":true}`)
    expect(said(sent)).toContain("signal-sent")
    expect(double.state.signaled).toEqual([{ runId: "run-3", signal: { name: "deploy-done", payload: { ok: true } } }])

    const before = double.state.signaled.length
    const refused = await controller.commands.run("runs.signal", "run-3 deploy-done {not json}")
    expect(said(refused)).toContain("isn't JSON")
    expect(double.state.signaled.length).toBe(before)
  })

  test("the steer family sends the steer envelope; the card notes the queued steer", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-4", flowId: "review-pr", status: "running" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.open", "run-4")

    const steered = await controller.commands.run("runs.steer", "run-4 use the smaller diff")
    expect(said(steered)).toContain("steered run=run-4")
    expect(double.state.steered[0]?.message).toMatchObject({ kind: "Message", body: "use the smaller diff", runId: "run-4" })

    await controller.commands.run("runs.seat", "run-4 anthropic:claude-opus-4-1")
    expect(double.state.steered[1]?.message).toMatchObject({ kind: "Seat", seat: "anthropic:claude-opus-4-1" })
    await controller.commands.run("runs.tools", "run-4 bash, edit")
    expect(double.state.steered[2]?.message).toMatchObject({ kind: "Tools", toolNames: ["bash", "edit"] })

    const card = store.collections.cards.get("flow-run-run-4")
    expect(card?.kind === "run-trace" && card.payload.steeringPending).toBe(true)
  })
})

describe("runs.rerun — the same flow, the same input, or the honest refusal", () => {
  test("a run launched from here reruns with its recorded input as a NEW run", async () => {
    const store = await webStore()
    const double = relay({ runs: [] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => double.state.launched.length === 1)
    // Launch carries no input for flow.run; give the card one as flow.create would.
    const firstRunId = "run-1"
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id: `flow-run-${firstRunId}`,
      patch: {
        payload: {
          ...(store.collections.cards.get(`flow-run-${firstRunId}`) as Extract<Card, { kind: "run-trace" }>).payload,
          input: { prompt: "summarize my open issues" }
        }
      }
    })

    const reran = await controller.commands.run("runs.rerun", firstRunId)
    expect(said(reran)).toContain("run-started")
    expect(double.state.launched).toHaveLength(2)
    expect(double.state.launched[1]).toMatchObject({
      workflow: "review-pr",
      input: { prompt: "summarize my open issues" },
      repo: REPO
    })
  })

  test("a run whose input was never recorded refuses instead of guessing", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-5", flowId: "deploy", status: "completed" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    // Opened from the inbox: the client never saw this run's launch input.
    await controller.commands.run("runs.open", "run-5")
    const before = double.state.launched.length
    const refused = await controller.commands.run("runs.rerun", "run-5")
    expect(said(refused)).toContain("nothing faithful to rerun")
    expect(double.state.launched.length).toBe(before)
  })
})

describe("the run card's facets — transcript, follow, and the verbose events tab", () => {
  // The served transcript row names its run; the seam decodes these against the gateway's schema.
  const lines = [
    { runId: "run-6", sequence: 1, turn: 1, at: 100, kind: "agent.turn.started", text: "turn 1 begins" },
    { runId: "run-6", sequence: 2, turn: 1, at: 200, kind: "control.approval.requested", text: "asks: deploy?" }
  ]

  test("runs.logs shows the transcript; --follow toggles the live merge", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-6", flowId: "deploy", status: "running" }],
      transcriptLines: lines
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.open", "run-6")

    const shown = await controller.commands.run("runs.logs", "run-6")
    expect(said(shown)).toContain("transcript run=run-6")
    let card = store.collections.cards.get("flow-run-run-6")
    expect(card?.kind === "run-trace" && card.payload.facet).toBe("transcript")
    expect(card?.kind === "run-trace" && card.payload.follow).toBe(false)
    expect(card?.kind === "run-trace" && card.payload.transcriptRows?.map((row) => row.text))
      .toEqual(["turn 1 begins", "asks: deploy?"])

    const followed = await controller.commands.run("runs.logs", "run-6 --follow")
    expect(said(followed)).toContain("following run=run-6")
    card = store.collections.cards.get("flow-run-run-6")
    expect(card?.kind === "run-trace" && card.payload.follow).toBe(true)
    // The pump merges the transcript on its own cycle while follow holds.
    await waitFor(() => {
      const current = store.collections.cards.get("flow-run-run-6")
      return current?.kind === "run-trace" && (current.payload.transcriptRows?.length ?? 0) === 2
    })
    // Following again unfollows.
    await controller.commands.run("runs.logs", "run-6 --follow")
    card = store.collections.cards.get("flow-run-run-6")
    expect(card?.kind === "run-trace" && card.payload.follow).toBe(false)
    // And the Steps tab is the way back.
    await controller.commands.run("runs.steps", "run-6")
    card = store.collections.cards.get("flow-run-run-6")
    expect(card?.kind === "run-trace" && card.payload.facet).toBe("steps")
  })

  test("runs.events exists only where verbose does", async () => {
    const store = await webStore()
    const double = relay({
      runs: [{ runId: "run-7", flowId: "deploy", status: "running" }],
      events: [{ kind: "control.run.accepted", payload: {}, sequence: 1, occurredAt: 100 }]
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.open", "run-7")

    const refused = await controller.commands.run("runs.events", "run-7")
    expect(said(refused)).toContain("/debug.verbose")

    await controller.commands.run("debug.verbose")
    const shown = await controller.commands.run("runs.events", "run-7")
    expect(said(shown)).toContain("events run=run-7")
    const card = store.collections.cards.get("flow-run-run-7")
    expect(card?.kind === "run-trace" && card.payload.facet).toBe("events")
    expect(card?.kind === "run-trace" && card.payload.events).toHaveLength(1)
  })
})

describe("the run trace's reader gestures and the pump's tail (spec 06 §5, §6)", () => {
  test("an incomplete agent request renders the view form with the known run prefilled", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), relay().services)
    await signIn(store)
    const result = await controller.commands.runForAgent("runs.trace.view", "run-8")
    expect(result).toMatchObject({ status: "form", flow: "runs.trace.view", fields: ["view"] })
    const form = store.collections.cards.get("form-runs.trace.view")
    expect(form?.kind === "flow-form" && form.payload).toMatchObject({
      flow: "runs.trace.view", via: "agent", draft: { runId: "run-8" }, given: { runId: "run-8" }
    })
    expect(form?.kind === "flow-form" && form.payload.fields.find((field) => field.name === "view")?.options?.map((option) => option.value))
      .toEqual(["turns", "timeline"])
  })

  test("runs.open builds the run-trace card under the flow-run id, on live tail, and the pump keeps its journal current", async () => {
    const store = await webStore()
    const journal: Array<Record<string, unknown>> = [
      { kind: "control.agent.turn-opened", payload: { seat: "openai:gpt-5.6-sol", at: 100 }, sequence: 1, occurredAt: 100 }
    ]
    const double = relay({
      runs: [{ runId: "run-8", flowId: "deploy", status: "running" }],
      events: journal
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.open", "run-8")
    let card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind).toBe("run-trace")
    expect(card?.kind === "run-trace" && card.payload.kind).toBeUndefined()
    expect(card?.kind === "run-trace" && card.payload.liveTail).toBe(true)
    // The trace is the card's body, so the journal arrives without a further act.
    await waitFor(() => {
      const current = store.collections.cards.get("flow-run-run-8")
      return current?.kind === "run-trace" && (current.payload.events?.length ?? 0) === 1
    })

    // The workspace journals a call; the pump's next cycle carries it onto the card.
    journal.push({ kind: "control.agent.cell-call-started", payload: { flowName: "files.read", input: { path: "README.md" }, at: 250 }, sequence: 2, occurredAt: 250 })
    await waitFor(() => {
      const current = store.collections.cards.get("flow-run-run-8")
      return current?.kind === "run-trace" && (current.payload.events?.length ?? 0) === 2
    })
    expect(double.calls.filter((call) => JSON.stringify(call.body).includes("\"run-events\"")).length).toBeGreaterThanOrEqual(2)

    // A filter is one word on the payload; nothing leaves the browser for it.
    const reads = double.calls.length
    const filtered = await controller.commands.run("runs.trace.filter", "run-8 failed")
    expect(said(filtered)).toBe("trace-filter run=run-8 filter=failed")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload.filter).toBe("failed")
    expect(double.calls.length).toBe(reads)

    // A selection names a node the journal in hand folds to, leaves live tail, and may scrub to a seq.
    const selected = await controller.commands.run("runs.trace.select", "run-8 call-1 2")
    expect(said(selected)).toBe("trace-select run=run-8 node=call-1 seq=2")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ selection: "call-1", liveTail: false, cursorSeq: 2, filter: "failed" })
    const invented = await controller.commands.run("runs.trace.select", "run-8 call-9")
    expect(said(invented)).toBe("Run run-8 has no trace node call-9.")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload.selection).toBe("call-1")
    // A sequence before this call, or beyond the journal, cannot quietly select current data.
    expect(said(await controller.commands.run("runs.trace.select", "run-8 call-1 1"))).toContain("no trace node call-1")
    expect(said(await controller.commands.run("runs.trace.select", "run-8 call-1 3"))).toContain("no recorded journal sequence 3")
    await controller.commands.runForAgent("runs.trace.view", "run-8 timeline")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload.traceView).toBe("timeline")
    // The background pump may append a system update after this command.
    // Assert the persisted gesture itself, not the last unrelated update.
    expect([...store.collections.transitions.values()].some((record) => {
      if (record.type !== "card.updated" || record.actor !== "smithers") return false
      const payload = JSON.parse(record.payload)
      return payload.id === "flow-run-run-8" && payload.patch?.payload?.traceView === "timeline"
    })).toBe(true)

    // A re-open keeps the reader's view (§5): filter, selection, cursor and live tail survive.
    await controller.commands.run("runs.open", "run-8")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ selection: "call-1", liveTail: false, cursorSeq: 2, filter: "failed", traceView: "timeline" })
    await controller.commands.runForAgent("runs.trace.live", "run-8")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload).toMatchObject({ liveTail: true, filter: "failed", traceView: "timeline" })
    expect(card?.kind === "run-trace" && card.payload.cursorSeq).toBeUndefined()
    expect(card?.kind === "run-trace" && card.payload.selection).toBeUndefined()
    // Omitting seq now pins the record in hand; a later settlement must not change that inspected value.
    await controller.commands.runForAgent("runs.trace.select", "run-8 call-1")
    card = store.collections.cards.get("flow-run-run-8")
    expect(card?.kind === "run-trace" && card.payload.cursorSeq).toBe(2)
  })

  test("both gestures need the run's card first", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-9", flowId: "deploy", status: "running" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    expect(said(await controller.commands.run("runs.trace.filter", "run-9 failed"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.trace.select", "run-9 frame-1"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.trace.view", "run-9 turns"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.trace.live", "run-9"))).toContain("runs.open run-9")
  })
})

describe("flow.run.stop-all — every live run, cancelled", () => {
  test("cancels each live run card's run and reports the count", async () => {
    const store = await webStore()
    const double = relay({
      runs: [
        { runId: "run-a", flowId: "deploy", status: "running" },
        { runId: "run-b", flowId: "review-pr", status: "running" }
      ]
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.open", "run-a")
    await controller.commands.run("runs.open", "run-b")

    const stopped = await controller.commands.run("flow.run.stop-all")
    expect(said(stopped)).toContain("stopped=2 of 2")
    expect(double.state.cancelled.map((entry) => entry.runId).sort()).toEqual(["run-a", "run-b"])
    expect(double.state.cancelled[0]?.reason).toContain("every run")
  })

  test("with nothing live there is nothing to stop", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    const stopped = await controller.commands.run("flow.run.stop-all")
    expect(said(stopped)).toContain("No runs are live")
    expect(double.state.cancelled).toHaveLength(0)
  })
})

describe("the approvals inbox — list, open, and the row decision", () => {
  test("approvals.list upserts the workspace's pending gates as one card", async () => {
    const store = await webStore()
    const double = relay({
      approvals: [approvalRow("run-a", "req-1", "Run the deploy script?"), approvalRow("run-b", "req-2", "Push the branch?")]
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const listed = await controller.commands.run("approvals.list")
    expect(said(listed)).toContain("2 approvals pending")
    const card = inboxCard(store)
    expect(card?.payload.approvals.map((row) => row.title)).toEqual(["Run the deploy script?", "Push the branch?"])
    // The inbox selected WITHOUT a run id — the whole workspace's gates.
    expect(double.calls.some((call) =>
      JSON.stringify(call.body).includes("\"_tag\":\"approvals\"}") ||
      JSON.stringify(call.body).includes("\"selector\":{\"_tag\":\"approvals\"}")
    )).toBe(true)
  })

  test("a row decision submits the gateway's own envelope unchanged and freezes the row", async () => {
    const store = await webStore()
    const double = relay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("approvals.list")

    // The exact dispatch the card's Approve button makes (approval.approve with the row id).
    const decided = await controller.commands.run("approval.approve", `approvals-inbox-${REPO}:req-1`)
    await settle(4)
    expect(decided.status).not.toBe("failed")
    expect(double.state.submitted).toHaveLength(1)
    expect(double.state.submitted[0]?.decision).toBe("approve")
    // The envelope went back byte-for-byte: no client reconstructs authority.
    expect(double.state.submitted[0]?.approval).toEqual(approvalRow("run-a", "req-1", "Run the deploy script?").payload)
    const card = inboxCard(store)
    expect(card?.payload.approvals[0]?.decision).toBe("approved")
    expect(card?.payload.approvals[0]?.decisionError).toBeUndefined()
  })

  test("a refused decision lands on the row as the error, never a fake freeze", async () => {
    const store = await webStore()
    const double = relay({
      approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")],
      refusals: { "Approval.Submit": "Stale: the gate was already decided" }
    })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("approvals.list")
    await controller.commands.run("approval.deny", `approvals-inbox-${REPO}:req-1`)
    await settle(4)
    const card = inboxCard(store)
    expect(card?.payload.approvals[0]?.decision).toBeUndefined()
    expect(card?.payload.approvals[0]?.decisionError).toContain("Stale")
  })

  test("approvals.open materializes a run's pending gates as ordinary approval cards", async () => {
    const store = await webStore()
    const double = relay({ approvals: [approvalRow("run-a", "req-1", "Run the deploy script?")] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)

    const opened = await controller.commands.run("approvals.open", "run-a")
    expect(said(opened)).toContain("1 approval opened for run run-a")
    const card = store.collections.cards.get("approval-run-a-req-1")
    expect(card?.kind === "approval" && card.payload.runId).toBe("run-a")
    expect(card?.kind === "approval" && card.payload.repo).toBe(REPO)

    // And those cards decide through the ordinary per-card path.
    await controller.commands.run("approval.approve", "approval-run-a-req-1")
    await settle(4)
    expect(double.state.submitted).toHaveLength(1)
  })
})


describe("typed coding launch and plan inspection", () => {
  test("the existing actor-tagged selection command reads prepared native plan evidence and respects the cursor", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-1", flowId: "coding", status: "running" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.open", `run-1 ${REPO}`)
    const original = store.collections.cards.get("flow-run-run-1") as Extract<Card, { kind: "run-trace" }>
    await store.dispatch({ type: "card.upsert", actor: "system", card: { ...original,
      payload: { ...original.payload, input: { prompt: CODING_PLAN.prompt }, events: preparedCodingJournal(), lastSeq: 5 } } })
    expect((await controller.commands.runForAgent("runs.coding.select", "sourceCard=flow-run-run-1 run-1 memory")).status).toBe("executed")
    const selected = store.collections.cards.get(original.id) as typeof original
    expect(selected.payload.codingChangeId).toBe("memory")
    expect([...store.collections.transitions.values()].filter(row => row.type === "card.upsert").at(-1)?.actor).toBe("smithers")
    await store.dispatch({ type: "card.upsert", actor: "user", card: { ...selected, payload: { ...selected.payload, cursorSeq: 3, liveTail: false } } })
    expect(said(await controller.commands.run("runs.coding.select", "sourceCard=flow-run-run-1 run-1 memory"))).toContain("no recorded planned Change")
  })

  test("flow.run preserves structured input, selection is actor-tagged and persisted, and reopening retains the plan", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({ runs: [{ runId: "run-1", flowId: "coding", status: "running" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    const launched = await controller.commands.run("flow.run", `coding ${REPO} ${JSON.stringify({ plan: CODING_PLAN })}`)
    expect(launched.status).toBe("executed")
    expect(double.state.launched[0]).toEqual({ workflow: "coding", input: { plan: CODING_PLAN }, repo: REPO })
    expect((await controller.commands.runForAgent("runs.coding.select", "run-1 memory")).status).toBe("executed")
    let card = store.collections.cards.get("flow-run-run-1") as Extract<Card, { kind: "run-trace" }>
    expect(card.payload.codingChangeId).toBe("memory")
    expect([...store.collections.transitions.values()].filter((row) => row.type === "card.upsert").at(-1)?.actor).toBe("smithers")
    await controller.commands.run("runs.open", `run-1 ${REPO}`)
    card = store.collections.cards.get("flow-run-run-1") as typeof card
    expect(card.payload.input).toEqual({ plan: CODING_PLAN })
    expect(card.payload.codingChangeId).toBe("memory")
    expect(said(await controller.commands.run("runs.coding.select", "run-1 fabricated"))).toContain("no recorded planned Change")
    await settle()
    controller.dispose()
    await store.dispose?.()
    const reloaded = await createAppStore({ kind: "localStorage", storage })
    const restored = reloaded.collections.cards.get("flow-run-run-1") as typeof card
    expect(restored.payload.codingChangeId).toBe("memory")
    expect(restored.payload.input).toEqual({ plan: CODING_PLAN })
    const second = createAppController(reloaded, unavailableRepositories, silentAgent(), double.services)
    await second.commands.run("runs.coding.select", "run-1 memory")
    expect((reloaded.collections.cards.get(card.id) as typeof card).payload.codingChangeId).toBeUndefined()
    second.dispose()
    await reloaded.dispose?.()
  })

  test("JSON input uses the existing schema form and malformed JSON launches nothing", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    const invalid = await controller.commands.run("flow.run", `coding ${REPO} {invalid`)
    expect(invalid.status).toBe("form")
    expect(double.state.launched).toHaveLength(0)
    const form = store.collections.cards.get("form-flow.run")
    expect(form?.kind === "flow-form" && form.payload.draft).toMatchObject({ name: "coding", repo: REPO, input: "{invalid" })
    expect(form?.kind === "flow-form" && form.payload.fields.some((field) => field.name === "input" && field.label === "Input JSON")).toBe(true)
    expect(form?.kind === "flow-form" && form.payload.error).toContain("not valid JSON")
    expect(said(await controller.commands.run("form.submit", "form-flow.run"))).toContain("not valid JSON")
    expect(double.state.launched).toHaveLength(0)
    await controller.commands.run("form.set", `form-flow.run input ${JSON.stringify({ plan: CODING_PLAN })}`)
    const result = await controller.commands.run("form.submit", "form-flow.run")
    expect(result.status).toBe("executed")
    expect(double.state.launched[0]?.input).toEqual({ plan: CODING_PLAN })
    const missing = await controller.commands.runForAgent("runs.coding.select", "run-1")
    expect(missing).toMatchObject({ status: "form", fields: ["changeId"] })
  })
})

describe("workspace-bound run cards", () => {
  const workspaceId = "83e75ae5-0920-4000-8000-000000000001"
  const selectWorkspace = async (store: Awaited<ReturnType<typeof webStore>>, id = workspaceId) => {
    await store.dispatch({
      type: "workspace.updated", actor: "system", workspace: {
        id, repoId: REPO, name: "Coding", status: "running", targetBookmark: "main",
        provisioningStage: null, suspendedAt: null, createdAt: null, head: null
      }
    }).isPersisted.promise
    await settle(2)
    store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${id}` })
    expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${id}`)
  }

  test("source-qualified flow catalogs and launches retain the original host through selection and reload", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({ runs: [{ runId: "run-1", flowId: "coding/request", status: "completed" }] })
    let controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store, [REPO, "other/repo"])
    await selectWorkspace(store)
    expect((await controller.commands.run("flow.run", "coding/request")).status).toBe("executed")
    const source = runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" })!
    await waitFor(() => runCardInScope(store, source.payload)?.payload.phase === "completed")
    await selectWorkspace(store, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    const before = double.calls.length
    expect((await controller.commands.run("flow.list", `sourceCard=${source.id}`)).status).toBe("executed")
    const catalog = [...store.collections.cards.values()].find(card => card.kind === "workflow-list" && card.payload.workspaceId === workspaceId)!
    expect(catalog).toMatchObject({ payload: { repo: REPO, workspaceId, gatewayBindingVersion: 1 } })
    expect(catalog.id).not.toBe(`workflow-list-${REPO}`)
    const missing = await controller.commands.runForAgent("flow.run", `sourceCard=${source.id}`)
    expect(missing).toMatchObject({ status: "form", fields: ["name"] })
    expect(store.collections.cards.get("form-flow.run")).toMatchObject({ payload: { draft: { sourceCard: source.id } } })
    expect((await controller.commands.run("flow.run", `sourceCard=${source.id} coding/vibe {"requestExecutionId":"native-request"}`)).status).toBe("executed")
    expect(double.state.launched.at(-1)).toMatchObject({ workflow: "coding/vibe", input: { requestExecutionId: "native-request" } })
    for (const call of double.calls.slice(before).filter(call => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
    const refused = double.calls.length
    expect(said(await controller.commands.run("flow.run", `sourceCard=${source.id} coding/vibe other/repo`))).toContain("another repository")
    expect(said(await controller.commands.run("flow.list", "sourceCard=missing"))).toContain("unavailable")
    expect(double.calls.length).toBe(refused)
    await settle()
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    expect(store.collections.cards.get(catalog.id)).toMatchObject({ payload: { workspaceId, gatewayBindingVersion: 1 } })
    const afterReload = double.calls.length
    expect((await controller.commands.run("flow.run", `sourceCard=${catalog.id} review-pr`)).status).toBe("executed")
    for (const call of double.calls.slice(afterReload).filter(call => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
  })

  test("list and inbox cards retain their gateway across provision, reload, filters and uncarded row actions", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({
      runs: [{ runId: "listed", flowId: "review-pr", status: "completed" }],
      approvals: [approvalRow("gated", "gate-a", "Review the change"), approvalRow("direct", "gate-b", "Apply the change")]
    })
    const fetch = double.services.fetchImpl!
    const services = { ...double.services, fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/api/workflow/provision")) store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
      return fetch(input, init)
    } }
    let controller = createAppController(store, unavailableRepositories, silentAgent(), services)
    await signIn(store)
    await selectWorkspace(store)
    expect((await controller.commands.run("runs.list", REPO)).status).toBe("executed")
    await selectWorkspace(store)
    expect((await controller.commands.run("approvals.list", REPO)).status).toBe("executed")
    const listId = `run-list-${REPO}-${workspaceId}`
    const inboxId = `approvals-inbox-${REPO}-${workspaceId}`
    expect(store.collections.cards.get(listId)).toMatchObject({ payload: { workspaceId } })
    expect(store.collections.cards.get(inboxId)).toMatchObject({ payload: { workspaceId } })
    await settle(10)
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, unavailableRepositories, silentAgent(), services)
    await signIn(store)
    await selectWorkspace(store, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    await controller.commands.run("runs.list", `completed sourceCard=${listId} ${REPO}`)
    await controller.commands.run("runs.open", "listed")
    await controller.commands.run("approvals.open", "gated")
    expect(runCardInScope(store, { repo: REPO, runId: "listed", workspaceId })).toMatchObject({ payload: { workspaceId } })
    expect(store.collections.cards.get(approvalCardIdFor(store, { repo: REPO, runId: "gated", workspaceId }, "gate-a"))).toMatchObject({ payload: { workspaceId } })
    await controller.commands.run("approval.approve", approvalCardIdFor(store, { repo: REPO, runId: "gated", workspaceId }, "gate-a"))
    await controller.commands.run("approval.approve", `${inboxId}:gate-b`)
    await waitFor(() => double.state.submitted.length === 2, 10_000)
    for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
  })

  test("older ancillary omissions use the already-recorded bound run after persistence reload", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }], approvals: [approvalRow("run-1", "old-gate", "Approve")] })
    let controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    // Actual pre-binding rows: persisted before the new writer/version existed.
    const approval = approvalRow("run-1", "old-gate", "Approve")
    const base = { title: "Old", status: "active" as const, createdAt: 1, ordinal: 1 }
    for (const card of [
      { ...base, id: "flow-run-run-1", kind: "run-trace", payload: { repo: REPO, workspaceId, runId: "run-1", workflow: "review-pr", phase: "completed", steps: [], result: null, lastSeq: 0 } },
      { ...base, id: `run-list-${REPO}`, kind: "run-list", payload: { repo: REPO, runs: [{ runId: "run-1", flowId: "review-pr", status: "completed", createdAt: 1, turns: 0, calls: 0 }] } },
      { ...base, id: "approval-run-1-old-gate", kind: "approval", payload: { repo: REPO, runId: "run-1", requestId: "old-gate", capability: "Approve", approval: approval.payload } },
      { ...base, id: `approvals-inbox-${REPO}`, kind: "approvals-inbox", payload: { repo: REPO, approvals: [{ runId: "run-1", requestId: "old-gate", title: "Approve", approval: approval.payload, requestedAt: 1 }] } }
    ] as Array<Card>) await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await settle(10)
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await selectWorkspace(store, "ffffffff-ffff-ffff-ffff-ffffffffffff")
    expect(gatewayRunContextFor(store, "run-1")).toEqual({ repo: REPO, workspaceId })
    const before = double.calls.length
    const submittedBefore = double.state.submitted.length
    await controller.commands.run("approval.approve", "approval-run-1-old-gate")
    await controller.commands.run("approval.approve", `approvals-inbox-${REPO}:old-gate`)
    await waitFor(() => double.state.submitted.length === submittedBefore + 2, 10_000)
    await controller.commands.run("runs.resume", "run-1")
    const historicalList = store.collections.cards.get(`run-list-${REPO}`)!
    if (historicalList.kind !== "run-list") throw new Error("missing historical list")
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      ...historicalList, payload: { ...historicalList.payload, runs: [...historicalList.payload.runs,
        { runId: "unbound-run", flowId: "review-pr", status: "completed", createdAt: 1, turns: 0, calls: 0 }
      ] }
    } }).isPersisted.promise
    const beforeMixedRefresh = double.calls.length
    expect(said(await controller.commands.run("runs.list", `completed sourceCard=run-list-${REPO} ${REPO}`))).toContain("several gateways")
    expect(double.calls.length).toBe(beforeMixedRefresh)
    await store.dispatch({ type: "card.upsert", actor: "system", card: historicalList }).isPersisted.promise
    await controller.commands.run("runs.list", `completed sourceCard=run-list-${REPO} ${REPO}`)
    expect(store.collections.cards.get(`run-list-${REPO}`)).toMatchObject({ payload: { workspaceId, gatewayBindingVersion: 1 } })
    for (const call of double.calls.slice(before).filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
  })

  test("legacy list rows stay unbound and conflicting recorded workspace identities refuse", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "legacy", flowId: "review-pr", status: "completed" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    await controller.commands.run("runs.list", REPO)
    await selectWorkspace(store)
    await controller.commands.run("runs.open", "legacy")
    await waitFor(() => runCardInScope(store, { repo: REPO, runId: "legacy" })?.payload.phase === "completed")
    expect(gatewayRunContextFor(store, "legacy")).toEqual({ repo: REPO })
    for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).not.toHaveProperty("workspaceId")
    const listed = store.collections.cards.get(`run-list-${REPO}`)!
    if (listed.kind !== "run-list") throw new Error("missing list")
    store.dispatch({ type: "card.upsert", actor: "system", card: {
      ...listed, id: "conflicting-list", payload: { ...listed.payload, workspaceId }
    } })
    expect(gatewayRunContextFor(store, "legacy")).toMatchObject({ error: expect.stringContaining("conflicting") })
    const callsBefore = double.calls.length
    await controller.commands.run("runs.resume", "legacy")
    expect(double.calls.length).toBe(callsBefore)
  })

  for (const command of ["flow.run", "runs.open"] as const) {
    test(`${command} keeps its owning workspace across selection changes during provision and later resumption`, async () => {
      const store = await webStore()
      const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }] })
      const fetch = double.services.fetchImpl!
      const controller = createAppController(store, unavailableRepositories, silentAgent(), {
        ...double.services,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
          if (url.endsWith("/api/workflow/provision")) {
            store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
          }
          return fetch(input, init)
        }
      })
      await signIn(store)
      await selectWorkspace(store)
      const result = await controller.commands.run(command, command === "flow.run" ? "review-pr" : "run-1")
      expect(result.status).toBe("executed")
      expect(runCardInScope(store, { repo: REPO, runId: "run-1", workspaceId })).toMatchObject({ kind: "run-trace", payload: { workspaceId } })
      expect(store.session().activeRepoKey).toBe(REPO)
      for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) {
        expect(call.body).toMatchObject({ workspaceId })
      }
      await controller.commands.run("runs.resume", "run-1")
      const resumed = double.calls.find((call) => (call.body as { procedure?: string })?.procedure === "Resume")
      expect(resumed?.body).toMatchObject({ workspaceId })
      if (command === "flow.run") {
        const rerun = await controller.commands.run("runs.rerun", "run-1")
        expect(rerun.status).toBe("executed")
        expect(runCardInScope(store, { repo: REPO, runId: "run-2", workspaceId })).toMatchObject({ payload: { workspaceId } })
        const launches = double.calls.filter((call) => (call.body as { procedure?: string })?.procedure === "Run")
        expect(launches).toHaveLength(2)
        for (const launch of launches) expect(launch.body).toMatchObject({ workspaceId })
      }
    })
  }
  test("two gateway databases can both own run-1 without sharing cards, pumps, actions or reload state", async () => {
    const storage = memoryStorage()
    let store = await createAppStore({ kind: "localStorage", storage })
    const workspaceB = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    const makeDouble = (seat: string) => relay({
      runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }],
      approvals: [approvalRow("run-1", "same-gate", `Approve ${seat}`)],
      transcriptLines: [{ runId: "run-1", sequence: 1, turn: 1, at: 100, kind: "message", text: seat }],
      events: [{ kind: "control.agent.turn-opened", payload: { seat, at: 100 }, sequence: 1, occurredAt: 100 }]
    })
    const a = makeDouble("workspace A")
    const b = makeDouble("workspace B")
    const services: AppServices = { ...a.services, workflowPollMs: 100_000, fetchImpl: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {}
      return (body.workspaceId === workspaceB ? b : a).services.fetchImpl!(input, init)
    } }
    let controller = createAppController(store, unavailableRepositories, silentAgent(), services)
    // The slash grammar recognizes a trailing repository beside text only
    // when it is loaded. This makes the mismatch reach the gateway guard.
    await signIn(store, [REPO, "other/repo"])
    await selectWorkspace(store)
    expect((await controller.commands.run("flow.run", "review-pr")).status).toBe("executed")
    await selectWorkspace(store, workspaceB)
    expect((await controller.commands.run("flow.run", "review-pr")).status).toBe("executed")
    const scopeA = { repo: REPO, workspaceId, runId: "run-1" }
    const scopeB = { repo: REPO, workspaceId: workspaceB, runId: "run-1" }
    const cardA = runCardInScope(store, scopeA)!
    const cardB = runCardInScope(store, scopeB)!
    expect(cardA.id).not.toBe(cardB.id)
    await waitFor(() => runCardInScope(store, scopeA)?.payload.events?.length === 1 && runCardInScope(store, scopeB)?.payload.events?.length === 1, 10_000)
    expect(runCardInScope(store, scopeA)?.payload.events?.[0]?.payload).toMatchObject({ seat: "workspace A" })
    expect(runCardInScope(store, scopeB)?.payload.events?.[0]?.payload).toMatchObject({ seat: "workspace B" })
    expect(gatewayRunContextFor(store, "run-1")).toMatchObject({ error: expect.stringContaining("conflicting") })
    const callsBefore = a.calls.length + b.calls.length
    expect(said(await controller.commands.run("runs.resume", "run-1"))).toContain("conflicting")
    expect(said(await controller.commands.run("runs.open", `sourceCard=${cardA.id} wrong-run`))).toContain("does not record")
    expect(said(await controller.commands.run("runs.open", `sourceCard=${cardA.id} run-1 other/repo`))).toContain("another repository")
    expect(a.calls.length + b.calls.length).toBe(callsBefore)
    for (const [card, double, seat] of [[cardA, a, "workspace A"], [cardB, b, "workspace B"]] as const) {
      const source = `sourceCard=${card.id} run-1`
      expect((await controller.commands.run("runs.resume", source)).status).toBe("executed")
      expect((await controller.commands.run("runs.steer", `${source} keep sourceCard=literal`)).status).toBe("executed")
      expect(double.state.steered.at(-1)?.message.body).toBe("keep sourceCard=literal")
      expect((await controller.commands.run("runs.signal", `${source} go {"text":"a  b sourceCard=literal"}`)).status).toBe("executed")
      expect(double.state.signaled.at(-1)?.signal).toEqual({ name: "go", payload: { text: "a  b sourceCard=literal" } })
      expect((await controller.commands.run("runs.logs", source)).status).toBe("executed")
      expect(runCardInScope(store, card.payload)?.payload.transcriptRows?.[0]?.text).toBe(seat)
      expect((await controller.commands.run("approvals.open", source)).status).toBe("executed")
      const approvalId = approvalCardIdFor(store, card.payload, "same-gate")
      expect((await controller.commands.run("approval.approve", approvalId)).status).toBe("executed")
      await waitFor(() => double.state.submitted.length === 2, 10_000) // Plan plus this gate.
      expect(double.state.resumed).toHaveLength(1)
    }
    expect(approvalCardIdFor(store, scopeA, "same-gate")).not.toBe(approvalCardIdFor(store, scopeB, "same-gate"))
    const missing = await controller.commands.runForAgent("runs.trace.view", `sourceCard=${cardA.id} run-1`)
    expect(missing).toMatchObject({ status: "form", fields: ["view"] })
    const form = store.collections.cards.get("form-runs.trace.view")
    expect(form?.kind === "flow-form" && form.payload.draft).toMatchObject({ sourceCard: cardA.id, runId: "run-1" })
    await controller.commands.run("form.set", "form-runs.trace.view view timeline")
    expect((await controller.commands.run("form.submit", "form-runs.trace.view")).status).toBe("executed")
    await controller.commands.run("runs.trace.filter", `sourceCard=${cardA.id} run-1 failed`)
    expect(runCardInScope(store, scopeB)?.payload.filter).toBeUndefined()
    await settle(10)
    await controller.dispose()
    store = await createAppStore({ kind: "localStorage", storage })
    controller = createAppController(store, unavailableRepositories, silentAgent(), services)
    await signIn(store)
    await selectWorkspace(store, workspaceB)
    expect(runCardInScope(store, scopeA)).toMatchObject({ id: cardA.id, payload: { filter: "failed", traceView: "timeline" } })
    expect(runCardInScope(store, scopeB)).toMatchObject({ id: cardB.id })
    await selectWorkspace(store)
    await controller.commands.run("runs.list", REPO)
    await controller.commands.run("approvals.list", REPO)
    await selectWorkspace(store, workspaceB)
    await controller.commands.run("runs.list", REPO)
    await controller.commands.run("approvals.list", REPO)
    const listA = `run-list-${REPO}-${workspaceId}`
    const listB = `run-list-${REPO}-${workspaceB}`
    const searchRows = controller.searchPalette("run: run-1").groups.flatMap((group) => group.items.map((row) => row.item))
    expect(searchRows).toHaveLength(2)
    expect(new Set(searchRows.map((item) => item.ref)).size).toBe(2)
    for (const item of searchRows) {
      const primary = item.actions.find((action) => action.role === "primary")!
      expect(primary.flow).toBe("runs.resume")
      expect(primary.args).toContain("sourceCard=")
      expect((await controller.commands.run(primary.flow, primary.args)).status).toBe("executed")
    }
    expect(a.state.resumed).toHaveLength(2)
    expect(b.state.resumed).toHaveLength(2)
    await controller.commands.run("search.runs", "run-1")
    const searchCard = store.collections.cards.get("search-search.runs")
    expect(searchCard?.kind === "search-results" && searchCard.payload.items).toHaveLength(2)
    const lastA = a.calls.length
    expect((await controller.commands.run("runs.open", `sourceCard=${listA} run-1`)).status).toBe("executed")
    expect((await controller.commands.run("runs.open", `sourceCard=${listB} run-1`)).status).toBe("executed")
    expect(runCardInScope(store, scopeA)?.id).toBe(cardA.id)
    expect(runCardInScope(store, scopeA)?.payload.filter).toBe("failed")
    await waitFor(() => runCardInScope(store, scopeA)?.payload.phase === "completed" && runCardInScope(store, scopeB)?.payload.phase === "completed", 10_000)
    expect(a.calls.slice(lastA).filter((call) => call.path.startsWith("/api/workflow/")).every((call) => (call.body as { workspaceId?: string }).workspaceId === workspaceId)).toBe(true)
    const submittedA = a.state.submitted.length
    const submittedB = b.state.submitted.length
    await controller.commands.run("approval.approve", `approvals-inbox-${REPO}-${workspaceId}:same-gate`)
    await controller.commands.run("approval.approve", `approvals-inbox-${REPO}-${workspaceB}:same-gate`)
    await waitFor(() => a.state.submitted.length === submittedA + 1 && b.state.submitted.length === submittedB + 1, 10_000)
    // Stop-all uses the source list's displayed set, not every workspace with the same repo.
    const list = store.collections.cards.get(listA)!
    if (list.kind !== "run-list") throw new Error("missing list")
    await store.dispatch({ type: "card.upsert", actor: "system", card: { ...list, payload: { ...list.payload, runs: list.payload.runs.map((row) => ({ ...row, status: "running" })) } } }).isPersisted.promise
    await controller.commands.run("flow.run.stop-all", `sourceCard=${listA} ${REPO}`)
    expect(a.state.cancelled).toHaveLength(1)
    expect(b.state.cancelled).toHaveLength(0)
    await controller.commands.run("flow.run.stop", cardB.id)
    await waitFor(() => b.state.cancelled.length === 1, 10_000)
    for (const [double, workspace] of [[a, workspaceId], [b, workspaceB]] as const) {
      for (const call of double.calls.filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId: workspace })
    }
  }, 120_000)

  test("historical raw card addresses survive while new explicit legacy cards never inherit a workspace", async () => {
    const store = await webStore()
    const double = relay({ runs: [{ runId: "run-1", flowId: "review-pr", status: "completed" }, { runId: "child-1", flowId: "review-pr", status: "completed" }] })
    const controller = createAppController(store, unavailableRepositories, silentAgent(), double.services)
    await signIn(store)
    const old: Extract<Card, { kind: "run-trace" }> = {
      id: "flow-run-run-1", kind: "run-trace", title: "Old", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: REPO, workspaceId, runId: "run-1", workflow: "review-pr", phase: "completed", steps: [], result: null, lastSeq: 0,
        events: [
          { kind: "control.agent.cell-call-started", payload: { flowName: "agent/spawn", input: {} }, sequence: 1, occurredAt: 1 },
          { kind: "control.agent.cell-call-settled", payload: { flowName: "agent/spawn", outcome: "success", value: { child: "child-1" } }, sequence: 2, occurredAt: 2 },
          { kind: "control.engine.event", sequence: 3, occurredAt: 3, payload: {
            version: 1, executionId: "native-1", generation: 0, sequence: 1, eventId: "native-1/1",
            sourceId: "engine", sourceSequence: 1, emittedAtMs: 3, eventType: "flows.engine.run-decision",
            meta: { lineageId: "native-1" }, payload: { decision: "created", state: { version: 1, flowName: "coding/RunPlan", payload: {} } }
          } }
        ] }
    }
    await store.dispatch({ type: "card.upsert", actor: "system", card: old }).isPersisted.promise
    await controller.commands.run("runs.list", REPO) // A newly recorded, explicitly legacy list.
    const listId = `run-list-${REPO}`
    expect(store.collections.cards.get(listId)).toMatchObject({ payload: { gatewayBindingVersion: 1 } })
    expect(gatewayRunContextFor(store, "run-1")).toMatchObject({ error: expect.stringContaining("conflicting") })
    let before = double.calls.length
    expect((await controller.commands.run("runs.open", `sourceCard=${listId} run-1`)).status).toBe("executed")
    const legacy = runCardInScope(store, { repo: REPO, runId: "run-1" })!
    expect(legacy.id).not.toBe(old.id)
    expect(store.collections.cards.get(old.id)).toMatchObject({ payload: { workspaceId } })
    await waitFor(() => legacy.id !== undefined && runCardInScope(store, { repo: REPO, runId: "run-1" })?.payload.phase === "completed", 10_000)
    for (const call of double.calls.slice(before).filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).not.toHaveProperty("workspaceId")
    const beforeNative = double.calls.length
    expect(said(await controller.commands.run("runs.open", `sourceCard=${old.id} native-1`))).toContain("does not record")
    expect(double.calls.length).toBe(beforeNative)
    // Only an actual recorded agent/spawn child can use its parent's source.
    before = double.calls.length
    expect((await controller.commands.run("runs.open", `sourceCard=${old.id} child-1`)).status).toBe("executed")
    expect(runCardInScope(store, { repo: REPO, workspaceId, runId: "child-1" })).toBeDefined()
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId, runId: "child-1" })?.payload.phase === "completed", 10_000)
    for (const call of double.calls.slice(before).filter((call) => call.path.startsWith("/api/workflow/"))) expect(call.body).toMatchObject({ workspaceId })
    expect((await controller.commands.run("runs.open", `sourceCard=${old.id} run-1`)).status).toBe("executed")
    expect(runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" })?.id).toBe(old.id)
    await waitFor(() => runCardInScope(store, { repo: REPO, workspaceId, runId: "run-1" })?.payload.phase === "completed")
    const wireCount = double.calls.length
    expect(said(await controller.commands.run("runs.resume", `sourceCard=${old.id} child-1`))).toContain("does not record")
    expect(double.calls.length).toBe(wireCount)
  }, 60_000)

})
