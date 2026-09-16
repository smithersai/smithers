import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { processRepositoryEvents } from "../RepositoryNotifications"
import { initialSetup } from "@smthrs/rpc/RepositorySetup"

/*
 * The issues seam, driven through the one command run path: issues.list /
 * issues.view / issues.close / issues.comment against stubbed platform routes.
 * Substance lands as cards ("issue-list", "issue") in store.collections.cards;
 * failures come back as honest error strings (CommandOutcome "failed"), never
 * throws. One loaded repository ("will/flows") stands in for the repo
 * resolution, matching the RepoContext single-repository rule.
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

type RouteAnswer = Response | ((request: Request) => Response | Promise<Response>)

/**
 * Route stub keyed "METHOD /path" (pathname only — the query is recorded in
 * `calls` so tests can assert it). Unstubbed routes answer 404 honestly.
 */
const backend = (routes: Record<string, RouteAnswer>, calls: string[] = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${absolute.pathname}${absolute.search}`)
    for (const [route, answer] of Object.entries(routes)) {
      const spaceIndex = route.indexOf(" ")
      const routeMethod = route.slice(0, spaceIndex)
      const routePath = route.slice(spaceIndex + 1)
      if (routeMethod !== method || absolute.pathname !== routePath) continue
      return typeof answer === "function"
        ? answer(new Request(absolute.toString(), init))
        : answer.clone()
    }
    return json(404, { status: "error", message: `no stub for ${method} ${absolute.pathname}` })
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

/** ONE loaded repo, so repo resolution answers "will/flows" without an argument. */
const reposChosen = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }]
  })
  await settled()
}

const issuesController = async (services: AppServices) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  await signedIn(store)
  await reposChosen(store)
  return { store, controller, storage }
}

/* Plue's issue wire shape (multi src/smithersCloud/issues.ts). */
const wireIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number * 100,
  number,
  title: `Fix the flake ${number}`,
  body: "It **flakes** on CI.",
  state: "open",
  labels: [{ id: 1, name: "bug", color: "d73a4a", description: "" }],
  assignees: [],
  author: { id: 3, login: "ana" },
  milestone_id: null,
  comment_count: 2,
  created_at: "2026-08-10T09:00:00Z",
  updated_at: "2026-08-11T09:00:00Z",
  closed_at: null,
  ...overrides
})

test.each([
  { name: "unconfigured", enabled: false, owner: "will", tips: 1 },
  { name: "enabled CI", enabled: true, owner: "will", tips: 0 },
  { name: "another account's CI", enabled: true, owner: "someone-else", tips: 1 }
])("issue creation suggests optional CI once for $name", async scenario => {
  const { store, controller } = await issuesController(backend({
    "POST /api/repos/will/flows/issues": json(201, wireIssue(8)),
    "GET /api/repos/will/flows/issues/8": json(200, wireIssue(8)),
    "GET /api/repos/will/flows/issues/8/comments": json(200, [])
  }))
  try {
    const setup = initialSetup("will/flows", "ci", scenario.owner)
    if (scenario.enabled) setup.active = { revision: 1, digest: "test", registrationId: "test", sourceRevision: "test", enabled: true }
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "ci-settings", kind: "repository-setup", title: "CI", createdAt: 1, ordinal: 1, status: "active", payload: setup
    } }).isPersisted.promise
    await controller.commands.run("issues.create", "Improve logging")
    await controller.commands.run("issues.create", "Improve tests")
    await store.settled?.()
    const tips = [...store.collections.toasts.values()].filter(toast => toast.action?.flow === "ci.setup")
    expect(tips).toHaveLength(scenario.tips)
    if (scenario.tips) expect(tips[0]).toMatchObject({ status: "ok", action: { label: "Set up CI", args: "will/flows" } })
  } finally { await controller.dispose(); await store.dispose?.() }
})

/* GitHub's issue wire shape off the source read (multi src/smithersCloud/githubIssues.ts). */
const wireGithubIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number * 1000,
  number,
  title: `Upstream bug ${number}`,
  body: "Seen on main.",
  state: "open",
  user: { login: "octo", avatar_url: "https://avatars.test/octo" },
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [],
  comments: 4,
  html_url: `https://github.com/will/flows/issues/${number}`,
  created_at: "2026-08-09T09:00:00Z",
  updated_at: "2026-08-10T09:00:00Z",
  ...overrides
})

