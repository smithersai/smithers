import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import type { AppServices } from "../AppController"
import { scopedControllers } from "../ControllerTestScope"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { waitFor } from "../TestFixtures"
import { Schema } from "effect"
import { initialSetup } from "@smthrs/rpc/RepositorySetup"
import { NO_RULES_SENTENCE, registerUnavailableSentence } from "./TriggersSeam"

const createAppController = scopedControllers()

// The first controller in a file pays the module warm-up; under machine load that alone passes 5 s.
setDefaultTimeout(30_000)

/*
 * The triggers seam through the real command path: controller.commands.run
 * drives triggers.list exactly as the Dispatcher chrome button, the Flows
 * pane door and the slash do. The declared rows come from the public mirror's
 * contents route for `.smithers/factory.json`; the live rows come from the
 * Worker's triggers route only for a signed-in session. The card states only
 * what each source answered.
 */

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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Route = Response | ((request: Request) => Response | Promise<Response>)

const backend = (routes: Record<string, Route>, seen: Array<string> = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    seen.push(path)
    for (const [route, answer] of Object.entries(routes)) {
      if (path === route || path.startsWith(`${route}?`)) {
        return typeof answer === "function" ? answer(new Request(absolute.toString(), init)) : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

/** A controller watching exactly will/flows over the given backend, signed out unless asked. */
const ready = async (services: AppServices, options: { signedIn?: boolean; store?: AppStore } = {}) => {
  const store = options.store ?? await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  if (options.signedIn === true) await signedIn(store)
  else await signedOut(store)
  await reposChosen(store)
  return { store, controller }
}

const REPO = "/api/repos/will/flows"
const PROJECTION = `${REPO}/contents/.smithers/factory.json`
const LIVE = "/api/workflow/triggers"

/** The day-one table (design §7) as the mirror serves the committed projection: a base64 contents document. */
const projectionDocument = (projection: unknown): Response =>
  json(200, {
    path: ".smithers/factory.json",
    encoding: "base64",
    content: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(projection))))
  })

const DAY_ONE = {
  summary: "How will/flows develops itself.",
  flows: [
    {
      id: "review",
      description: "Reviews the change.",
      summary: "Review the change.",
      featured: true,
      kind: "mdx",
      path: "flows/review/flow.mdx",
      capabilities: ["fs:read:**"],
      model: null,
      modelInvocable: true
    }
  ],
  github: { mirror: "push", issues: "two-way", changes: "land" },
  on: [
    { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
    { event: "issue.labeled:smithers", flow: "implement" },
    { event: "change.landed", flow: ["wiki", "history.fold", "improve.mine"] },
    { event: "schedule:0 9 * * 1-5", flow: "review" }
  ]
}

const triggerCard = (store: AppStore) => {
  const card = store.collections.cards.get("trigger-list-will/flows")
  if (card === undefined || card.kind !== "trigger-list") throw new Error("expected the dispatcher card")
  return card
}

describe("triggers seam: the declaration, signed out", () => {
  test("the declared rows come from the projection on the public mirror, and the Worker's triggers route is never asked", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }, seen))
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = triggerCard(store)
    expect(card.title).toBe("Dispatcher · will/flows")
    expect(card.payload).toEqual({
      repo: "will/flows",
      declared: DAY_ONE.on,
      live: false,
      triggers: [],
      webhooks: []
    })
    // The projection is read once for the card (and once more by the repository-flows seam, which reads the same file for the slash leaves).
    expect(new Set(seen)).toEqual(new Set([PROJECTION]))
    expect(seen.some((path) => path.startsWith(LIVE))).toBe(false)
  })

  test("a mirror with no projection committed yet is 'No rules declared yet': an empty table, no live rows, no reason", async () => {
    const { store, controller } = await ready(backend({}))
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toBe(`${NO_RULES_SENTENCE} on will/flows.`)
    await settled()
    const card = triggerCard(store)
    expect(card.payload).toEqual({ repo: "will/flows", declared: [], live: false, triggers: [], webhooks: [] })
    expect(JSON.stringify(card.payload)).not.toContain("reason")
  })

  test("a projection the schema does not accept, or a mirror that does not answer, is an honest refusal, never an empty table", async () => {
    const malformed = await ready(backend({ [PROJECTION]: projectionDocument({ flows: ["issue"], on: [] }) }))
    const refused = await malformed.controller.commands.run("triggers.list")
    expect(refused.status).toBe("failed")
    if (refused.status === "failed") expect(refused.error).toBe("The rules of will/flows couldn't be read: .smithers/factory.json is not a factory projection.")
    expect(malformed.store.collections.cards.get("trigger-list-will/flows")).toBeUndefined()

    const down = await ready(backend({ [PROJECTION]: json(502, { message: "Repository data is temporarily unavailable." }) }))
    const unavailable = await down.controller.commands.run("triggers.list")
    expect(unavailable.status).toBe("failed")
    if (unavailable.status === "failed") expect(unavailable.error).toBe("The rules of will/flows couldn't be read: the mirror did not answer for .smithers/factory.json.")
  })

  test("the slash door and the agent door run the read signed out, and the register door defers behind sign-in", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }))
    expect((await controller.commands.runForAgent("triggers.list", "will/flows")).status).toBe("executed")
    expect(store.session().pendingCommand ?? null).toBeNull()
    /* The human's door parks the write behind sign-in: the outcome is auth.sign-in's, the parked flow is the register. */
    await controller.commands.run("triggers.register")
    expect(store.session().pendingCommand?.name).toBe("triggers.register")
    expect(store.session().pendingCommand?.requirement).toBe("signed-in")
    const agentRefused = await controller.commands.runForAgent("triggers.register", "will/flows")
    expect(agentRefused.status).toBe("failed")
    if (agentRefused.status === "failed") expect(agentRefused.error).toContain("Sign in with GitHub first")
  })
})

