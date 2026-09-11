import { describe, expect, test } from "bun:test"
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import { createAppStore } from "../AppStore"
import { createActorBindings } from "../ActorBindings"
import type { AppStore } from "../AppStore"
import {
  createLinearSeam,
  LINEAR_LOST_STREAM_TRIGGER,
  linearSyncPolling,
  OPS_PAGE_LIMIT,
  SETUP_EXPIRED_NOTE,
  SIGN_OUT_REFUSAL,
  sumRunCounts
} from "./LinearSeam"
import type { LinearSeamDeps } from "./LinearSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The Linear seam (lane sync, ADR 0005; lane L5 against the live routes):
 * the connector-setup card is the wizard (handoff → team → repository →
 * confirm → connected); sync starts a RUN and tracks its state, counts and
 * ops; activity reads the last 24 hours of ops; a failed op retries through
 * its own card; disconnect removes the card.
 *
 * Every fixture below is shaped as plue answers it (verified against
 * `~/plue` main, `internal/routes/linear_integration.go` +
 * `internal/services/linear_sync.go`): the list and the delete live under
 * `/api/integrations/linear`, the runs and the ops under `/api/linear`, the
 * op's error is `error_message`, its status is `pending | success | failed |
 * skipped`, and the run's counts are PER ENTITY. Every route is a double.
 */

const memoryStorage = () => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  }
}

/* A route factory: a Response's body is consumed once, so shared fixtures must build a fresh one per call. */
const json = (status: number, body: unknown): (() => Response) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * A paged answer as plue writes it (plue#491): the rows, and a `Link` header
 * whose `rel="next"` carries the opaque keyset cursor. A last page carries
 * `rel="first"` only.
 */
const page = (body: unknown, nextCursor?: string): (() => Response) => () => {
  const first = '</api/linear/7/ops?limit=50>; rel="first"'
  const link = nextCursor === undefined
    ? first
    : `${first}, </api/linear/7/ops?limit=50&cursor=${nextCursor}>; rel="next"`
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", link, "x-per-page": "50" }
  })
}

/* plue's chi router answers an unrouted path with this plain text — the shape prod gives today. */
const chiNotFound = (): Response => new Response("404 page not found", { status: 404 })

const INTEGRATION = {
  id: 7,
  linear_team_id: "team-eng",
  linear_team_key: "ENG",
  linear_team_name: "Engineering",
  repo_owner: "will",
  repo_name: "smithers",
  is_active: true,
  last_sync_at: "2026-09-02T09:00:00Z",
  created_at: "2026-09-01T10:00:00Z"
}

/* An answer that names no actor at all — the row then reads a bare `authorized`. */
const SETUP_LIVE = {
  teams: [
    { id: "team-eng", name: "Engineering", key: "ENG" },
    { id: "team-design", name: "Design", key: "DES" }
  ],
  expires_at: "2099-09-02T12:00:00Z"
}

/*
 * plue's own answer since #491 (services.LinearOAuthSetupResult):
 * `linear_actor` is a LinearViewer `{ id, email, name }`, which is what
 * `authorized as <linear_actor>` names.
 */
const SETUP = { ...SETUP_LIVE, linear_actor: { id: "u1", email: "will@example.com", name: "Will" } }

/* One op as `GET /api/linear/{id}/ops` answers it (services.LinearSyncOp). */
const op = (over: Record<string, unknown> = {}) => ({
  id: 12,
  run_id: 4,
  source: "linear",
  target: "smithers-cloud",
  entity: "issue",
  entity_id: "ENG-482",
  action: "create",
  status: "success",
  error_message: "",
  created_at: "2026-09-02T09:00:00Z",
  ...over
})

/* One run as `GET /api/linear/{id}/sync/{runId}` answers it (services.LinearSyncRunStatus). */
const run = (state: string, over: Record<string, unknown> = {}) => ({
  state,
  counts: {
    issues: { done: 8, total: 10, failed: 1 },
    comments: { done: 2, total: 2, failed: 0 }
  },
  started_at: "2026-09-02T09:00:00Z",
  finished_at: null,
  ...over
})

/* A route sees the request init, so a double can record the body a write posted. */
type Route = (init?: RequestInit) => Response | Promise<Response>

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean } & LinearSeamDeps = {}
) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const requests: Array<string> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const method = init?.method ?? "GET"
      const path = input.startsWith(CLOUD_ROUTE_PREFIX) ? input.slice(CLOUD_ROUTE_PREFIX.length) : input
      const key = `${method} ${path}`
      requests.push(key)
      const route = routes[key] ?? routes[path]
      if (route === undefined) return chiNotFound()
      return route(init)
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: null
    })
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      {
        id: "will/smithers",
        org: "will",
        ownerKind: "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  })
  const { signedIn: _signedIn, ...deps } = options
  const bindings = createActorBindings(() => {})
  const seam = bindings.pair(ctx, (context) => createLinearSeam(context, deps))
  return { store, storage, seam, requests, confirmAsAgent: () => bindings.select(seam.confirmConnect)() }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : (result as { value?: string } | null | undefined)?.value

/** Spin until a background poll has landed what the assertion needs, or give up loudly. */
const waitUntil = async (ready: () => boolean, label = "the condition"): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`waitUntil gave up on ${label}`)
}

const cardOf = (store: AppStore) => store.collections.cards.get("connector-setup-linear-will/smithers")

const payloadOf = (store: AppStore) => {
  const card = cardOf(store)
  return card?.kind === "connector-setup" ? card.payload : undefined
}

const syncPayloadOf = (store: AppStore) => {
  const card = store.collections.cards.get("sync-ops-linear-7")
  return card?.kind === "sync-ops" ? card.payload : undefined
}

/** The authorized handoff: session answers waiting once, then the setup key. */
const authorizedSession = (): Route => {
  let polls = 0
  return () => {
    polls += 1
    return json(200, polls < 2 ? { state: "waiting" } : { state: "authorized", setupKey: "sk-123" })()
  }
}

describe("createLinearSeam", () => {
  test("signed out, every act refuses with the sign-in wording", async () => {
    const { seam } = await harness({}, { signedIn: false })

    expect(textOf(await seam.connect())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.openLinear())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.confirmConnect())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.syncNow("7"))).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.activity())).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.disconnect("7"))).toBe(SIGN_OUT_REFUSAL)
    expect(textOf(await seam.retryOp("op-1"))).toBe(SIGN_OUT_REFUSAL)
  })

  test("connect upserts the wizard card with the active authorize step", async () => {
    const { store, seam } = await harness({})

    const result = await seam.connect()

    expect(textOf(result)).toBe("Connect Linear on will/smithers — the card walks the handoff.")
    const payload = payloadOf(store)
    expect(payload?.connector).toBe("linear")
    expect(payload?.repo).toBe("will/smithers")
    expect(payload?.phase).toBe("setup")
    expect(payload?.steps).toEqual([
      { id: "authorize", label: "Authorize in your browser", state: "active", detail: null },
      { id: "team", label: "Team", state: "pending", detail: null },
      { id: "repository", label: "Repository", state: "pending", detail: "will/smithers" },
      { id: "confirm", label: "Confirm", state: "pending", detail: null }
    ])
  })

  test("openLinear runs the handoff, lists the teams, and advances the card", async () => {
    const opened: Array<string> = []
    const { store, seam, requests } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear?callback_port=9" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP)
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async (url) => (opened.push(url), true) }
    )
    await seam.connect()

    await seam.openLinear()

    expect(opened).toEqual(["https://api.smithers-cloud.test/api/auth/linear?callback_port=9"])
    expect(requests).toContain("POST /api/linear-auth/start")
    expect(requests).toContain("GET api/linear/setup/sk-123")
    const payload = payloadOf(store)
    expect(payload).not.toHaveProperty("setupKey")
    expect(payload?.actor).toBe("Will")
    expect(payload?.teams).toEqual(SETUP.teams)
    expect(payload?.steps.find((step) => step.id === "authorize")).toEqual({
      id: "authorize",
      label: "Authorize in your browser",
      state: "done",
      detail: "authorized as Will"
    })
    expect(payload?.steps.find((step) => step.id === "team")?.state).toBe("active")
  })

  test("a setup answer that names no actor reads a bare authorized", async () => {
    /*
     * plue#491 added `linear_actor`, but a server that answers without it
     * still has to read honestly: the row states what the answer supports,
     * never a name it did not carry.
     */
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP_LIVE)
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()

    await seam.openLinear()

    const payload = payloadOf(store)
    expect(payload?.actor).toBeNull()
    expect(payload?.teams).toEqual(SETUP_LIVE.teams)
    expect(payload?.steps.find((step) => step.id === "authorize")?.detail).toBe("authorized")
    expect(payload?.steps.find((step) => step.id === "team")?.state).toBe("active")
  })

  test("a setup lookup the server does not route fails step 1 in the product's own voice", async () => {
    /* chi's plain-text 404 is plumbing: never copied, and never mistaken for an expired key. */
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession()
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()

    const result = await seam.openLinear()

    expect(result).toBe("Reading /linear/setup failed (404)")
    const authorize = payloadOf(store)?.steps.find((step) => step.id === "authorize")
    expect(authorize?.state).toBe("error")
    expect(authorize?.error).toBe("Reading /linear/setup failed (404)")
  })

  test("openLinear with an expired setup key reads authorization expired", async () => {
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(404, { message: "linear oauth setup not found or expired" })
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()

    const result = await seam.openLinear()

    expect(result).toBe(SETUP_EXPIRED_NOTE)
    const authorize = payloadOf(store)?.steps.find((step) => step.id === "authorize")
    expect(authorize?.state).toBe("error")
    expect(authorize?.error).toBe(SETUP_EXPIRED_NOTE)
  })

  test("pickTeam marks the team and activates the repository step", async () => {
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP)
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()

    await seam.pickTeam("team-eng")
    const payload = payloadOf(store)
    expect(payload?.teamId).toBe("team-eng")
    expect(payload?.steps.find((step) => step.id === "team")).toEqual({
      id: "team",
      label: "Team",
      state: "done",
      detail: "ENG · Engineering"
    })
    expect(payload?.steps.find((step) => step.id === "repository")?.state).toBe("active")

    expect(await seam.pickTeam("team-nope")).toBe("Team team-nope is not one this authorization can see.")
  })

  test("confirmConnect posts the integration and turns the card connected", async () => {
    const { store, seam, requests } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP),
        "POST api/linear": json(201, INTEGRATION),
        "api/integrations/linear": json(200, [INTEGRATION])
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")

    const result = await seam.confirmConnect()

    expect(requests).toContain("POST api/linear")
    expect(textOf(result)).toBe("Linear ENG connected to will/smithers — the card tracks it.")
    const card = cardOf(store)
    expect(card?.title).toBe("Linear · ENG → will/smithers")
    expect(card?.status).toBe("acted")
    const payload = payloadOf(store)
    expect(payload?.phase).toBe("connected")
    expect(payload?.integration).toEqual({
      id: 7,
      teamKey: "ENG",
      teamName: "Engineering",
      active: true,
      lastSyncAt: "2026-09-02T09:00:00Z"
    })
    expect(payload?.steps.every((step) => step.state === "done")).toBe(true)
    /* The integrations collection carries the row the refresh read. */
    const row = store.collections.linearIntegrations.get("7")
    expect(row?.teamKey).toBe("ENG")
    expect(row?.lastSyncAt).toBe("2026-09-02T09:00:00Z")
  })

  test("setup handles never enter cards, transitions, or localStorage, including after completion", async () => {
    const { store, storage, seam } = await harness({
      "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
      "GET /api/linear-auth/session": authorizedSession(),
      "api/linear/setup/sk-123": json(200, SETUP),
      "POST api/linear": json(201, INTEGRATION),
      "api/integrations/linear": json(200, [INTEGRATION])
    }, { pollMs: 1, timeoutMs: 5000, openExternal: async () => true })
    const assertPrivate = async () => {
      await store.dispatch({ type: "linear.integrations.loaded", actor: "system", integrations: [] }).isPersisted.promise
      expect(JSON.stringify([...store.collections.cards.values()])).not.toContain("sk-123")
      expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("sk-123")
      expect(storage.data.size).toBeGreaterThan(0)
      expect(JSON.stringify([...storage.data])).not.toContain("sk-123")
    }
    await seam.connect()
    await seam.openLinear()
    await assertPrivate()
    await seam.pickTeam("team-eng")
    await seam.confirmConnect()
    expect(payloadOf(store)?.phase).toBe("connected")
    await assertPrivate()
    expect(await seam.confirmConnect()).toBe("Step 1 first: Open Linear and authorize.")
  })

  for (const failure of ["fallback", "server", "transport"] as const) {
    test(`setup ${failure} failures redact the handle from error text and storage`, async () => {
      const { store, storage, seam } = await harness({
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": () => {
          if (failure === "transport") throw new Error("request /linear/setup/sk-123 failed")
          return failure === "server" ? json(503, { message: "setup sk-123 unavailable" })() : new Response(null, { status: 503 })
        }
      }, { pollMs: 1, timeoutMs: 5000, openExternal: async () => true })
      await seam.connect()
      const result = await seam.openLinear()
      expect(typeof result).toBe("string")
      expect(result).not.toContain("sk-123")
      if (failure === "fallback") expect(result).toBe("Reading /linear/setup failed (503)")
      await store.dispatch({ type: "linear.integrations.loaded", actor: "system", integrations: [] }).isPersisted.promise
      expect(JSON.stringify([...store.collections.cards.values()])).not.toContain("sk-123")
      expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("sk-123")
      expect(JSON.stringify([...storage.data])).not.toContain("sk-123")
      expect(await seam.confirmConnect()).toBe("Step 1 first: Open Linear and authorize.")
    })
  }

  test("a create echo and refreshed list without an id cannot invent a connected integration", async () => {
    const { id: _id, ...unnamed } = INTEGRATION
    const { store, seam } = await harness({
      "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
      "GET /api/linear-auth/session": authorizedSession(),
      "api/linear/setup/sk-123": json(200, SETUP),
      "POST api/linear": json(201, unnamed),
      "api/integrations/linear": json(200, [])
    }, { pollMs: 1, timeoutMs: 5000, openExternal: async () => true })
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")
    expect(await seam.confirmConnect()).toBe("Smithers Cloud created the Linear integration without naming an integration id.")
    expect(payloadOf(store)?.phase).toBe("setup")
    expect(payloadOf(store)?.integration).toBeUndefined()
    expect(cardOf(store)?.status).toBe("error")
    expect(payloadOf(store)?.error).toBe("Smithers Cloud created the Linear integration without naming an integration id.")
  })

  test("the agent binding can confirm the user's transient setup using the refreshed id", async () => {
    const { store, seam, confirmAsAgent } = await harness({
      "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
      "GET /api/linear-auth/session": authorizedSession(),
      "api/linear/setup/sk-123": json(200, SETUP),
      "POST api/linear": json(201, {}),
      "api/integrations/linear": json(200, [INTEGRATION])
    }, { pollMs: 1, timeoutMs: 5000, openExternal: async () => true })
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")
    expect(textOf(await confirmAsAgent())).toBe("Linear ENG connected to will/smithers — the card tracks it.")
    expect(payloadOf(store)?.integration?.id).toBe(7)
  })

  test("an expired setup cannot be posted and is discarded", async () => {
    let clock = Date.now()
    const { store, seam, requests } = await harness({
      "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
      "GET /api/linear-auth/session": authorizedSession(),
      "api/linear/setup/sk-123": json(200, { ...SETUP, expires_at: new Date(clock + 60_000).toISOString() })
    }, { pollMs: 1, timeoutMs: 5000, openExternal: async () => true, now: () => clock })
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")
    clock += 60_001
    expect(await seam.confirmConnect()).toBe(SETUP_EXPIRED_NOTE)
    expect(requests).not.toContain("POST api/linear")
    expect(payloadOf(store)?.steps.find((step) => step.id === "authorize")?.state).toBe("error")
    clock -= 60_001
    expect(await seam.confirmConnect()).toBe("Step 1 first: Open Linear and authorize.")
  })

  test("a failed create redacts and discards its setup handle", async () => {
    const { store, seam, requests } = await harness({
      "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
      "GET /api/linear-auth/session": authorizedSession(),
      "api/linear/setup/sk-123": json(200, SETUP),
      "POST api/linear": json(503, { message: "create for sk-123 unavailable" })
    }, { pollMs: 1, timeoutMs: 5000, openExternal: async () => true })
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")
    expect(await seam.confirmConnect()).toBe("create for [redacted] unavailable")
    expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("sk-123")
    expect(await seam.confirmConnect()).toBe("Step 1 first: Open Linear and authorize.")
    expect(requests.filter((line) => line === "POST api/linear")).toHaveLength(1)
  })

  test("picking another repository at step 3 keeps the card, and Connect posts the picked repository", async () => {
    /*
     * Review finding 1: the card id is keyed on the repository the wizard
     * opened on, while step 3 rewrites payload.repo — and the card's Connect
     * passes payload.repo. Resolving the card by that repo alone found no
     * card, so the wizard could never complete for anything but the default.
     */
    const posted: Array<unknown> = []
    const picked = { ...INTEGRATION, repo_owner: "acme", repo_name: "flows" }
    let integrations: Array<unknown> = []
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP),
        "POST api/linear": (init) => {
          posted.push(JSON.parse(String(init?.body)))
          integrations = [picked]
          return json(201, picked)()
        },
        "api/integrations/linear": () => json(200, integrations)(),
        "DELETE api/integrations/linear/7": () => {
          integrations = []
          return new Response(null, { status: 204 })
        }
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")

    await seam.pickRepository("will/smithers", "acme/flows")
    expect(cardOf(store)?.title).toBe("Connect Linear · acme/flows")
    expect(payloadOf(store)?.repo).toBe("acme/flows")
    expect(payloadOf(store)?.steps.find((step) => step.id === "repository")?.detail).toBe("acme/flows")

    /* The card's Connect button passes the picked repository, not the opening one. */
    const result = await seam.confirmConnect("acme/flows")

    expect(textOf(result)).toBe("Linear ENG connected to acme/flows — the card tracks it.")
    expect(posted).toEqual([{ setup_key: "sk-123", linear_team_id: "team-eng", repo: "acme/flows" }])
    /* The SAME card turned connected — no second card under the picked repo's id. */
    expect(store.collections.cards.get("connector-setup-linear-acme/flows")).toBeUndefined()
    expect(cardOf(store)?.title).toBe("Linear · ENG → acme/flows")
    expect(payloadOf(store)?.phase).toBe("connected")
    expect(payloadOf(store)?.integration?.id).toBe(7)

    /* Disconnect finds that same card, keyed on the opening repository. */
    await seam.disconnect("7", "ENG")
    expect(cardOf(store)).toBeUndefined()
  })

  test("the create's own linear_actor names the connected card's account (plue#491)", async () => {
    /*
     * plue#491 echoes `linear_actor` on the 201, so a card whose step 1
     * never ran (a re-created integration) still names the account that
     * authorized it — the setup's actor is not the only source.
     */
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP_LIVE),
        "POST api/linear": json(201, {
          ...INTEGRATION,
          linear_actor: { id: "u1", email: "ana@example.com", name: "Ana" }
        }),
        "api/integrations/linear": json(200, [INTEGRATION])
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    /* The live setup named nobody, so step 1 left the card without an actor. */
    expect(payloadOf(store)?.actor).toBeNull()
    await seam.pickTeam("team-eng")

    await seam.confirmConnect()

    expect(payloadOf(store)?.actor).toBe("Ana")
  })

  test("an actor DTO with only an email is named by its email, never by its opaque id", async () => {
    /* A Linear actor id is not a person's name; the email still identifies the account. */
    const { store, seam } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, {
          ...SETUP_LIVE,
          linear_actor: { id: "9f3c-opaque", email: "ana@example.com", name: "" }
        })
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()

    await seam.openLinear()

    expect(payloadOf(store)?.actor).toBe("ana@example.com")
    expect(payloadOf(store)?.steps.find((step) => step.id === "authorize")?.detail).toBe(
      "authorized as ana@example.com"
    )
  })

  test("confirmConnect before the team pick names the missing step", async () => {
    const { seam } = await harness({})
    await seam.connect()

    expect(await seam.confirmConnect()).toBe("Step 1 first: Open Linear and authorize.")
  })

  test("syncNow starts a run and the card carries its id", async () => {
    const { store, seam, requests } = await harness({
      "api/integrations/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(202, { run_id: 41 })
    })

    const result = await seam.syncNow()

    expect(textOf(result)).toBe("Sync run 41 started for Linear ENG ↔ will/smithers — the card tracks it.")
    expect(requests).toContain("POST api/linear/7/sync")
    const payload = syncPayloadOf(store)
    expect(payload?.subject).toBe("Linear ENG ↔ will/smithers")
    expect(payload?.runId).toBe("41")
    expect(payload?.trigger).toBe("sync started · run 41")
    /* Nothing about the run is claimed before the run DTO answers. */
    expect(payload?.runState).toBeNull()
    expect(payload?.counts).toBeNull()
    expect(payload?.ops).toEqual([])
  })

  test("the run poll fills the header counts and the ops, and stops when the run settles", async () => {
    const previous = { ...linearSyncPolling }
    linearSyncPolling.delayMs = 1
    linearSyncPolling.maxAttempts = 6
    try {
      let polls = 0
      const { store, seam, requests } = await harness({
        "api/integrations/linear": json(200, [INTEGRATION]),
        "POST api/linear/7/sync": json(202, { run_id: 41 }),
        "api/linear/7/sync/41": () => {
          polls += 1
          return json(200, polls < 2 ? run("running") : run("completed", { finished_at: "2026-09-02T09:05:00Z" }))()
        },
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}`]: json(200, [
          op(),
          op({ id: 11, source: "smithers-cloud", target: "linear", entity: "issue", entity_id: "90", action: "update", status: "failed", error_message: "Linear API: 422 label 'infra' does not exist on team ENG" })
        ])
      })

      await seam.syncNow()
      await waitUntil(() => syncPayloadOf(store)?.runState === "completed")

      const payload = syncPayloadOf(store)
      /* The state word is plue's own — never renamed to a vocabulary of this app's. */
      expect(payload?.runState).toBe("completed")
      /* Counts arrive per entity (issues + comments) and the header is their sum. */
      expect(payload?.counts).toEqual({ total: 12, done: 10, failed: 1 })
      expect(payload?.ops).toHaveLength(2)
      expect(payload?.ops[0]).toEqual({
        id: "12",
        source: "linear",
        target: "smithers-cloud",
        entity: "issue",
        entityId: "ENG-482",
        action: "create",
        status: "success",
        retryable: false,
        at: "2026-09-02T09:00:00Z"
      })
      /* The failed row keeps `error_message` verbatim and is the only retryable one. */
      expect(payload?.ops[1]?.error).toBe("Linear API: 422 label 'infra' does not exist on team ENG")
      expect(payload?.ops[1]?.retryable).toBe(true)
      expect(requests.filter((line) => line === "GET api/linear/7/sync/41").length).toBe(2)
    } finally {
      Object.assign(linearSyncPolling, previous)
    }
  })

  test("sumRunCounts adds every entity bucket the wire names, and answers null for none", () => {
    expect(sumRunCounts({ issues: { done: 8, total: 10, failed: 1 }, comments: { done: 2, total: 2, failed: 0 } }))
      .toEqual({ total: 12, done: 10, failed: 1 })
    /* A bucket plue adds later lands in the total with no code change. */
    expect(sumRunCounts({ issues: { done: 1, total: 1, failed: 0 }, labels: { done: 3, total: 4, failed: 2 } }))
      .toEqual({ total: 5, done: 4, failed: 2 })
    expect(sumRunCounts({})).toBeNull()
    expect(sumRunCounts(null)).toBeNull()
  })

  test("a run plue refuses to start reads its own sentence verbatim on the card", async () => {
    /* plue's two 409s: "linear sync already running" and "linear integration is inactive". */
    const { store, seam } = await harness({
      "api/integrations/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(409, { message: "linear sync already running" })
    })

    const result = await seam.syncNow("ENG")

    expect(textOf(result)).toBe("linear sync already running")
    expect(syncPayloadOf(store)?.error).toBe("linear sync already running")
    expect(store.collections.cards.get("sync-ops-linear-7")?.status).toBe("error")
  })

  test("a start that names no run id is not a started run", async () => {
    const { store, seam } = await harness({
      "api/integrations/linear": json(200, [INTEGRATION]),
      "POST api/linear/7/sync": json(202, {})
    })

    const result = await seam.syncNow("7")

    expect(textOf(result)).toBe("Smithers Cloud started the sync without naming a run id.")
    expect(syncPayloadOf(store)?.runId).toBeUndefined()
  })

  test("syncNow with several integrations names them; with none, points at connect", async () => {
    const many = await harness({
      "api/integrations/linear": json(200, [
        INTEGRATION,
        { ...INTEGRATION, id: 9, linear_team_key: "DES", linear_team_name: "Design", linear_team_id: "team-design" }
      ])
    })
    expect(textOf(await many.seam.syncNow())).toBe(
      "linear.sync names an integration: ENG (7) → will/smithers, DES (9) → will/smithers."
    )

    const none = await harness({ "api/integrations/linear": json(200, []) })
    expect(textOf(await none.seam.syncNow())).toBe("No Linear integration is connected — /linear.connect opens the card.")
    expect(textOf(await none.seam.syncNow("ENG"))).toBe(
      "No Linear integration named ENG — none are connected. /linear.connect opens the card."
    )
  })

  test("activity reads the last 24 hours of ops, newest first, failures included", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    const { store, seam, requests } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: json(200, [
          op({ id: 20, status: "failed", error_message: "Linear API: 500" }),
          op({ id: 19 })
        ])
      },
      { now: () => at }
    )

    const result = await seam.activity("ENG")

    expect(requests).toContain(`GET api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`)
    expect(textOf(result)).toBe("2 Linear ENG sync ops in the last 24 hours — the card lists them.")
    const payload = syncPayloadOf(store)
    expect(payload?.window).toBe("24h")
    /* The answer's own order stands, and the failed row is never filtered out. */
    expect(payload?.ops.map((row) => row.id)).toEqual(["20", "19"])
    expect(payload?.ops[0]?.status).toBe("failed")
    expect(payload?.hasOlder).toBe(false)
  })

  test("a page whose Link names a next cursor offers older ops; load older continues from that cursor and appends (plue#491)", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    const first = Array.from({ length: OPS_PAGE_LIMIT }, (_, index) => op({ id: 100 + index }))
    const { store, seam, requests } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: page(first, "cur-2"),
        /* The next page continues from the cursor plue named, and is the last one. */
        "api/linear/7/ops?limit=100&cursor=cur-2": page([op({ id: 9 })])
      },
      { now: () => at }
    )
    await seam.activity("ENG")
    expect(syncPayloadOf(store)?.hasOlder).toBe(true)
    expect(syncPayloadOf(store)?.opsCursor).toBe("cur-2")

    await seam.loadOlderOps("sync-ops-linear-7")

    expect(requests).toContain("GET api/linear/7/ops?limit=100&cursor=cur-2")
    const payload = syncPayloadOf(store)
    /* The older page APPENDS: paging back never drops the rows already read. */
    expect(payload?.ops).toHaveLength(OPS_PAGE_LIMIT + 1)
    expect(payload?.ops.at(-1)?.id).toBe("9")
    expect(payload?.window).toBeUndefined()
    expect(payload?.expanded).toBe(true)
    /* A last page carries only rel="first": the cursor is spent and nothing older is offered. */
    expect(payload?.hasOlder).toBe(false)
    expect(payload?.opsCursor).toBeNull()
  })

  test("a card whose feed is exhausted says so rather than re-reading the same page", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    const { store, seam, requests } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: page([op({ id: 20 })])
      },
      { now: () => at }
    )
    await seam.activity("ENG")
    expect(syncPayloadOf(store)?.opsCursor).toBeNull()
    requests.length = 0

    expect(await seam.loadOlderOps("sync-ops-linear-7")).toBe(
      "The Linear ENG sync feed has no older page — the card lists all of it."
    )
    expect(requests).toEqual([])
  })

  test("a next link that leaves the ops route is not followed", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    const { store, seam } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: () =>
          new Response(JSON.stringify([op({ id: 20 })]), {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: '</api/linear/9/ops?limit=50&cursor=cur-2>; rel="next"'
            }
          })
      },
      { now: () => at }
    )
    await seam.activity("ENG")
    expect(syncPayloadOf(store)?.opsCursor).toBeNull()
    expect(syncPayloadOf(store)?.hasOlder).toBe(false)
  })

  test("activity states a refused feed verbatim on the card", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    const { store, seam } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: json(403, {
          message: "read:repository scope required"
        })
      },
      { now: () => at }
    )

    const result = await seam.activity("ENG")

    expect(textOf(result)).toBe("read:repository scope required")
    expect(syncPayloadOf(store)?.error).toBe("read:repository scope required")
  })

  test("disconnect deletes the integration and removes the connected card", async () => {
    /* The list reads one integration before the delete, none after. */
    let integrations: Array<unknown> = [INTEGRATION]
    const { store, seam, requests } = await harness(
      {
        "POST /api/linear-auth/start": json(200, { url: "https://api.smithers-cloud.test/api/auth/linear" }),
        "GET /api/linear-auth/session": authorizedSession(),
        "api/linear/setup/sk-123": json(200, SETUP),
        "POST api/linear": json(201, INTEGRATION),
        "api/integrations/linear": () => json(200, integrations)(),
        "DELETE api/integrations/linear/7": () => {
          integrations = []
          return new Response(null, { status: 204 })
        }
      },
      { pollMs: 1, timeoutMs: 5000, openExternal: async () => true }
    )
    await seam.connect()
    await seam.openLinear()
    await seam.pickTeam("team-eng")
    await seam.confirmConnect()
    expect(store.collections.cards.get("connector-setup-linear-will/smithers")?.kind).toBe("connector-setup")

    /*
     * Review finding 4: disconnecting is consequential, so the team key typed
     * back is the confirm — without it (or with the wrong one) nothing is
     * deleted and the answer names the exact invocation.
     */
    expect(textOf(await seam.disconnect("7"))).toBe(
      "Disconnecting Linear ENG from will/smithers needs its team key typed back exactly — /linear.disconnect 7 ENG."
    )
    expect(textOf(await seam.disconnect("7", "DES"))).toBe(
      "Disconnecting Linear ENG from will/smithers needs its team key typed back exactly — /linear.disconnect 7 ENG."
    )
    expect(requests).not.toContain("DELETE api/integrations/linear/7")
    expect(store.collections.cards.get("connector-setup-linear-will/smithers")?.kind).toBe("connector-setup")

    const result = await seam.disconnect("7", "ENG")

    expect(requests).toContain("DELETE api/integrations/linear/7")
    expect(textOf(result)).toBe("Linear ENG disconnected from will/smithers.")
    expect(store.collections.linearIntegrations.get("7")).toBeUndefined()
    expect(store.collections.cards.get("connector-setup-linear-will/smithers")).toBeUndefined()
  })

  test("retryOp posts through the integration the op's own card names, then re-reads the feed", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    let listed = [op({ id: 20, status: "failed", error_message: "Linear API: 500" })]
    const { store, seam, requests } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: () => json(200, listed)(),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}`]: () => json(200, listed)(),
        "POST api/linear/7/ops/20/retry": () => {
          listed = [op({ id: 21, retry_of_id: 20, status: "success" }), ...listed]
          return json(202, op({ id: 21, retry_of_id: 20, status: "success" }))()
        }
      },
      { now: () => at }
    )
    await seam.activity("ENG")

    const result = await seam.retryOp("20")

    /* `sync.retry <opId>` names only the op; the card it sits on names the integration. */
    expect(requests).toContain("POST api/linear/7/ops/20/retry")
    expect(textOf(result)).toBe("Op 20 retried — the card lists the retry.")
    expect(syncPayloadOf(store)?.ops.map((row) => row.id)).toEqual(["21", "20"])
  })

  test("retryOp with no card listing the op calls nothing", async () => {
    const { seam, requests } = await harness({})

    expect(textOf(await seam.retryOp(" "))).toBe("sync.retry needs an op id: /sync.retry <opId>")
    expect(textOf(await seam.retryOp("20"))).toBe(
      "No sync card lists op 20 — the Retry button lives on the failed op's row."
    )
    expect(requests).toEqual([])
  })

  test("a retry plue refuses reads its own sentence verbatim on the card", async () => {
    const at = Date.parse("2026-09-02T12:00:00Z")
    const since = new Date(at - 24 * 60 * 60 * 1000).toISOString()
    const { store, seam } = await harness(
      {
        "api/integrations/linear": json(200, [INTEGRATION]),
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}&since=${encodeURIComponent(since)}`]: json(200, [
          op({ id: 20, status: "failed", error_message: "Linear API: 500" })
        ]),
        "POST api/linear/7/ops/20/retry": json(409, { message: "only failed linear sync operations can be retried" })
      },
      { now: () => at }
    )
    await seam.activity("ENG")

    const result = await seam.retryOp("20")

    expect(textOf(result)).toBe("only failed linear sync operations can be retried")
    expect(syncPayloadOf(store)?.error).toBe("only failed linear sync operations can be retried")
  })

  test("the integrations list is read from plue's own path, never /api/linear", async () => {
    /*
     * plue registers GET /linear only inside /api/integrations; a GET at the
     * api root is a different route (POST /api/linear is the create). The
     * old path answered nothing, so every bare act read an empty list.
     */
    const { store, seam, requests } = await harness({ "api/integrations/linear": json(200, [INTEGRATION]) })

    await seam.refreshIntegrations()

    expect(requests).toEqual(["GET api/integrations/linear"])
    expect(store.collections.linearIntegrations.get("7")?.teamKey).toBe("ENG")
  })
})

