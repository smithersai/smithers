// Review on request (worker/github/Review.ts, decision 0126, docs/features/pulls.md#review-on-request) through the GitHub
// routes' real handler, over this file's schema of the compose Postgres and the scripted GitHub: a Maintainer of a
// repository the deployment acts on, other than its own, asks Smithers to review a pull request someone else opened;
// the route claims the head's review run and starts `pull/Review`, which then runs on the Node host's engine and posts
// one comment review as the App. Faults come from injected services: a starter that fails, Sessions that fail, a
// Postgres nobody answers on, GitHub's own faults.
import { type ModelEvent } from "@smthrs/model"
import { Effect, Exit, Layer, Redacted, Stream } from "effect"
import { beforeEach, describe, expect, test, vi } from "vitest"
import * as Database from "../../db/Database.ts"
import { GITHUB_WEBHOOK_ROUTE } from "../../src/features/issues/contract.ts"
import { reviewExecutionId, reviewRoute } from "../../src/features/pulls/contract.ts"
import * as Actor from "../Actor.ts"
import { Machines } from "../branch/Machines.ts"
import { FlowStarter, StartUnavailable } from "../Flows.ts"
import * as Checks from "../flows/Checks.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import { handles } from "./Api.ts"
import { parseReviewPath, requests } from "./Review.ts"
import { judgeSeat, REPOSITORY, reset, services as githubServices, signedIn, sql } from "./test/fixtures.ts"
import { delivery, githubHarness, member } from "./test/harness.ts"
import { BOT_LOGIN, type ScriptedGitHub, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_review")

beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE pulls, pull_commits, reviews, runs")
})

// The deployment's own repository is acme/home; the pull request is on acme/widgets, a second repository it acts on, as
// smithersai/vibelang is for smithers.sh.
const OWN = { owner: "acme", name: "home", id: "github/acme/home" } as const
const REPO_ID = "github/acme/widgets"

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
})

/** A person signed in, a Member of the deployment's own repository, whose role on acme/widgets GitHub gives. */
const person = async (login: string): Promise<Actor.Actor> => {
  const signed = await signedIn(runtime, { login, token: Redacted.make("ghu_unused") })
  return { ...member(signed.personId, signed.sessionId), login }
}

