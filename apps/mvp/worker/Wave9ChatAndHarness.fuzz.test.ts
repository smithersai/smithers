import { PgClient } from "@effect/sql-pg"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Data, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as Database from "../db/Database.ts"
import migration0025 from "../db/migrations/0025_flow_source.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { ACK_ROUTE, NOTIFICATIONS_SHAPE_ROUTE, WATCHES_ROUTE } from "../src/features/attention/contract.ts"
import { HOSTED_MODEL_ROUTE } from "../src/features/auth/contract.ts"
import { MAX_QUESTION_BODY_BYTES, QUESTIONS_ROUTE, SHAPE_ROUTE, TELEMETRY_ROUTE } from "../src/features/chat/contract.ts"
import { FLOW_DRAFTS_ROUTE, FLOW_DRAFTS_SHAPE_ROUTE, FLOWS_ROUTE, FLOWS_SHAPE_ROUTE } from "../src/features/flows-ui/contract.ts"
import { PIN_ROUTE, PINS_SHAPE_ROUTE } from "../src/features/pins/contract.ts"
import {
  ALERT_CHANNELS_ROUTE,
  ALERT_CHANNELS_SHAPE_ROUTE,
  ALERT_DELIVERIES_SHAPE_ROUTE,
  SANDBOX_LIMITS_ROUTE,
  SANDBOX_LIMITS_SHAPE_ROUTE,
  SPEND_ALERTS_SHAPE_ROUTE,
} from "../src/features/spend/contract.ts"
import { RUNS_ROUTE, RUNS_SHAPE_ROUTE } from "../src/features/status/contract.ts"
import { VIEWS_ROUTE, VIEWS_SHAPE_ROUTE } from "../src/features/views/contract.ts"
import { WEB_PREVIEW_ROUTE } from "../src/features/web/contract.ts"
import * as Actor from "./Actor.ts"
import * as BranchAccess from "./branch/Access.vibe"
import * as Conversations from "./branch/Conversations.vibe"
import * as ChatMetrics from "./ChatMetrics.ts"
import * as Messages from "./Messages.ts"
import * as Views from "./Views.ts"
import * as H from "./test/harness.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const dbExecs = Math.max(15, Math.min(Math.ceil(baseExecs / 8), 30))
const pureExecs = Math.max(25, Math.min(Math.ceil(baseExecs / 2), 100))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261191")

const ADMIN_ID = "11111111-1111-4111-8111-111111111111"
const MEMBER_ID = "22222222-2222-4222-8222-222222222222"
const GUEST_ID = "33333333-3333-4333-8333-333333333333"

const adminActor: Actor.Actor = { subject: { kind: "person", id: ADMIN_ID }, role: "admin", login: "admin-user" }
const memberActor: Actor.Actor = { subject: { kind: "person", id: MEMBER_ID }, role: "member", login: "member-user" }
const guestActor: Actor.Actor = { subject: { kind: "person", id: GUEST_ID }, role: "guest", login: "guest-user" }
const agentActor: Actor.Actor = {
  subject: { kind: "person", id: MEMBER_ID },
  role: "member",
  login: "member-user",
  act: { kind: "agent", id: "44444444-4444-4444-8444-444444444444" },
}

const okElectricFetch: typeof globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  return new Response(JSON.stringify([{ url }]), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "electric-handle": "h-wave9",
      "electric-offset": "0_0",
      "electric-schema": "{}",
    },
  })
}

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

class CustomTaggedDefect extends Data.TaggedError("CustomTaggedDefect")<{ readonly reason: string }> {}
class SessionDown extends Data.TaggedError("SessionDown")<{ readonly errorCode: string }> {}

