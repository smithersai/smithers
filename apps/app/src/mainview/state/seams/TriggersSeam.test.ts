import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { Schema } from "effect"
import { NO_RULES_SENTENCE, registerUnavailableSentence } from "./TriggersSeam"

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
const ready = async (services: AppServices, options: { signedIn?: boolean } = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
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

/** The relay stub: every call recorded, answered by procedure with a gateway frame. */
const relayRoute = (
  calls: Array<RelayCall>,
  answers: Record<string, (payload: Record<string, unknown>) => unknown>
): Route =>
async (request) => {
  const frame = await request.json() as { procedure: string; payload: Record<string, unknown> }
  calls.push({ procedure: frame.procedure, payload: frame.payload })
  const answer = answers[frame.procedure]
  return json(200, answer === undefined ? { ok: false, error: { message: `no stub for ${frame.procedure}` } } : answer(frame.payload))
}

const okFrame = (payload: unknown) => ({ ok: true, payload })
const refusedFrame = (message: string, detail?: unknown) => ({ ok: false, error: { message, ...(detail === undefined ? {} : { detail }) } })

/** The workspace that holds one markdown flow and plans it deterministically. */
const workspaceAnswers = (overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}) => ({
  List: () => okFrame({ _tag: "flows", items: FLOW_ITEMS }),
  Plan: (payload: Record<string, unknown>) =>
    payload.flowId === "nightly-lint"
      ? okFrame(PLAN)
      : okFrame({ ...PLAN, planId: "plan-registrar", digest: "f".repeat(64), flowId: String(payload.flowId) }),
  "Approval.Submit": () => okFrame({ decision: { _tag: "Accepted" } }),
  Run: () => okFrame({ runId: "run-1" }),
  ...overrides
})

const lastAction = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => right.ordinal - left.ordinal).find((message) => message.action !== undefined)?.action

const REQUEST = { operation: "register" as const, repo: "will/flows", flow: "nightly-lint", slug: "nightly", schedule: "0 9 * * 1-5", input: '{"label":"nightly"}' }

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
    const { controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) }),
      { signedIn: true }
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
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) }),
      { signedIn: true }
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

  test("correcting the input prepares a new plan instead of pinning the first one to the name forever", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) }),
      { signedIn: true }
    )
    await controller.registerTrigger({ ...REQUEST, input: '{"label":"nightlyy"}' })
    const first = String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)
    await controller.registerTrigger(REQUEST)
    const second = String((JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>).requestId)
    expect(second).not.toBe(first)
    expect(calls.filter((call) => call.procedure === "Plan").map((call) => call.payload.idempotencyKey))
      .toEqual([`trigger:${first}:plan`, `trigger:${second}:plan`])
  })

  test("a workspace that cannot register schedules says so before it plans anything", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers({ List: () => okFrame({ _tag: "flows", items: [FLOW_ITEMS[0]] }) }))
      }),
      { signedIn: true }
    )
    expect(await controller.registerTrigger(REQUEST)).toBe(registerUnavailableSentence("will/flows"))
    expect(calls.map((call) => call.procedure)).toEqual(["List"])
    expect(lastAction(store)).toBeUndefined()
  })

  test("the agent may prepare a registration and may never approve one", async () => {
    const calls: Array<RelayCall> = []
    const { store, controller } = await ready(
      backend({ [PROJECTION]: projectionDocument(DAY_ONE), [RPC]: relayRoute(calls, workspaceAnswers()) }),
      { signedIn: true }
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
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute(calls, workspaceAnswers()),
        [APPROVAL]: async (request) => {
          receipts.push(await request.json())
          return json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
        }
      }),
      { signedIn: true }
    )
    await controller.registerTrigger(REQUEST)
    const args = lastAction(store)?.args ?? "{}"
    const requestId = String((JSON.parse(args) as Record<string, unknown>).requestId)
    const approved = await controller.commands.run("triggers.approve", args)
    expect(approved.status).toBe("executed")
    /* Plue's RecordApproval refuses an approval whose flow_id does not match the registered flow. */
    expect(receipts).toEqual([{
      repo: "will/flows", slug: "nightly", flowId: "nightly-lint", planId: "plan-1", planDigest: PLAN_DIGEST, envelope: PLAN.envelope
    }])
    expect(calls.map((call) => call.procedure)).toEqual([
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

    /* A retry after a lost answer repeats the same keys and adds no second receipt shape. */
    const again = await controller.commands.run("triggers.approve", args)
    expect(again.status).toBe("executed")
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toEqual(receipts[1])
    expect(calls.filter((call) => call.payload.idempotencyKey === `trigger:${requestId}:register-run`)).toHaveLength(2)
  })

  test("the host's own refusal and Smithers Cloud's own refusal each reach the human as themselves", async () => {
    const moduleRefusal = '"nightly-lint" is a flow.ts. Schedules run flow.mdx.'
    const hosted = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers({
          Plan: (payload) => payload.flowId === "repository/trigger" ? refusedFrame(moduleRefusal) : okFrame(PLAN)
        })),
        [APPROVAL]: json(200, { status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
      }),
      { signedIn: true }
    )
    await hosted.controller.registerTrigger(REQUEST)
    const hostArgs = lastAction(hosted.store)?.args ?? "{}"
    const hostRefused = await hosted.controller.commands.run("triggers.approve", hostArgs)
    expect(hostRefused).toEqual({ status: "failed", error: moduleRefusal })

    const cloudRefusal = "register only the plan a person approved; approve the preview, then apply"
    const clouded = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers()),
        [APPROVAL]: json(409, { status: "error", code: "trigger_approval_missing", message: cloudRefusal })
      }),
      { signedIn: true }
    )
    await clouded.controller.registerTrigger(REQUEST)
    const cloudArgs = lastAction(clouded.store)?.args ?? "{}"
    const cloudRefused = await clouded.controller.commands.run("triggers.approve", cloudArgs)
    expect(cloudRefused.status).toBe("failed")
    if (cloudRefused.status === "failed") {
      expect(cloudRefused.error).toContain("trigger_approval_missing")
      expect(cloudRefused.error).toContain(cloudRefusal)
    }
  })

  test("a plan that no longer reproduces refuses rather than registering something else", async () => {
    const { store, controller } = await ready(
      backend({
        [PROJECTION]: projectionDocument(DAY_ONE),
        [RPC]: relayRoute([], workspaceAnswers())
      }),
      { signedIn: true }
    )
    await controller.registerTrigger(REQUEST)
    const args = JSON.parse(lastAction(store)?.args ?? "{}") as Record<string, unknown>
    const moved = await controller.commands.run("triggers.approve", JSON.stringify({ ...args, planDigest: "a".repeat(64) }))
    expect(moved.status).toBe("failed")
    if (moved.status === "failed") expect(moved.error).toContain("changed")
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

  test("the pause door is the agent's to ask for and the human's to confirm", async () => {
    const { store, controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    const asked = await controller.commands.runForAgent("triggers.pause", JSON.stringify({ repo: "will/flows", slug: "nightly" }))
    expect(asked.status).toBe("executed")
    expect(lastAction(store)?.flow).toBe("triggers.pause")
  })
})