/** A pull request an outsider opened on acme/widgets, projected as the webhook projects it; its number and head. */
const opened = async (github: ScriptedGitHub) => {
  const base = github.refs.get("main")!
  const head = github.push("feature", { "A.md": "a\n" })
  const pull = github.openPull("feature", "Add A", "outsider")
  const seed = await githubHarness(runtime, { own: OWN, github, run: true, actor: null })
  const event = { action: "opened", repository: { full_name: "acme/widgets" }, pull_request: { number: pull.number } }
  expect((await seed.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", event))).status).toBe(200)
  await seed.settled()
  return { number: pull.number, head, base }
}

/** A judge that answers `text`. */
const judge = (text: string) => () =>
  Stream.fromIterable<ModelEvent.ModelEvent>([
    { type: "text-delta", id: "t", text },
    { type: "usage", inputTokens: 30, outputTokens: 5 },
    { type: "settle", stopReason: "stop" },
  ])

/** Machines that are never reached: the review alone needs no machine. */
const noMachines = Layer.succeed(Machines, Machines.of({
  tool: () => Effect.die("the review needs no machine"),
  commands: () => Effect.die("the review needs no machine") as never,
  sleepIfIdle: () => Effect.die("the review needs no machine"),
}))

/** Runs a started `pull/Review` on the Node host with `text` as the judge's answer, the reviewer asked for by owner. */
const review = async (
  github: ScriptedGitHub,
  start: { readonly executionId: string; readonly payload: unknown },
  text: string,
) => {
  const { seat } = await judgeSeat(runtime, judge(text))
  const { services } = await githubServices(runtime, github, { judge: seat })
  const owners: Array<string> = []
  const ran = await runFlow(
    Checks.ReviewRun,
    start.payload as Checks.ChecksRequest,
    Checks.registration({ ...services, reviewerFor: (ownerId) => (owners.push(ownerId), seat) }).pipe(Layer.provide(noMachines)),
    { executionId: start.executionId },
  )
  return { ran, owners }
}

const reviewRun = () =>
  sql(runtime, `SELECT flow, status, sha, launched_by AS "launchedBy" FROM runs ORDER BY flow`)

describe("POST /api/repos/<owner>/<name>/pulls/<n>/review", { timeout: 60_000 }, () => {
  test("a Maintainer of another repository asks for a review of a pull request an outsider opened: it runs once, as theirs", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    const maya = await person("maya")
    const h = await githubHarness(runtime, { own: OWN, github, actor: maya })
    const asked = await h.fetch(reviewRoute("acme", "widgets", pull.number), post({ headSha: pull.head }))
    expect([asked.status, await asked.json()]).toEqual([202, { sha: pull.head, started: true }])
    expect(h.starts).toEqual([{
      flow: "pull/Review",
      executionId: expect.stringMatching(new RegExp(`^review:${REPO_ID}:${pull.head}:\\d+$`)),
      payload: {
        repoId: REPO_ID,
        sha: pull.head,
        prNumber: pull.number,
        baseSha: pull.base,
        attemptId: h.starts[0]!.executionId,
        branch: "feature",
        ownerId: maya.subject.id,
      },
    }])
    // The head's one review run, claimed for her: the Checks tab shows it Running at once.
    expect(await reviewRun()).toEqual([{ flow: "checks/review", status: "working", sha: pull.head, launchedBy: maya.subject.id }])
    // Asking again while it runs, from the slash command (no head named), starts nothing.
    const again = await h.fetch(reviewRoute("acme", "widgets", pull.number), post({}))
    expect([again.status, await again.json()]).toEqual([202, { sha: pull.head, started: false }])
    expect(h.starts).toHaveLength(1)
    expect([h.count(requests, { outcome: "started" }), h.count(requests, { outcome: "existing" })]).toEqual([1, 1])

    // The review runs on the Node host: her reviewer, one comment review as the App on the head, its status.
    const { ran, owners } = await review(github, h.starts[0]!, "- A.md: no test covers it.")
    expect(ran.exit).toEqual(Exit.succeed({ statuses: [{ name: "review", state: "success", outcome: "sent" }] }))
    expect(owners).toEqual([maya.subject.id])
    const reviews = github.pulls.get(pull.number)!.reviews
    expect(reviews.map((posted) => [posted.event, posted.login, posted.commitId])).toEqual([["COMMENT", BOT_LOGIN, pull.head]])
    expect(reviews[0]!.body).toContain("- A.md: no test covers it.")
    expect(reviews[0]!.body).toContain("Reviewed by Smithers for @maya (review).")
    expect(github.shownStatuses(pull.head)).toEqual({ "smithers/review": "success" })
    expect(await reviewRun()).toEqual([{ flow: "checks/review", status: "done", sha: pull.head, launchedBy: maya.subject.id }])
    // Passed: asking again starts nothing.
    expect(await (await h.fetch(reviewRoute("acme", "widgets", pull.number), post({}))).json()).toEqual({ sha: pull.head, started: false })
    expect(h.starts).toHaveLength(1)

    // Each request is a span and a log line with ids and outcomes, never the title or the diff.
    const lines = h.line("pull.review.request")
    expect(lines.map((line) => [line.annotations.outcome, line.annotations.status])).toEqual([
      ["started", 202],
      ["existing", 202],
      ["existing", 202],
    ])
    expect(lines[0]!.annotations).toMatchObject({ repoId: REPO_ID, number: pull.number, sha: pull.head })
    expect(JSON.stringify(lines)).not.toContain("Add A")
    expect(h.spans.filter((span) => span.name === "pull.review.request")).toHaveLength(3)
  })

  test("a review that failed is asked for again: a new run of it, the next Maintainer's", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    github.roles.set("ben", "admin")
    const pull = await opened(github)
    const maya = await person("maya")
    const h = await githubHarness(runtime, { own: OWN, github, actor: maya })
    expect((await h.fetch(reviewRoute("acme", "widgets", pull.number), post({}))).status).toBe(202)
    // The judge answered nothing: the review failed, and posted nothing.
    const failed = await review(github, h.starts[0]!, "   ")
    expect(failed.ran.exit).toEqual(Exit.succeed({ statuses: [{ name: "review", state: "failure", outcome: "sent" }] }))
    expect(await reviewRun()).toEqual([{ flow: "checks/review", status: "failed", sha: pull.head, launchedBy: maya.subject.id }])

    const ben = await person("ben")
    const second = await githubHarness(runtime, { own: OWN, github, actor: ben })
    const asked = await second.fetch(reviewRoute("acme", "widgets", pull.number), post({ headSha: pull.head }))
    expect(await asked.json()).toEqual({ sha: pull.head, started: true })
    expect(second.starts[0]!.executionId).not.toBe(h.starts[0]!.executionId)
    expect(second.starts[0]!.payload).toMatchObject({ ownerId: ben.subject.id })
    expect(await reviewRun()).toEqual([{ flow: "checks/review", status: "working", sha: pull.head, launchedBy: ben.subject.id }])
    const passed = await review(github, second.starts[0]!, "No findings.")
    expect(passed.owners).toEqual([ben.subject.id])
    expect(await reviewRun()).toEqual([{ flow: "checks/review", status: "done", sha: pull.head, launchedBy: ben.subject.id }])
    expect(github.pulls.get(pull.number)!.reviews.map((posted) => posted.body)).toEqual([
      expect.stringContaining("Reviewed by Smithers for @ben (review)."),
    ])
    expect(github.shownStatuses(pull.head)).toEqual({ "smithers/review": "success" })
  })

  test("two presses at once start one review: the second waits on the first's claim and answers the same review", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    const maya = await person("maya")
    // The first press's start holds its transaction open until the second press waits on its claim.
    const started: Array<string> = []
    let entered = false
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const starter = FlowStarter.of({
      start: (_, start) =>
        Effect.sync(() => void (entered = true)).pipe(
          Effect.andThen(Effect.promise(() => held)),
          Effect.andThen(Effect.sync(() => void started.push(start.executionId))),
        ),
    })
    const h = await githubHarness(runtime, { own: OWN, github, actor: maya, starter })
    const route = reviewRoute("acme", "widgets", pull.number)
    const first = h.fetch(route, post({}))
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000, interval: 20 })
    const second = h.fetch(route, post({}))
    await vi.waitFor(async () =>
      expect(await sql(runtime, `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO runs%' AND query LIKE '%launched_by = EXCLUDED.launched_by%'`))
        .toHaveLength(1), { timeout: 10_000, interval: 20 })
    release()
    const answers = await Promise.all([first, second].map(async (response) => (await response).json()))
    expect(answers).toEqual([{ sha: pull.head, started: true }, { sha: pull.head, started: false }])
    expect(h.count(requests, { outcome: "existing" })).toBe(1)
    expect(started).toHaveLength(1)
  })

  test("the execution id names the repository, the head and the claim", () => {
    expect(reviewExecutionId("github/o/n", "s", 7)).toBe("review:github/o/n:s:7")
  })
})

