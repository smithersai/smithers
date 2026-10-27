import { role as readRepositoryRole } from "../repo/actions"
// Pull requests on the tab (decision 0012 §6, docs/features/pulls.md#the-browser), driven as React drives them: the
// pulls layer's plain actions and its live queries, with no React. Each device runs the browser's own layer (`appLayer`)
// on a Node device (src/test/chatApi.ts), against ChatApi's real handler and its git routes (worker/github/Api.ts) over
// the compose Postgres and Electric. No remote host runs here: a test writes what GitHub's flows would (the projection,
// a merge's settlement) through the server's own store (worker/github/Store.ts, worker/github/Pulls.ts). The compare
// route reads the scripted GitHub as the App. Unhappy paths give the tab a faulty `PullsClient`, the real one behind
// switches (test.faults-by-injection).
import { ShapeSource } from "@smthrs/effect-electric"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { GitHub } from "@smthrs/integrations"
import { Context, Deferred, Effect, Exit, Layer, type ManagedRuntime, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import * as PullStore from "../../../worker/github/Pulls.ts"
import * as Store from "../../../worker/github/Store.ts"
import { CHATAPI_ORIGIN, openTab, openTestApp, type TabOptions, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { read } from "../../test/otlp"
import { itemId } from "../issues/contract"
import { ISSUES_STREAM } from "../issues/contract"
import { Issues } from "../issues/issues"
import { pageOf } from "../issues/view"
import { shapeRetries } from "../issues/shapeSync"
import { repoId } from "../repo/contract"
import { mergePresses } from "./actions"
import { PullsClient, PullsRequestFailed } from "./api"
import { mergeExecutionId, PULLS_SHAPE_ROUTE } from "./contract"
import { persistenceFailingOnce } from "../../test/faults"
import { startedOnRead } from "../../test/liveQueries"
import { Pulls } from "./pulls"
import { pullShapeTransitions } from "./shapeSync"
import { PullsStore } from "./store"
import { listPageOf, pullAccessOf } from "./view"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long Electric may take to deliver a row on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: a fresh device and its first syncs, on a loaded machine. */
const WITHIN = 90_000

const [OWNER, NAME] = TEST_REPOSITORY.split("/") as [string, string]
const REPO_ID = repoId(OWNER, NAME)
const SHA_BASE = "b".repeat(40)
const SHA_HEAD = "a".repeat(40)
const SHA_OLD = "c".repeat(40)

const person = (role: "maintainer" | "member"): Actor => ({
  subject: { kind: "person", id: `person-${role}` },
  role,
  login: role,
  session: crypto.randomUUID(),
})

/** A Maintainer, who may merge (decision 0007 `repo:merge`). */
const sam = person("maintainer")

/** A faulty `PullsClient`: the real one, behind switches. */
const faultyClient = () => {
  const state = { merge: [] as Array<number | "network">, compare: [] as Array<number | "network"> }
  const fail = (fault: number | "network") =>
    Effect.fail(fault === "network" ? new PullsRequestFailed({}) : new PullsRequestFailed({ status: fault }))
  const layer = Layer.effect(
    PullsClient,
    Effect.map(PullsClient, (real) =>
      PullsClient.of({
        merge: (owner, name, merge) =>
          Effect.suspend(() => {
            const next = state.merge.shift()
            return next === undefined ? real.merge(owner, name, merge) : fail(next)
          }),
        compare: (owner, name, base, head) =>
          Effect.suspend(() => {
            const next = state.compare.shift()
            return next === undefined ? real.compare(owner, name, base, head) : fail(next)
          }),
      })),
  ).pipe(Layer.provide(PullsClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
  return { layer, state }
}

type App = ManagedRuntime.ManagedRuntime<Pulls | Issues | TestChatApi, unknown>

/** A feature's facade with its queries started as React starts them, on read. */
const started = <F extends { readonly queries: object }>(facade: F): F => ({ ...facade, queries: startedOnRead(facade.queries) })

/** The app on a fresh ChatApi as `actor` (Sam, a Maintainer, unless set), with the pulls queries started as React does. */
const open = async (options: TabOptions = {}, actor: Actor | null = sam) => {
  const runtime: App = openTestApp(options, { actor })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  const pulls = started(await runtime.runPromise(Effect.service(Pulls)))
  const issues = started(await runtime.runPromise(Effect.service(Issues)))
  return {
    api,
    actions: pulls.actions,
    queries: pulls.queries,
    issues,
    view: () => pulls.queries.view.toArray[0],
    pull: () => pulls.queries.pull.toArray[0],
    count: (attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(mergePresses, attributes))).count,
  }
}

const at = (second: number) => `2026-10-20T10:00:${String(second).padStart(2, "0")}Z`

/** GitHub's issue for pull request `number`, as the server's flows read it. */
const issueOf = (number: number, title: string, state: "open" | "closed" = "open"): GitHub.Issues.Issue => ({
  id: 9_000 + number,
  node_id: `I_${number}`,
  number,
  title,
  body: "Body",
  state,
  state_reason: null,
  user: { id: 1, login: "smithers[bot]" },
  comments: 0,
  created_at: at(0),
  updated_at: at(number),
  closed_at: null,
  labels: [],
  pull_request: {},
})

/** GitHub's pull request `number`, from `head` into `base` (`main`), its repository's default branch `main`. */
const pullOf = (
  number: number,
  options: { readonly base?: string; readonly head?: string; readonly draft?: boolean } = {},
): GitHub.Pulls.PullRequest => {
  const { base = SHA_BASE, head = SHA_HEAD, draft = false } = options
  return {
    id: 7_000 + number,
    node_id: `PR_${number}`,
    number,
    title: `T${number}`,
    body: "Body",
    state: "open",
    draft,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    merged_by: null,
    mergeable_state: "clean",
    user: { id: 1, login: "smithers[bot]" },
    head: { ref: `smithers/t${number}`, sha: head },
    base: { ref: "main", sha: base, repo: { default_branch: "main" } },
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    created_at: at(0),
    updated_at: at(number),
    closed_at: null,
  }
}

/** What GitHub's flows write on the server, through its own store. */
const server = (api: TestChatApi["Service"]) => {
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(api.github.run(effect))
  return {
    /** Pull request `pull` as `github/Apply` projects it: its `items` row (with title), and its `pulls` row. */
    pull: (pull: GitHub.Pulls.PullRequest, title = pull.title, state: "open" | "closed" = "open") =>
      run(
        Effect.andThen(
          Store.upsertIssue(REPO_ID, issueOf(pull.number, title, state), Date.now()),
          PullStore.upsertPull(REPO_ID, pull, pull.base.sha, Date.now()),
        ),
      ),
    /** A plain issue: never on the pull request list. */
    issue: (number: number, title: string) => {
      const { pull_request: _pull, ...issue } = issueOf(number, title)
      return run(Store.upsertIssue(REPO_ID, issue, Date.now()))
    },
    commits: (number: number, shas: ReadonlyArray<string>) =>
      run(PullStore.replaceCommits(
        REPO_ID,
        number,
        shas.map((sha, index) => ({
          sha,
          commit: { message: `Commit ${index + 1}\n\nMore.`, author: { name: "Smithers", date: at(index) } },
          author: index === 0 ? { id: 1, login: "smithers[bot]" } : null,
        })),
      )),
    review: (number: number, id: number, state: string, body: string, submittedAt: string | null) =>
      run(PullStore.upsertReview(
        REPO_ID,
        number,
        { id, node_id: `R_${id}`, user: { id: 2, login: "ben" }, body, state, commit_id: SHA_HEAD, submitted_at: submittedAt },
        Date.now(),
      )),
    comment: (number: number, id: number, body: string) =>
      run(Store.upsertComment(
        REPO_ID,
        number,
        {
          id,
          node_id: `IC_${id}`,
          body,
          user: { id: 3, login: "maya" },
          created_at: at(30 + id % 10),
          updated_at: at(30 + id % 10),
          issue_url: `https://api.github.com/repos/${TEST_REPOSITORY}/issues/${number}`,
        },
        Date.now(),
      )),
    /** A check run on `sha`: a `runs` row with the commit, as `checks/Run` records it. */
    check: (flow: string, sha: string, status: string) =>
      run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
          VALUES (${crypto.randomUUID()}::uuid, ${flow}, ${status}, 'person-maya', ${REPO_ID}, ${sha})`)),
    settle: (writeId: string, settlement: Store.Settlement) => run(Store.settleWrite(writeId, settlement)),
  }
}

describe("the list and a pull request's page", () => {
  test("a cold list with a sync receipt shows unknown counts until its items arrive, never a spinner", async () => {
    const release = Deferred.makeUnsafe<void>()
    const source = ShapeSource.ShapeSource.of({ request: (url, init) =>
      new URL(url).pathname === "/api/shapes/item-summaries"
        ? Effect.andThen(Deferred.await(release), ShapeSource.fetchSource.request(url, init))
        : ShapeSource.fetchSource.request(url, init),
    })
    const tab = await open({ replace: Layer.succeed(ShapeSource.ShapeSource, source) })
    await server(tab.api).pull(pullOf(2), "Cold pull")
    await Effect.runPromise(tab.api.github.run(Store.finishSync(REPO_ID, ISSUES_STREAM, { complete: true, failure: null })))
    await tab.actions.open(OWNER, NAME)
    const page = () => listPageOf(tab.queries.list.toArray, { owner: OWNER, name: NAME },
      tab.issues.queries.synced.toArray[0], tab.issues.queries.access.toArray[0], tab.queries.list.isReady())
    await until(() => expect(tab.issues.queries.synced.toArray[0]).toMatchObject({ syncedAt: expect.any(String) }))
    expect(tab.queries.list.isReady()).toBe(false)
    expect(page()).toMatchObject({ pulls: [], loading: false, unknown: true })
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await until(() => expect(page().pulls.map((row) => row.number)).toEqual([2]))
    expect(page()).toMatchObject({ loading: false, unknown: false })
  }, WITHIN)

  test.each([[401, "unavailable", "shown"], [403, "unavailable", "shown"]] as const)(
    "a %s pull refusal survives a failed reconnect and recovers only with an installed batch",
    async (status, refusal, page) => {
      let fault: number | undefined = status
      const source = ShapeSource.ShapeSource.of({ request: (url, init) =>
        new URL(url).pathname === PULLS_SHAPE_ROUTE && fault !== undefined
          ? Effect.succeed(new Response(null, { status: fault }))
          : ShapeSource.fetchSource.request(url, init),
      })
      const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, { actor: sam })
      runtimes.push(runtime)
      const api = await runtime.runPromise(Effect.service(TestChatApi))
      const pulls = started(await runtime.runPromise(Effect.service(Pulls)))
      const issues = started(await runtime.runPromise(Effect.service(Issues)))
      await server(api).pull(pullOf(2), "Recovered pull")
      await pulls.actions.open(OWNER, NAME, 2)
      const view = () => pulls.queries.view.toArray[0]
      const currentPage = () => pageOf(pulls.queries.pull.toArray[0], issues.queries.synced.toArray[0],
        pulls.queries.pull.isReady() && view()?.installed === true, issues.queries.synced.isReady(),
        pullAccessOf(issues.queries.access.toArray[0], view()))
      await until(() => expect(view()).toMatchObject({ pullStatus: refusal, installed: false }))
      await until(() => expect(issues.queries.access.toArray[0]).toMatchObject({ status: "allowed", installed: true }))
      expect(currentPage()).toBe(page)
      fault = 503
      pulls.actions.retry()
      await until(() => expect(runtime.runSync(Metric.value(
        Metric.withAttributes(pullShapeTransitions, { phase: "failed" }),
      )).count).toBeGreaterThan(0))
      expect(view()).toMatchObject({ pullStatus: refusal, installed: false })
      expect(currentPage()).toBe(page)
      fault = undefined
      pulls.actions.retry()
      await until(() => expect(view()).toMatchObject({ pullStatus: "allowed", installed: true }))
      await until(() => expect(pulls.queries.pull.toArray[0]).toMatchObject({ number: 2, title: "Recovered pull" }))
      expect(currentPage()).toBe("shown")
    }, WITHIN,
  )

  test("a stopped pull shape settles a direct page and Try again installs its recovered batch", async () => {
    let refused = true
    let pullRequests = 0
    const source = ShapeSource.ShapeSource.of({ request: (url, init) => {
      if (new URL(url).pathname === PULLS_SHAPE_ROUTE) {
        pullRequests++
        if (refused) return Effect.succeed(new Response(null, { status: 400 }))
      }
      return ShapeSource.fetchSource.request(url, init)
    } })
    const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, { actor: sam })
    runtimes.push(runtime)
    const pulls = started(await runtime.runPromise(Effect.service(Pulls)))
    const issues = started(await runtime.runPromise(Effect.service(Issues)))
    await pulls.actions.open(OWNER, NAME, 404)
    await until(() => expect(pulls.queries.view.toArray[0]).toMatchObject({ pullStatus: "unavailable", installed: false }), 5_000)
    await until(() => expect(issues.queries.access.toArray[0]).toMatchObject({ status: "allowed", installed: true }))
    const access = pullAccessOf(issues.queries.access.toArray[0], pulls.queries.view.toArray[0])
    expect(pageOf(pulls.queries.pull.toArray[0], issues.queries.synced.toArray[0],
      pulls.queries.pull.isReady() && pulls.queries.view.toArray[0]?.installed === true,
      issues.queries.synced.isReady(), access)).toBe("unknown")
    expect(runtime.runSync(Metric.value(Metric.withAttributes(pullShapeTransitions, { phase: "stopped" }))).count).toBeGreaterThan(0)
    const beforeRetry = pullRequests
    refused = false
    pulls.actions.retry()
    await until(() => expect(pullRequests).toBeGreaterThan(beforeRetry))
    await until(() => expect(pulls.queries.view.toArray[0]).toMatchObject({ pullStatus: "allowed", installed: true }))
    expect(pageOf(pulls.queries.pull.toArray[0], issues.queries.synced.toArray[0],
      pulls.queries.pull.isReady() && pulls.queries.view.toArray[0]?.installed === true,
      issues.queries.synced.isReady(), pullAccessOf(issues.queries.access.toArray[0], pulls.queries.view.toArray[0]))).toBe("unknown")
    expect(runtime.runSync(Metric.value(Metric.withAttributes(shapeRetries, { item: "pull" }))).count).toBe(1)
  }, WITHIN)

  test("an absent direct pull settles after both current shape batches are installed", async () => {
    const tab = await open()
    tab.issues.queries.access.startSyncImmediate()
    tab.issues.queries.synced.startSyncImmediate()
    await tab.actions.open(OWNER, NAME, 404)
    await until(() => expect(tab.view()).toMatchObject({ installed: true }))
    await until(() => expect(tab.issues.queries.access.toArray[0]).toMatchObject({ status: "allowed", installed: true }))
    await until(() => expect(tab.queries.pull.isReady()).toBe(true))
    await until(() => expect(tab.issues.queries.synced.isReady()).toBe(true))
    expect(pageOf(tab.pull(), tab.issues.queries.synced.toArray[0], tab.queries.pull.isReady() && tab.view()?.installed === true,
      tab.issues.queries.synced.isReady(), pullAccessOf(tab.issues.queries.access.toArray[0], tab.view()))).toBe("unknown")
  }, WITHIN)

  test("a fresh signed-out device hydrates a chunked issue snapshot without losing its pulls", async () => {
    const source = await open({}, null)
    expect(source.queries.list.toArray).toEqual([])
    await Effect.runPromise(source.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
      yield* Store.recordRepository(REPO_ID, { githubId: 1, private: false })
      // Production-size counts, with a multi-chunk items snapshot. The pull
      // metadata and sync receipt can finish before the shared items shape.
      yield* sql`INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at, source_updated_at, fetched_at)
        SELECT ${REPO_ID} || '/' || n, ${REPO_ID}, n, CASE WHEN n > 3840 THEN 'pull' ELSE 'issue' END,
          n, 'Item ' || n, repeat('x', 2000), 'open', now(), now(), now(), now() FROM generate_series(1, 3845) n`
      yield* sql`INSERT INTO comments (id, repo_id, item_id, github_id, body, created_at, updated_at, source_updated_at, fetched_at)
        SELECT 'comment-' || n, ${REPO_ID}, ${REPO_ID} || '/3845', n, repeat('c', 1000), now(), now(), now(), now()
        FROM generate_series(1, 8061) n`
      yield* Store.finishSync(REPO_ID, ISSUES_STREAM, { complete: true, failure: null })
    })))))
    let itemChunks = 0
    let initialBytes = 0
    let rows = 0
    let bodies = 0
    let commentRequests = 0
    let itemsComplete = false
    const fresh = openTab({ ...source.api, fetch: async (input, init) => {
      const response = await source.api.fetch(input, init)
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/api/shapes/comments") commentRequests++
      if (url.pathname === "/api/shapes/item-summaries" && url.searchParams.get("live") !== "true") {
        const bytes = await response.clone().arrayBuffer()
        initialBytes += bytes.byteLength
        const messages = JSON.parse(new TextDecoder().decode(bytes)) as Array<{ headers: { control?: string }; value?: Record<string, unknown> }>
        rows += messages.filter((message) => message.value !== undefined).length
        bodies += messages.filter((message) => message.value !== undefined && "body" in message.value).length
        itemChunks++
        itemsComplete ||= messages.some((message) => message.headers.control === "up-to-date")
      }
      return response
    } }, { answers: false })
    runtimes.push(fresh)
    const pulls = started(await fresh.runPromise(Effect.service(Pulls)))
    await fresh.runPromise(readRepositoryRole(OWNER, NAME))
    await pulls.actions.open(OWNER, NAME)
    await until(() => expect(pulls.queries.list.toArray.map((row) => row.number)).toEqual([3845, 3844, 3843, 3842, 3841]))
    expect(itemChunks).toBeGreaterThan(1)
    expect(itemsComplete).toBe(true)
    expect(rows).toBe(3845)
    expect(bodies).toBe(0)
    expect(commentRequests).toBe(0)
    expect(initialBytes).toBeLessThan(3_000_000)
    console.info("shape.payload", { initialBytes, rows, bodies, commentRequests })
    expect(pulls.queries.list.isReady()).toBe(true)
    const page = listPageOf(pulls.queries.list.toArray, { owner: OWNER, name: NAME }, { syncedAt: "now" }, { status: "allowed" }, pulls.queries.list.isReady())
    expect(page.loading).toBe(false)
    expect(page.pulls.map((row) => row.href)).toEqual([3845, 3844, 3843, 3842, 3841].map((number) => `/${TEST_REPOSITORY}/pull/${number}`))
  }, WITHIN)

  test("a direct pull-list visit uses that repository's completed sync, including an empty list", async () => {
    const tab = await open()
    await Effect.runPromise(tab.api.github.run(Store.finishSync(REPO_ID, ISSUES_STREAM, { complete: true, failure: null })))
    await tab.actions.open(OWNER, NAME)
    tab.issues.queries.synced.startSyncImmediate()
    await until(() => expect(tab.issues.queries.synced.toArray[0]).toMatchObject({ syncedAt: expect.any(String) }))
    await until(() => expect(tab.queries.list.isReady()).toBe(true))
    expect(listPageOf(tab.queries.list.toArray, { owner: OWNER, name: NAME },
      tab.issues.queries.synced.toArray[0], undefined, tab.queries.list.isReady()))
      .toMatchObject({ loading: false, unknown: false, pulls: [] })
    await tab.actions.open("other", "repository")
    await until(() => expect(tab.issues.queries.synced.toArray).toEqual([]))
    await until(() => expect(tab.queries.list.toArray).toEqual([]))
    expect(listPageOf(tab.queries.list.toArray, { owner: "other", name: "repository" },
      tab.issues.queries.synced.toArray[0], { status: "allowed" }, tab.queries.list.isReady()))
      .toMatchObject({ loading: false, unknown: true, pulls: [] })
  }, WITHIN)

  test("the repository's pull requests newest first, never its issues; each with its head, draft and merge", async () => {
    const tab = await open()
    const github = server(tab.api)
    await github.issue(1, "An issue")
    await github.pull(pullOf(2), "T2: Add a line")
    await github.pull(pullOf(3, { draft: true }), "T3: Draft it")
    // GitHub's issue row arrived before its pull request's: the list shows it, without what only a pull has yet.
    await github.issue(4, "Not read yet")
    await Effect.runPromise(tab.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE items SET kind = 'pull' WHERE id = ${itemId(REPO_ID, 4)}`)))
    await tab.actions.warm(OWNER, NAME)
    await tab.actions.open(OWNER, NAME)
    await until(() =>
      expect(tab.queries.list.toArray.map(({ number, title, draft, merged, headRef }) => ({ number, title, draft, merged, headRef })))
        .toEqual([
          { number: 4, title: "Not read yet", draft: false, merged: false, headRef: "" },
          { number: 3, title: "T3: Draft it", draft: true, merged: false, headRef: "smithers/t3" },
          { number: 2, title: "T2: Add a line", draft: false, merged: false, headRef: "smithers/t2" },
        ])
    )
    expect(tab.view()).toMatchObject({ owner: OWNER, name: NAME, repoId: REPO_ID, number: null, tab: "conversation" })
    expect(tab.pull()).toBeUndefined()
  }, WITHIN)

  test("one pull request: its base, head and default branch, its conversation and reviews, its commits, and the checks on its head only", async () => {
    const tab = await open()
    const github = server(tab.api)
    await github.pull(pullOf(2), "T2: Add a line")
    await github.comment(2, 501, "Looks right.")
    await github.review(2, 601, "COMMENTED", "- A finding", at(20))
    await github.review(2, 602, "APPROVED", "", null)
    await github.commits(2, [SHA_OLD, SHA_HEAD])
    await github.check("checks/readme", SHA_HEAD, "done")
    await github.check("checks/review", SHA_HEAD, "working")
    await github.check("checks/readme", SHA_OLD, "failed")
    await tab.actions.open(OWNER, NAME, 2)
    await until(() =>
      expect(tab.pull()).toMatchObject({
        number: 2,
        title: "T2: Add a line",
        body: "Body",
        state: "open",
        author: "smithers[bot]",
        synced: 2,
        headRef: "smithers/t2",
        headSha: SHA_HEAD,
        baseRef: "main",
        baseSha: SHA_BASE,
        defaultBranch: "main",
        draft: false,
        merged: false,
        mergeableState: "clean",
        changedFiles: 1,
        commitCount: 1,
      })
    )
    await until(() => expect(tab.queries.comments.toArray.map(({ author, body }) => ({ author, body }))).toEqual([
      { author: "maya", body: "Looks right." },
    ]))
    await until(() =>
      expect(tab.queries.reviews.toArray.map(({ author, state, body, submittedAt }) => ({ author, state, body, submittedAt })))
        .toEqual([
          { author: "ben", state: "COMMENTED", body: "- A finding", submittedAt: expect.stringContaining("2026-10-20") },
          { author: "ben", state: "APPROVED", body: "", submittedAt: "" },
        ])
    )
    await until(() =>
      expect(tab.queries.commits.toArray.map(({ sha, headline, author, position }) => ({ sha, headline, author, position })))
        .toEqual([
          { sha: SHA_OLD, headline: "Commit 1", author: "smithers[bot]", position: 1 },
          { sha: SHA_HEAD, headline: "Commit 2", author: "", position: 2 },
        ])
    )
    await until(() =>
      expect(tab.queries.checks.toArray.map(({ flow, status }) => ({ flow, status })).sort((a, b) => a.flow.localeCompare(b.flow)))
        .toEqual([{ flow: "checks/readme", status: "done" }, { flow: "checks/review", status: "working" }])
    )
    // Another tab of the same pull request reads the same; another pull request's page reads its own.
    await tab.actions.open(OWNER, NAME, 2, "checks")
    expect(tab.view()).toMatchObject({ number: 2, tab: "checks" })
    await tab.actions.open(OWNER, NAME, 9)
    await until(() => expect(tab.pull()).toBeUndefined())
  }, WITHIN)
})

