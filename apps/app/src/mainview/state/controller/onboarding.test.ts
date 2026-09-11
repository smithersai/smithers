import { Authorize } from "@smthrs/chain"
import { Effect } from "effect"
import { createChainPolicy } from "../../chain/Policy"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { HomeDocument } from "@smthrs/rpc/HomePane"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { scopedControllers } from "../ControllerTestScope"
import { parseActivity, PROTOTYPE_FLOW_ID, PROTOTYPE_RUN_KIND, summaryPredicate, welcomeSentence } from "./onboarding"

/*
 * The repository welcome's decisions, through the one run path: the gate
 * (signed-out + maintain parks the flow and renders the sign-in step; the
 * signed-in answer resumes it as the signed-in user; the model's invocation
 * renders the step and fails honestly), the explore branch (the guide
 * documents the repository actually holds, read through the public contents
 * route), the maintain card's honest line while the activity route 404s, and
 * the feature prototype as a run of kind prototype through flow.run's launch
 * path.
 */

const createAppController = scopedControllers()

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const REPO = "smithersai/smithers"
const SUMMARY = "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."

const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = async (ticks = 4): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A route stub: the response for one path, given the request's init (the relay stubs read the body). */
type Route = (init?: RequestInit) => Response

const fixture = async (routes: Record<string, Route>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const turns: Array<string> = []
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      const last = request.messages.at(-1)
      turns.push(last !== undefined && "content" in last ? last.content : "")
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }
  const services: AppServices = {
    bootstrap: WEB,
    workflowPollMs: 5,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url, "https://app.test").pathname
      // The repository-flows seam reads .smithers/factory.json in the background whenever the target repository changes (the slash leaves); it is not one of the flow's own reads, so it stays out of the log.
      if (!path.endsWith("/contents/.smithers/factory.json")) requests.push(path)
      return (routes[path] ?? (() => json(404, { status: "error", message: `no stub for ${path}` })))(init)
    }
  }
  const controller = createAppController(store, unavailableRepositories, agent, services)
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "user", name: "smithers", head: null, catalog: true, summary: SUMMARY }]
  })
  store.dispatch({ type: "repo.selected", actor: "user", id: REPO })
  return { store, controller, requests, turns }
}

const identity = (store: AppStore, state: "signed-out" | "signed-in"): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state,
    login: state === "signed-in" ? "will" : null,
    allowlisted: state === "signed-in",
    admin: false,
    scopesPlain: null
  })
}

const onboardingCards = (store: AppStore): Array<Extract<Card, { kind: "repo-onboarding" }>> =>
  [...store.collections.cards.values()]
    .flatMap((card) => (card.kind === "repo-onboarding" ? [card] : []))
    .sort((left, right) => left.ordinal - right.ordinal)

const lastMessage = (store: AppStore) =>
  [...store.collections.messages.values()].sort((left, right) => left.ordinal - right.ordinal).at(-1)

describe("the welcome's sentence", () => {
  test("turns the catalog's product sentence into a predicate of the repository", () => {
    expect(summaryPredicate(REPO, SUMMARY)).toBe(
      "a durable framework that lets agents plan, run, and review changes to a code repository through flows."
    )
    expect(welcomeSentence(REPO, summaryPredicate(REPO, SUMMARY))).toBe(`Welcome to Smithers. ${REPO} is ${summaryPredicate(REPO, SUMMARY)}`)
    // A sentence that does not open on the repository's name is kept whole.
    expect(summaryPredicate("acme/widgets", "A widget toolkit for the web.")).toBe("A widget toolkit for the web.")
    expect(summaryPredicate(REPO, undefined)).toBeNull()
    expect(summaryPredicate(REPO, "  ")).toBeNull()
  })

  test("the activity answer is read only in the route's shape", () => {
    expect(parseActivity({ sentence: "2 commits this week.", counts: { commits: 2, pullRequests: 0, issues: 0 }, since: "2026-08-31" }))
      .toEqual({ sentence: "2 commits this week.", counts: { commits: 2, pullRequests: 0, issues: 0 }, since: "2026-08-31" })
    // A count the mirror could not answer is null and rides the card as null, never as a zero.
    expect(parseActivity({ sentence: "Pull request activity is not available.", counts: { commits: 2, pullRequests: null, issues: 0 } }))
      .toEqual({ sentence: "Pull request activity is not available.", counts: { commits: 2, pullRequests: null, issues: 0 }, since: "" })
    expect(parseActivity({ sentence: "", counts: { commits: 2, pullRequests: 0, issues: 0 } })).toBeNull()
    expect(parseActivity({ sentence: "x", counts: { commits: -1, pullRequests: 0, issues: 0 } })).toBeNull()
    expect(parseActivity("nope")).toBeNull()
  })
})