describe("triggers seam: the box, signed in", () => {
  test("a box that answered adds live rows beside the declared ones", async () => {
    const seen: Array<string> = []
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, {
          status: "ok",
          repo: "will/flows",
          live: true,
          triggers: [
            { id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true, lastFiredAt: 1_700_000_000_000, nextFireAt: 1_700_086_400_000, activeRunId: "run-8f21" },
            { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false },
            { id: "broken" }
          ],
          webhooks: [{ name: "github-push", flowId: "review" }, { flowId: "nameless" }]
        })
      }, seen),
      { signedIn: true }
    )
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toBe(
        "Dispatcher on will/flows: 4 rules declared in .smithers/FACTORY.ts: issue.opened runs issue; issue.labeled:smithers runs implement; change.landed runs wiki, history.fold, improve.mine; schedule:0 9 * * 1-5 runs review. the box is listening: nightly runs review, sweep runs issue, webhook github-push runs review."
      )
    }
    await settled()
    const card = triggerCard(store)
    expect(card.payload.declared).toEqual(DAY_ONE.on)
    expect(card.payload.live).toBe(true)
    expect(card.payload.triggers).toEqual([
      { id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true, lastFiredAt: 1_700_000_000_000, nextFireAt: 1_700_086_400_000, activeRunId: "run-8f21" },
      { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }
    ])
    expect(card.payload.webhooks).toEqual([{ name: "github-push", flowId: "review" }])
    /* Two live sources now: the box's own store and the repository's Smithers Cloud registrations. */
    expect(seen.filter((path) => path !== PROJECTION).sort()).toEqual(
      [`${LIVE}?repo=will%2Fflows`, `/api/workflow/trigger-registrations?repo=will%2Fflows`].sort()
    )
    expect(seen).toContain(PROJECTION)
  })

  test("signed in with no box answering, the card is the declaration alone with live false", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, { status: "ok", repo: "will/flows", live: false, triggers: [], webhooks: [] })
      }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload).toEqual({ repo: "will/flows", declared: DAY_ONE.on, live: false, triggers: [], webhooks: [] })
    /* A route that stopped answering does not fail the card: the declaration still renders, with no live column. */
    const down = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE), [LIVE]: json(502, { message: "gateway down" }) }), { signedIn: true })
    expect((await down.controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(down.store).payload.live).toBe(false)
  })

  /* Was: the door refused every registration with a sentence. THE FORM LAW replaces that with the form. */
  test("the register door runs signed in and asks for what it is missing", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    const outcome = await controller.commands.run("triggers.register")
    expect(outcome.status).toBe("form")
    if (outcome.status === "form") expect(outcome.fields).toEqual(["flow", "slug", "schedule"])
  })

  test("re-listing re-surfaces the one card at the end of the transcript instead of adding a second", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    const first = triggerCard(store)
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    const second = triggerCard(store)
    expect([...store.collections.cards.values()].filter((card) => card.kind === "trigger-list")).toHaveLength(1)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.ordinal).toBeGreaterThan(first.ordinal)
  })
})

/*
 * The generic flow trigger: prepare a registration, preview the plan the
 * workspace made, approve it as the human, and register. The relay, the
 * Worker's three trigger routes and Smithers Cloud are all stubs here; no
 * test in this file may reach a network.
 */

const RPC = "/api/workflow/rpc"
const REGISTRATIONS = "/api/workflow/trigger-registrations"
const PAUSE = "/api/workflow/trigger-pause"
const APPROVAL = "/api/workflow/trigger-approval"

interface RelayCall {
  readonly procedure: string
  readonly payload: Record<string, unknown>
  /** Which box the Worker was asked to relay to: the repository's own, or one workspace's. */
  readonly workspaceId?: string
}

const PLAN_DIGEST = "d".repeat(64)
/* The card Control publishes: its envelope carries the budget nested, exactly as control/ControlSchema.ts Envelope declares it. */
const PLAN = {
  planId: "plan-1",
  digest: PLAN_DIGEST,
  flowId: "nightly-lint",
  executionDigest: "e".repeat(64),
  envelope: { capabilities: ["fs:read:**"], flows: ["nightly-lint"], budget: { tokens: 200_000, milliseconds: 1_800_000 } }
}

/* Exactly what the workspace publishes for a flow's input: registry Descriptor.inputDocument's own document. */
const LINT_SCHEMA = JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(Schema.Struct({ label: Schema.String })))) as unknown

const FLOW_ITEMS = [
  { flowId: "nightly-lint", description: "Lints the repository.", inputSchema: LINT_SCHEMA },
  { flowId: "repository/trigger", description: "Register one repository flow to run on a reviewed schedule." }
]