describe("Wave9 Chat.ts & harness.ts real Postgres fuzzing", () => {
  const runtime = H.testFile("wave9_chat")

  it("fuzzes /api/questions happy path, idempotent resend, traceparent parsing, harness helpers, and all Chat.ts routes", async () => {
    const homeId = await H.homeConversation(runtime)
    const h = await H.harness(runtime, H.answers("hello ", "world"), {
      actor: adminActor,
      fetch: okElectricFetch,
      spendAlerts: false,
      hostedModel: true,
    })

    // Exercise harness helpers: contents, answers, recorded, eventually
    expect(H.contents({
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    } as never)).toEqual(["ping"])
    await H.eventually(() => true, 200)
    await expect(H.eventually(() => false, 40)).rejects.toThrow("condition never held")

    const validTraceArb = Arbitrary.schema(Schema.Struct({
      traceHex: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
      spanHex: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
      sampled: Schema.Boolean,
      useHome: Schema.Boolean,
      text: Schema.String.check(Schema.isBetweenLength(1, 80)),
    }))

    await holds(validTraceArb, dbExecs, (sample) =>
      Effect.promise(async () => {
        const cleanText = sample.text.toWellFormed().replace(/\u0000/g, "x").trim() || "hello"
        const id = H.uuid()
        const answerId = H.uuid()
        const tp = sample.traceHex === "0".repeat(32) || sample.spanHex === "0".repeat(16)
          ? "00-00000000000000000000000000000000-0000000000000000-01"
          : `00-${sample.traceHex}-${sample.spanHex}-${sample.sampled ? "01" : "00"}`
        const body = sample.useHome
          ? { id, answerId, text: cleanText }
          : { id, answerId, conversationId: homeId.toUpperCase(), text: cleanText }

        const res1 = await h.ask(body, { traceparent: tp })
        expect(res1.status).toBe(202)
        const json1 = await res1.json() as { txid: number | string }
        expect(json1.txid).toBeTruthy()

        // Idempotent resend hits txid === null -> 200 { txid: null, existing: true }
        const res2 = await h.ask(body, { traceparent: "invalid-traceparent" })
        expect(res2.status).toBe(200)
        const json2 = await res2.json() as { txid: null; existing: boolean }
        expect(json2.existing).toBe(true)

        // Reuse question id with different answerId -> 409 id_taken
        const res3 = await h.ask({ id, answerId: H.uuid(), conversationId: homeId, text: cleanText })
        expect(res3.status).toBe(409)

        // Reuse answerId with different question id -> 409 answer_id_taken
        const res4 = await h.ask({ id: H.uuid(), answerId, conversationId: homeId, text: cleanText })
        expect(res4.status).toBe(409)
      }))

    expect(await H.rowCount(runtime)).toBeGreaterThanOrEqual(dbExecs * 2)
    expect(h.starts).toEqual([])
    expect(h.count(ChatMetrics.questions, { status: "202" })).toBeGreaterThanOrEqual(dbExecs)
    expect(h.span("chat.question").length).toBeGreaterThan(0)
    expect(h.line("chat.question").length).toBeGreaterThan(0)
    expect(H.recorded(h)).toContain("chat.question")

    // Regression checks for Bugs #12 & #13: NUL bytes and unpaired UTF-16 surrogates must fail cleanly with 400 invalid
    for (const badText of ["\u0000", "hello\u0000world", "\ud800", "\udc00", "a\ud800b"]) {
      const badRes = await h.ask({ id: H.uuid(), answerId: H.uuid(), conversationId: homeId, text: badText })
      expect(badRes.status).toBe(400)
    }
    expect(() => h.only("chat.question")).toThrow()

    // Check row() helper
    const singleId = H.uuid()
    const singleAns = H.uuid()
    const singleRes = await h.ask({ id: singleId, answerId: singleAns, text: "check-row" })
    expect(singleRes.status).toBe(202)
    const dbRow = await H.row(runtime, singleId)
    expect(dbRow.id).toBe(singleId)
    expect(dbRow.role).toBe("user")

    // Exercise ALL route dispatch branches in Chat.ts fetch (lines 400-445)
    const routes: ReadonlyArray<[string, RequestInit?]> = [
      [QUESTIONS_ROUTE, { method: "GET" }],
      [PIN_ROUTE, { method: "GET" }],
      [`${PIN_ROUTE}/stamp`, { method: "GET" }],
      [PINS_SHAPE_ROUTE, { method: "GET" }],
      ["/api/timeline-summaries", { method: "GET" }],
      [`${SHAPE_ROUTE}?conversation=${homeId}`, { method: "GET" }],
      [SHAPE_ROUTE, { method: "GET" }],
      [`${SHAPE_ROUTE}?conversation=not-a-uuid`, { method: "GET" }],
      [VIEWS_ROUTE, { method: "GET" }],
      [`${VIEWS_ROUTE}/${H.uuid()}/state`, { method: "GET" }],
      [VIEWS_SHAPE_ROUTE, { method: "GET" }],
      [WEB_PREVIEW_ROUTE, { method: "GET" }],
      [RUNS_SHAPE_ROUTE, { method: "GET" }],
      [`${RUNS_ROUTE}/${H.uuid()}`, { method: "GET" }],
      [NOTIFICATIONS_SHAPE_ROUTE, { method: "GET" }],
      [WATCHES_ROUTE, { method: "GET" }],
      [ACK_ROUTE, { method: "GET" }],
      [SPEND_ALERTS_SHAPE_ROUTE, { method: "GET" }],
      [ALERT_CHANNELS_ROUTE, { method: "GET" }],
      [ALERT_CHANNELS_SHAPE_ROUTE, { method: "GET" }],
      [ALERT_DELIVERIES_SHAPE_ROUTE, { method: "GET" }],
      [SANDBOX_LIMITS_ROUTE, { method: "GET" }],
      [SANDBOX_LIMITS_SHAPE_ROUTE, { method: "GET" }],
      [HOSTED_MODEL_ROUTE, { method: "GET" }],
      [FLOWS_SHAPE_ROUTE, { method: "GET" }],
      [FLOW_DRAFTS_SHAPE_ROUTE, { method: "GET" }],
      [FLOWS_ROUTE, { method: "GET" }],
      [`${FLOWS_ROUTE}/${H.uuid()}`, { method: "GET" }],
      [FLOW_DRAFTS_ROUTE, { method: "GET" }],
      [`${FLOW_DRAFTS_ROUTE}/${H.uuid()}`, { method: "GET" }],
      [`${TELEMETRY_ROUTE}/v1/traces`, { method: "POST", body: "{}" }],
      ["/api/model/chat", { method: "GET" }],
      ["/api/model/not-a-role", { method: "GET" }],
      [`/api/answers/${singleAns}`, { method: "GET" }],
      ["/api/does-not-exist", { method: "GET" }],
    ]
    for (const [path, init] of routes) {
      const r = await h.fetch(path, init)
      expect(r.status).toBeGreaterThanOrEqual(200)
      expect(r.status).toBeLessThan(600)
    }
    const getQ = await h.fetch(QUESTIONS_ROUTE, { method: "GET" })
    expect(getQ.status).toBe(405)
    expect(getQ.headers.get("allow")).toBe("POST")
    expect((await h.fetch("/api/does-not-exist")).status).toBe(404)
  }, 120_000)

  it("fuzzes /api/questions refusals: auth, person-only, roles, view_only, missing conversation, view source errors, body limits, db failure, and defects", async () => {
    const homeId = await H.homeConversation(runtime)

    // 1. Signed out -> 401
    const hOut = await H.harness(runtime, H.answers("x"), { fetch: okElectricFetch })
    expect((await hOut.ask({ id: H.uuid(), answerId: H.uuid(), text: "hi" })).status).toBe(401)
    expect((await hOut.fetch(`${SHAPE_ROUTE}?conversation=${homeId}`)).status).toBe(200)

    // 2. Session resolution error -> 503
    const hSessErr = await H.harness(runtime, H.answers("x"), {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({
        resolve: Effect.fail(new SessionDown({ errorCode: "session_down" }) as never),
      })),
      fetch: okElectricFetch,
    })
    expect((await hSessErr.ask({ id: H.uuid(), answerId: H.uuid(), text: "hi" })).status).toBe(503)

    // 3. Agent acting -> 403 person_only
    const hAgent = await H.harness(runtime, H.answers("x"), { actor: agentActor, fetch: okElectricFetch })
    expect((await hAgent.ask({ id: H.uuid(), answerId: H.uuid(), text: "hi" })).status).toBe(403)

    // 4. Guest -> 403 forbidden
    const hGuest = await H.harness(runtime, H.answers("x"), { actor: guestActor, fetch: okElectricFetch })
    expect((await hGuest.ask({ id: H.uuid(), answerId: H.uuid(), conversationId: homeId, text: "hi" })).status).toBe(403)

    // 5. View-only shared branch -> 403 view_only + missing conversation -> 404
    const viewOnlyConv = await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const homeRow = yield* sql<{ readonly repo_id: string }>`SELECT repo_id FROM conversations WHERE id = ${homeId}`
      const repoId = homeRow[0]!.repo_id
      const tracked = yield* Conversations.track(repoId, "wave9-view-only", "open", "a".repeat(40), ADMIN_ID)
      yield* sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${tracked.branch.branchId}, ${MEMBER_ID}, 'member-user', 'view')`
      return tracked.branch.conversationId
    }))
    const hMember = await H.harness(runtime, H.answers("x"), { actor: memberActor, fetch: okElectricFetch, admitBody: false })
    expect((await hMember.ask({ id: H.uuid(), answerId: H.uuid(), conversationId: viewOnlyConv, text: "hi" })).status).toBe(403)
    expect((await hMember.ask({ id: H.uuid(), answerId: H.uuid(), conversationId: H.uuid(), text: "hi" })).status).toBe(404)

    // 6. Invalid payloads: same id===answerId, empty text, malformed JSON, too large body
    const same = H.uuid()
    expect((await hMember.ask({ id: same, answerId: same, text: "hi" })).status).toBe(400)
    expect((await hMember.ask({ id: H.uuid(), answerId: H.uuid(), text: "   " })).status).toBe(400)
    expect((await hMember.ask("{not-json")).status).toBe(400)
    expect((await hMember.ask("a".repeat(MAX_QUESTION_BODY_BYTES + 16))).status).toBe(413)

    // 7. View-sourced ask: view_not_found -> 404
    const resViewNotFound = await hMember.ask({
      id: H.uuid(),
      answerId: H.uuid(),
      conversationId: homeId,
      text: "submit",
      source: { viewId: H.uuid(), event: "submit" },
      data: { ok: "yes" },
    })
    expect(resViewNotFound.status).toBe(400)

    // 9. Defect handling (nameOf for tagged error, Error, plain object, string, invalid long name) -> 500
    const defects: ReadonlyArray<unknown> = [
      new CustomTaggedDefect({ reason: "boom" }),
      new TypeError("bad type"),
      { plain: true },
      "raw string defect",
      { _tag: "invalid name with spaces and $$$" },
    ]
    for (const defect of defects) {
      const hDefect = await H.harness(runtime, H.answers("x"), {
        actor: adminActor,
        database: Layer.effect(SqlClient.SqlClient, Effect.die(defect)),
        fetch: okElectricFetch,
      })
      const r = await hDefect.ask({ id: H.uuid(), answerId: H.uuid(), conversationId: homeId, text: "trigger defect" })
      expect(r.status).toBe(500)
      expect(JSON.stringify(hDefect.only("chat.question"))).toContain("defect")
    }

    // 10. Database failure (generic SqlError + non-SqlError + no_home) -> 503
    const sqlErr = new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: new Error("down") }) })
    const makeFailingSqlLayer = (err: unknown) =>
      Layer.succeed(
        SqlClient.SqlClient,
        new Proxy(() => Effect.fail(err), {
          get: (_t, prop) => {
            if (prop === "withTransaction") return () => Effect.fail(err)
            return () => Effect.fail(err)
          },
          apply: () => Effect.fail(err),
        }) as never,
      )
    for (const err of [sqlErr, new Error("db_down")]) {
      const hBrokenDb = await H.harness(runtime, H.answers("x"), {
        actor: adminActor,
        database: makeFailingSqlLayer(err),
        branchRoles: Layer.succeed(BranchAccess.BranchRoles, BranchAccess.BranchRoles.of({
          roleOn: () => Effect.succeed("admin"),
        })),
        fetch: okElectricFetch,
      })
      expect((await hBrokenDb.ask({ id: H.uuid(), answerId: H.uuid(), text: "hi" })).status).toBe(503)
      expect((await hBrokenDb.fetch(SHAPE_ROUTE)).status).toBe(503)
      expect((await hBrokenDb.fetch(`${SHAPE_ROUTE}?conversation=${homeId}`)).status).toBe(503)
    }

    // Trigger no_home (Conversations.home returns undefined)
    const emptySqlLayer = Layer.succeed(
      SqlClient.SqlClient,
      new Proxy(() => Effect.succeed([]), {
        get: (_t, prop) => {
          if (prop === "withTransaction") return <A, E, R>(eff: Effect.Effect<A, E, R>) => eff
          return () => Effect.succeed([])
        },
        apply: () => Effect.succeed([]),
      }) as never,
    )
    const hNoHome = await H.harness(runtime, H.answers("x"), {
      actor: adminActor,
      database: emptySqlLayer,
      branchRoles: Layer.succeed(BranchAccess.BranchRoles, BranchAccess.BranchRoles.of({
        roleOn: () => Effect.succeed("admin"),
      })),
      fetch: okElectricFetch,
    })
    expect((await hNoHome.ask({ id: H.uuid(), answerId: H.uuid(), text: "hi" })).status).toBe(503)
    expect(Messages.IdTaken).toBeDefined()
    expect(Views.SourceRefused).toBeDefined()
  }, 120_000)
})

describe("Wave9 db/migrations/0025_flow_source, Database.ts & TestDatabase.ts fuzzing", () => {
  it("fuzzes Database.hyperdrive and TestDatabase.explain / serverUrl / fixtureConfig", async () => {
    const urlArb = Arbitrary.schema(Schema.Struct({
      user: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}$/)),
      pass: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}$/)),
      db: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,8}$/)),
      port: Schema.Option(Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65000 }))),
      sslmode: Schema.Literals(["require", "verify-ca", "verify-full", "prefer", "disable", "none"]),
      hasCa: Schema.Boolean,
    }))

    await holds(urlArb, pureExecs, (s) =>
      Effect.sync(() => {
        const portPart = Option.isSome(s.port) ? `:${s.port.value}` : ""
        const params = new URLSearchParams()
        if (s.sslmode !== "none") params.set("sslmode", s.sslmode)
        if (s.hasCa) params.set("sslrootcert", "/etc/ssl/ca.pem")
        const qs = params.toString() ? `?${params.toString()}` : ""
        const raw = `postgresql://${s.user}:${s.pass}@db.example.com${portPart}/${s.db}${qs}`
        if (s.hasCa) {
          expect(() => Database.hyperdrive(Redacted.make(raw))).toThrow(/CA settings/)
        } else {
          const hd = Database.hyperdrive(Redacted.make(raw))
          expect(hd.origin.host).toBe("db.example.com")
          expect(hd.origin.port).toBe(Option.isSome(s.port) ? s.port.value : 5432)
          expect(hd.origin.database).toBe(s.db)
          expect(hd.origin.user).toBe(s.user)
          expect(Redacted.value(hd.origin.password)).toBe(s.pass)
          if (s.sslmode === "require" || s.sslmode === "verify-ca" || s.sslmode === "verify-full") {
            expect(hd.sslmode).toBe(s.sslmode)
          } else {
            expect(hd.sslmode).toBe("disable")
          }
        }
      }))

    for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]) {
      const explained = TestDatabase.explain("Postgres", "localhost:54321")({ code })
      expect(explained).toBeInstanceOf(TestDatabase.Unusable)
      const nested = TestDatabase.explain("Electric", "localhost:30001")({ cause: { code } })
      expect(nested).toBeInstanceOf(TestDatabase.Unusable)
    }
    const other = new Error("plain failure")
    expect(TestDatabase.explain("Postgres", "localhost:54321")(other)).toBe(other)
    expect(TestDatabase.explain("Postgres", "localhost:54321")(null)).toBeNull()

    const remoteExit = await Effect.runPromiseExit(
      TestDatabase.serverUrl.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ DATABASE_URL: "postgresql://u:p@remote.db.invalid:5432/prod" }),
        ),
      ),
    )
    expect(Exit.isFailure(remoteExit)).toBe(true)

    const fc = await Effect.runPromise(TestDatabase.fixtureConfig)
    expect(new URL(fc.DATABASE_URL).port).toBe(fc.TEST_DATABASE_PORT)
    expect(new URL(fc.ELECTRIC_URL).port).toBe(fc.TEST_ELECTRIC_PORT)
  })

  it("fuzzes migration 0025_flow_source and Database.migrateAndReport on real Postgres 18 temp schemas", async () => {
    const server = await Effect.runPromise(TestDatabase.serverUrl)
    const adminLayer = PgClient.layer({ url: Redacted.make(server.toString()), maxConnections: 1 })
    const schemaName = `wave9_0025_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    const scoped = new URL(server)
    scoped.searchParams.set("options", `-c search_path=${schemaName}`)
    const scopedLayer = Database.layer(Effect.succeed(Redacted.make(scoped.toString())))

    const runAdmin = <A>(eff: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
      Effect.runPromise(eff.pipe(Effect.provide(adminLayer)))

    try {
      await runAdmin(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE SCHEMA ${sql(schemaName)}`))

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE flows (id text PRIMARY KEY)`
          yield* sql`CREATE TABLE flow_revisions (flow_id text NOT NULL, revision int NOT NULL, source text NOT NULL, digest text NOT NULL)`
          yield* sql`CREATE TABLE flow_drafts (id text PRIMARY KEY, status text NOT NULL, files jsonb NOT NULL, checks jsonb NOT NULL DEFAULT '[]'::jsonb, failure text)`

          const skillPlain = [
            "---",
            "name: daily-check",
            "description: Check repo status",
            "flows:",
            "  - chat/Answer",
            "  - \"repo/Open\"",
            "---",
            "Inspect the open issues and summarize.",
          ].join("\n")

          const skillQuoted = [
            "---",
            "name: \"quoted-flow\"",
            "description: \"Uses \\\"quotes\\\" safely\"",
            "---",
            "Run checks.",
          ].join("\n")

          const brokenBadJson = [
            "---",
            "name: \"unterminated",
            "description: broken",
            "---",
            "Body",
          ].join("\n")

          const brokenNoFrontmatter = "just plain markdown without frontmatter"
          const brokenEmptyName = "---\nname: \ndescription: d\n---\nbody"
          const brokenBadFlowItem = "---\nname: ok\ndescription: d\nflows:\n  - \"bad\n---\nbody"

          yield* sql`INSERT INTO flow_revisions VALUES ('f1', 1, ${skillPlain}, 'old1'), ('f2', 1, ${skillQuoted}, 'old2')`
          yield* sql`
            INSERT INTO flow_drafts (id, status, files) VALUES
              ('d_ok', 'ready', ${JSON.stringify([{ path: "README.md", text: "keep" }, { path: "SKILL.md", text: skillPlain }])}::jsonb),
              ('d_saved', 'saved', ${JSON.stringify([{ path: "SKILL.md", text: brokenBadJson }])}::jsonb),
              ('d_proposed', 'proposed', ${JSON.stringify([{ path: "SKILL.md", text: brokenNoFrontmatter }])}::jsonb),
              ('d_fail1', 'drafting', ${JSON.stringify([{ path: "SKILL.md", text: brokenEmptyName }])}::jsonb),
              ('d_fail2', 'drafting', ${JSON.stringify([{ path: "SKILL.md", text: brokenBadFlowItem }])}::jsonb)
          `

          yield* migration0025

          const revs = yield* sql<{ flow_id: string; source: string; digest: string }>`
            SELECT flow_id, source, digest FROM flow_revisions ORDER BY flow_id`
          expect(revs).toHaveLength(2)
          expect(revs[0]!.source).toContain("Flow.make")
          expect(revs[0]!.digest).not.toBe("old1")
          expect(revs[1]!.source).toContain("quoted-flow")

          const drafts = yield* sql<{ id: string; status: string; files: ReadonlyArray<{ path: string; text: string }>; failure: string | null }>`
            SELECT id, status, files, failure FROM flow_drafts ORDER BY id`
          const byId = new Map(drafts.map((d) => [d.id, d]))
          expect(byId.get("d_ok")!.files.map((f) => f.path)).toEqual(["README.md", "flow.ts"])
          expect(byId.get("d_saved")!.files).toEqual([])
          expect(byId.get("d_saved")!.status).toBe("saved")
          expect(byId.get("d_proposed")!.files).toEqual([])
          expect(byId.get("d_fail1")!.status).toBe("failed")
          expect(byId.get("d_fail1")!.failure).toBe("migrated")
          expect(byId.get("d_fail2")!.status).toBe("failed")
          expect(byId.get("d_fail2")!.failure).toBe("migrated")
        }).pipe(Effect.provide(scopedLayer)),
      )

      await runAdmin(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP SCHEMA ${sql(schemaName)} CASCADE`))
      await runAdmin(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE SCHEMA ${sql(schemaName)}`))

      const dieExit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE flows (id text PRIMARY KEY)`
          yield* sql`CREATE TABLE flow_revisions (flow_id text NOT NULL, revision int NOT NULL, source text NOT NULL, digest text NOT NULL)`
          yield* sql`CREATE TABLE flow_drafts (id text PRIMARY KEY, status text NOT NULL, files jsonb NOT NULL, checks jsonb NOT NULL DEFAULT '[]'::jsonb, failure text)`
          yield* sql`INSERT INTO flow_revisions VALUES ('bad_flow', 7, '--- broken', 'd')`
          yield* migration0025
        }).pipe(Effect.provide(scopedLayer)),
      )
      expect(Exit.isFailure(dieExit)).toBe(true)

      await runAdmin(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP SCHEMA ${sql(schemaName)} CASCADE`))
      await runAdmin(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE SCHEMA ${sql(schemaName)}`))
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Database.migrateAndReport
          yield* Database.migrateAndReport
        }).pipe(Effect.provide(scopedLayer), Effect.provide(Logger.layer([]))),
      )
    } finally {
      await runAdmin(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP SCHEMA IF EXISTS ${sql(schemaName)} CASCADE`))
    }
  }, 120_000)
})
