// Repository feeds' routes (worker/feeds/Api.ts, docs/features/feeds.md) through their real handler, over this file's
// schema of the compose Postgres and through the compose Electric. Roles come from the real `RepoRoles` as local
// development builds it; a role that can't be read, sessions and Postgres fail only through injected faulty services.
// Every test that writes searches what was recorded for the key, the bodies, the private names and the answers' words.
import { Data, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import {
  ANSWERS_MAX,
  feedAnswersRoute,
  FEED_DOCUMENT_COLUMNS,
  feedsRoute,
  FEEDS_SHAPE_ROUTE,
  MAX_FEED_DOCUMENT_BYTES,
  MAX_FEED_DOCUMENTS,
  MAX_FEED_REQUEST_BYTES,
} from "../../src/features/feeds/contract.ts"
import { FeedAnswers, Ingested } from "../../src/features/feeds/schema.ts"
import * as Actor from "../Actor.ts"
import { recorded, testFile } from "../test/harness.ts"
import * as FeedsApi from "./Api.ts"
import { DEV_FEED_KEY } from "./dev.ts"
import {
  admin,
  agent,
  type FeedsHarness,
  feedsHarness,
  KEY,
  maintainer,
  member,
  type Options,
  REPO,
  refusingRoles,
} from "./test/harness.ts"

const runtime = testFile("feeds")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE feed_documents, feed_answers RESTART IDENTITY`))
)

/** A private document's name, a body and an answer's words: sentinels no record may carry. */
const PRIVATE = "transcript/lane-sentinel-31c"
const BODY = { lanes: [{ id: "lane-1", note: "body-sentinel-8a2e" }] }
const WORDS = "answer-sentinel-9f40"

const open = (options: Options = {}) => feedsHarness(runtime, options)

const json = async (response: Response) => [response.status, await response.json()] as const

const ingest = (h: FeedsHarness, body: unknown, key: string | null = KEY, repo: { owner: string; name: string } = REPO) =>
  h.fetch(feedsRoute(repo.owner, repo.name), {
    method: "POST",
    headers: { "content-type": "application/json", ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
    body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  })

const answers = (h: FeedsHarness, query = "", key: string | null = KEY) =>
  h.fetch(`${feedAnswersRoute(REPO.owner, REPO.name)}${query}`, {
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
  })

const answer = (h: FeedsHarness, body: unknown) =>
  h.fetch(feedAnswersRoute(REPO.owner, REPO.name), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
  })

/** The documents as Postgres holds them. */
const documents = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ id: string; repo: string; name: string; visibility: string; body: unknown; updatedAt: string }>`
      SELECT id, repo, name, visibility, body, updated_at::text AS "updatedAt" FROM feed_documents ORDER BY name`))

/** What a handler recorded that carries the key, a body, a private name or an answer's words. */
const leaks = (h: FeedsHarness) =>
  [KEY, "body-sentinel", PRIVATE, WORDS, "maya-sentinel-login"].filter((value) => recorded(h).includes(value))

class Unreachable extends Data.TaggedError("Unreachable")<{}> {}
/** A Postgres client that can't connect. */
const down = Layer.effect(SqlClient.SqlClient, Effect.fail(new Unreachable()))

/** Sessions that can't be read. */
const unreadable = Layer.succeed(
  Actor.Sessions,
  Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }),
)

describe("FEED_KEYS", () => {
  const read = (value: string | undefined) =>
    feedsHarness(runtime, { config: value === undefined ? {} : { FEED_KEYS: value } }).then(
      () => "built",
      (error: unknown) => String(error),
    )

  test("unset or blank turns the collector's routes off; each pair's repository is lowercased", async () => {
    for (const value of [undefined, "  "]) {
      const h = await open({ config: value === undefined ? {} : { FEED_KEYS: value } })
      expect(await json(await ingest(h, { set: {} }))).toEqual([503, { code: "off" }])
      expect(await json(await answers(h))).toEqual([503, { code: "off" }])
    }
    // The harness's own list names `SmithersAI/VibeLang`.
    expect((await ingest(await open(), { set: {} })).status).toBe(200)
  })

  test("alchemy dev's development key opens every repository while FEED_KEYS is unset, and never once it is set", async () => {
    const dev = await open({ config: {}, api: { developmentKey: DEV_FEED_KEY } })
    expect(await json(await ingest(dev, { set: {} }, DEV_FEED_KEY))).toEqual([200, { written: 0, unchanged: 0, deleted: 0 }])
    expect((await ingest(dev, { set: {} }, DEV_FEED_KEY, { owner: "acme", name: "other" })).status).toBe(200)
    expect((await answers(dev, "", DEV_FEED_KEY)).status).toBe(200)
    expect((await ingest(dev, { set: {} }, KEY)).status).toBe(401)
    expect((await ingest(dev, { set: {} }, null)).status).toBe(401)
    // FEED_KEYS set: its keys only.
    const listed = await open({ api: { developmentKey: DEV_FEED_KEY } })
    expect((await ingest(listed, { set: {} }, DEV_FEED_KEY)).status).toBe(401)
    expect((await ingest(listed, { set: {} })).status).toBe(200)
    // Built without one, as production's ChatApi is, the routes stay off.
    expect(await json(await ingest(await open({ config: {} }), { set: {} }, DEV_FEED_KEY))).toEqual([503, { code: "off" }])
    expect(recorded(dev).includes(DEV_FEED_KEY)).toBe(false)
  })

  test("a malformed list fails the deployment's config, never a request", async () => {
    expect(await read("smithersai/vibelang=abc")).toContain("FEED_KEYS is not a comma-separated list")
    expect(await read(`-bad/name=${"a".repeat(64)}`)).toContain("FEED_KEYS is not a comma-separated list")
    expect(await read(`a/b=${"A".repeat(64)}, c/d=${"b".repeat(64)}`)).toBe("built")
  })
})

describe("POST /api/repos/<owner>/<name>/feeds", () => {
  test("the collector sets documents; an identical body is left alone; null deletes; it answers the counts", async () => {
    const h = await open()

    const first = await ingest(h, {
      set: {
        lanes: { visibility: "public", body: BODY },
        [PRIVATE]: { visibility: "maintainers", body: { text: "body-sentinel" } },
        empty: { visibility: "public", body: null },
      },
    })
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("no-store")
    expect(Schema.decodeUnknownSync(Ingested)(await first.json())).toEqual({ written: 3, unchanged: 0, deleted: 0 })
    const stored = await documents()
    expect(stored.map(({ updatedAt: _, ...row }) => row)).toEqual([
      { id: "smithersai/vibelang:empty", repo: "smithersai/vibelang", name: "empty", visibility: "public", body: null },
      { id: "smithersai/vibelang:lanes", repo: "smithersai/vibelang", name: "lanes", visibility: "public", body: BODY },
      {
        id: `smithersai/vibelang:${PRIVATE}`,
        repo: "smithersai/vibelang",
        name: PRIVATE,
        visibility: "maintainers",
        body: { text: "body-sentinel" },
      },
    ])

    // The same body in another key order is the same JSON: not written again, so Electric sends nothing.
    const again = await ingest(h, {
      set: {
        lanes: { visibility: "public", body: JSON.parse(JSON.stringify(BODY)) },
        empty: { visibility: "maintainers", body: null },
        [PRIVATE]: null,
        gone: null,
      },
    })
    expect(await json(again)).toEqual([200, { written: 1, unchanged: 1, deleted: 1 }])
    const after = await documents()
    expect(after.map((row) => [row.name, row.visibility])).toEqual([["empty", "maintainers"], ["lanes", "public"]])
    expect(after.find((row) => row.name === "lanes")!.updatedAt).toBe(stored.find((row) => row.name === "lanes")!.updatedAt)

    expect(await json(await ingest(h, { set: { lanes: null } }))).toEqual([200, { written: 0, unchanged: 0, deleted: 1 }])
    expect(h.count(FeedsApi.requests, { op: "ingest", outcome: "ingested" })).toBe(3)
    expect(h.line("feed.ingest").at(0)).toMatchObject({
      level: "INFO",
      annotations: expect.objectContaining({ op: "ingest", repoId: "smithersai/vibelang", documents: 3, written: 3, status: 200 }),
    })
    expect(h.spans.map((span) => span.name)).toContain("feed.ingest")
    expect(leaks(h)).toEqual([])
  })

  test("a wrong key, no key, or a repository FEED_KEYS doesn't name is 401", async () => {
    const h = await open()
    expect(await json(await ingest(h, { set: {} }, "another-key"))).toEqual([401, { code: "authentication" }])
    expect(await json(await ingest(h, { set: {} }, null))).toEqual([401, { code: "authentication" }])
    expect(await json(await ingest(h, { set: {} }, ""))).toEqual([401, { code: "authentication" }])
    expect(await json(await ingest(h, { set: {} }, KEY, { owner: "acme", name: "other" }))).toEqual([
      401,
      { code: "authentication" },
    ])
    expect(await json(await ingest(h, { set: {} }, KEY, { owner: "acme", name: "unnamed" }))).toEqual([
      401,
      { code: "authentication" },
    ])
    expect(h.count(FeedsApi.requests, { op: "ingest", outcome: "authentication" })).toBe(5)
    expect(leaks(h)).toEqual([])
  })

  test("bodies, names and sizes outside the contract are refused, and nothing is written", async () => {
    const h = await open()
    const big = "x".repeat(MAX_FEED_DOCUMENT_BYTES)
    const many = Object.fromEntries(
      Array.from({ length: MAX_FEED_DOCUMENTS + 1 }, (_, index) => [`d${index}`, null]),
    )
    const cases: ReadonlyArray<readonly [unknown, number, string]> = [
      ["not json", 400, "invalid"],
      [{ documents: {} }, 400, "invalid"],
      [{ set: { lanes: { visibility: "everyone", body: 1 } } }, 400, "invalid"],
      [{ set: { lanes: { visibility: "public" } } }, 400, "invalid"],
      [{ set: { lanes: { visibility: "public", body: "nul\u0000" } } }, 400, "invalid"],
      [{ set: { Lanes: { visibility: "public", body: 1 } } }, 400, "invalid_name"],
      [{ set: { "lanes/": { visibility: "public", body: 1 } } }, 400, "invalid_name"],
      [{ set: { [`l${"a".repeat(200)}`]: null } }, 400, "invalid_name"],
      [{ set: { lanes: { visibility: "public", body: big } } }, 413, "too_large"],
      [{ set: many }, 413, "too_large"],
      [new Uint8Array([0x7b, 0xff, 0x7d]), 400, "invalid"],
      ["x".repeat(MAX_FEED_REQUEST_BYTES + 1), 413, "too_large"],
    ]
    for (const [body, status, code] of cases) {
      expect(await json(await ingest(h, body)), JSON.stringify(body).slice(0, 80)).toEqual([status, { code }])
    }
    expect(await documents()).toEqual([])
    expect(leaks(h)).toEqual([])
  })

  test("names may nest with capitals and colons after the first segment", async () => {
    const h = await open()
    const names = ["report/r2/Codex:astra", "diff/0a1b2c", "a.b_c-d"]
    const set = Object.fromEntries(names.map((name) => [name, { visibility: "public", body: { name } }]))
    expect(await json(await ingest(h, { set }))).toEqual([200, { written: 3, unchanged: 0, deleted: 0 }])
  })

  test("another method is 405; Postgres not answering is 503 unavailable", async () => {
    const h = await open()
    const got = await h.fetch(feedsRoute(REPO.owner, REPO.name))
    expect([got.status, got.headers.get("allow")]).toEqual([405, "POST"])
    const broken = await open({ database: down })
    expect(await json(await ingest(broken, { set: { lanes: { visibility: "public", body: BODY } } }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(broken.line("feed.ingest").at(0)).toMatchObject({
      level: "ERROR",
      annotations: expect.objectContaining({ errorCode: "Unreachable", status: 503 }),
    })
    expect(leaks(broken)).toEqual([])
  })
})

describe("POST /api/repos/<owner>/<name>/feeds/answers", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    item: "decision-7",
    choice: "approve",
    text: WORDS,
    ...overrides,
  })

  test("a Maintainer of the repository, not of the deployment's own, records an answer; a resend changes nothing", async () => {
    const h = await open({ actor: maintainer })
    const sent = body()

    const [status, first] = await json(await answer(h, sent))
    expect([status, first]).toEqual([200, { id: sent.id, seq: 1 }])
    expect(await json(await answer(h, { ...sent, text: "changed" }))).toEqual([200, { id: sent.id, seq: 1 }])
    const recordedRows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`SELECT repo, item, choice, text, person_id AS "personId", login FROM feed_answers`))
    expect(recordedRows).toEqual([{
      repo: "smithersai/vibelang",
      item: "decision-7",
      choice: "approve",
      text: WORDS,
      personId: "person-maintainer",
      login: "maya-sentinel-login",
    }])
    expect(h.count(FeedsApi.requests, { op: "answer", outcome: "recorded" })).toBe(2)
    expect(h.spans.map((span) => span.name)).toContain("feed.answer")
    expect(leaks(h)).toEqual([])
  })

  test("an Admin answers with a choice alone or a text alone", async () => {
    const h = await open({ actor: admin })
    expect((await answer(h, body({ text: undefined }))).status).toBe(200)
    expect((await answer(h, body({ choice: null }))).status).toBe(200)
  })

  test("the same id from another person is 409", async () => {
    const sent = body()
    expect((await answer(await open({ actor: maintainer }), sent)).status).toBe(200)
    expect(await json(await answer(await open({ actor: admin }), sent))).toEqual([409, { code: "conflict" }])
  })

  test("signed out is 401, an agent acting for a Maintainer 403 person_only, a Member 403", async () => {
    expect(await json(await answer(await open(), body()))).toEqual([401, { code: "authentication" }])
    const acting = await open({ actor: agent })
    expect(await json(await answer(acting, body()))).toEqual([403, { code: "person_only" }])
    expect(acting.count(Actor.personOnlyRefusals, { act: "feed/answer", by: "agent" })).toBe(1)
    expect(await json(await answer(await open({ actor: member }), body()))).toEqual([403, { code: "forbidden" }])
  })

  test("a role the deployment can't read there is 403; one GitHub can't answer now is 503", async () => {
    const elsewhere = await open({ actor: maintainer, roles: refusingRoles("app_not_installed") })
    expect(await json(await answer(elsewhere, body()))).toEqual([403, { code: "forbidden" }])
    const busy = await open({ actor: maintainer, roles: refusingRoles("github_unavailable") })
    expect(await json(await answer(busy, body()))).toEqual([503, { code: "unavailable" }])
    expect(busy.line("feed.answer").at(0)).toMatchObject({
      level: "ERROR",
      annotations: expect.objectContaining({ roleCode: "github_unavailable" }),
    })
  })

  test("bodies outside the contract are refused, and nothing is recorded", async () => {
    const h = await open({ actor: maintainer })
    const cases: ReadonlyArray<readonly [unknown, number, string]> = [
      ["not json", 400, "invalid"],
      [body({ id: "not-a-uuid" }), 400, "invalid"],
      [body({ item: "" }), 400, "invalid"],
      [body({ choice: null, text: null }), 400, "invalid"],
      [body({ choice: undefined, text: undefined }), 400, "invalid"],
      [body({ text: "nul\u0000" }), 400, "invalid"],
      [new Uint8Array([0x7b, 0xff, 0x7d]), 400, "invalid"],
      ["x".repeat(40 * 1024), 413, "too_large"],
    ]
    for (const [sent, status, code] of cases) {
      expect(await json(await answer(h, sent)), JSON.stringify(sent).slice(0, 80)).toEqual([status, { code }])
    }
    expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id FROM feed_answers`)))
      .toEqual([])
    expect(leaks(h)).toEqual([])
  })

  test("another method is 405; sessions or Postgres not answering is 503", async () => {
    const h = await open({ actor: maintainer })
    const removed = await h.fetch(feedAnswersRoute(REPO.owner, REPO.name), { method: "DELETE" })
    expect([removed.status, removed.headers.get("allow")]).toEqual([405, "GET, POST"])
    expect(await json(await answer(await open({ sessions: unreadable }), body()))).toEqual([503, { code: "unavailable" }])
    expect(await json(await answer(await open({ actor: maintainer, database: down }), body()))).toEqual([
      503,
      { code: "unavailable" },
    ])
  })
})