describe("repo.welcome", () => {
  test("renders the welcome card for the selected catalog repository with its curated sentence", async () => {
    const { store, controller } = await fixture({})
    const outcome = await controller.commands.run("repo.welcome")
    expect(outcome.status).toBe("executed")
    const [card] = onboardingCards(store)
    expect(card?.id).toBe(`repo-welcome-${REPO}`)
    expect(card?.payload).toEqual({
      stage: "welcome",
      repo: REPO,
      summary: "a durable framework that lets agents plan, run, and review changes to a code repository through flows."
    })
  })

  test("the model's door answers the sentence and names the three flows", async () => {
    const { controller } = await fixture({})
    const outcome = await controller.commands.runForAgent("repo.welcome")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toContain(`Welcome to Smithers. ${REPO} is a durable framework`)
      expect(outcome.value).toContain("repo.maintain")
      expect(outcome.value).toContain("repo.explore")
    }
  })
})

describe("repo.maintain", () => {
  test("signed out, the human's click parks the flow and renders the sign-in step; the signed-in answer resumes it", async () => {
    const { store, controller } = await fixture({})
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.run("repo.maintain", REPO)
    expect(outcome.status).toBe("executed")
    await settled()
    // The gating decision: the auth.prompt step, one click away, and no maintain card yet.
    const prompt = lastMessage(store)
    expect(prompt?.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
    expect(onboardingCards(store)).toEqual([])
    expect(store.session().pendingCommand).toMatchObject({ name: "repo.maintain", args: REPO, requirement: "signed-in" })

    // The existing auth-return path: the signed-in answer (the session load calls
    // resumeDeferredCommand after it settles) continues the parked flow as the signed-in user.
    identity(store, "signed-in")
    controller.resumeDeferredCommand()
    await settled(8)
    expect(store.session().pendingCommand ?? null).toBeNull()
    const [card] = onboardingCards(store)
    expect(card?.payload.stage).toBe("maintain")
  })

  test("the model's signed-out invocation renders the step and fails honestly without parking", async () => {
    const { store, controller } = await fixture({})
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.runForAgent("repo.maintain")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    expect(lastMessage(store)?.action?.flow).toBe("auth.sign-in")
    expect(store.session().pendingCommand ?? null).toBeNull()
  })

  test("signed in, while the activity route answers 404 the card says so and still offers the maintainer's reads", async () => {
    const { store, controller, requests } = await fixture({})
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("repo.maintain")
    expect(outcome.status).toBe("executed")
    expect(requests).toContain(`/api/public/repos/${REPO}/activity`)
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({
      stage: "maintain",
      repo: REPO,
      activity: null,
      reason: "Recent activity is not available yet.",
      flows: ["issues.list", "prs.list", "runs.list", "triggers.list"]
    })
  })

  test("signed in, the route's sentence rides the card", async () => {
    const { store, controller } = await fixture({
      [`/api/public/repos/${REPO}/activity`]: () =>
        json(200, { sentence: "3 commits, 1 pull request, and 2 issues in the last 7 days.", counts: { commits: 3, pullRequests: 1, issues: 2 }, since: "2026-08-31" })
    })
    identity(store, "signed-in")
    await settled()
    await controller.commands.run("repo.maintain")
    const [card] = onboardingCards(store)
    expect(card?.payload.stage === "maintain" ? card.payload.activity?.sentence : undefined)
      .toBe("3 commits, 1 pull request, and 2 issues in the last 7 days.")
  })
})

describe("repo.contribute", () => {
  test("signed out, it parks like maintain; signed in, it finds the contributing guide through the public contents route", async () => {
    const { store, controller, requests } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () =>
        json(200, [{ name: "README.md", type: "file" }, { name: "CONTRIBUTING.md", type: "file" }, { name: "src", type: "dir" }])
    })
    identity(store, "signed-out")
    await settled()
    await controller.commands.run("repo.contribute")
    await settled()
    expect(store.session().pendingCommand?.name).toBe("repo.contribute")
    expect(lastMessage(store)?.action?.flow).toBe("auth.sign-in")

    identity(store, "signed-in")
    controller.resumeDeferredCommand()
    await settled(8)
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(requests).toContain("/api/repos/smithersai/smithers/contents")
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({ stage: "contribute", repo: REPO, guide: "CONTRIBUTING.md" })
  })

  test("a repository without a contributing guide says so", async () => {
    const { store, controller } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () => json(200, [{ name: "README.md", type: "file" }])
    })
    identity(store, "signed-in")
    await settled()
    await controller.commands.run("repo.contribute")
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({ stage: "contribute", repo: REPO, guide: null, reason: "This repository has no CONTRIBUTING.md." })
  })
})