const okFrame = (payload: unknown) => ({ ok: true, payload })
const refusedFrame = (message: string, detail?: unknown) => ({ ok: false, error: { message, ...(detail === undefined ? {} : { detail }) } })

/** The workspace Smithers Cloud gave this repository's reviewed jobs: the box whose gateway runs the coding host. */
const JOB_WORKSPACE = "b9275008-1c3e-4f2a-9a7d-0c2f5a6b1d84"

/*
 * The repository's own gateway, which is the box a relay body that names no
 * workspace reaches: plue matches such a call to the `workspace_id IS NULL`
 * row alone (db/queries/repo_gateways.sql), and that row runs the product
 * host — the two librarian flows, no registrar, and no run of one.
 */
const productHost: Record<string, (payload: Record<string, unknown>) => unknown> = {
  List: () => okFrame({ _tag: "flows", items: [{ flowId: "librarian/history" }, { flowId: "librarian/wiki" }] }),
  Plan: (payload) => refusedFrame(`No flow "${String(payload.flowId)}" is registered on this workspace.`, [
    { _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId: payload.flowId } }
  ]),
  "Projection.Snapshot": () => okFrame({ rows: [] })
}

/** The relay stub: every call recorded, answered by the box its own frame named. */
const relayRoute = (
  calls: Array<RelayCall>,
  answers: Record<string, (payload: Record<string, unknown>) => unknown>
): Route =>
async (request) => {
  const frame = await request.json() as { procedure: string; payload: Record<string, unknown>; workspaceId?: string }
  calls.push({ procedure: frame.procedure, payload: frame.payload, ...(frame.workspaceId === undefined ? {} : { workspaceId: frame.workspaceId }) })
  const answer = (frame.workspaceId === JOB_WORKSPACE ? answers : productHost)[frame.procedure]
  /* A stub may answer late, or never: a launch a reload interrupts is a call the workspace never answers. */
  return json(200, answer === undefined ? { ok: false, error: { message: `no stub for ${frame.procedure}` } } : await answer(frame.payload))
}

/** The registrar run the workspace started; the registration's outcome is this run's outcome. */
const REGISTRAR_RUN = "run-1"

/** How the registrar run stands, as the workspace's own run-summary projection answers for it. */
interface HostRun {
  status: "running" | "completed" | "failed"
  /** A completed run's own output line. A failed run's verdict is derived from its journal cause, as the gateway derives it. */
  verdict: string
  /**
   * What the agent journals on `control.run.failed`: `<code>: <sentence>` on
   * the first line (internal/FailureSummary.ts), then the rendered cause.
   */
  cause?: string
}

/**
 * The gateway's own one-line verdict for a failed run, as
 * `packages/smithers/gateway` Diagnosis.verdict writes it: the cause's first
 * line behind `failed — `, clipped to 100 code points. The registrar's code
 * rides in front of the sentence, and a long sentence loses its ending.
 */
const hostVerdict = (cause: string): string => {
  const line = cause.split(/[\r\n]/)[0] ?? ""
  const points = [...line]
  return `failed — ${points.length <= 100 ? line : `${points.slice(0, 99).join("")}…`}`
}

/** The one journal event a failed registrar run leaves behind. */
const FAILED_SEQUENCE = 1

const runSummarySnapshot = (run: HostRun, tag: string): unknown => {
  /* A settled run is newer lifecycle evidence than the running one it replaces. */
  const at = run.status === "running" ? 2 : 3
  const verdict = run.status === "failed" ? hostVerdict(run.cause ?? "") : run.verdict
  if (tag === "run-events") {
    return {
      cursor: { selector: { _tag: tag, runId: REGISTRAR_RUN }, projection: tag, runId: REGISTRAR_RUN, value: FAILED_SEQUENCE, offset: 0 },
      rows: run.cause === undefined ? [] : [{
        sequence: FAILED_SEQUENCE, kind: "control.run.failed", runId: REGISTRAR_RUN, occurredAt: at, payload: { cause: run.cause }
      }]
    }
  }
  return {
    cursor: { selector: { _tag: tag, runId: REGISTRAR_RUN }, projection: tag, runId: REGISTRAR_RUN, value: at, offset: 0 },
    rows: tag !== "run-summary" ? [] : [{
      runId: REGISTRAR_RUN, flowId: "repository/trigger", status: run.status, createdAt: 1, updatedAt: at,
      turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
      verdict, diagnosis: verdict
    }]
  }
}

/** The workspace that holds one markdown flow, plans it deterministically, and reports its own runs. */
const workspaceAnswers = (
  overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {},
  run: HostRun = { status: "running", verdict: "" }
) => ({
  List: () => okFrame({ _tag: "flows", items: FLOW_ITEMS }),
  Plan: (payload: Record<string, unknown>) =>
    payload.flowId === "nightly-lint"
      ? okFrame(PLAN)
      : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) }),
  "Approval.Submit": () => okFrame({ decision: { _tag: "Accepted" } }),
  Run: () => okFrame({ runId: REGISTRAR_RUN }),
  "Projection.Snapshot": (payload: Record<string, unknown>) =>
    okFrame(runSummarySnapshot(run, (payload.selector as { _tag?: string } | undefined)?._tag ?? "run-summary")),
  ...overrides
})

/** The watch this app already runs for a launched flow run: a fast pump, no toast debounce. */
const watched = (services: AppServices): AppServices => ({
  ...services, workflowPollMs: 1, toastDebounceMs: 0, toastAutoDismissMs: 10_000
})