describe("GET /api/repos/<owner>/<name>/feeds/answers", () => {
  /** A read's answers, held to the contract. */
  const read = async (response: Response) => {
    expect(response.status).toBe(200)
    return Schema.decodeUnknownSync(FeedAnswers)(await response.json())
  }

  test("the collector reads answers after its cursor, oldest first, and reading deletes nothing", async () => {
    const person = await open({ actor: maintainer })
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    for (const [index, id] of ids.entries()) {
      expect((await answer(person, { id, item: `item-${index}`, choice: index === 1 ? null : "yes", text: index === 1 ? WORDS : null })).status)
        .toBe(200)
    }
    const h = await open()

    const all = await read(await answers(h))
    expect(all.answers.map((row) => [row.seq, row.id, row.item, row.choice, row.text, row.login])).toEqual([
      [1, ids[0], "item-0", "yes", null, "maya-sentinel-login"],
      [2, ids[1], "item-1", null, WORDS, "maya-sentinel-login"],
      [3, ids[2], "item-2", "yes", null, "maya-sentinel-login"],
    ])
    expect(all.answers[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(all.next).toBe(3)
    const later = await read(await answers(h, "?after=2"))
    expect([later.answers.map((row) => row.id), later.next]).toEqual([[ids[2]], 3])
    expect(await json(await answers(h, "?after=3"))).toEqual([200, { answers: [], next: 3 }])
    expect((await read(await answers(h))).answers).toHaveLength(3)
    expect(h.count(FeedsApi.requests, { op: "answers", outcome: "listed" })).toBe(4)
    expect(h.spans.map((span) => span.name)).toContain("feed.answers")
    expect(leaks(h)).toEqual([])
  })

  test("at most ANSWERS_MAX answers a read", async () => {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO feed_answers (id, repo, item, choice, person_id)
      SELECT gen_random_uuid(), 'smithersai/vibelang', 'i' || n, 'yes', 'p' FROM generate_series(1, ${ANSWERS_MAX + 5}) n`))
    const page = await read(await answers(await open()))
    expect([page.answers.length, page.next]).toEqual([ANSWERS_MAX, ANSWERS_MAX])
  })

  test("a wrong key is 401, a cursor that isn't a whole number 400", async () => {
    const h = await open()
    expect(await json(await answers(h, "", "wrong"))).toEqual([401, { code: "authentication" }])
    for (const after of ["-1", "x", "1.5", "9".repeat(16)]) {
      expect(await json(await answers(h, `?after=${after}`))).toEqual([400, { code: "invalid" }])
    }
  })
})

describe("GET /api/shapes/feeds", () => {
  /** The rows a shape response carries. */
  const values = async (response: Response) =>
    ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
      row.value === undefined ? [] : [row.value]
    )

  /** An index of a public and a private document, and an on-demand document of each. */
  const fed = async () => {
    expect((await ingest(await open(), {
      set: {
        lanes: { visibility: "public", body: BODY },
        grades: { visibility: "maintainers", body: { grade: "body-sentinel" } },
        "diff/abc": { visibility: "public", body: { diff: "+1" } },
        [PRIVATE]: { visibility: "maintainers", body: { text: "body-sentinel" } },
      },
    })).status).toBe(200)
    expect((await ingest(await open(), { set: { lanes: { visibility: "public", body: 1 } } }, KEY, {
      owner: "acme",
      name: "other",
    })).status).toBe(401)
  }

  const shape = (h: FeedsHarness, query: string) => h.fetch(`${FEEDS_SHAPE_ROUTE}?offset=-1&${query}`)
  const names = async (response: Response) => (await values(response)).map((row) => row.name).sort()

  test("signed out reads the public index: no name with a slash, and every column", async () => {
    await fed()
    const h = await open()

    const rows = await values(await shape(h, "repo=SmithersAI/VibeLang"))

    expect(rows.map((row) => row.name)).toEqual(["lanes"])
    expect(Object.keys(rows[0]!).sort()).toEqual([...FEED_DOCUMENT_COLUMNS].sort())
    expect(h.electric.map((url) => Object.fromEntries(url.searchParams))).toEqual([{
      offset: "-1",
      table: "feed_documents",
      where: "repo = $1 AND name NOT LIKE '%/%' AND visibility = 'public'",
      "params[1]": "smithersai/vibelang",
      columns: FEED_DOCUMENT_COLUMNS.join(","),
    }])
    expect(h.count(FeedsApi.audiences, { audience: "public", single: "false" })).toBe(1)
    expect(h.count(FeedsApi.shapes, { status: "200", live: "false" })).toBe(1)
  })

  test("a Maintainer or Admin of the repository in person reads its private documents too", async () => {
    await fed()
    for (const actor of [maintainer, admin]) {
      const h = await open({ actor })
      expect(await names(await shape(h, "repo=smithersai/vibelang"))).toEqual(["grades", "lanes"])
      expect(h.count(FeedsApi.audiences, { audience: "maintainers", single: "false" })).toBe(1)
      expect(await names(await shape(h, `repo=smithersai/vibelang&name=${encodeURIComponent(PRIVATE)}`))).toEqual([PRIVATE])
      expect(h.count(FeedsApi.audiences, { audience: "maintainers", single: "true" })).toBe(1)
      expect(leaks(h)).toEqual([])
    }
  })

  test("a Member, an agent for a Maintainer, or a role that can't be read gets the public documents only", async () => {
    await fed()
    const cases: ReadonlyArray<Options> = [
      { actor: member },
      { actor: agent },
      { actor: maintainer, roles: refusingRoles("github_unavailable") },
    ]
    for (const options of cases) {
      const h = await open(options)
      expect(await names(await shape(h, "repo=smithersai/vibelang"))).toEqual(["lanes"])
      expect(await names(await shape(h, `repo=smithersai/vibelang&name=${encodeURIComponent(PRIVATE)}`))).toEqual([])
      expect(await names(await shape(h, "repo=smithersai/vibelang&name=diff/abc"))).toEqual(["diff/abc"])
    }
  })

  test("a repository or a name that isn't one reads no rows", async () => {
    await fed()
    const h = await open({ actor: maintainer })
    expect(await names(await shape(h, "repo=nope"))).toEqual([])
    expect(await names(await shape(h, "repo=smithersai/vibelang&name=Bad%20Name"))).toEqual([])
    expect(await names(await shape(h, ""))).toEqual([])
    expect(h.count(FeedsApi.audiences, { audience: "public", single: "true" })).toBe(1)
  })

  test("sessions that can't be read are 503 with a retry, without calling Electric", async () => {
    const h = await open({ sessions: unreadable })
    const response = await shape(h, "repo=smithersai/vibelang")
    expect([response.status, response.headers.get("retry-after")]).toEqual([503, "5"])
    expect(h.electric).toEqual([])
  })
})

describe("helpers", () => {
  test("a cursor, a key and who may maintain", () => {
    expect([FeedsApi.afterOf(null), FeedsApi.afterOf("12"), FeedsApi.afterOf("a")]).toEqual([0, 12, undefined])
    expect(FeedsApi.keyMatches(KEY, "0".repeat(64))).toBe(false)
    expect(FeedsApi.mayMaintain(maintainer, "maintainer")).toBe(true)
    expect(FeedsApi.mayMaintain(agent, "admin")).toBe(false)
    expect(FeedsApi.mayMaintain(member, "member")).toBe(false)
    expect(FeedsApi.handles("/api/repos/a/b/feeds")).toBe(true)
    expect(FeedsApi.handles("/api/repos/a/b/feeds/answers")).toBe(true)
    expect(FeedsApi.handles(FEEDS_SHAPE_ROUTE)).toBe(true)
    expect(FeedsApi.handles("/api/repos/a/b/feeds/other")).toBe(false)
    expect(FeedsApi.handles("/api/repos/%E0%A4%A/b/feeds")).toBe(false)
    expect(FeedsApi.handles("/api/repos/-a/b/feeds")).toBe(false)
  })
})