describe("repo.explore", () => {
  test("signed out, it lists the guide documents the repository holds, docs index included, and never a made-up one", async () => {
    const { store, controller, requests } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () =>
        json(200, [
          { name: "readme.md", type: "file" },
          { name: "llms.txt", type: "file" },
          { name: "docs", type: "dir" },
          { name: "CONTRIBUTING.md", type: "dir" }
        ]),
      [`/api/repos/smithersai/smithers/contents/docs`]: () => json(200, [{ name: "index.md", type: "file" }])
    })
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.run("repo.explore")
    expect(outcome.status).toBe("executed")
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(requests.filter((path) => path.startsWith("/api/repos/"))).toEqual([
      "/api/repos/smithersai/smithers/contents",
      "/api/repos/smithersai/smithers/contents/docs"
    ])
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({
      stage: "explore",
      repo: REPO,
      guides: [{ path: "readme.md" }, { path: "llms.txt" }, { path: "docs/index.md" }]
    })
  })

  test("an unreadable repository carries the honest reason and no rows", async () => {
    const { store, controller } = await fixture({
      [`/api/repos/smithersai/smithers/contents`]: () => json(502, { message: "Repository data is temporarily unavailable." })
    })
    identity(store, "signed-out")
    await settled()
    await controller.commands.run("repo.explore")
    const [card] = onboardingCards(store)
    expect(card?.payload).toEqual({ stage: "explore", repo: REPO, guides: [], reason: "Repository data is temporarily unavailable." })
  })
})

const HOME: HomeDocument = {
  blocks: [
    { type: "text", text: "Smithers builds itself with Smithers." },
    { type: "flows", title: "Try first" },
    { type: "ci-benchmark", title: "CI on Smithers", measures: ["cold", "incremental", "cache-hit-rate"] }
  ]
}
/** One catalog row of .smithers/factory.json as the projection writes it. */
const row = (id: string, summary: string | null, featured: boolean) => ({
  id,
  description: `Describes ${id}.`,
  summary,
  featured,
  kind: "mdx",
  path: `flows/${id}/flow.mdx`,
  capabilities: [],
  model: null,
  modelInvocable: true
})
const PROJECTION = {
  summary: "How smithersai/smithers develops itself.",
  flows: [
    row("review", "Review the change.", true),
    row("lint", "Lint the named files.", true),
    row("create-flow/scaffold", null, false)
  ],
  on: [{ event: "issue.opened", flow: "issue" }],
  github: { mirror: "push", issues: "two-way", changes: "land" }
}
/** The contents route's file record, base64 as the mirror answers it. */
const file = (value: unknown): Response =>
  json(200, { path: ".smithers/home.json", encoding: "base64", content: btoa(JSON.stringify(value)) })
const projection = (): Response =>
  json(200, { path: ".smithers/factory.json", encoding: "utf-8", content: JSON.stringify(PROJECTION) })

const homeCards = (store: AppStore): Array<Extract<Card, { kind: "repo-home" }>> =>
  [...store.collections.cards.values()].flatMap((card) => (card.kind === "repo-home" ? [card] : []))

