// `GET /api/repos/<owner>/<name>/issues` (worker/github/IssueList.ts, docs/features/issues.md#routes): a repository's
// issues one page at a time, through the real handler over this file's schema of the compose Postgres.
import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { getSearch } from "../../src/features/issues/api.vibe"
import { readIssue } from "../../src/features/issues/actions.vibe"
import { accessQuery } from "../../src/features/issues/queries.vibe"
import { ACCESS, Access, SEARCHED, Searched } from "../../src/features/issues/schema.vibe"
import { IssuesStore } from "../../src/features/issues/store.vibe"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { issuesRoute } from "../../src/features/issues/contract.ts"
import { testFile } from "../test/harness.ts"
import { handles } from "./Api.ts"
import { decodeCursor, encodeCursor, parseIssuesPath } from "./IssueList.ts"
import * as Metrics from "./Metrics.vibe"
import { scriptedGitHub } from "./test/scriptedGitHub.ts"
import { member, githubHarness } from "./test/harness.ts"
import { REPOSITORY, reset, sql } from "./test/fixtures.ts"

const runtime = testFile("github_issue_list")

beforeEach(() => reset(runtime))

/** `count` issues of the repository, #n updated n minutes after a fixed time; every fifth closed. */
const seed = async (count: number) => {
  const rows = Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const at = `timestamptz '2026-10-01T00:00:00Z' + interval '${n} minutes'`
    return `('${REPOSITORY.id}#${n}', '${REPOSITORY.id}', ${n}, 'issue', ${1000 + n}, 'Issue ${n}${n % 7 === 0 ? " flaky webkit" : ""}', 'Body', '${n % 5 === 0 ? "closed" : "open"}', 'maya', ${n % 3}, ${at}, ${at}, ${at}, now())`
  })
  await sql(
    runtime,
    `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, author_login, comments, created_at, updated_at,
      source_updated_at, fetched_at) VALUES ${rows.join(",")}`,
  )
  // Never listed: a pull request, a tombstoned issue, another repository's issue.
  await sql(
    runtime,
    `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at, source_updated_at, fetched_at, deleted_at)
    VALUES ('${REPOSITORY.id}#${count + 1}', '${REPOSITORY.id}', ${count + 1}, 'pull', 1, 'A pull', '', 'open', now(), now(), now(), now(), NULL),
      ('${REPOSITORY.id}#${count + 2}', '${REPOSITORY.id}', ${count + 2}, 'issue', 2, 'Gone', '', 'open', now(), now(), now(), now(), now()),
      ('github/someone/else#1', 'github/someone/else', 1, 'issue', 3, 'Other', '', 'open', now(), now(), now(), now(), NULL)`,
  )
}

type Listed = { readonly number: number; readonly title: string; readonly state: string; readonly comments: number }
const route = issuesRoute(REPOSITORY.owner, REPOSITORY.name)

/** The `rel="next"` URL of a Link header, if any. */
const nextOf = (response: Response) => /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1]