const registrationToast = (store: AppStore, slug = "nightly") =>
  store.collections.toasts.get(`toast-trigger.register.will/flows.${slug}`)

const registrationRun = (store: AppStore, requestId: string) => {
  const card = store.collections.cards.get(`trigger-register-${requestId}`)
  return card?.kind === "run-trace" ? card : undefined
}

const preparedId = (store: AppStore): string =>
  String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)

const lastAction = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal).find((message) => message.action !== undefined)?.action

const REQUEST = { operation: "register" as const, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5", input: '{"label":"nightly"}' }

/** One reviewed job already set up on `repo`, as its own card records the workspace it ran on. */
const jobSetUp = async (store: AppStore, repo = "will/flows", workspaceId = JOB_WORKSPACE): Promise<void> => {
  await store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: `setup-${repo}-issues`, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1,
      payload: { ...initialSetup(repo, "issues", "will"), workspaceId }
    }
  }).isPersisted.promise
}

/** A signed-in controller on a repository whose reviewed jobs already run on JOB_WORKSPACE. */
const readyToRegister = async (services: AppServices, store?: AppStore) => {
  const scope = await ready(services, { signedIn: true, ...(store === undefined ? {} : { store }) })
  await jobSetUp(scope.store)
  return scope
}

describe("triggers seam: registering a repository flow on a schedule", () => {
  test("a bad name or a schedule that is not five UTC cron fields is refused before anything is asked of the workspace", async () => {
    const seen: Array<string> = []
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }, seen), { signedIn: true })
    expect(await controller.registerTrigger({ ...REQUEST, slug: "Nightly" })).toContain("schedule name")
    expect(await controller.registerTrigger({ ...REQUEST, schedule: "0 9 * *" })).toBe("schedule must have five cron fields in UTC")
    expect(await controller.registerTrigger({ ...REQUEST, input: "{not json" })).toContain("valid JSON")
    expect(seen.filter((path) => path.startsWith(RPC))).toEqual([])
  })

  test("input the flow's own schema refuses never reaches a plan, and an unknown flow lists what the workspace has", async () => {
    const calls: Array<RelayCall> = []
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    const refused = await controller.registerTrigger({ ...REQUEST, input: "{}" })
    expect(typeof refused).toBe("string")
    expect(String(refused)).toContain("label")
    expect(calls.map((call) => call.procedure)).toEqual(["List"])

    const unknown = await controller.registerTrigger({ ...REQUEST, flow: "weekly-sweep" })
    expect(String(unknown)).toContain("nightly-lint")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "List"])
  })

  test("a prepared registration previews the plan and offers the human's approve button; nothing is approved yet", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    const prepared = await controller.registerTrigger(REQUEST)
    expect(typeof prepared).toBe("object")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
    const action = lastAction(store)
    expect(action?.flow).toBe("triggers.approve")
    const args = JSON.parse(action?.args ?? "{}") as Record<string, unknown>
    const requestId = String(args.requestId)
    expect(requestId).not.toBe("undefined")
    expect(args).toEqual({
      requestId, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5",
      input: '{"label":"nightly"}', planId: "plan-1", planDigest: PLAN_DIGEST
    })
    /* The plan is keyed by this request, not by the schedule's name (L36 §3 step 4). */
    expect(calls[1]?.payload).toEqual({
      flowId: "nightly-lint",
      input: { label: "nightly" },
      idempotencyKey: `trigger:${requestId}:plan`
    })
    const preview = [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal)[0]?.text ?? ""
    expect(preview).toContain("nightly-lint")
    expect(preview).toContain("0 9 * * 1-5")
    expect(preview).toContain("fs:read:**")
    expect(preview).toContain(PLAN.executionDigest.slice(0, 12))
    /* The standing budget a person grants by approving is on the card they approve. */
    expect(preview).toContain("200000 tokens")
    expect(preview).toContain("30 min")
  })

  /*
   * The registrar is a built-in of the workspace coding host (flows/coding
   * host.ts, flows/repository/registry.ts). A relay call that names no
   * workspace reaches the repository's own gateway instead, which runs the
   * product host and holds the two librarian flows and no registrar at all —
   * the canary's `No flow "repository/trigger" is registered on this
   * workspace.` on every repository.
   */
  test("every relayed call names the workspace the repository's reviewed jobs run on", async () => {
    const calls: Array<RelayCall> = []
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    expect(typeof await controller.registerTrigger(REQUEST)).toBe("object")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
    expect(calls.map((call) => call.workspaceId)).toEqual([JOB_WORKSPACE, JOB_WORKSPACE])
  })

  /* A reviewed job on another repository is not this repository's box, so the call reaches the product host. */
  test("a repository with no reviewed job set up has no recorded workspace to name, and its own gateway holds no registrar", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) }),
      { signedIn: true }
    )
    await jobSetUp(store, "will/other")
    expect(await controller.registerTrigger(REQUEST)).toBe(registerUnavailableSentence("will/flows"))
    expect(calls.map((call) => call.workspaceId)).toEqual([undefined])
  })

  test("correcting the input prepares a new plan instead of pinning the first one to the name forever", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    await controller.registerTrigger({ ...REQUEST, input: '{"label":"nightlyy"}' })
    const first = String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)
    await controller.registerTrigger(REQUEST)
    const second = String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)
    expect(second).not.toBe(first)
    expect(calls.filter((call) => call.procedure === "Plan").map((call) => call.payload.idempotencyKey))
      .toEqual([`trigger:${first}:plan`, `trigger:${second}:plan`])
  })

  /*
   * A workspace that idle-suspended is resuming, and the relay answers that
   * state as HTTP 200 with its own sentence (apps/server workflows.ts
   * gatewayCallResponse: provisioning, no-capacity, quota-exceeded,
   * no-cloud-identity, no-cloud-repo). Since the register door always
   * addresses the repository-jobs box, this is the ordinary first press after
   * the box has been idle.
   */
  test("a box that is still resuming answers with its own sentence, not with a refusal it never made", async () => {
    const resuming = "The workspace is resuming; ask again in a moment."
    const { controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: json(200, { status: "provisioning", message: resuming }) })
    )
    expect(await controller.registerTrigger(REQUEST)).toBe(resuming)
  })

  test("a workspace that cannot register schedules says so before it plans anything", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers({ List: () => okFrame({ _tag: "flows", items: [FLOW_ITEMS[0]] }) }))
      })
    )
    expect(await controller.registerTrigger(REQUEST)).toBe(registerUnavailableSentence("will/flows"))
    expect(calls.map((call) => call.procedure)).toEqual(["List"])
    expect(lastAction(store)).toBeUndefined()
  })

  test("the agent may prepare a registration and may never approve one", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) })
    )
    await controller.registerTrigger(REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const refused = await controller.commands.runForAgent("triggers.approve", args)
    expect(refused.status).toBe("failed")
    if (refused.status === "failed") expect(refused.error).toContain("approvals belong to the human")
    expect(calls.map((call) => call.procedure)).toEqual(["List", "Plan"])
  })

  test("the human's approval submits the plan once, records the receipt once, and starts one registration run", async () => {
    const calls: Array<RelayCall> = []
    const receipts: Array<unknown> = []
    const { store, controller } = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers()),
        [APPROVAL]: async (request) => {
          receipts.push(await request.json())
          return json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
        }
      }))
    )
    await controller.registerTrigger(REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const requestId = String((JSON.parse(args) as Record<string, unknown>).requestId)
    const approved = await controller.commands.run("triggers.approve", args)
    expect(approved.status).toBe("executed")
    /* The approval answers at once and the registration runs behind it (AGENTS.md, instant chat). */
    await waitFor(() => calls.filter((call) => call.procedure === "Run").length === 1)
    /* Plue's RecordApproval refuses an approval whose flow_id does not match the registered flow. */
    expect(receipts).toEqual([{
      repo: "will/flows", slug: "nightly", flowId: "nightly-lint", planId: "plan-1", planDigest: PLAN_DIGEST, envelope: PLAN.envelope
    }])
    expect(calls.map((call) => call.procedure).filter((name) => name !== "Projection.Snapshot")).toEqual([
      "List", "Plan", "List", "Plan", "Approval.Submit", "Plan", "Approval.Submit", "Run"
    ])
    /* The target's plan is approved by its own digest; the registrar's plan carries the approved pair. */
    expect(calls[4]?.payload).toMatchObject({ target: { _tag: "Plan", planId: "plan-1", digest: PLAN_DIGEST }, decision: "approve" })
    expect(calls[5]?.payload).toMatchObject({
      flowId: "repository/trigger",
      idempotencyKey: `trigger:${requestId}:register-plan`,
      input: {
        requestId, operation: "register", repo: "will/flows", slug: "nightly", flow: "nightly-lint",
        schedule: "0 9 * * 1-5", input: { label: "nightly" },
        approvedPlanId: "plan-1", approvedPlanDigest: PLAN_DIGEST
      }
    })
    expect(calls[7]?.payload).toMatchObject({ _tag: "Plan", idempotencyKey: `trigger:${requestId}:register-run` })

    /* Was: a second press repeated the whole attempt. It now reconnects to the run this attempt already started. */
    const again = await controller.commands.run("triggers.approve", args)
    expect(again.status).toBe("executed")
    expect(receipts).toHaveLength(1)
    expect(calls.filter((call) => call.payload.idempotencyKey === `trigger:${requestId}:register-run`)).toHaveLength(1)
  })

  /*
   * Was: each refusal was the approve command's own failure. The approval now
   * answers at once and the registration runs behind it, so a refusal on the
   * way to the run reaches the human on the notice that named the work.
   */
  test("the host's own refusal and Smithers Cloud's own refusal each reach the human as themselves", async () => {
    const moduleRefusal = '"nightly-lint" is a flow.ts. Schedules run flow.mdx.'
    const hosted = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers({
          Plan: (payload) => payload.flowId === "repository/trigger" ? refusedFrame(moduleRefusal) : okFrame(PLAN)
        })),
        [APPROVAL]: json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
      }))
    )
    await hosted.controller.registerTrigger(REQUEST)
    const hostArgs = lastAction(hosted.store)?.args ?? "{}"
    const hostId = preparedId(hosted.store)
    expect((await hosted.controller.commands.run("triggers.approve", hostArgs)).status).toBe("executed")
    await waitFor(() => registrationRun(hosted.store, hostId)?.payload.phase === "failed")
    expect(registrationRun(hosted.store, hostId)?.payload.error).toBe(moduleRefusal)

    const cloudRefusal = "register only the plan a person approved; approve the preview, then apply"
    const clouded = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers()),
        [APPROVAL]: json(409, { status: "error", code: "trigger_approval_missing", message: cloudRefusal })
      }))
    )
    await clouded.controller.registerTrigger(REQUEST)
    const cloudArgs = lastAction(clouded.store)?.args ?? "{}"
    const cloudId = preparedId(clouded.store)
    expect((await clouded.controller.commands.run("triggers.approve", cloudArgs)).status).toBe("executed")
    await waitFor(() => registrationRun(clouded.store, cloudId)?.payload.phase === "failed")
    expect(registrationRun(clouded.store, cloudId)?.payload.error).toContain("trigger_approval_missing")
    expect(registrationRun(clouded.store, cloudId)?.payload.error).toContain(cloudRefusal)
  })

  test("a plan that no longer reproduces refuses rather than registering something else", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(
      watched(backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers())
      }))
    )
    await controller.registerTrigger(REQUEST)
    const args = JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>
    const requestId = preparedId(store)
    await controller.commands.run("triggers.approve", JSON.stringify({ ...args, planDigest: "a".repeat(64) }))
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "failed")
    expect(registrationRun(store, requestId)?.payload.error).toContain("changed")
    expect(calls.filter((call) => call.procedure === "Run")).toEqual([])
  })
})