describe("the Files tab", () => {
  test("reads the files the base and head differ by once, through the compare route, kept on the tab", async () => {
    const tab = await open()
    const scripted = tab.api.github.scripted
    const base = scripted.refs.get("main")!
    const head = scripted.push("smithers/t2", { "README.md": "# Widgets\n\nA line\n" })
    await server(tab.api).pull(pullOf(2, { base, head }))
    await tab.actions.open(OWNER, NAME, 2, "files")
    await until(() =>
      expect(tab.queries.files.toArray.map(({ id, status, files, truncated }) => ({ id, status, files, truncated }))).toEqual([{
        id: `${base}...${head}`,
        status: "ready",
        files: [expect.objectContaining({ filename: "README.md", status: "modified", patch: expect.stringContaining("+A line") })],
        truncated: false,
      }])
    )
    // A comparison of two SHAs never changes: no second read, and nothing for a ref that isn't a SHA.
    const asked = scripted.calls.length
    tab.actions.loadFiles(OWNER, NAME, base, head)
    tab.actions.loadFiles(OWNER, NAME, "main", head)
    tab.actions.loadFiles(OWNER, NAME, base, "smithers/t2")
    expect(scripted.calls.length).toBe(asked)
    expect(tab.queries.files.toArray).toHaveLength(1)
  }, WITHIN)

  test("a comparison that fails shows failed, and the next read asks again", async () => {
    const client = faultyClient()
    const tab = await open({ replace: client.layer })
    const scripted = tab.api.github.scripted
    const base = scripted.refs.get("main")!
    const head = scripted.push("smithers/t2", { "B.md": "b\n" })
    client.state.compare.push("network", 503)
    tab.actions.loadFiles(OWNER, NAME, base, head)
    await until(() => expect(tab.queries.files.toArray.map(({ status }) => status)).toEqual(["failed"]))
    tab.actions.loadFiles(OWNER, NAME, base, head)
    await until(() => expect(client.state.compare).toEqual([]))
    await until(() => expect(tab.queries.files.toArray.map(({ status }) => status)).toEqual(["failed"]))
    tab.actions.loadFiles(OWNER, NAME, base, head)
    await until(() =>
      expect(tab.queries.files.toArray.map(({ status, files }) => ({ status, names: files.map((file) => file.filename) })))
        .toEqual([{ status: "ready", names: ["B.md"] }])
    )
    // Each failed read was logged once, by its code, and by its status when ChatApi answered.
    for (const each of runtimes.splice(0).reverse()) await each.dispose()
    const lines = read(tab.api.telemetry).log("pulls.files.load")
    expect(lines).toEqual([
      expect.objectContaining({
        severity: "Warn",
        attributes: expect.objectContaining({ feature: "pulls", outcome: "failed", errorCode: "PullsRequestFailed" }),
      }),
      expect.objectContaining({
        severity: "Warn",
        attributes: expect.objectContaining({ feature: "pulls", outcome: "failed", status: 503, errorCode: "PullsRequestFailed" }),
      }),
    ])
    expect(lines[0]!.attributes).not.toHaveProperty("status")
  }, WITHIN)
})