/* Plue's IssueCommentResponse wire shape (multi src/smithersCloud/issueComments.ts). */
const wireComment = (id: number, body: string) => ({
  id,
  issue_id: 7,
  user_id: 4,
  commenter: "bob",
  body,
  type: "comment",
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T10:00:00Z"
})

const cardOfKind = <K extends Card["kind"]>(
  store: AppStore,
  id: string,
  kind: K
): Extract<Card, { kind: K }> => {
  const card: Card | undefined = store.collections.cards.get(id)
  if (card === undefined || card.kind !== kind) {
    throw new Error(`Expected card ${id} of kind ${kind}, got ${card?.kind ?? "nothing"}`)
  }
  return card as Extract<Card, { kind: K }>
}

describe("issues seam — the list", () => {
  test("rejects malformed top-level lists instead of reporting an empty success", async () => {
    for (const body of [{}, "not a list", null]) {
      const { store, controller } = await issuesController(
        backend({ "GET /api/repos/will/flows/issues": json(200, body) })
      )
      const outcome = await controller.commands.run("issues.list")
      expect(outcome.status).toBe("failed")
      expect(store.collections.cards.get("issues-will/flows")).toMatchObject({ status: "error", loading: false })
    }
  })
  test("issues.list upserts the issue-list card with defensively parsed rows and asks state=open", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(200, [
            wireIssue(7),
            "junk",
            { title: "no number at all" },
            wireIssue(9, { state: "closed", author: null, comment_count: "not-a-number", updated_at: null })
          ])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.title).toBe("Issues · will/flows")
    expect(card.status).toBe("active")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.filter).toBe("open")
    // The two real rows survive; garbage entries drop; missing fields go null/zero.
    expect(card.payload.issues).toEqual([
      {
        number: 7,
        title: "Fix the flake 7",
        state: "open",
        author: "ana",
        comments: 2,
        updatedAt: "2026-08-11T09:00:00Z",
        source: "smithers-cloud"
      },
      {
        number: 9,
        title: "Fix the flake 9",
        state: "closed",
        author: null,
        comments: 0,
        updatedAt: null,
        source: "smithers-cloud"
      }
    ])
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
    // GitHub's issues are read beside Smithers Cloud's own; an unstubbed (404) GitHub route is a stated refusal, never a silent absence.
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=open")
    expect(card.payload.github?.refusal).toBeTruthy()
  })

  test("issues.list all omits the state param — Plue rejects state=all", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend({ "GET /api/repos/will/flows/issues": json(200, []) }, calls)
    )
    const outcome = await controller.commands.run("issues.list", "all")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.filter).toBe("all")
    expect(card.payload.issues).toEqual([])
    expect(calls).toContain("GET /api/repos/will/flows/issues")
    // Smithers Cloud's own route never sees state=all; GitHub's accepts it.
    expect(calls.some((call) => call.startsWith("GET /api/repos/") && call.includes("state=all"))).toBe(false)
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all")
  })

  test("a mirrored repo lists Smithers Cloud's own issues AND GitHub's, each row labeled, with the read's provenance from plue's headers", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
        "GET /api/user/github-repos/will/flows/issues": new Response(JSON.stringify([wireGithubIssue(12)]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-metadata-source": "synced",
            "x-metadata-synced-at": "2026-09-02T16:00:00Z",
            "x-metadata-stale": "true",
            "x-metadata-sync-error": "rate limited at 15:59"
          }
        })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.issues.map((issue) => [issue.number, issue.source])).toEqual([[7, "smithers-cloud"], [12, "github"]])
    expect(card.payload.issues[1]?.htmlUrl).toBe("https://github.com/will/flows/issues/12")
    expect(card.payload.github).toEqual({
      source: "synced",
      syncedAt: "2026-09-02T16:00:00Z",
      stale: true,
      syncError: "rate limited at 15:59",
      refusal: null
    })
    // The model reads the rows as text, GitHub rows marked.
    expect(outcome.status === "executed" ? outcome.value : "").toContain("#12 Upstream bug 12 · open · GitHub")
  })

  test("a GitHub refusal (not linked, not mirrored) is stated on the card while Smithers Cloud's own issues still list", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(200, [wireIssue(7)]),
        "GET /api/user/github-repos/will/flows/issues": json(403, { message: "GitHub is not linked for this account" })
      })
    )
    expect((await controller.commands.run("issues.list")).status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.issues.map((issue) => issue.number)).toEqual([7])
    expect(card.payload.github?.refusal).toBe("GitHub is not linked for this account")
  })
})