describe("repo.home", () => {
  test("reads .smithers/home.json through the public contents route and carries the blocks with the projection's featured rows", async () => {
    const { store, controller, requests } = await fixture({
      "/api/repos/smithersai/smithers/contents/.smithers/home.json": () => file(HOME),
      "/api/repos/smithersai/smithers/contents/.smithers/factory.json": () => projection()
    })
    const outcome = await controller.commands.runForAgent("repo.home")
    expect(outcome.status).toBe("executed")
    // The projection read is filtered from the log (the repository-flows seam reads it too); the featured rows below prove the flow read it.
    expect(requests).toEqual(["/api/repos/smithersai/smithers/contents/.smithers/home.json"])
    const [card] = homeCards(store)
    expect(card?.id).toBe(`repo-home-${REPO}`)
    expect(card?.payload).toEqual({
      repo: REPO,
      path: ".smithers/home.json",
      blocks: HOME.blocks,
      featuredFlows: [{ id: "review", summary: "Review the change." }, { id: "lint", summary: "Lint the named files." }]
    })
    if (outcome.status === "executed") {
      expect(outcome.value).toContain("Smithers builds itself with Smithers.")
      expect(outcome.value).toContain("review (Review the change.)")
      expect(outcome.value).toContain("not measured yet")
    }
  })

  test("without .smithers/home.json it refuses honestly and renders nothing", async () => {
    const { store, controller } = await fixture({})
    const outcome = await controller.commands.run("repo.home")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(`${REPO} declares no home pane: it has no .smithers/home.json.`)
    expect(homeCards(store)).toEqual([])
  })

  test("a file that carries raw HTML is not a home pane: nothing renders and the flow says why", async () => {
    const { store, controller } = await fixture({
      "/api/repos/smithersai/smithers/contents/.smithers/home.json": () => file({ blocks: [{ type: "text", text: "<h1>Hi</h1>" }] })
    })
    const outcome = await controller.commands.run("repo.home")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("must not contain HTML")
    expect(homeCards(store)).toEqual([])
  })

  test("a flows block without a factory projection leaves the featured rows null with the reason", async () => {
    const { store, controller } = await fixture({
      "/api/repos/smithersai/smithers/contents/.smithers/home.json": () => file(HOME)
    })
    expect((await controller.commands.run("repo.home")).status).toBe("executed")
    const [card] = homeCards(store)
    expect(card?.payload.featuredFlows).toBeNull()
    expect(card?.payload.featuredReason).toBe(`${REPO} has no .smithers/factory.json, so its featured flows are not published yet.`)
  })

  test("repo.welcome renders the home pane above the welcome when the repository declares one, and stands alone when it does not", async () => {
    const declared = await fixture({
      "/api/repos/smithersai/smithers/contents/.smithers/home.json": () => file(HOME),
      "/api/repos/smithersai/smithers/contents/.smithers/factory.json": () => projection()
    })
    const outcome = await declared.controller.commands.runForAgent("repo.welcome")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") expect(outcome.value).toContain("repo.home")
    const [home] = homeCards(declared.store)
    const [welcome] = onboardingCards(declared.store)
    expect(home?.payload.blocks).toEqual(HOME.blocks)
    expect(welcome?.payload.stage).toBe("welcome")
    expect(home!.ordinal).toBeLessThan(welcome!.ordinal)

    const undeclared = await fixture({})
    expect((await undeclared.controller.commands.run("repo.welcome")).status).toBe("executed")
    expect(homeCards(undeclared.store)).toEqual([])
    expect(onboardingCards(undeclared.store).map((card) => card.payload.stage)).toEqual(["welcome"])
  })
})

/*
 * The relay, as the prototype launch rides it: provision answers ready, and
 * the gateway procedures answer in the wire's shapes. Every procedure the
 * launch called is recorded so the test reads the launch off the wire, not
 * off the card alone.
 */
/**
 * The relay's frame for a gateway `Plan` the control plane refused with
 * ControlError.FlowNotFound: the Worker's sentence leads, and the whole
 * encoded cause rides as the detail. Effect's RPC protocol encodes a failure
 * cause as an array of reasons, `[{ _tag: "Fail", error }]`, and the error is
 * the TaggedError's encoded form (verified: `new FlowNotFound({ flowId })`
 * has an empty `message`, so only its tag and code identify it).
 */
const flowNotFoundFrame = (flowId: string) => ({
  ok: false,
  error: {
    message: "/control/FlowNotFound",
    detail: [{ _tag: "Fail", error: { _tag: "/control/FlowNotFound", code: "flow_not_found", flowId } }]
  }
})