describe("Merge", () => {
  test("a Maintainer's press sends pr/merge at the head and base shown, once at a time, and the page follows its write", async () => {
    const tab = await open()
    await server(tab.api).pull(pullOf(2))
    await tab.actions.open(OWNER, NAME, 2)
    await until(() => expect(tab.pull()?.headSha).toBe(SHA_HEAD))
    expect(tab.actions.merge(SHA_HEAD, SHA_BASE, 2)).toBe(true)
    // A second press while the first is on its way sends nothing.
    expect(tab.actions.merge(SHA_HEAD, SHA_BASE, 2)).toBe(false)
    const writeId = tab.view()!.mergeWriteId!
    await until(() => expect(tab.view()).toMatchObject({ merging: false, mergeStatus: "pending", mergeRefused: null }))
    expect(tab.api.github.starts).toContainEqual(expect.objectContaining({
      flow: "pr/Merge",
      executionId: mergeExecutionId(writeId),
    }))
    expect(tab.count({ outcome: "sent" })).toBe(1)
    // GitHub's head moved: the write settles refused, and the page says so.
    await server(tab.api).settle(writeId, { status: "refused", failure: "head_moved" })
    await until(() => expect(tab.view()).toMatchObject({ mergeStatus: "refused", mergeFailure: "head_moved" }))
    // Another tab of the same pull request keeps it; another pull request starts clean.
    await tab.actions.open(OWNER, NAME, 2, "commits")
    expect(tab.view()?.mergeWriteId).toBe(writeId)
    await tab.actions.open(OWNER, NAME, 3)
    expect(tab.view()).toMatchObject({ mergeWriteId: null, mergeRefused: null, merging: false })
  }, WITHIN)

  test("refused by the route: a Member is not allowed, a person signed out signs in, and an unreachable ChatApi couldn't", async () => {
    const member = await open({}, person("member"))
    await member.actions.open(OWNER, NAME, 2)
    member.actions.merge(SHA_HEAD, SHA_BASE, 2)
    await until(() => expect(member.view()).toMatchObject({ merging: false, mergeRefused: "forbidden" }))
    expect(member.count({ outcome: "403" })).toBe(1)

    const signedOut = await open({}, null)
    await signedOut.actions.open(OWNER, NAME, 2)
    signedOut.actions.merge(SHA_HEAD, SHA_BASE, 2)
    await until(() => expect(signedOut.view()).toMatchObject({ merging: false, mergeRefused: "sign_in" }))

    const client = faultyClient()
    const offline = await open({ replace: client.layer })
    client.state.merge.push("network")
    await offline.actions.open(OWNER, NAME, 2)
    offline.actions.merge(SHA_HEAD, SHA_BASE, 2)
    await until(() => expect(offline.view()).toMatchObject({ merging: false, mergeRefused: "unavailable" }))
    expect(offline.count({ outcome: "unreachable" })).toBe(1)
    // Pressed again, the refusal clears while the new press is on its way.
    offline.actions.merge(SHA_HEAD, SHA_BASE, 2)
    expect(offline.view()).toMatchObject({ merging: true, mergeRefused: null })
    // Each refusal is logged once, by why and the status ChatApi answered.
    for (const each of runtimes.splice(0).reverse()) await each.dispose()
    const refusals = (tab: { readonly api: { readonly telemetry: Parameters<typeof read>[0] } }) =>
      read(tab.api.telemetry).log("pulls.merge").map(({ severity, attributes }) => ({ severity, ...attributes }))
    expect(refusals(member)).toEqual([expect.objectContaining({ severity: "Warn", feature: "pulls", outcome: "forbidden", status: 403 })])
    expect(refusals(signedOut)).toEqual([expect.objectContaining({ severity: "Warn", outcome: "sign_in", status: 401 })])
    expect(refusals(offline)[0]).toEqual(
      expect.objectContaining({ severity: "Warn", outcome: "unavailable", errorCode: "PullsRequestFailed" }),
    )
  }, WITHIN)
})