describe("issues seam — the detail", () => {
  test.each(["run", "runForAgent"] as const)("issues.view fetches the issue AND its comments and upserts the detail card (%s)", async (door) => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7)),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [
          wireComment(1, "First!"),
          "junk"
        ])
      })
    )
    const outcome = await controller.commands[door]("issues.view", "7")
    expect(outcome.status).toBe("executed")
    const value = outcome.status === "executed" ? outcome.value : undefined
    for (const text of ["will/flows", "#7 Fix the flake 7 · open", "ana", "It **flakes** on CI.", "bug", "bob", "First!", "2026-08-11T10:00:00Z"]) {
      expect(value).toContain(text)
    }
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload).toEqual({
      repo: "will/flows",
      number: 7,
      title: "Fix the flake 7",
      state: "open",
      author: "ana",
      issueBody: "It **flakes** on CI.",
      labels: ["bug"],
      comments: [{ author: "bob", commentBody: "First!", createdAt: "2026-08-11T10:00:00Z" }]
    })
  })
})

test("issue detail bounds the model value while retaining the card body", async () => {
  const body = "large issue body ".repeat(2_000)
  const { store, controller } = await issuesController(backend({
    "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, { body })),
    "GET /api/repos/will/flows/issues/7/comments": json(200, [])
  }))
  const outcome = await controller.commands.runForAgent("issues.view", "7")
  expect(outcome.status).toBe("executed")
  const value = outcome.status === "executed" ? outcome.value : undefined
  expect(value).toContain("#7 Fix the flake 7 · open")
  expect(value).toContain("[truncated]")
  expect(value?.length).toBeLessThanOrEqual(16_000)
  expect(cardOfKind(store, "issue-will/flows-7", "issue").payload.issueBody).toBe(body)
})

describe("issues seam — mutations re-fetch so the card states the new truth", () => {
  test("issues.close PATCHes {state:'closed'} then upserts the re-fetched closed card", async () => {
    let patched: unknown
    const { store, controller } = await issuesController(
      backend({
        "PATCH /api/repos/will/flows/issues/7": async (request) => {
          patched = await request.json()
          return json(200, wireIssue(7, { state: "closed", closed_at: "2026-08-12T09:30:00Z" }))
        },
        "GET /api/repos/will/flows/issues/7": json(
          200,
          wireIssue(7, { state: "closed", closed_at: "2026-08-12T09:30:00Z" })
        ),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [])
      })
    )
    const outcome = await controller.commands.run("issues.close", "7")
    expect(outcome.status).toBe("executed")
    expect(patched).toEqual({ state: "closed" })
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload.state).toBe("closed")
    expect(card.payload.comments).toEqual([])
  })

  test("issues.comment POSTs {body} then upserts the card carrying the new comment", async () => {
    let posted: unknown
    const { store, controller } = await issuesController(
      backend({
        "POST /api/repos/will/flows/issues/7/comments": async (request) => {
          posted = await request.json()
          return json(201, wireComment(2, "hello"))
        },
        "GET /api/repos/will/flows/issues/7": json(200, wireIssue(7, { comment_count: 3 })),
        "GET /api/repos/will/flows/issues/7/comments": json(200, [
          wireComment(1, "First!"),
          wireComment(2, "hello")
        ])
      })
    )
    const outcome = await controller.commands.run("issues.comment", "7 hello")
    expect(outcome.status).toBe("executed")
    expect(posted).toEqual({ body: "hello" })
    await settled()
    const card = cardOfKind(store, "issue-will/flows-7", "issue")
    expect(card.payload.comments.map((comment) => comment.commentBody)).toEqual([
      "First!",
      "hello"
    ])
  })
})