describe("the issues list", () => {
  test.each(["allowed", "forbidden"] as const)("the direct action retains only an authorized HTTP answer when summaries fail before delivery: %s", async (authority) => {
    await seed(7)
    const h = await githubHarness(runtime)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const answered = yield* Deferred.make<void>()
      const deliver = yield* Deferred.make<void>()
      const searched = yield* Collection.local<Searched, string>({ id: "direct-answer", schema: Searched, getKey: (row) => row.id })
      const access = yield* Collection.local<Access, string>({ id: "failed-summaries", schema: Access, getKey: (row) => row.id,
        initialData: [{ id: ACCESS, status: "unknown", installed: false }] })
      const accessState = yield* accessQuery(access)
      const searches = { latest: 0, repoId: "", issue: false }
      // Inject failed summary transport through the store service. The early route and collections are real;
      // this fixture's signed-in repository reader remains authorized independently of that transport.
      const faulty = {
        searched, searches,
        forgetSearch: Effect.sync(() => { searches.latest++ }),
        opened: () => undefined,
        forRepo: () => Effect.succeed({ accessState }),
        authority: () => Stream.make(authority),
        search: (owner: string, name: string, q: string, number?: number) =>
          getSearch("http://github.test", { owner, name }, q, "5 seconds", number).pipe(
            Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, h.fetch),
            Effect.tap(() => Deferred.succeed(answered, undefined)), Effect.tap(() => Deferred.await(deliver)),
          ),
      } as unknown as IssuesStore["Service"]
      yield* Effect.all([
        readIssue(REPOSITORY.owner, REPOSITORY.name, 7).pipe(Effect.provideService(IssuesStore, faulty)),
        Effect.gen(function* () {
          yield* Deferred.await(answered)
          yield* access.update(ACCESS, (row) => { row.status = "unavailable" })
          yield* Deferred.succeed(deliver, undefined)
        }),
      ], { concurrency: "unbounded" })
      expect(yield* searched.toArray).toMatchObject(authority === "allowed" ? [{ id: SEARCHED, issues: [{ number: 7, title: "Issue 7 flaky webkit" }] }] : [])
    })))
  })

  test("is the issues route, and nothing else under the repository", () => {
    expect(handles(route)).toBe(true)
    expect(handles(`${route}/7`)).toBe(false)
    expect(handles("/api/repos/acme/widgets/issuez")).toBe(false)
    expect(parseIssuesPath("/api/repos/%E0%A4%A/widgets/issues")).toBeUndefined()
    expect(parseIssuesPath("/api/repos/-bad/widgets/issues")).toBeUndefined()
    expect(parseIssuesPath("/api/other/acme/widgets/issues")).toBeUndefined()
    expect([decodeCursor("@@"), decodeCursor("a"), decodeCursor(btoa("{}"))]).toEqual([undefined, undefined, undefined])
  })

  test("pages a repository's open issues, latest update first, with a next link until the last page", async () => {
    await seed(75)
    const h = await githubHarness(runtime)
    const first = await h.fetch(`${route}?limit=25`)
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("no-store")
    const page = (await first.json()) as Array<Listed>
    expect(page).toHaveLength(25)
    expect(page[0]).toMatchObject({ number: 74, title: "Issue 74", state: "open", comments: 74 % 3, author: { login: "maya" } })
    expect(page.every((issue) => issue.state === "open")).toBe(true)
    const seen = page.map((issue) => issue.number)
    let next = nextOf(first)
    while (next !== undefined) {
      const url = new URL(next, "http://localhost")
      expect(url.pathname).toBe(route)
      const response = await h.fetch(`${url.pathname}${url.search}`)
      expect(response.status).toBe(200)
      seen.push(...((await response.json()) as Array<Listed>).map((issue) => issue.number))
      next = nextOf(response)
    }
    const open = Array.from({ length: 75 }, (_, i) => 75 - i).filter((n) => n % 5 !== 0)
    expect(seen).toEqual(open)
  })

  test("a direct read finds an older issue behind more than thirty newer title matches", async () => {
    await seed(40)
    await sql(runtime, `UPDATE items SET title = 'Mentions #7' WHERE repo_id = '${REPOSITORY.id}' AND number > 7`)
    const h = await githubHarness(runtime)
    const read = (number: number) => Effect.runPromise(getSearch("http://github.test", REPOSITORY, `#${number}`, "5 seconds", number).pipe(
      Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, h.fetch),
    ))
    const first = await (await h.fetch(`${route}?state=all&q=%237`)).json() as Array<Listed>
    expect(first).toHaveLength(30)
    expect(first.some((issue) => issue.number === 7)).toBe(false)
    expect(await read(7)).toMatchObject([{ number: 7, title: "Issue 7 flaky webkit" }])
    expect(await read(999)).toEqual([])
  })

  test("filters by state, and searches titles and numbers", async () => {
    await seed(40)
    const h = await githubHarness(runtime)
    const numbers = async (query: string) =>
      ((await (await h.fetch(`${route}?${query}`)).json()) as Array<Listed>).map((issue) => issue.number)
    expect(await numbers("state=closed")).toEqual([40, 35, 30, 25, 20, 15, 10, 5])
    expect(await numbers("state=all&limit=100")).toHaveLength(40)
    expect(await numbers("state=all&q=flaky")).toEqual([35, 28, 21, 14, 7])
    expect(await numbers("q=FLAKY%20WEBKIT")).toEqual([28, 21, 14, 7])
    expect(await numbers("state=all&q=%2312")).toEqual([12])
    expect(await numbers("state=all&q=12")).toEqual([12])
    // LIKE's own characters are only text.
    expect(await numbers("state=all&q=%25")).toEqual([])
  })

  test("refuses what it can't answer: a bad state, limit or cursor is 400; a limit over 100 is 100", async () => {
    await seed(120)
    const h = await githubHarness(runtime)
    for (const query of ["state=fixed", "limit=0", "limit=x", "cursor=nope", `cursor=${encodeCursor({ updatedAt: "not a time", number: 1 })}`]) {
      const response = await h.fetch(`${route}?${query}`)
      expect([query, response.status, await response.json()]).toEqual([query, 400, { code: "invalid" }])
    }
    expect(((await (await h.fetch(`${route}?limit=500&state=all`)).json()) as Array<Listed>)).toHaveLength(100)
    expect(decodeCursor(encodeCursor({ updatedAt: "2026-10-01T00:01:00.000Z", number: 1 }))).toEqual({ updatedAt: "2026-10-01T00:01:00.000Z", number: 1 })
  })

  test("is read as the shapes are: a private repository's issues reach only someone with a role there", async () => {
    await seed(3)
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, true)`)
    const visitor = await githubHarness(runtime, { actor: null })
    expect((await visitor.fetch(route)).status).toBe(401)
    const outsider = await githubHarness(runtime, { actor: { ...member(), role: null } })
    expect((await outsider.fetch(route)).status).toBe(403)
    const insider = await githubHarness(runtime)
    expect(((await (await insider.fetch(route)).json()) as Array<Listed>).map((issue) => issue.number)).toEqual([3, 2, 1])
    expect((await insider.fetch(issuesRoute("someone", "else"), { method: "POST" })).status).toBe(405)
  })

  test("answers 404 where the deployment doesn't act or found the App absent, and 503 when Postgres fails", async () => {
    const OWN = { owner: "acme", name: "home", id: "github/acme/home" } as const
    const gadgets = () => scriptedGitHub("acme", "gadgets")
    const notActed = await githubHarness(runtime, { own: OWN, github: gadgets(), allowed: new Set([OWN.id]) })
    const refused = await notActed.fetch(issuesRoute("acme", "gadgets"))
    expect([refused.status, await refused.json()]).toEqual([404, { code: "not_found" }])
    await sql(runtime, `INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('github/acme/gadgets', now() + interval '1 hour')`)
    try {
      const absent = await githubHarness(runtime, { own: OWN, github: gadgets() })
      const answer = await absent.fetch(issuesRoute("acme", "gadgets"))
      expect([answer.status, await answer.json()]).toEqual([404, { code: "app_not_installed" }])
      expect(absent.count(Metrics.issueLists, { outcome: "app_not_installed" })).toBe(1)
    } finally {
      await sql(runtime, `TRUNCATE repo_about`)
    }
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const offline = await githubHarness(runtime, { database: unreachable })
    const down = await offline.fetch(route)
    expect([down.status, await down.json()]).toEqual([503, { code: "unavailable" }])
    expect(offline.line("github.issues.list")[0]!.annotations).toMatchObject({ status: 503 })
    // Another repository with Postgres down: the App-absent check leaves it to the read, which can't answer either.
    const otherOffline = await githubHarness(runtime, { own: OWN, github: gadgets(), database: unreachable })
    expect((await otherOffline.fetch(issuesRoute("acme", "gadgets"))).status).toBe(503)
  })
})