test("a repository whose pull requests failed to open opens again once persistence recovers", async () => {
  const runtime = openTestApp()
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    // A device whose persistence metadata becomes temporarily unreadable, then recovers.
    const faulty = persistenceFailingOnce(yield* Persistence.Persistence)
    const built = yield* Layer.build(PullsStore.layer({ origin: api.origin }).pipe(
      Layer.provide(Layer.succeed(Persistence.Persistence, faulty.service)),
    ))
    const store = Context.get(built, PullsStore)
    faulty.failNext()
    expect(Exit.isFailure(yield* Effect.exit(store.forRepo(REPO_ID, 1)))).toBe(true)
    // The failure isn't kept: the next open opens, once.
    const reopened = yield* store.forRepo(REPO_ID)
    expect(yield* store.forRepo(REPO_ID)).toBe(reopened)
      const detail = yield* store.forRepo(REPO_ID, 1)
      expect(yield* store.forRepo(REPO_ID, 1)).toBe(detail)
      expect(detail).not.toBe(reopened)
  })))
}, WITHIN)

test("another repository's pull requests answering never move the routed page's access", async () => {
  // Another repository's pulls shape refuses; the routed one's answers.
  const source = ShapeSource.ShapeSource.of({
    request: (url, init) => {
      const asked = new URL(url)
      return asked.pathname === PULLS_SHAPE_ROUTE && asked.searchParams.get("repo") === "someone/else"
        ? Effect.succeed(new Response(null, { status: 403 }))
        : ShapeSource.fetchSource.request(url, init)
    },
  })
  const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, source) }, { actor: sam })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = Context.get(yield* Layer.build(PullsStore.layer({ origin: api.origin }).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, api.fetch)),
    )), PullsStore)
    const pullStatus = () => store.view.tanstack.toArray[0]?.pullStatus
    yield* store.forRepo(REPO_ID)
    yield* store.route(REPO_ID)
    yield* Effect.promise(() => until(() => expect(pullStatus()).toBe("allowed")))
    // Another repository's pull requests, opened without routing them (a link's warm), are refused.
    const other = yield* store.forRepo(repoId("someone", "else"))
    yield* Effect.promise(() =>
      until(async () => expect(await Effect.runPromise(other.status)).toMatchObject({ pullStatus: "forbidden" }))
    )
    expect(pullStatus()).toBe("allowed")
  })))
}, WITHIN)