describe("issues seam — honest failures, never throws", () => {
  test("a 500 answers the backend's message as a failed outcome and keeps the failed view visible", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(500, { message: "the platform exploded" })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the platform exploded")
    await settled()
    expect(store.collections.cards.get("issues-will/flows")).toMatchObject({ status: "error", loading: false })
  })

  test("a network throw answers an honest string and keeps the failed view visible", async () => {
    // Only the issues routes throw; everything else 404s so startup seams stay honest.
    const throwingBackend: AppServices = {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const path = new URL(url, "https://app.test").pathname
        if (path.startsWith("/api/repos/")) throw new TypeError("socket hangup")
        return json(404, { status: "error", message: `no stub for ${path}` })
      }
    }
    const { store, controller } = await issuesController(throwingBackend)
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Could not reach the backend")
      expect(outcome.error).toContain("socket hangup")
    }
    await settled()
    expect(store.collections.cards.get("issue-will/flows-7")).toMatchObject({ status: "error", loading: false })
  })

  test("with several loaded repositories and no argument, the answer is the missing-repository form", async () => {
    const { store, controller } = await issuesController(backend({}))
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [
        { id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null },
        { id: "will/smithers", org: "will", ownerKind: "user", name: "smithers", head: null }
      ]
    })
    await settled()
    /* THE FORM LAW: the missing repository is asked for, never guessed (tutorial stage 3). */
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    const form = store.collections.cards.get("form-issues.list")
    expect(form?.kind).toBe("flow-form")
    if (form?.kind === "flow-form") expect(form.payload.fields.map(field => field.name)).toContain("repo")
    expect(store.collections.cards.get("issues-will/flows")).toBeUndefined()
  })
})

/*
 * IMPORT-READINESS degradation (multi importReadiness.ts + githubIssues.ts):
 * the imported namespace 404s for a source-only repo, so the list falls back
 * to the GET-only GitHub-source read; detail and mutations answer honest
 * strings pointing at /repos.import and never touch the source namespace.
 */
describe("issues seam — source-only fallback (repo not imported)", () => {
  test("issues.list on an imported-namespace 404 reads the GitHub source and marks the card", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
          "GET /api/user/github-repos/will/flows/issues": json(200, [
            wireGithubIssue(12),
            // GitHub's issues endpoint includes pull requests — the row drops.
            wireGithubIssue(99, { pull_request: { url: "https://api.github.test/pulls/99" } }),
            "junk",
            wireGithubIssue(15, {
              state: "closed",
              user: null,
              comments: "not-a-number",
              updated_at: null
            })
          ])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(
      "#12 Upstream bug 12 · open · GitHub\n#15 Upstream bug 15 · closed · GitHub"
    )
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.title).toBe("Issues · will/flows")
    expect(card.body).toBe("Read from GitHub — import for full features: /repos.import will/flows")
    expect(card.payload.repo).toBe("will/flows")
    expect(card.payload.filter).toBe("open")
    // GitHub spellings land in the same rows: user.login → author, comments → comments.
    expect(card.payload.issues).toEqual([
      {
        number: 12,
        source: "github",
        htmlUrl: "https://github.com/will/flows/issues/12",
        title: "Upstream bug 12",
        state: "open",
        author: "octo",
        comments: 4,
        updatedAt: "2026-08-10T09:00:00Z"
      },
      {
        number: 15,
        source: "github",
        htmlUrl: "https://github.com/will/flows/issues/15",
        title: "Upstream bug 15",
        state: "closed",
        author: null,
        comments: 0,
        updatedAt: null
      }
    ])
    expect(calls).toContain("GET /api/repos/will/flows/issues?state=open")
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=open")
  })

  test.each(["open", "closed", "all"])("empty source list answers a value for %s", async (filter) => {
    const { controller } = await issuesController(backend({
      "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
      "GET /api/user/github-repos/will/flows/issues": json(200, [])
    }))
    const outcome = await controller.commands.runForAgent("issues.list", filter)
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toBe(
      `No ${filter === "all" ? "" : `${filter} `}issues in will/flows (read from GitHub).`
    )
  })

  test("issues.list all asks the GitHub source with state=all — only Plue rejects state=all", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend(
        {
          "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
          "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(3)])
        },
        calls
      )
    )
    const outcome = await controller.commands.run("issues.list", "all")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(card.payload.filter).toBe("all")
    expect(card.payload.issues.map((issue) => issue.number)).toEqual([3])
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all")
  })

  test("the GitHub source failing too answers the honest error and keeps the failed view visible", async () => {
    const { store, controller } = await issuesController(
      backend({
        "GET /api/repos/will/flows/issues": json(404, { message: "repository not found" }),
        "GET /api/user/github-repos/will/flows/issues": json(404, {
          message: "GitHub answered 404 for will/flows"
        })
      })
    )
    const outcome = await controller.commands.run("issues.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("GitHub answered 404 for will/flows")
    }
    await settled()
    expect(store.collections.cards.get("issues-will/flows")).toMatchObject({ status: "error", loading: false })
  })

  test("native issues.view on a 404 names the explicit GitHub door without switching trackers", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(
      backend({ "GET /api/repos/will/flows/issues/7": json(404, { message: "not found" }) }, calls)
    )
    const outcome = await controller.commands.run("issues.view", "7")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toContain("Issue #7 in will/flows answered 404")
      expect(outcome.error).toContain("/issues.view 7 will/flows --source github")
    }
    expect(calls.some((call) => call.includes("/api/user/github-repos/"))).toBe(false)
    expect(store.collections.cards.get("issue-will/flows-7")).toMatchObject({ status: "error", loading: false })
  })

  test("mutations on a 404 answer the repos.import error and never write to the source", async () => {
    const calls: string[] = []
    // Nothing stubbed: every imported-namespace mutation answers the honest 404.
    const { store, controller } = await issuesController(backend({}, calls))
    const mutations: ReadonlyArray<readonly [string, string]> = [
      ["issues.create", "A brand new idea"],
      ["issues.close", "7"],
      ["issues.reopen", "7"],
      ["issues.comment", "7 hello there"]
    ]
    for (const [command, args] of mutations) {
      const outcome = await controller.commands.run(command, args)
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") {
        expect(outcome.error).toBe("will/flows isn't imported yet — run /repos.import will/flows first")
      }
    }
    // Zero fallback traffic: the GET-only source namespace was never touched.
    expect(calls.some((call) => call.includes("/api/user/github-repos/"))).toBe(false)
    await settled()
    expect(store.collections.cards.get("issue-will/flows-7")).toBeUndefined()
  })
})