const relayStubs = (options: { readonly refuseRun?: string; readonly flows?: ReadonlyArray<string>; readonly refusePlan?: string } = {}) => {
  const procedures: Array<{ readonly procedure: string; readonly payload: Record<string, unknown> }> = []
  const rpc: Route = (init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { procedure?: string; payload?: Record<string, unknown> }
    const procedure = body.procedure ?? ""
    const payload = body.payload ?? {}
    procedures.push({ procedure, payload })
    switch (procedure) {
      case "List":
        return options.flows === undefined
          ? json(200, { ok: false, error: { message: "no List" } })
          : json(200, { ok: true, payload: { _tag: "flows", items: options.flows.map((flowId) => ({ flowId, description: "" })) } })
      case "Plan":
        if (options.refusePlan !== undefined) return json(200, flowNotFoundFrame(options.refusePlan))
        return json(200, {
          ok: true,
          payload: { planId: "plan-1", flowId: payload.flowId, digest: "digest-1", envelope: { capabilities: [], flows: [], budget: {} }, nodes: [] }
        })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Run":
        return options.refuseRun === undefined
          ? json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-1" } })
          : json(200, { ok: false, error: { message: options.refuseRun } })
      case "Projection.Snapshot":
        return json(200, {
          ok: true,
          payload: {
            cursor: { projection: "run-summary", runId: "run-1", value: 0 },
            rows: [{
              runId: "run-1",
              flowId: "prototype",
              status: "running",
              createdAt: 1,
              updatedAt: 2,
              turns: 0,
              calls: 0,
              callsFailed: 0,
              editsAttempted: 0,
              editsSucceeded: 0,
              inputTokens: 0,
              outputTokens: 0,
              verdict: "running",
              diagnosis: ""
            }]
          }
        })
      default:
        return json(200, { ok: false, error: { message: `no ${procedure}` } })
    }
  }
  return {
    procedures,
    routes: {
      "/api/workflow/provision": () => json(200, { status: "ready", repo: REPO, gatewayId: "gw-1" }),
      "/api/workflow/rpc": rpc
    }
  }
}

const runCards = (store: AppStore): Array<Extract<Card, { kind: "run-trace" }>> =>
  [...store.collections.cards.values()].flatMap((card) => (card.kind === "run-trace" ? [card] : []))