/*
 * The registration is slow work: the approve door answers at once, the shared
 * toast runs through the launch AND the registrar run, and the run the app
 * already knows how to watch carries the outcome (AGENTS.md, instant chat).
 */
describe("triggers seam: watching the registration run", () => {
  const ROUTES = (
    calls: Array<RelayCall>,
    run: HostRun,
    extra: Record<string, Route> = {},
    answers: Record<string, (payload: Record<string, unknown>) => unknown> = {}
  ) => watched(backend({
    [PROJECTION]: projectionDocument(DAY_ONE),
    [RPC]: relayRoute(calls, workspaceAnswers(answers, run)),
    [APPROVAL]: json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 }),
    ...extra
  }))

  /** The registrar's own refusal, as the host writes it: one coded error, one sentence for the person. */
  const MODEL_REFUSAL = 'Add a model to "nightly-lint" to schedule it.'
  const DECLARED_INPUT =
    '"declared-input" declares an input schema the engine ignores (discovery warning unsupported_input_schema). Remove it: a trigger delivers your registered input to the flow as JSON, unvalidated.'
  /* The registrar's other code: the one it maps an unexpected failure to (flows/repository/triggers.ts:226). */
  const CRASH = "The schedule registration did not complete; inspect the retained run"
  const journalCause = (sentence: string, code = "invalid_receipt"): string =>
    `${code}: ${sentence}\n    at repository/trigger (flows/repository/triggers.ts:20)`

  const approved = async (store: AppStore, controller: Awaited<ReturnType<typeof ready>>["controller"]) => {
    await controller.registerTrigger(REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const outcome = await controller.commands.run("triggers.approve", args)
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toBe("Registering nightly on will/flows.")
    return String((JSON.parse(args) as Record<string, unknown>).requestId)
  }

  /*
   * The falsifier for every fake in this file: the run-summary shape below is
   * what the real gateway projects for a real registrar refusal, measured on
   * host 54db60f5 through GatewayProjection.runSummary. If the fake ever
   * drifts to a bare sentence, this fails.
   */
  test("the fake's verdict is what the real gateway projects: the code in front and 100 code points of it", () => {
    expect(hostVerdict(journalCause('Add a model to "nightly-check" to schedule it.')))
      .toBe('failed — invalid_receipt: Add a model to "nightly-check" to schedule it.')
    expect(hostVerdict(journalCause(DECLARED_INPUT)))
      .toBe('failed — invalid_receipt: "declared-input" declares an input schema the engine ignores (discovery warning un…')
  })

  /*
   * The registrar runs on the workspace gateway, so the watch has to read it
   * there. A card that records no box binds the pump to the repository's own
   * gateway (controller/workflow-pump.ts `const binding = { workspaceId }`),
   * which holds no run of this registration: the card would sit reconnecting
   * for ten minutes, then go quiet, and the person would be told the
   * registration is no longer being watched — while the schedule was
   * registered.
   */
  test("the run card records the box the registration was started on, and the watch reads that box", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "running")
    expect(registrationRun(store, requestId)?.payload.workspaceId).toBe(JOB_WORKSPACE)
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
    /* The registration settles from the run the workspace holds, so the notice resolves as this schedule's. */
    await waitFor(() => registrationToast(store)?.status === "ok")
    expect([...new Set(calls.filter((call) => call.procedure === "Projection.Snapshot").map((call) => call.workspaceId))])
      .toEqual([JOB_WORKSPACE])
  })

  test("a run that settles failed shows the host's own sentence as this run's typed failure", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.cause = journalCause(MODEL_REFUSAL)
    run.status = "failed"
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "failed")
    expect(registrationRun(store, requestId)?.payload.error).toBe('failed — invalid_receipt: Add a model to "nightly-lint" to schedule it.')
    await waitFor(() => registrationToast(store)?.status === "failed")
    /* The host's own sentence, with no `failed — invalid_receipt:` in front of it. */
    expect(registrationToast(store)?.detail).toBe(MODEL_REFUSAL)
  })

  test("a refusal longer than the gateway's one line still reaches the person whole", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.cause = journalCause(DECLARED_INPUT)
    run.status = "failed"
    await waitFor(() => registrationToast(store)?.status === "failed")
    expect(registrationToast(store)?.detail).toBe(DECLARED_INPUT)
  })

  test("the registrar's other code reaches the person as its sentence too, not as its code", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(ROUTES(calls, run))
    await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.cause = journalCause(CRASH, "execution")
    run.status = "failed"
    await waitFor(() => registrationToast(store)?.status === "failed")
    expect(registrationToast(store)?.detail).toBe(CRASH)
  })

  test("a run that settles completed shows the registration the schedule now holds", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    const { store, controller } = await readyToRegister(
      ROUTES(calls, run, {
        [REGISTRATIONS]: json(200, {
          status: "ok", repo: "will/flows",
          rows: [{
            slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
            digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
            registrationId: "registration-nightly"
          }]
        })
      })
    )
    const requestId = await approved(store, controller)
    await waitFor(() => registrationToast(store)?.status === "running")
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "completed")
    await waitFor(() => registrationToast(store)?.status === "ok")
    await waitFor(() => triggerCard(store).payload.triggers.length === 1)
    expect(triggerCard(store).payload.triggers).toEqual([{
      id: "registration-nightly", flowId: "nightly-lint", cron: "0 9 * * 1-5", timezone: "UTC",
      enabled: true, nextFireAt: Date.parse("2026-09-18T09:00:00Z")
    }])
  })

  test("a run that never settles keeps the notice running, the card running, and chat usable", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await readyToRegister(ROUTES(calls, { status: "running", verdict: "" }))
    const requestId = await approved(store, controller)
    await waitFor(() => registrationRun(store, requestId)?.payload.phase === "running")
    /* Chat and every unrelated door stay usable while the registration runs. */
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    expect(registrationToast(store)?.status).toBe("running")
    expect(registrationRun(store, requestId)?.payload.phase).toBe("running")
  })

  test("reload reconnects to the running registration instead of starting a second one", async () => {
    const calls: Array<RelayCall> = []
    const storage = memoryStorage()
    const run: HostRun = { status: "running", verdict: "" }
    const first = await readyToRegister(ROUTES(calls, run), await createAppStore({ kind: "localStorage", storage }))
    const requestId = await approved(first.store, first.controller)
    await waitFor(() => registrationRun(first.store, requestId)?.payload.phase === "running")
    await first.controller.dispose()

    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    /* The reloaded page sets nothing up: the run card it read back names the box its watch has to read. */
    const resumed = await ready(ROUTES(calls, run), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    resumed.controller.resumeWorkflowRuns()
    await waitFor(() => registrationRun(resumed.store, requestId)?.payload.phase === "completed")
    expect(calls.filter((call) => call.procedure === "Run")).toHaveLength(1)
    expect(registrationRun(resumed.store, requestId)?.payload.workspaceId).toBe(JOB_WORKSPACE)
  })

  test("a second press inside the launch window joins the attempt already running", async () => {
    const calls: Array<RelayCall> = []
    const run: HostRun = { status: "running", verdict: "" }
    let start = () => {}
    const held = new Promise<void>((resolve) => { start = resolve })
    const { store, controller } = await readyToRegister(
      ROUTES(calls, run, {}, { Run: async () => { await held; return okFrame({ runId: REGISTRAR_RUN }) } })
    )
    await controller.registerTrigger(REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    expect((await controller.commands.run("triggers.approve", args)).status).toBe("executed")
    await waitFor(() => calls.some((call) => call.procedure === "Run"))
    /* The button has no pressed state, and the launch window is six relayed round trips. */
    expect((await controller.commands.run("triggers.approve", args)).status).toBe("executed")
    start()
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationToast(store)?.status === "ok")
    expect(calls.filter((call) => call.procedure === "Run")).toHaveLength(1)
  })

  test("a reload inside the launch window strands nothing, and the approve button still registers", async () => {
    const calls: Array<RelayCall> = []
    const storage = memoryStorage()
    const run: HostRun = { status: "running", verdict: "" }
    /* A launch the reload interrupts: this `Run` is never answered, as a closed tab's never is. */
    const unanswered = new Promise<never>(() => {})
    const first = await readyToRegister(
      ROUTES(calls, run, {}, { Run: () => unanswered }),
      await createAppStore({ kind: "localStorage", storage })
    )
    await first.controller.registerTrigger(REQUEST)
    const args = lastAction(first.store)?.args ?? "{}"
    const requestId = String((JSON.parse(args) as Record<string, unknown>).requestId)
    expect((await first.controller.commands.run("triggers.approve", args)).status).toBe("executed")
    await waitFor(() => calls.some((call) => call.procedure === "Run"))
    await first.controller.dispose()

    const resumed = await ready(ROUTES(calls, run), {
      signedIn: true, store: await createAppStore({ kind: "localStorage", storage })
    })
    resumed.controller.resumeWorkflowRuns()
    /* No card names a run the workspace never started, so nothing reconnects to one. */
    expect(registrationRun(resumed.store, requestId)).toBeUndefined()
    /* The press the reloaded page offers is the same prepared registration, so a person presses what they see. */
    const reloaded = lastAction(resumed.store)?.args
    expect(reloaded).toBe(args)
    expect((await resumed.controller.commands.run("triggers.approve", reloaded ?? "{}")).status).toBe("executed")
    run.status = "completed"
    run.verdict = "Registered nightly on will/flows."
    await waitFor(() => registrationRun(resumed.store, requestId)?.payload.phase === "completed")
    /* The retry carries the attempt's own key, so the workspace can refuse a second run of the same registration. */
    expect(calls.filter((call) => call.procedure === "Run").map((call) => call.payload.idempotencyKey))
      .toEqual([`trigger:${requestId}:register-run`, `trigger:${requestId}:register-run`])
  })
})