describe("what the route refuses", { timeout: 60_000 }, () => {
  test.each([
    ["signed out", { actor: null }, (): void => {}, 401, "authentication"],
    ["no GitHub App, so no repository but its own", { app: null }, (): void => {}, 404, "not_found"],
    ["left out of GITHUB_ALLOWED_REPOSITORIES", { allowed: new Set(["github/acme/other"]) }, (): void => {}, 404, "not_found"],
    ["the App not installed there", {}, (github: ScriptedGitHub): void => void (github.installed = false), 404, "app_not_installed"],
    ["a Member there", {}, (github: ScriptedGitHub): void => void github.roles.set("maya", "write"), 403, "forbidden"],
    ["no role there", {}, (github: ScriptedGitHub): void => void github.roles.delete("maya"), 403, "forbidden"],
    [
      "GitHub down",
      {},
      (github: ScriptedGitHub): void => void github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 }),
      503,
      "github_unavailable",
    ],
  ] as const)("%s: %i %s, nothing started", async (_, options, fault, status, code) => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    fault(github)
    const actor = "actor" in options ? options.actor : await person("maya")
    const h = await githubHarness(runtime, { own: OWN, github, ...options, actor })
    const response = await h.fetch(reviewRoute("acme", "widgets", pull.number), post({}))
    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(h.starts).toEqual([])
    expect(await reviewRun()).toEqual([])
    expect(h.count(requests, { outcome: code })).toBe(1)
  })

  test("GitHub's rate limit: 429 rate_limited with GitHub's wait, nothing started", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "30" } })
    const h = await githubHarness(runtime, { own: OWN, github, actor: await person("maya") })
    const response = await h.fetch(reviewRoute("acme", "widgets", pull.number), post({}))
    expect([response.status, response.headers.get("retry-after"), await response.json()]).toEqual([429, "30", { code: "rate_limited" }])
    expect(h.starts).toEqual([])
  })

  test("a path that names no repository: 404, before GitHub is asked", async () => {
    const h = await githubHarness(runtime, { actor: { ...member(), role: "maintainer" } })
    const response = await h.fetch("/api/repos/-bad-/widgets/pulls/1/review", post({}))
    expect([response.status, await response.json()]).toEqual([404, { code: "not_found" }])
    expect(h.github.calls).toEqual([])
  })

  test("on the deployment's own repository without the App, a Maintainer is told it isn't configured", async () => {
    const h = await githubHarness(runtime, { app: null, actor: { ...member(), role: "maintainer" } })
    const response = await h.fetch(reviewRoute(REPOSITORY.owner, REPOSITORY.name, 1), post({}))
    expect([response.status, await response.json()]).toEqual([503, { code: "not_configured" }])
    expect(h.starts).toEqual([])
  })

  test("on the deployment's own repository, a person with no role there is refused before the App is asked", async () => {
    const h = await githubHarness(runtime, { actor: { ...member(), role: null } })
    const response = await h.fetch(reviewRoute("acme", "widgets", 1), post({}))
    expect([response.status, await response.json()]).toEqual([403, { code: "forbidden" }])
    expect(h.github.calls).toEqual([])
  })

  test("a pull request Smithers hasn't read, a closed or merged one, a newer head, a head whose checks run: nothing started", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    const h = await githubHarness(runtime, { own: OWN, github, actor: await person("maya") })
    const ask = async (number: number, body: unknown = {}) => {
      const response = await h.fetch(reviewRoute("acme", "widgets", number), post(body))
      return [response.status, await response.json()]
    }
    expect(await ask(pull.number + 1)).toEqual([404, { code: "not_found" }])
    // The page showed a head the pull request has moved on from.
    expect(await ask(pull.number, { headSha: "f".repeat(40) })).toEqual([409, { code: "head_moved" }])
    // Another check of the head runs: `checks/Run` reviews the head after its scripts.
    await sql(runtime, `INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
      VALUES (gen_random_uuid(), 'checks/lint', 'working', 'p', '${REPO_ID}', '${pull.head}')`)
    expect(await ask(pull.number)).toEqual([409, { code: "checks_running" }])
    await sql(runtime, `UPDATE runs SET status = 'done'`)
    await sql(runtime, `UPDATE pulls SET merged = true`)
    expect(await ask(pull.number)).toEqual([409, { code: "closed" }])
    await sql(runtime, `UPDATE pulls SET merged = false`)
    await sql(runtime, `UPDATE items SET state = 'closed'`)
    expect(await ask(pull.number)).toEqual([409, { code: "closed" }])
    expect(h.starts).toEqual([])
    expect(await sql(runtime, `SELECT flow FROM runs`)).toEqual([{ flow: "checks/lint" }])
  })

  test("a body that isn't one, or too large; another method", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    const h = await githubHarness(runtime, { own: OWN, github, actor: await person("maya") })
    const route = reviewRoute("acme", "widgets", pull.number)
    for (const body of [{ headSha: "HEAD" }, "not json", JSON.stringify({ headSha: "a".repeat(40), pad: "x".repeat(2000) })]) {
      const response = await h.fetch(route, post(body))
      expect([response.status, await response.json()]).toEqual([400, { code: "invalid" }])
    }
    expect((await h.fetch(route, { method: "GET" })).headers.get("allow")).toBe("POST")
    // An empty body asks for the current head.
    expect((await h.fetch(route, post(""))).status).toBe(202)
    expect(h.starts).toHaveLength(1)
  })

  test("a start the host couldn't record rolls the claim back: 503, and the next press starts it", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const pull = await opened(github)
    const maya = await person("maya")
    const failing = FlowStarter.of({ start: () => Effect.fail(new StartUnavailable({ errorCode: "do_unavailable" })) })
    const down = await githubHarness(runtime, { own: OWN, github, actor: maya, starter: failing })
    const response = await down.fetch(reviewRoute("acme", "widgets", pull.number), post({}))
    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(down.line("pull.review.request")[0]!.annotations).toMatchObject({ outcome: "unavailable", status: 503 })
    expect(await reviewRun()).toEqual([])
    const up = await githubHarness(runtime, { own: OWN, github, actor: maya })
    expect(await (await up.fetch(reviewRoute("acme", "widgets", pull.number), post({}))).json()).toEqual({
      sha: pull.head,
      started: true,
    })
  })

  test("sign-in or Postgres not answering: 503 unavailable", async () => {
    const sessions = await githubHarness(runtime, {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })),
    })
    expect((await sessions.fetch(reviewRoute("acme", "widgets", 1), post({}))).status).toBe(503)
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const offline = await githubHarness(runtime, { database: unreachable, actor: { ...member(), role: "maintainer" } })
    const response = await offline.fetch(reviewRoute("acme", "widgets", 1), post({}))
    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(offline.line("pull.review.request")[0]!.annotations).toMatchObject({ outcome: "unavailable", errorCode: expect.any(String) })
  })
})

describe("the route's path", () => {
  test("names a repository and a pull request number, and nothing else", () => {
    expect(parseReviewPath("/api/repos/o%20w/n/pulls/12/review")).toEqual({ owner: "o w", name: "n", number: 12 })
    for (const path of [
      "/api/repos/o/n/pulls/0/review",
      "/api/repos/o/n/pulls/01/review",
      "/api/repos/o/n/pulls/x/review",
      "/api/repos/o/n/pulls/9999999999/review",
      "/api/repos/o/n/pulls/1/merge",
      "/api/repos/o/n/issues/1/review",
      "/api/repos/o/n/pulls/1",
      "/api/repos/%E0%A4%A/n/pulls/1/review",
      "/api/other/o/n/pulls/1/review",
    ]) expect([path, parseReviewPath(path)]).toEqual([path, undefined])
    expect(handles("/api/repos/o/n/pulls/1/review")).toBe(true)
  })
})
