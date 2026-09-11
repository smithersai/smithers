import type { StorageApi } from "@tanstack/db"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
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
    expect(seen.filter((path) => path !== PROJECTION)).toEqual([`${LIVE}?repo=will%2Fflows`])
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

  test("the register door runs signed in and refuses honestly until a register procedure crosses the relay", async () => {
    const { controller } = await ready(backend({ [PROJECTION]: projectionDocument(DAY_ONE) }), { signedIn: true })
    const outcome = await controller.commands.run("triggers.register")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(registerUnavailableSentence("will/flows"))
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