describe("triggers seam: listing and pausing a schedule", () => {
  const ROWS = {
    status: "ok",
    repo: "will/flows",
    rows: [{
      slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
      digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
      registrationId: "registration-nightly"
    }]
  }

  test("the dispatcher lists the registered schedule beside the box's own rows", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [LIVE]: json(200, { status: "ok", repo: "will/flows", live: true, triggers: [{ id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false }], webhooks: [] }),
        [REGISTRATIONS]: json(200, ROWS)
      }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    const card = triggerCard(store)
    expect(card.payload.live).toBe(true)
    expect(card.payload.triggers).toEqual([
      { id: "sweep", flowId: "issue", cron: "*/15 * * * *", enabled: false },
      {
        id: "registration-nightly", flowId: "nightly-lint", cron: "0 9 * * 1-5", timezone: "UTC",
        enabled: true, nextFireAt: Date.parse("2026-09-18T09:00:00Z")
      }
    ])
  })

  test("a repository with no registrations and no box is not listening", async () => {
    /* Smithers Cloud answers 200 [] for every repository, which is the shape every signed-in user meets on day one. */
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [REGISTRATIONS]: json(200, { status: "ok", repo: "will/flows", rows: [] }) }),
      { signedIn: true }
    )
    const outcome = await controller.commands.run("triggers.list")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).not.toContain("listening")
    await settled()
    expect(triggerCard(store).payload).toEqual({ repo: "will/flows", declared: DAY_ONE.on, live: false, triggers: [], webhooks: [] })
  })

  test("a registrations route that did not answer leaves the declaration and the box alone", async () => {
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [REGISTRATIONS]: json(502, { message: "gateway down" }) }),
      { signedIn: true }
    )
    expect((await controller.commands.run("triggers.list")).status).toBe("executed")
    await settled()
    expect(triggerCard(store).payload).toEqual({ repo: "will/flows", declared: DAY_ONE.on, live: false, triggers: [], webhooks: [] })
  })

  test("pause stops the schedule through the Worker and re-reads the listing; a refusal stays the refusing party's", async () => {
    const seen: Array<string> = []
    const paused: Array<unknown> = []
    const { controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [REGISTRATIONS]: json(200, { ...ROWS, rows: [{ ...ROWS.rows[0], enabled: false }] }),
        [PAUSE]: async (request) => {
          paused.push(await request.json())
          return json(200, { status: "ok", paused: 1 })
        }
      }, seen),
      { signedIn: true }
    )
    const outcome = await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    expect(typeof outcome).toBe("object")
    expect(paused).toEqual([{ repo: "will/flows", slug: "nightly" }])
    expect(seen.filter((path) => path.startsWith(REGISTRATIONS))).toHaveLength(1)

    const refused = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [PAUSE]: json(404, { status: "error", code: "upstream_refused", message: "unknown repository job" }) }),
      { signedIn: true }
    )
    const answer = await refused.controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "nightly" })
    expect(String(answer)).toContain("unknown repository job")
  })

  test("a pause that stopped nothing says so instead of saying paused", async () => {
    const seen: Array<string> = []
    const { controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [PAUSE]: json(200, { status: "ok", paused: 0 })
      }, seen),
      { signedIn: true }
    )
    const outcome = await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "no-such-schedule" })
    expect(outcome).toBe('No schedule "no-such-schedule" is registered on will/flows.')
    expect(seen.filter((path) => path.startsWith(REGISTRATIONS))).toEqual([])
  })

  /*
   * Canary D-3: the sentence above was returned and never read. A returned
   * string surfaces only as the command-failure toast, which states itself
   * and dismisses after four seconds, so a person who pressed a consequential
   * door and looked away saw nothing at all. The transcript is the durable
   * half of the answer, so the door writes it there itself.
   */
  test("a pause that stopped nothing states it in the transcript, not only on a toast", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [PAUSE]: json(200, { status: "ok", paused: 0 })
      }),
      { signedIn: true }
    )
    await controller.registerTrigger({ operation: "pause", repo: "will/flows", slug: "canary-never-registered" })
    await settled()
    expect([...store.collections.messages.values()].map((message) => message.text))
      .toContain('No schedule "canary-never-registered" is registered on will/flows.')
  })

  test("the pause door is the agent's to ask for and the human's to confirm", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    const asked = await controller.commands.runForAgent("triggers.pause", JSON.stringify({ repo: "will/flows", slug: "nightly" }))
    expect(asked.status).toBe("executed")
    expect(lastAction(store)?.flow).toBe("triggers.pause")
  })
})