describe("source-qualified issue identity", () => {
  test("same-number native and GitHub rows open their own details and remain separate in history", async () => {
    const calls: string[] = []
    const { store, controller, storage } = await issuesController(backend({
      "GET /api/repos/will/flows/issues": json(200, [wireIssue(1, { title: "Native issue" })]),
      "GET /api/repos/will/flows/issues/1": json(200, wireIssue(1, { title: "Native issue" })),
      "GET /api/repos/will/flows/issues/1/comments": json(200, []),
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(1, { title: "GitHub issue" })]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [{ user: { login: "octo" }, body: "GitHub comment", created_at: "2026-09-14T12:00:00Z" }])
    }, calls))
    expect((await controller.commands.run("issues.list", "will/flows")).status).toBe("executed")
    const list = cardOfKind(store, "issues-will/flows", "issue-list")
    expect(list.payload.issues.map(row => [row.number, row.source])).toEqual([[1, "smithers-cloud"], [1, "github"]])
    expect((await controller.commands.run("issues.view", "1 will/flows --source smithers-cloud")).status).toBe("executed")
    expect(cardOfKind(store, list.id, "issue").payload.title).toBe("Native issue")
    calls.length = 0
    expect((await controller.commands.run("issues.view", "1 will/flows --source github")).status).toBe("executed")
    const detail = cardOfKind(store, list.id, "issue")
    expect(detail.payload).toMatchObject({ number: 1, source: "github", title: "GitHub issue", issueBody: "Seen on main.", author: "octo", labels: ["bug"], comments: [{ author: "octo", commentBody: "GitHub comment" }] })
    expect(calls.filter(call => call.includes("/issues"))).toEqual([
      "GET /api/user/github-repos/will/flows/issues?state=all&per_page=100&page=1",
      "GET /api/user/github-repos/will/flows/issues/1/comments?per_page=100&page=1"
    ])
    const history = store.collections.cardHistories.get(list.id)!
    expect(history.entries.filter(entry => entry.kind === "issue").map(entry => entry.payload.title)).toEqual(["Native issue", "GitHub issue"])
    await controller.dispose()
    await store.settled?.()
    await store.dispose?.()
    const restored = await createAppStore({ kind: "localStorage", storage })
    expect(cardOfKind(restored, list.id, "issue").payload.source).toBe("github")
    await restored.dispatch({ type: "card.history.moved", actor: "user", id: list.id, delta: -1 }).isPersisted.promise
    expect(cardOfKind(restored, list.id, "issue").payload.title).toBe("Native issue")
    await restored.dispatch({ type: "card.history.moved", actor: "user", id: list.id, delta: 1 }).isPersisted.promise
    expect(cardOfKind(restored, list.id, "issue").payload.source).toBe("github")
  })

  test("GitHub read follows metadata pagination and refuses a missing source issue without reading native detail", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/user/github-repos/will/flows/issues": request => new URL(request.url).searchParams.get("page") === "1"
        ? new Response(JSON.stringify([wireGithubIssue(2)]), { headers: { link: '<https://untrusted.example/path?page=2>; rel="next"' } })
        : json(200, [wireGithubIssue(1)]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
    }, calls))
    expect((await controller.commands.run("issues.view", "1 will/flows --source github")).status).toBe("executed")
    expect(cardOfKind(store, "issue-github-will/flows-1", "issue").payload.title).toBe("Upstream bug 1")
    expect(calls).toContain("GET /api/user/github-repos/will/flows/issues?state=all&per_page=100&page=2")
    expect((await controller.commands.run("issues.view", "99 will/flows --source github")).status).toBe("failed")
    expect(calls.some(call => /\/api\/repos\/.*\/issues/.test(call) || call.includes("untrusted"))).toBe(false)
  })

  test("missing issue number preserves GitHub source and repository in the shared form", async () => {
    const calls: string[] = []
    const { store, controller } = await issuesController(backend({
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(1)]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
    }, calls))
    const outcome = await controller.commands.run("issues.view", "will/flows --source github")
    expect(outcome.status).toBe("form")
    await settled()
    const form = [...store.collections.cards.values()].find(card => card.kind === "flow-form")
    expect(form?.kind).toBe("flow-form")
    if (form?.kind !== "flow-form") throw Error("Missing form")
    expect(form.payload.draft).toMatchObject({ source: "github", repo: "will/flows" })
    expect(form.payload.fields.find(field => field.name === "number")?.required).toBe(true)
    expect((await controller.commands.run("form.set", `${form.id} number 1`)).status).toBe("executed")
    expect((await controller.commands.run("form.submit", form.id)).status).toBe("executed")
    expect(cardOfKind(store, "issue-github-will/flows-1", "issue").payload.source).toBe("github")
    expect(calls.some(call => /\/api\/repos\/.*\/issues/.test(call))).toBe(false)
  })

  test("opening a GitHub issue marks only that tracker read and failed reads leave receipts unread", async () => {
    const { store, controller } = await issuesController(backend({
      "GET /api/user/github-repos/will/flows/issues": json(200, [wireGithubIssue(1)]),
      "GET /api/user/github-repos/will/flows/issues/1/comments": json(200, [])
    }))
    const notices = processRepositoryEvents("github:will", "will/flows", ["smithers", "github"].flatMap(source => [1, 99].map(number => ({
      source, sourceId: String(number), kind: "issue" as const, number, title: `${source} ${number}`, state: "open", updatedAt: null, tags: []
    }))), [], 0).rows
    await store.dispatch({ type: "repo.update.published", actor: "system", notifications: notices, card: {
      id: "activity", kind: "repo-update", title: "Activity", status: "active", createdAt: 0, ordinal: 0,
      payload: { repo: "will/flows", scope: "github:will", checkedAt: 0, summary: "", openIssues: 4, openPrs: 0, problems: [], items: [] }
    } }).isPersisted.promise
    expect((await controller.commands.run("issues.view", "1 will/flows --source github")).status).toBe("executed")
    expect((await controller.commands.run("issues.view", "99 will/flows --source github")).status).toBe("failed")
    for (const notice of store.collections.repositoryNotifications.values()) {
      expect(notice.readVersion === notice.version).toBe(notice.source === "github" && notice.number === 1)
    }
  })
})
