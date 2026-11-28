import { TestSchemas } from "@smthrs/database"
import { Uphill } from "@smthrs/rpc"
import { Effect, Redacted } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { backfillUphillFeedIndexes } from "../../db/migrations/0141_uphill_feed_index.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { feedsRoute, FEEDS_SHAPE_ROUTE, MAX_FEED_NAME_LENGTH } from "../../src/features/feeds/contract.ts"
import { recorded, testFile } from "../test/harness.ts"
import * as UphillIndex from "./UphillIndex.vibe"
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

const runtime = testFile("uphill_index")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE feed_documents, feed_answers RESTART IDENTITY`),
  ),
)

const PR2_ENVELOPE = {
  commit: "1dd29e1c4a0f8b2d",
  branch: "pr-2",
  updatedAt: "2026-11-27T18:00:00Z",
  provenance: {
    trust: "untrusted_contributor",
    gateEligible: false,
    cacheWriteAllowed: false,
    actor: "roninjin10",
    runner: "Community runner (roninjin10)",
  },
  report: {
    categories: [
      { id: "correctness", title: "Correctness", score: 90, metrics: [] },
      { id: "security", title: "Security", score: 84, metrics: [] },
      { id: "performance", title: "Performance", score: 80, metrics: [] },
      { id: "reliability", title: "Reliability", score: 82, metrics: [] },
      { id: "maintainability", title: "Maintainability", score: 78, metrics: [] },
      { id: "observability", title: "Observability", score: 78, metrics: [] },
    ],
    opportunities: [],
  },
}

const open = (options: Options = {}) => feedsHarness(runtime, options)

const ingest = (h: FeedsHarness, set: Record<string, unknown>) =>
  h.fetch(feedsRoute(REPO.owner, REPO.name), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ set }),
  })

const shapeValues = async (response: Response) =>
  ((await response.json()) as Array<{ readonly value?: Record<string, unknown> }>).flatMap((row) =>
    row.value === undefined ? [] : [row.value],
  )

const readDocs = () =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ id: string; repo: string; name: string; visibility: string; body: unknown; updatedAt: string }>`
        SELECT id, repo, name, visibility, body,
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
        FROM feed_documents ORDER BY name`,
    ),
  )

describe("UphillIndex helpers", () => {
  test("derives safe isolated untrusted preview names with bounded length and fallback", () => {
    expect(UphillIndex.untrustedFeedName("roninjin10")).toBe("uphill/untrusted-roninjin10")
    expect(UphillIndex.untrustedFeedName("Octo_Cat!")).toBe("uphill/untrusted-octocat")
    expect(UphillIndex.untrustedFeedName("!!!", "Person_42")).toBe("uphill/untrusted-person42")
    expect(UphillIndex.untrustedFeedName("!!!", "???")).toBe("uphill/untrusted-contributor")
    expect(UphillIndex.untrustedFeedName("a".repeat(300)).length).toBe(MAX_FEED_NAME_LENGTH)
  })
})

describe("Uphill visibility-partitioned feed index over real Postgres and Electric", () => {
  test("maintains public and maintainers index documents with identical visibility, exact ingest counts, idempotency, visibility switches, and deletion cleanup", async () => {
    const h = await open()
    const written = await ingest(h, {
      "uphill/untrusted-roninjin10": { visibility: "public", body: PR2_ENVELOPE },
      "uphill/untrusted-priv": { visibility: "maintainers", body: { ...PR2_ENVELOPE, commit: "priv0001" } },
      "uphill/history": { visibility: "maintainers", body: { history: [{ commit: "aaa1111", overall: 80 }] } },
    })
    expect(written.status).toBe(200)
    // Index upkeep does not distort the collector's returned document counts.
    expect(await written.json()).toEqual({ written: 3, unchanged: 0, deleted: 0 })

    const docs = await readDocs()
    expect(docs.map((d) => [d.name, d.visibility])).toEqual([
      ["uphill-index", "public"],
      ["uphill-index-maintainers", "maintainers"],
      ["uphill/history", "maintainers"],
      ["uphill/untrusted-priv", "maintainers"],
      ["uphill/untrusted-roninjin10", "public"],
    ])
    const pubIndex = Uphill.decodeFeedIndex(docs.find((d) => d.name === "uphill-index")!.body)
    const maintIndex = Uphill.decodeFeedIndex(docs.find((d) => d.name === "uphill-index-maintainers")!.body)
    expect(pubIndex?.previews.map((p) => p.name)).toEqual(["uphill/untrusted-roninjin10"])
    expect(pubIndex?.history).toBeNull()
    expect(maintIndex?.previews.map((p) => p.name)).toEqual(["uphill/untrusted-priv"])
    expect(maintIndex?.history?.name).toBe("uphill/history")

    // Re-ingesting identical bodies is 100% idempotent with zero index churn.
    const indexTsBefore = docs.find((d) => d.name === "uphill-index")!.updatedAt
    const repeat = await ingest(h, {
      "uphill/untrusted-roninjin10": { visibility: "public", body: PR2_ENVELOPE },
    })
    expect(repeat.status).toBe(200)
    expect(await repeat.json()).toEqual({ written: 0, unchanged: 1, deleted: 0 })
    const afterRepeat = await readDocs()
    expect(afterRepeat.find((d) => d.name === "uphill-index")!.updatedAt).toBe(indexTsBefore)

    // Electric shape permissions: public/member/agent/unreadable-role viewers receive ONLY uphill-index (public),
    // never uphill-index-maintainers or maintainer-only named documents.
    for (const options of [{}, { actor: member }, { actor: agent }, { actor: maintainer, roles: refusingRoles("github_unavailable") }]) {
      const viewer = await open(options)
      const indexRows = await shapeValues(await viewer.fetch(`${FEEDS_SHAPE_ROUTE}?offset=-1&repo=smithersai/vibelang`))
      expect(indexRows.map((r) => r.name)).toEqual(["uphill-index"])
      const pubNamed = await shapeValues(
        await viewer.fetch(`${FEEDS_SHAPE_ROUTE}?offset=-1&repo=smithersai/vibelang&name=${encodeURIComponent("uphill/untrusted-roninjin10")}`),
      )
      expect(pubNamed.map((r) => r.name)).toEqual(["uphill/untrusted-roninjin10"])
      const privNamed = await shapeValues(
        await viewer.fetch(`${FEEDS_SHAPE_ROUTE}?offset=-1&repo=smithersai/vibelang&name=${encodeURIComponent("uphill/untrusted-priv")}`),
      )
      expect(privNamed).toEqual([])
    }

    // Maintainer and Admin in person receive both indexes and both named documents.
    for (const actor of [maintainer, admin]) {
      const viewer = await open({ actor })
      const indexRows = await shapeValues(await viewer.fetch(`${FEEDS_SHAPE_ROUTE}?offset=-1&repo=smithersai/vibelang`))
      expect(indexRows.map((r) => r.name).sort()).toEqual(["uphill-index", "uphill-index-maintainers"])
      const privNamed = await shapeValues(
        await viewer.fetch(`${FEEDS_SHAPE_ROUTE}?offset=-1&repo=smithersai/vibelang&name=${encodeURIComponent("uphill/untrusted-priv")}`),
      )
      expect(privNamed.map((r) => r.name)).toEqual(["uphill/untrusted-priv"])
      expect(recorded(viewer)).not.toContain("uphill/untrusted-priv")
    }

    // Switching visibility from maintainers -> public moves the reference out of uphill-index-maintainers into uphill-index.
    expect((await ingest(h, {
      "uphill/untrusted-priv": { visibility: "public", body: { ...PR2_ENVELOPE, commit: "priv0001" } },
      "uphill/history": null,
    })).status).toBe(200)
    const afterFlip = await readDocs()
    expect(afterFlip.map((d) => d.name)).toEqual([
      "uphill-index",
      "uphill/untrusted-priv",
      "uphill/untrusted-roninjin10",
    ])
    const pubAfterFlip = Uphill.decodeFeedIndex(afterFlip.find((d) => d.name === "uphill-index")!.body)
    expect(pubAfterFlip?.previews.map((p) => p.name).sort()).toEqual([
      "uphill/untrusted-priv",
      "uphill/untrusted-roninjin10",
    ])

    // Deleting all previews deletes the empty uphill-index row too.
    expect((await ingest(h, {
      "uphill/untrusted-priv": null,
      "uphill/untrusted-roninjin10": null,
    })).status).toBe(200)
    expect(await readDocs()).toEqual([])
  })

  test("mirrorAuditReport writes canonical uphill without touching previews, and mirrors untrusted previews atomically with idempotent repeat", async () => {
    const firstUntrusted = await runtime.runPromise(
      UphillIndex.mirrorAuditReport({
        repo: "smithersai/smithers-ci",
        name: "uphill/untrusted-roninjin10",
        visibility: "public",
        serializedBody: JSON.stringify(PR2_ENVELOPE),
        trusted: false,
      }),
    )
    expect(firstUntrusted).toEqual({
      written: true,
      feedName: "uphill/untrusted-roninjin10",
      feedVisibility: "public",
      feedIndexName: "uphill-index",
    })

    const repeatUntrusted = await runtime.runPromise(
      UphillIndex.mirrorAuditReport({
        repo: "smithersai/smithers-ci",
        name: "uphill/untrusted-roninjin10",
        visibility: "public",
        serializedBody: JSON.stringify(PR2_ENVELOPE),
        trusted: false,
      }),
    )
    expect(repeatUntrusted.written).toBe(false)

    const trusted = await runtime.runPromise(
      UphillIndex.mirrorAuditReport({
        repo: "smithersai/smithers-ci",
        name: "uphill",
        visibility: "public",
        serializedBody: JSON.stringify({ report: { categories: [{ name: "speed", title: "Speed", score: 95 }] } }),
        trusted: true,
      }),
    )
    expect(trusted).toEqual({
      written: true,
      feedName: "uphill",
      feedVisibility: "public",
      feedIndexName: null,
    })

    const docs = await readDocs()
    expect(docs.map((d) => d.name)).toEqual(["uphill", "uphill-index", "uphill/untrusted-roninjin10"])
  })
})

describe("0141_uphill_feed_index backfill migration", () => {
  test("backfills existing pre-0141 uphill/untrusted-* and uphill/history rows with identical visibility and is idempotent", async () => {
    const schema = TestSchemas.schemaName("uphill_m0141")
    const runSql = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))
    await runSql(`CREATE SCHEMA ${schema}`)
    try {
      const url = await runtime.runPromise(TestDatabase.serverUrl)
      url.searchParams.set("options", `-c search_path=${schema}`)
      const db = Database.layer(Effect.succeed(Redacted.make(url.toString())))
      const on = <A, E>(eff: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(eff, db))
      const through = (last: string) =>
        Migrator.make({})({
          loader: Migrator.fromRecord(
            Object.fromEntries(Object.entries(Database.migrations).filter(([name]) => name.slice(0, 4) <= last)),
          ),
        })

      await on(through("0140"))

      // Seed existing pre-migration rows directly as production has them (zero index documents yet).
      await on(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO feed_documents (id, repo, name, visibility, body, updated_at) VALUES
              ('smithersai/smithers-ci:uphill/untrusted-roninjin10', 'smithersai/smithers-ci', 'uphill/untrusted-roninjin10', 'public', ${JSON.stringify(PR2_ENVELOPE)}::jsonb, '2026-11-27T18:00:00Z'::timestamptz),
              ('smithersai/smithers-ci:uphill/untrusted-alice', 'smithersai/smithers-ci', 'uphill/untrusted-alice', 'public', ${JSON.stringify(PR2_ENVELOPE)}::jsonb, '2026-11-27T17:00:00Z'::timestamptz),
              ('smithersai/smithers-ci:uphill/untrusted-secret', 'smithersai/smithers-ci', 'uphill/untrusted-secret', 'maintainers', ${JSON.stringify(PR2_ENVELOPE)}::jsonb, '2026-11-27T18:05:00Z'::timestamptz),
              ('smithersai/smithers-ci:uphill/history', 'smithersai/smithers-ci', 'uphill/history', 'public', '{"history":[]}'::jsonb, '2026-11-27T17:30:00Z'::timestamptz),
              ('other/repo:uphill/untrusted-nested/bad', 'other/repo', 'uphill/untrusted-nested/bad', 'public', '{}'::jsonb, '2026-11-27T17:00:00Z'::timestamptz)`
        }),
      )

      const applied = await on(through("0141"))
      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["141_uphill_feed_index"])

      const readIndexes = () =>
        on(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql<{ id: string; repo: string; name: string; visibility: string; body: unknown; updatedAt: string }>`
              SELECT id, repo, name, visibility, body,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
              FROM feed_documents
              WHERE name IN ('uphill-index', 'uphill-index-maintainers')
              ORDER BY id`,
          ),
        )

      const first = await readIndexes()
      expect(first.map((r) => ({ id: r.id, visibility: r.visibility, body: r.body }))).toEqual([
        {
          id: "smithersai/smithers-ci:uphill-index",
          visibility: "public",
          body: {
            version: 1,
            previews: [
              { name: "uphill/untrusted-roninjin10", updatedAt: "2026-11-27T18:00:00.000Z" },
              { name: "uphill/untrusted-alice", updatedAt: "2026-11-27T17:00:00.000Z" },
            ],
            history: { name: "uphill/history", updatedAt: "2026-11-27T17:30:00.000Z" },
          },
        },
        {
          id: "smithersai/smithers-ci:uphill-index-maintainers",
          visibility: "maintainers",
          body: {
            version: 1,
            previews: [{ name: "uphill/untrusted-secret", updatedAt: "2026-11-27T18:05:00.000Z" }],
            history: null,
          },
        },
      ])

      // Re-running backfill is a 100% idempotent no-op (timestamps untouched).
      await on(backfillUphillFeedIndexes)
      const second = await readIndexes()
      expect(second).toEqual(first)
    } finally {
      await runSql(`DROP SCHEMA ${schema} CASCADE`)
    }
  })
})