/*
 * The two fences the Linear run poll runs behind: the epoch that retires a
 * superseded loop, and the drop budget that separates a lost connection from
 * a run read the platform refused.
 */
describe("the Linear run poll's fences", () => {
  /** A route that answers only when the test releases it, so a poll can be parked. */
  const parked = () => {
    let release: (response: Response) => void = () => {}
    const answer = new Promise<Response>((resolve) => {
      release = resolve
    })
    return { route: () => answer, release: (response: Response): void => release(response) }
  }

  const settleTicks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

  test("a poll parked across two newer runs never writes the run the card stopped tracking", async () => {
    /*
     * Review finding 4: the epoch used to be DELETED when a loop settled, so
     * the third run was handed epoch 1 again and the first run's parked poll
     * passed the fence and wrote its state and counts over the card.
     */
    const previous = { ...linearSyncPolling }
    linearSyncPolling.delayMs = 1
    linearSyncPolling.maxAttempts = 6
    try {
      const first = parked()
      const third = parked()
      let runId = 41
      const { store, seam, requests } = await harness({
        "api/integrations/linear": json(200, [INTEGRATION]),
        "POST api/linear/7/sync": () => json(202, { run_id: runId })(),
        "api/linear/7/sync/41": first.route,
        "api/linear/7/sync/42": json(200, run("completed", { finished_at: "2026-09-02T09:05:00Z" })),
        "api/linear/7/sync/43": third.route,
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}`]: json(200, [])
      })

      /* Run 41's first poll parks; run 42 settles and retires its epoch; run 43 takes the card. */
      await seam.syncNow()
      await waitUntil(() => requests.includes("GET api/linear/7/sync/41"), "run 41's poll to be in flight")
      runId = 42
      await seam.syncNow()
      await waitUntil(() => syncPayloadOf(store)?.runState === "completed", "run 42 to settle")
      runId = 43
      await seam.syncNow()
      expect(syncPayloadOf(store)?.runId).toBe("43")

      first.release(json(200, run("failed"))() as Response)
      await settleTicks()

      /* The card still states run 43 and nothing run 41 answered. */
      expect(syncPayloadOf(store)?.runId).toBe("43")
      expect(syncPayloadOf(store)?.runState).toBeNull()
      expect(syncPayloadOf(store)?.counts).toBeNull()
      third.release(json(200, run("completed"))() as Response)
    } finally {
      Object.assign(linearSyncPolling, previous)
    }
  })

  test("one dropped run read is retried and the run still settles", async () => {
    /* Review finding 3: a single transport drop used to end tracking with an error card. */
    const previous = { ...linearSyncPolling }
    linearSyncPolling.delayMs = 1
    linearSyncPolling.maxAttempts = 6
    try {
      let polls = 0
      const { store, seam } = await harness({
        "api/integrations/linear": json(200, [INTEGRATION]),
        "POST api/linear/7/sync": json(202, { run_id: 41 }),
        "api/linear/7/sync/41": () => {
          polls += 1
          if (polls === 1) throw new Error("socket hung up")
          return json(200, run("completed", { finished_at: "2026-09-02T09:05:00Z" }))()
        },
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}`]: json(200, [])
      })

      await seam.syncNow()
      await waitUntil(() => syncPayloadOf(store)?.runState === "completed", "the run to settle after the drop")

      expect(syncPayloadOf(store)?.error).toBeUndefined()
      expect(store.collections.cards.get("sync-ops-linear-7")?.status).toBe("acted")
    } finally {
      Object.assign(linearSyncPolling, previous)
    }
  })

  test("drops past the budget hand off honestly, keeping the last state instead of failing the run", async () => {
    const previous = { ...linearSyncPolling }
    linearSyncPolling.delayMs = 1
    linearSyncPolling.maxAttempts = 20
    try {
      let polls = 0
      const { store, seam } = await harness({
        "api/integrations/linear": json(200, [INTEGRATION]),
        "POST api/linear/7/sync": json(202, { run_id: 41 }),
        "api/linear/7/sync/41": () => {
          polls += 1
          if (polls === 1) return json(200, run("running"))()
          throw new Error("socket hung up")
        },
        [`api/linear/7/ops?limit=${OPS_PAGE_LIMIT}`]: json(200, [])
      })

      await seam.syncNow()
      await waitUntil(
        () => syncPayloadOf(store)?.trigger === LINEAR_LOST_STREAM_TRIGGER,
        "the lost-stream hand-off"
      )

      /* The run keeps syncing upstream: an honest standstill, not an error. */
      expect(syncPayloadOf(store)?.runState).toBe("running")
      expect(syncPayloadOf(store)?.error).toBeUndefined()
      expect(store.collections.cards.get("sync-ops-linear-7")?.status).toBe("active")
      /* One read plus the budget's drops, then the hand-off — never a drop per attempt. */
      expect(polls).toBe(1 + linearSyncPolling.networkRetries + 1)
    } finally {
      Object.assign(linearSyncPolling, previous)
    }
  })
})