describe("feature.prototype", () => {
  test("signed in, the human's request starts a run of kind prototype on the workspace's prototype flow, tracked by the run card", async () => {
    const relay = relayStubs()
    const { store, controller, turns } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    // Missing input renders the form, never a usage sentence (THE FORM LAW).
    const form = await controller.commands.run("feature.prototype")
    expect(form.status).toBe("form")
    if (form.status === "form") expect(form.fields).toEqual(["request"])

    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("executed")
    if (outcome.status === "executed") {
      expect(outcome.value).toContain("run-started workflow=prototype run=run-1")
      expect(outcome.value).toContain("kind=prototype")
    }
    // The flow list is asked first (it cannot answer here, so the launch is tried); then the launch is flow.run's
    // own: Plan, approve the plan, Run, on the prototype flow with the request as its goal.
    expect(relay.procedures.map((call) => call.procedure).slice(0, 4)).toEqual(["List", "Plan", "Approval.Submit", "Run"])
    expect(relay.procedures[1]?.payload).toMatchObject({ flowId: "prototype", input: { goal: "a dark mode toggle" } })
    const [card] = runCards(store)
    expect(card?.id).toBe("flow-run-run-1")
    expect(card?.payload).toMatchObject({
      repo: REPO,
      runId: "run-1",
      workflow: "prototype",
      kind: "prototype",
      input: { goal: "a dark mode toggle" },
      // Spec 06 §5: a new run-trace card starts on live tail; the pump tails the journal from the first cycle.
      liveTail: true
    })
    expect(card?.kind).toBe("run-trace")
    expect(card?.title).toBe("prototype · a dark mode toggle")
    // No chat turn is spent on a sketch: the run is the answer.
    expect(turns).toHaveLength(0)
    expect([...store.collections.messages.values()].filter((message) => message.role === "user")).toHaveLength(0)
  })

  /*
   * RULINGS 42 (Will, 2026-09-08): Implement runs on the smart seat, first try
   * included, and cost control is never a cheaper implementer. The launch path
   * `feature.prototype` shares with an implement launch names the flow and the
   * kind and nothing about a model, so no caller can quietly downgrade a run's
   * seat from here; the workspace flow's own declaration stays the only seat
   * authority. A lane that adds `seat`, `tier`, `model`, or `role` to this
   * payload fails here and has to answer for it.
   */
  test("the launch asks for no seat, tier, model, or role: the workspace flow's declaration is the only seat authority", async () => {
    const relay = relayStubs({ flows: ["prototype"] })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()

    expect((await controller.commands.run("feature.prototype", "a dark mode toggle")).status).toBe("executed")

    const launchKeys = relay.procedures
      .filter((call) => call.procedure === "Plan" || call.procedure === "Run")
      .flatMap((call) => Object.keys(call.payload))
    expect(launchKeys).not.toContain("seat")
    expect(launchKeys).not.toContain("tier")
    expect(launchKeys).not.toContain("model")
    expect(launchKeys).not.toContain("role")
    // The Plan still names the flow and its goal, so the pin is on the seat, not on an empty payload.
    expect(relay.procedures.find((call) => call.procedure === "Plan")?.payload)
      .toMatchObject({ flowId: PROTOTYPE_FLOW_ID, input: { goal: "a dark mode toggle" } })
    expect(runCards(store)[0]?.payload).toMatchObject({ kind: PROTOTYPE_RUN_KIND })
  })

  test("signed out, the human's request parks on the sign-in step and resumes as a launch once signed in", async () => {
    const relay = relayStubs()
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-out")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("executed")
    await settled()
    expect(lastMessage(store)?.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
    expect(store.session().pendingCommand).toMatchObject({ name: "feature.prototype", args: "a dark mode toggle", requirement: "signed-in" })
    // Nothing was provisioned or launched for a signed-out visitor.
    expect(relay.procedures).toEqual([])
    expect(runCards(store)).toEqual([])

    identity(store, "signed-in")
    controller.resumeDeferredCommand()
    await settled(8)
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(relay.procedures.map((call) => call.procedure)).toContain("Run")
    expect(runCards(store)[0]?.payload).toMatchObject({ kind: "prototype", workflow: "prototype" })
  })

  test("the authorized model's signed-out invocation renders the sign-in step and fails honestly without launching", async () => {
    const relay = relayStubs()
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-out")
    await settled()
    // Reach the onboarding handler under an explicit outbound decision.
    // The registry now refuses an unscoped protected agent invocation first.
    const policy = createChainPolicy()
    policy.resolve("onboarding", "approved", { name: "feature.prototype", claim: "outbound:launch" })
    const authorize = await Effect.runPromise(Authorize.Authorize.pipe(Effect.provide(policy.layerFor("onboarding"))))
    const outcome = await controller.commands.runForAgent("feature.prototype", "a dark mode toggle", {
      authorize, slot: { chain: "", link: 1, ordinal: 0 }, refused: () => {}
    })
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("Sign in with GitHub first")
    expect(lastMessage(store)?.action?.flow).toBe("auth.sign-in")
    expect(relay.procedures).toEqual([])
  })

  test("a workspace whose flow list lacks prototype is refused before anything is planned, naming the flow", async () => {
    const relay = relayStubs({ flows: ["review-pr", "implement"] })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(`${REPO} has no prototype flow on its workspace yet, so there is nothing to run the prototype with.`)
    // The list answered, so nothing was planned, approved or run.
    expect(relay.procedures.map((call) => call.procedure)).toEqual(["List"])
    expect(runCards(store)).toEqual([])
  })

  test("a Plan the control plane refuses with FlowNotFound is read off the wire's shape, never off its prose", async () => {
    // The list cannot answer (the gateway's registry is lazy), so the launch is tried and refused at Plan.
    const relay = relayStubs({ refusePlan: "prototype" })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(`${REPO} has no prototype flow on its workspace yet, so there is nothing to run the prototype with.`)
    expect(relay.procedures.map((call) => call.procedure)).toEqual(["List", "Plan"])
    expect(runCards(store)).toEqual([])
  })

  test("any other launch refusal is surfaced as the workspace said it", async () => {
    const relay = relayStubs({ flows: ["prototype"], refuseRun: "The workspace is out of capacity." })
    const { store, controller } = await fixture(relay.routes)
    identity(store, "signed-in")
    await settled()
    const outcome = await controller.commands.run("feature.prototype", "a dark mode toggle")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("The workspace is out of capacity.")
    expect(relay.procedures.map((call) => call.procedure)).toEqual(["List", "Plan", "Approval.Submit", "Run"])
    expect(runCards(store)).toEqual([])
  })
})
