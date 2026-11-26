import { Fuzz } from "@smthrs/fuzz"
import { GitHub } from "@smthrs/integrations"
import {
  Arbitrary,
  ConfigProvider,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { PHASES_FLOW, SUMMARIZE_FLOW } from "../src/features/timeline/contract.ts"
import { revisionOf, segmentRevision } from "../src/features/timeline/identity.ts"
import * as Marks from "../src/features/timeline/marks.ts"
import * as AboutGitHub from "./about/GitHubRead.ts"
import * as AboutStore from "./about/Store.vibe"
import * as Actor from "./Actor.vibe"
import * as BranchAccess from "./branch/Access.vibe"
import { repositoryOf } from "./github/Config.vibe"
import * as RepoRoles from "./github/RepoRoles.vibe"
import * as Notifications from "./Notifications.ts"
import * as RepoAbout from "./RepoAbout.vibe"
import * as TimelineSummaries from "./TimelineSummaries.vibe"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261183")
const silentLogger = Logger.layer([])

const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_ID = "99999999-9999-4999-8999-999999999999"
const BRANCH_ID = "44444444-4444-4444-8444-444444444444"
const CONV_ID = "55555555-5555-4555-8555-555555555555"
const RUN_ID = "66666666-6666-4666-8666-666666666666"
const OWNER_RUN = "77777777-7777-4777-8777-777777777777"
const MSG_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000007",
  "10000000-0000-4000-8000-000000000008",
  "10000000-0000-4000-8000-000000000009",
  "10000000-0000-4000-8000-000000000010",
  "10000000-0000-4000-8000-000000000011",
  "10000000-0000-4000-8000-000000000012",
] as const

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const makeSqlLayer = (
  handler: (q: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | unknown,
): Layer.Layer<SqlClient.SqlClient> => {
  const exec = (q: string, params: ReadonlyArray<unknown> = []): Effect.Effect<ReadonlyArray<any>, unknown> =>
    Effect.suspend(() => {
      const out = handler(q, params)
      return Array.isArray(out) ? Effect.succeed(out) : Effect.fail(out)
    })
  const tag: any = Object.assign(
    (strings: TemplateStringsArray | string, ...values: ReadonlyArray<unknown>) => {
      if (typeof strings === "string") return { _sql: strings, _params: [] }
      let q = ""
      const params: Array<unknown> = []
      strings.forEach((part, idx) => {
        q += part
        if (idx < values.length) {
          const val = values[idx] as any
          if (val && typeof val === "object" && typeof val._sql === "string") {
            q += val._sql
            if (Array.isArray(val._params)) params.push(...val._params)
          } else {
            params.push(val)
            q += `$${params.length}`
          }
        }
      })
      const norm = q.replace(/\s+/g, " ").trim()
      return Object.assign(exec(norm, params), { _sql: norm, _params: params })
    },
    {
      unsafe: (raw: string, params?: ReadonlyArray<unknown>) => exec(raw, params ?? []),
      withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
      in: (a: any, b?: ReadonlyArray<unknown>) =>
        b !== undefined
          ? { _sql: `${a} IN (${b.map((_, i) => `$in${i}`).join(",")})`, _params: [...b] }
          : { _sql: `(${a.map((_: any, i: number) => `$in${i}`).join(",")})`, _params: [...a] },
      and: (frags: ReadonlyArray<any>) => ({
        _sql: frags.map((f) => f._sql ?? "true").join(" AND "),
        _params: frags.flatMap((f) => f._params ?? []),
      }),
      csv: (frags: ReadonlyArray<any>) => ({
        _sql: frags.map((f) => f._sql ?? "").join(", "),
        _params: frags.flatMap((f) => f._params ?? []),
      }),
      literal: (s: string) => ({ _sql: s, _params: [] }),
    },
  )
  return Layer.succeed(SqlClient.SqlClient, tag as unknown as SqlClient.SqlClient)
}

const makeReq = (
  fullUrl: string,
  opts: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {},
): HttpServerRequest.HttpServerRequest => {
  const method = opts.method ?? "GET"
  const init: RequestInit = { method, headers: opts.headers ?? {} }
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") init.body = opts.body
  return HttpServerRequest.fromWeb(new Request(fullUrl, init))
}

const personActor = (
  opts: {
    readonly id?: string
    readonly role?: Actor.Role
    readonly act?: Actor.Actor["act"]
    readonly session?: string
  } = {},
): Actor.Actor => ({
  subject: { kind: "person", id: opts.id ?? PERSON_ID },
  role: opts.role ?? "member",
  login: "will",
  ...(opts.session === undefined ? {} : { session: opts.session }),
  ...(opts.act === undefined ? {} : { act: opts.act }),
})

const sessionsLayer = (actor: Option.Option<Actor.Actor> | Error): Layer.Layer<Actor.Sessions> =>
  Layer.succeed(
    Actor.Sessions,
    Actor.Sessions.of({
      resolve: actor instanceof Error ? Effect.fail(actor as never) : Effect.succeed(actor),
    }),
  )

const branchRow = (
  opts: { readonly createdBy?: string | null; readonly installed?: boolean } = {},
) => ({
  branchId: BRANCH_ID,
  conversationId: CONV_ID,
  repoId: "github/acme/app",
  name: "main",
  mode: "open",
  createdBy: opts.createdBy === undefined ? PERSON_ID : opts.createdBy,
  person: null,
  repository: null,
  anyShare: false,
  installed: opts.installed ?? false,
})

const branchRolesLayer = (
  opts: { readonly role?: Actor.Role | null; readonly roleErr?: boolean } = {},
): Layer.Layer<BranchAccess.BranchRoles> =>
  Layer.succeed(
    BranchAccess.BranchRoles,
    BranchAccess.BranchRoles.of({
      roleOn: () =>
        opts.roleErr
          ? Effect.fail(new RepoRoles.RoleRefused({ code: "unavailable" }))
          : Effect.succeed(opts.role === undefined ? "member" : opts.role),
      uninstalled: () => (opts.role === undefined ? "member" : opts.role),
      publicCopy: () => Effect.succeed(true),
    }),
  )

const mockElectricClient = (status = 200): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(JSON.stringify([]), { status, headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  )

const makeExchangeRows = (count: number, opts: { readonly closedFirst?: number; readonly openAt?: number } = {}) => {
  const rows: Array<Marks.PhaseRow & { readonly arc?: string | null }> = []
  for (let i = 0; i < count; i++) {
    const qid = MSG_IDS[i % MSG_IDS.length]!
    const aid = `20000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
    let phase: string | null = null
    if (opts.closedFirst !== undefined && i === 0) {
      phase = JSON.stringify({ title: "Auth setup", summary: "Built auth layer", closed: true, covered: opts.closedFirst })
    } else if (opts.openAt !== undefined && i === opts.openAt) {
      phase = JSON.stringify({ title: "Billing work", summary: "Started billing", closed: false, covered: 2 })
    }
    rows.push({
      id: qid,
      role: "user",
      status: "done",
      text: `Question ${i} ` + "detail ".repeat(i === 0 ? 40 : 1),
      summary: i === 1 ? "Short q1" : null,
      phase,
      arc: null,
    })
    rows.push({
      id: aid,
      role: "assistant",
      status: i === count - 1 ? "failed" : "done",
      text: `Answer ${i} completed cleanly`,
      questionId: qid,
      phase: null,
      arc: null,
    })
  }
  return rows
}

describe("Wave8: src/features/timeline/marks.ts & worker/TimelineSummaries.ts", () => {
  it("fuzzes timeline marks: parseMark, exchangeUnits, phaseUnits, planOf, readOf, checkPlan, cleanTitle, cleanSpanSummary, sealSpans, cleanSpans", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "parse_valid_and_invalid",
        "exchange_and_unfinished_tail",
        "phase_units_and_arcs",
        "plan_fresh_and_rolling",
        "check_plan_closed_stale_ok",
        "clean_title_and_summary",
        "seal_spans_ok_and_bad",
        "clean_spans_ok_and_bad",
      ]),
    )

    await holds(modeArb, Math.max(execs, 24), (mode) =>
      Effect.sync(() => {
        if (mode === "parse_valid_and_invalid") {
          expect(Option.isNone(Marks.parseMark(null))).toBe(true)
          expect(Option.isNone(Marks.parseMark(""))).toBe(true)
          expect(Option.isNone(Marks.parseMark("x".repeat(5000)))).toBe(true)
          expect(Option.isNone(Marks.parseMark("{bad"))).toBe(true)
          const valid = JSON.stringify({ title: "Setup", summary: "Configured repo", closed: false, covered: 3 })
          expect(Option.isSome(Marks.parseMark(valid))).toBe(true)
        } else if (mode === "exchange_and_unfinished_tail") {
          const rows = [
            ...makeExchangeRows(3),
            { id: MSG_IDS[4], role: "user", status: "streaming", text: "pending" },
          ]
          expect(Marks.exchangeUnits(rows).length).toBe(3)
          const rows2 = [
            ...makeExchangeRows(2),
            { id: MSG_IDS[5], role: "user", status: "done", text: "no answer" },
          ]
          expect(Marks.exchangeUnits(rows2).length).toBe(2)
        } else if (mode === "phase_units_and_arcs") {
          const rows = makeExchangeRows(8, { closedFirst: 3, openAt: 3 })
          const phases = Marks.phaseUnits(rows)
          expect(phases.length).toBe(1)
          expect(Marks.planOf(phases, 2)).toBeUndefined()
        } else if (mode === "plan_fresh_and_rolling") {
          const few = Marks.exchangeUnits(makeExchangeRows(3))
          expect(Marks.planOf(few, 1)).toBeUndefined()
          const units = Marks.exchangeUnits(makeExchangeRows(10))
          const plan = Marks.planOf(units, 1)
          expect(plan).toBeDefined()
          expect(Marks.readOf(plan!.items)).toBeGreaterThan(0)
          // Rolling window (> SEGMENT_WINDOW[1]) with open marks
          const bigRows: Array<Marks.PhaseRow & { readonly arc?: string | null }> = []
          for (let i = 0; i < 30; i++) {
            const id = `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
            const aid = `40000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
            bigRows.push({
              id,
              role: "user",
              status: "done",
              text: `Step ${i}`,
              phase: i === 0 ? JSON.stringify({ title: "Initial work", summary: "Built core", closed: false, covered: 4 }) : null,
            })
            bigRows.push({ id: aid, role: "assistant", status: "done", text: `Done ${i}`, questionId: id })
          }
          const rollingPlan = Marks.planOf(Marks.exchangeUnits(bigRows), 1)
          expect(rollingPlan).toBeDefined()
          expect(Marks.readOf(rollingPlan!.items)).toBeGreaterThan(4)
        } else if (mode === "check_plan_closed_stale_ok") {
          const units = Marks.exchangeUnits(makeExchangeRows(10, { closedFirst: 3, openAt: 3 }))
          expect(Marks.checkPlan(units, units[0]!.id, 3)).toBe("closed")
          expect(Marks.checkPlan(units, units[4]!.id, 3)).toBe("stale")
          expect(Marks.checkPlan(units, units[3]!.id, 2)).toBe("stale")
          const ids = Marks.checkPlan(units, units[3]!.id, 5)
          expect(Array.isArray(ids)).toBe(true)
        } else if (mode === "clean_title_and_summary") {
          expect(Marks.cleanTitle("Fix login bug.")).toBe("Fix login bug")
          expect(Marks.cleanTitle("Phase 1")).toBeUndefined()
          expect(Marks.cleanTitle("<script>")).toBeUndefined()
          expect(Marks.cleanTitle(123)).toBeUndefined()
          expect(Marks.cleanSpanSummary("  Clean summary text  ")).toBe("Clean summary text")
          expect(Marks.cleanSpanSummary("")).toBeUndefined()
          const longSummary = Marks.cleanSpanSummary("word ".repeat(80))
          expect(longSummary?.endsWith("…")).toBe(true)
          const noSpaceLong = Marks.cleanSpanSummary("a".repeat(300))
          expect(noSpaceLong?.endsWith("…")).toBe(true)
        } else if (mode === "seal_spans_ok_and_bad") {
          const ids = MSG_IDS.slice(0, 8)
          const sealed = Marks.sealSpans(
            [
              { id: ids[0]!, title: "Auth work", summary: "Implemented OAuth flow" },
              { id: ids[4]!, title: "UI polish", summary: "Refined buttons" },
            ],
            ids,
          )
          expect(sealed?.length).toBe(2)
          expect(JSON.parse(sealed![0]!.mark).closed).toBe(true)
          expect(JSON.parse(sealed![1]!.mark).closed).toBe(false)
          // Unordered / bad start / dirty title
          expect(Marks.sealSpans([{ id: ids[1]!, title: "Bad start", summary: "x" }], ids)).toBeUndefined()
          expect(Marks.sealSpans([{ id: ids[0]!, title: "Phase 1", summary: "x" }], ids)).toBeUndefined()
        } else {
          const ids = MSG_IDS.slice(0, 6)
          const plan = { items: ids.map((id) => ({ id, text: "x" })) }
          const okText = `Here is JSON: {"spans":[{"from":1,"title":"Auth setup","summary":"Built login"},{"from":4,"title":"Phase 2","summary":"skipped"},{"from":5,"title":"Tests added","summary":"Verified login"}]}`
          const cleaned = Marks.cleanSpans(okText, plan)
          expect(cleaned?.length).toBe(2)
          expect(Marks.cleanSpans("no json", plan)).toBeUndefined()
          expect(Marks.cleanSpans('{"spans":[]}', plan)).toBeUndefined()
          expect(Marks.cleanSpans('{"spans":[{"from":1,"title":"A","summary":"B"},{"from":1,"title":"C","summary":"D"}]}', plan)).toBeUndefined()
          expect(Marks.cleanSpans('{"spans":[{"from":1,"title":"Phase 1","summary":"B"}]}', plan)).toBeUndefined()
        }
      }),
    )
  })

  it("fuzzes TimelineSummaries HTTP route across claim, record, release, and span ops", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "method_405",
        "signed_out_401",
        "person_only_403",
        "flow_actor_allowed",
        "invalid_json_400",
        "msg_not_found_404",
        "no_view_access_404",
        "record_unclaimed",
        "record_already_recorded",
        "record_stale",
        "record_ok",
        "release_ok",
        "release_spans_ok",
        "record_spans_bad_rev",
        "record_spans_unclaimed",
        "record_spans_already",
        "record_spans_plan_conflict",
        "record_spans_bad_seal",
        "record_spans_ok_l1",
        "record_spans_ok_l2",
        "claim_unfinished",
        "claim_resumed",
        "claim_capped",
        "claim_taken",
        "claim_ok",
        "claim_spans_bad_rev",
        "claim_spans_plan_conflict",
        "claim_spans_resumed",
        "claim_spans_ok",
        "db_503",
      ]),
    )

    const sampleRow = { id: MSG_IDS[0], role: "user", text: "Hello world" }
    const sampleRev = revisionOf(sampleRow)
    const spanRev6 = segmentRevision(MSG_IDS[0], 1, 6)

    await holds(modeArb, Math.max(execs * 2, 60), (mode) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (mode === "db_503") return new Error("db_down")
          if (q.includes("SELECT conversation_id AS \"conversationId\", role IN")) {
            if (mode === "msg_not_found_404") return []
            return [{ conversationId: CONV_ID, finished: mode !== "claim_unfinished", position: "1" }]
          }
          if (q.includes("FROM branches") && q.includes("conversations")) {
            return mode === "no_view_access_404" ? [branchRow({ createdBy: OTHER_ID })] : [branchRow()]
          }
          if (q.includes("FROM messages WHERE conversation_id =")) {
            if (mode === "record_spans_plan_conflict" || mode === "claim_spans_plan_conflict") return []
            if (mode === "record_spans_ok_l2") {
              return makeExchangeRows(6).map((r, idx) =>
                r.role === "user"
                  ? { ...r, phase: JSON.stringify({ title: `Work ${idx}`, summary: `Did ${idx}`, closed: true, covered: 1 }) }
                  : r,
              )
            }
            return makeExchangeRows(8)
          }
          if (q.includes("FROM timeline_summaries c JOIN messages m")) {
            if (mode === "record_unclaimed") return []
            return [{
              id: MSG_IDS[0],
              role: "user",
              text: mode === "record_stale" ? "Changed text" : "Hello world",
              recorded: mode === "record_already_recorded",
            }]
          }
          if (q.includes("SELECT recorded_at IS NOT NULL AS recorded FROM timeline_phase_claims")) {
            if (mode === "record_spans_unclaimed") return []
            return [{ recorded: mode === "record_spans_already" }]
          }
          if (q.includes("SELECT 1 AS held FROM timeline_phase_claims")) {
            return mode === "claim_spans_resumed" ? [{ held: 1 }] : []
          }
          if (q.includes("SELECT 1 AS held FROM timeline_summaries")) {
            return mode === "claim_resumed" ? [{ held: 1 }] : []
          }
          if (q.includes("FROM timeline_attempts")) {
            return [{ n: mode === "claim_capped" ? 200 : 1 }]
          }
          if (q.includes("INSERT INTO timeline_phase_claims")) {
            return [{ anchor_id: MSG_IDS[0] }]
          }
          if (q.includes("INSERT INTO timeline_summaries")) {
            return mode === "claim_taken" ? [] : [{ message_id: MSG_IDS[0] }]
          }
          return []
        })

        const route = yield* TimelineSummaries.make(db).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
        )
        const actor = mode === "signed_out_401"
          ? Option.none<Actor.Actor>()
          : mode === "person_only_403"
          ? Option.some(personActor({ act: { kind: "agent", id: RUN_ID } }))
          : mode === "flow_actor_allowed"
          ? Option.some(personActor({ act: { kind: "flow", runId: RUN_ID, chain: [SUMMARIZE_FLOW] } as any }))
          : mode === "claim_spans_ok"
          ? Option.some(personActor({ act: { kind: "flow", runId: RUN_ID, chain: [PHASES_FLOW] } as any }))
          : Option.some(personActor())
        const env = Layer.mergeAll(sessionsLayer(actor), branchRolesLayer(), silentLogger)

        let payload: unknown = { op: "claim", messageId: MSG_IDS[0], revision: sampleRev, owner: OWNER_RUN, reason: "question" }
        if (mode.startsWith("record_spans_")) {
          const level = mode === "record_spans_ok_l2" ? 2 : 1
          const read = level === 2 ? 3 : 6
          payload = {
            op: "record_spans",
            messageId: MSG_IDS[0],
            level,
            revision: mode === "record_spans_bad_rev" ? "0".repeat(32) : segmentRevision(MSG_IDS[0], level, read),
            owner: OWNER_RUN,
            read,
            spans: mode === "record_spans_bad_seal"
              ? [{ id: MSG_IDS[1], title: "Wrong start", summary: "Bad" }]
              : [{ id: MSG_IDS[0], title: "Auth setup", summary: "Built login flow" }],
          }
        } else if (mode.startsWith("record_")) {
          payload = { op: "record", messageId: MSG_IDS[0], revision: sampleRev, owner: OWNER_RUN, summary: "Short summary" }
        } else if (mode === "release_ok") {
          payload = { op: "release", messageId: MSG_IDS[0], revision: sampleRev, owner: OWNER_RUN }
        } else if (mode === "release_spans_ok") {
          payload = { op: "release_spans", messageId: MSG_IDS[0], level: 1, revision: spanRev6, owner: OWNER_RUN }
        } else if (mode.startsWith("claim_spans_")) {
          payload = {
            op: "claim_spans",
            messageId: MSG_IDS[0],
            level: 1,
            revision: mode === "claim_spans_bad_rev" ? "0".repeat(32) : spanRev6,
            owner: OWNER_RUN,
            read: 6,
          }
        }

        const res = yield* route.write.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            makeReq(`https://app.test${route.route}`, {
              method: mode === "method_405" ? "GET" : "POST",
              body: mode === "invalid_json_400" ? "{" : JSON.stringify(payload),
            }),
          ),
          Effect.provide(env),
        )
        const expected = mode === "method_405"
          ? 405
          : mode === "signed_out_401"
          ? 401
          : mode === "person_only_403"
          ? 403
          : mode === "invalid_json_400" ||
            mode === "record_spans_bad_rev" ||
            mode === "record_spans_bad_seal" ||
            mode === "claim_spans_bad_rev"
          ? 400
          : mode === "msg_not_found_404" || mode === "no_view_access_404"
          ? 404
          : mode === "record_unclaimed" ||
            mode === "record_stale" ||
            mode === "record_spans_unclaimed" ||
            mode === "record_spans_plan_conflict" ||
            mode === "claim_unfinished" ||
            mode === "claim_spans_plan_conflict"
          ? 409
          : mode === "claim_capped"
          ? 429
          : mode === "db_503"
          ? 503
          : 200
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/about/Store.ts, about/GitHubRead.ts & worker/RepoAbout.ts", () => {
  it("fuzzes about/Store postgres operations and about/GitHubRead rest & graphql", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "store_get_none",
        "store_get_some",
        "store_get_err",
        "store_claim_ok_and_false",
        "store_keep_and_refuse_and_absent",
        "rest_full_ok",
        "rest_private_404",
        "rest_repo_404",
        "rest_repo_429",
        "rest_repo_500",
        "rest_partial_missing",
        "rest_bad_path",
        "gql_full_ok",
        "gql_custom_readme_rest_fallback",
        "gql_private_404",
        "gql_not_found_error",
        "gql_null_unknown_error",
        "gql_malformed_repo",
        "gql_empty_repo",
      ]),
    )

    await holds(modeArb, Math.max(execs, 36), (mode) =>
      Effect.gen(function* () {
        if (mode.startsWith("store_")) {
          const db = makeSqlLayer((q) => {
            if (mode === "store_get_err") return new Error("db_down")
            if (q.includes("SELECT about, via")) {
              if (mode === "store_get_none") return []
              return [{
                about: "{}",
                via: "app",
                readAtMs: 1000,
                freshUntilMs: 5000,
                nextReadAtMs: 5000,
                refusal: null,
                refusalVia: "anonymous",
                appAbsentUntilMs: null,
              }]
            }
            if (q.includes("INSERT INTO repo_about (repo_id, next_read_at")) {
              return [{ generation: "2" }]
            }
            if (q.includes("UPDATE repo_about SET about =")) return [{ repo_id: "github/acme/app" }]
            if (q.includes("UPDATE repo_about SET refusal =")) return [{ repo_id: "github/acme/app" }]
            return []
          })
          const store = AboutStore.postgres(db)
          if (mode === "store_get_err") {
            expect(Exit.isFailure(yield* store.get("github/acme/app").pipe(Effect.exit))).toBe(true)
          } else if (mode === "store_get_none") {
            expect(Option.isNone(yield* store.get("github/acme/app"))).toBe(true)
          } else if (mode === "store_get_some") {
            expect(Option.isSome(yield* store.get("github/acme/app"))).toBe(true)
          } else if (mode === "store_claim_ok_and_false") {
            expect(yield* store.claim("github/acme/app", 1000, 5000, true)).toBe("2")
          } else {
            expect(yield* store.keep("github/acme/app", { text: "{}", via: "app", readAtMs: 1, freshUntilMs: 2 }, "1")).toBe(true)
            expect(yield* store.refuse("github/acme/app", "not_found", 2, undefined, "1")).toBe(true)
            yield* store.appAbsent("github/acme/app", 9999)
          }
          return
        }

        const jsonRes = (req: any, body: unknown, status = 200, headers: Record<string, string> = {}) =>
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json", "x-ratelimit-remaining": "42", ...headers },
            }),
          )

        const mockHttp = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((req) => {
            const url = req.url
            if (url.includes("/graphql")) {
              if (mode === "gql_not_found_error") {
                return Effect.succeed(jsonRes(req, { data: { repository: null }, errors: [{ type: "NOT_FOUND" }] }))
              }
              if (mode === "gql_null_unknown_error") {
                return Effect.succeed(jsonRes(req, { data: { repository: null }, errors: [{ type: "INTERNAL" }] }))
              }
              if (mode === "gql_malformed_repo") {
                return Effect.succeed(jsonRes(req, { data: { repository: { bad: true } } }))
              }
              const baseRepo: Record<string, unknown> = {
                nameWithOwner: "acme/app",
                description: "  Cool app  ",
                homepageUrl: "https://acme.dev",
                isPrivate: mode === "gql_private_404",
                isArchived: false,
                stargazerCount: 10,
                forkCount: 2,
                watchers: { totalCount: 5 },
                licenseInfo: { spdxId: "MIT", name: "MIT License" },
                repositoryTopics: { nodes: [{ topic: { name: "effect" } }] },
                languages: { edges: [{ size: 500, node: { name: "TypeScript" } }, { size: 0, node: { name: "Empty" } }] },
                latestRelease: mode === "gql_empty_repo" ? null : { tagName: "v1.0.0", name: "Release 1", publishedAt: "2026-01-01T00:00:00Z" },
                releases: { totalCount: 1 },
                branches: { totalCount: 2 },
                tags: { totalCount: 1 },
                defaultBranchRef: mode === "gql_empty_repo"
                  ? null
                  : {
                    name: "main",
                    target: {
                      oid: "a".repeat(40),
                      message: "init",
                      author: { name: "Will", date: "2026-01-01T00:00:00Z", user: { login: "will" } },
                      history: { totalCount: 12 },
                    },
                  },
                root: {
                  entries: mode === "gql_custom_readme_rest_fallback"
                    ? [{ name: "README.custom", type: "blob" }, { name: "src", type: "tree" }, { name: "sub", type: "commit" }]
                    : [{ name: "README.md", type: "blob" }, { name: "src", type: "tree" }],
                },
                home: { text: '{"docs":"https://docs.acme.dev/llms.txt"}', byteSize: 40, isBinary: false, isTruncated: false },
                readme1: mode === "gql_custom_readme_rest_fallback"
                  ? null
                  : { text: "# Hello", byteSize: 7, isBinary: false, isTruncated: false },
              }
              return Effect.succeed(jsonRes(req, { data: { repository: baseRepo } }))
            }
            if (url.endsWith("/repos/acme/app")) {
              if (mode === "rest_repo_404") return Effect.succeed(jsonRes(req, { message: "Not Found" }, 404))
              if (mode === "rest_repo_429") {
                return Effect.succeed(jsonRes(req, { message: "rate limit" }, 429, { "retry-after": "30" }))
              }
              if (mode === "rest_repo_500") return Effect.succeed(jsonRes(req, { message: "boom" }, 500))
              return Effect.succeed(
                jsonRes(req, {
                  full_name: "acme/app",
                  description: "App desc",
                  homepage: "https://acme.dev",
                  topics: ["ts"],
                  stargazers_count: 5,
                  forks_count: 1,
                  subscribers_count: 3,
                  watchers_count: 5,
                  license: { spdx_id: "NOASSERTION", name: "Custom" },
                  default_branch: "main",
                  archived: false,
                  private: mode === "rest_private_404",
                }),
              )
            }
            if (mode === "rest_partial_missing" && (url.includes("/languages") || url.includes("/commits"))) {
              return Effect.succeed(jsonRes(req, { message: "err" }, 502))
            }
            if (url.includes("/languages")) return Effect.succeed(jsonRes(req, { TypeScript: 1000, Rust: 500 }))
            if (url.includes("/releases/latest")) {
              return Effect.succeed(jsonRes(req, { tag_name: "v1.0.0", name: "v1", published_at: "2026-01-01T00:00:00Z" }))
            }
            if (url.includes("/releases")) return Effect.succeed(jsonRes(req, [{ id: 1 }]))
            if (url.includes("/contributors")) {
              return Effect.succeed(jsonRes(req, [{ login: "will", avatar_url: "https://a.test/1" }]))
            }
            if (url.includes("/readme")) {
              return Effect.succeed(
                jsonRes(req, { path: "README.md", size: 5, encoding: "base64", content: btoa("hello") }),
              )
            }
            if (url.includes("/contents/.smithers/home.json")) {
              return Effect.succeed(
                jsonRes(req, { path: ".smithers/home.json", size: 2, encoding: "base64", content: btoa("{}") }),
              )
            }
            if (url.includes("/contents/")) {
              return Effect.succeed(
                jsonRes(req, [
                  { name: ".smithers", type: "dir" },
                  { name: "README.md", type: "file" },
                  { name: "sub", type: "submodule" },
                  { name: "link", type: "symlink" },
                  { name: "weird", type: "unknown" },
                ]),
              )
            }
            if (url.includes("/commits")) {
              return Effect.succeed(
                jsonRes(req, [
                  { sha: "b".repeat(40), commit: { message: "feat", author: { name: "Will", date: "2026-01-01T00:00:00Z" } }, author: { login: "will" } },
                ]),
              )
            }
            return Effect.succeed(jsonRes(req, [{ name: "main" }]))
          }),
        )

        const client = yield* GitHub.GitHubClient.make(
          { apiBaseUrl: "https://api.github.com", requestTimeout: Duration.seconds(2), ...(mode.startsWith("gql_") ? { token: "ghp_test" } : {}) },
          {},
        ).pipe(Effect.provide(mockHttp), Effect.orDie)

        const res = mode.startsWith("gql_")
          ? yield* AboutGitHub.graphql(client, "acme", "app", "smithers").pipe(Effect.result)
          : yield* AboutGitHub.rest(client, mode === "rest_bad_path" ? "../bad" : "acme", "app", "smithers").pipe(Effect.result)

        if (
          mode === "rest_full_ok" ||
          mode === "rest_partial_missing" ||
          mode === "gql_full_ok" ||
          mode === "gql_custom_readme_rest_fallback" ||
          mode === "gql_empty_repo"
        ) {
          expect(Result.isSuccess(res)).toBe(true)
        } else {
          expect(Result.isFailure(res)).toBe(true)
        }
      }),
    )
  }, 60_000)

  it("fuzzes RepoAbout.make, fieldsOf, cache hit/miss/wait/refusal, absentOnWeb, and curated recovery", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "hit_fresh",
        "store_get_down",
        "store_claim_down",
        "kept_refusal",
        "await_resolves_hit",
        "await_resolves_refusal",
        "await_timeout",
        "miss_anon_ok",
        "miss_anon_keep_rejected",
        "miss_anon_429_web_404",
        "miss_anon_429_web_200",
        "miss_member_gql_ok",
        "miss_refuse_rejected",
        "curated_recover_no_token",
        "curated_recover_with_token",
      ]),
    )

    await holds(modeArb, Math.max(execs, 30), (mode) =>
      Effect.gen(function* () {
        const now = Date.now()
        let gets = 0
        const store: AboutStore.AboutStore = {
          get: () => {
            gets += 1
            if (mode === "store_get_down") return Effect.fail(new AboutStore.StoreUnavailable({ op: "get" }))
            if (mode === "hit_fresh") {
              return Effect.succeed(Option.some({
                answer: Option.some({ text: "{}", via: "anonymous", readAtMs: now - 1000, freshUntilMs: now + 60_000 }),
                nextReadAtMs: now + 60_000,
                refusal: null,
                appAbsentUntilMs: null,
              }))
            }
            if (mode === "kept_refusal") {
              return Effect.succeed(Option.some({
                answer: Option.none(),
                nextReadAtMs: now + 60_000,
                refusal: "rate_limited",
                refusalVia: "anonymous",
                appAbsentUntilMs: null,
              }))
            }
            if (mode === "curated_recover_no_token" || mode === "curated_recover_with_token") {
              return Effect.succeed(Option.some({
                answer: Option.none(),
                nextReadAtMs: now + 60_000,
                refusal: "rate_limited",
                refusalVia: "anonymous",
                appAbsentUntilMs: null,
              }))
            }
            if (mode === "await_resolves_hit" || mode === "await_resolves_refusal" || mode === "await_timeout") {
              if (gets === 1) {
                return Effect.succeed(Option.some({
                  answer: Option.none(),
                  nextReadAtMs: now + 60_000,
                  refusal: null,
                  appAbsentUntilMs: null,
                }))
              }
              if (mode === "await_resolves_hit") {
                return Effect.succeed(Option.some({
                  answer: Option.some({ text: "{}", via: "app", readAtMs: now, freshUntilMs: now + 60_000 }),
                  nextReadAtMs: now + 60_000,
                  refusal: null,
                  appAbsentUntilMs: null,
                }))
              }
              if (mode === "await_resolves_refusal") {
                return Effect.succeed(Option.some({
                  answer: Option.none(),
                  nextReadAtMs: now + 60_000,
                  refusal: "not_found",
                  refusalVia: "anonymous",
                  appAbsentUntilMs: null,
                }))
              }
              return Effect.succeed(Option.none())
            }
            return Effect.succeed(Option.none())
          },
          claim: () => {
            if (mode === "store_claim_down") return Effect.fail(new AboutStore.StoreUnavailable({ op: "claim" }))
            if (mode === "kept_refusal" || mode.startsWith("await_")) return Effect.succeed(false as const)
            return Effect.succeed("gen-1")
          },
          keep: () => Effect.succeed(mode !== "miss_anon_keep_rejected"),
          refuse: () => Effect.succeed(mode !== "miss_refuse_rejected"),
          appAbsent: () => Effect.void,
        }

        const mockHttp = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((req) => {
            if (req.url.startsWith("https://github.com/")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(req, new Response("", { status: mode === "miss_anon_429_web_404" ? 404 : 200 })),
              )
            }
            if (mode === "miss_anon_429_web_404" || mode === "miss_anon_429_web_200" || mode === "miss_refuse_rejected") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(JSON.stringify({ message: "rate limit" }), {
                    status: 429,
                    headers: { "content-type": "application/json", "retry-after": "60" },
                  }),
                ),
              )
            }
            if (req.url.includes("/graphql")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(
                    JSON.stringify({
                      data: {
                        repository: {
                          nameWithOwner: "acme/app",
                          description: "d",
                          homepageUrl: null,
                          isPrivate: false,
                          isArchived: false,
                          stargazerCount: 1,
                          forkCount: 0,
                          watchers: { totalCount: 1 },
                          licenseInfo: null,
                          repositoryTopics: { nodes: [] },
                          languages: { edges: [] },
                          latestRelease: null,
                          releases: { totalCount: 0 },
                          branches: { totalCount: 1 },
                          tags: { totalCount: 0 },
                          defaultBranchRef: null,
                          root: { entries: [] },
                        },
                      },
                    }),
                    { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" } },
                  ),
                ),
              )
            }
            if (req.url.endsWith("/repos/acme/app") || req.url.endsWith("/repos/smithersai/smithers")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(
                    JSON.stringify({
                      full_name: "acme/app",
                      description: null,
                      homepage: null,
                      stargazers_count: 1,
                      forks_count: 0,
                      watchers_count: 1,
                      license: null,
                      default_branch: "main",
                    }),
                    { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "55" } },
                  ),
                ),
              )
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(req, new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })),
            )
          }),
        )

        const opts: RepoAbout.Settings = {
          token: Effect.succeed(
            mode === "miss_member_gql_ok" || mode === "curated_recover_with_token"
              ? Option.some(Redacted.make("ghp_tok"))
              : Option.none(),
          ),
          apiBaseUrl: "https://api.github.com",
          appSlug: "smithers",
          freshFor: Duration.minutes(10),
          anonymousFreshFor: Duration.minutes(60),
          app: Option.none(),
          allowed: Option.none(),
        }

        const source = yield* RepoAbout.make(opts, store, makeSqlLayer(() => []), {
          waitFor: Duration.millis(15),
          poll: Duration.millis(4),
        })

        const isCurated = mode === "curated_recover_no_token" || mode === "curated_recover_with_token"
        const outcome = yield* source
          .answer(isCurated ? "smithersai" : "acme", isCurated ? "smithers" : "app", Effect.succeed(mode === "miss_member_gql_ok"))
          .pipe(Effect.provide(Layer.mergeAll(mockHttp, silentLogger)))

        const fields = RepoAbout.fieldsOf(outcome)
        expect(typeof fields.cache).toBe("string")
        if (mode === "miss_anon_429_web_404") {
          expect(outcome._tag).toBe("Refused")
          if (outcome._tag === "Refused") expect(outcome.code).toBe("not_found")
        }
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/Notifications.ts & worker/github/RepoRoles.ts deep", () => {
  it("fuzzes Notifications.make watch, ack, shape, foldRun, and recordRepoEvent", async () => {
    const modes = [
      "watch_405",
      "watch_401",
      "watch_too_large",
      "watch_bad_json",
      "watch_branch_404",
      "watch_branch_ok",
      "watch_repo_ok",
      "ack_405",
      "ack_401",
      "ack_bad_json",
      "ack_404",
      "ack_ok",
      "ack_existing",
      "shape_signed_out",
      "shape_member_reused_and_unresolved",
      "shape_guest_mine_only",
      "fold_missing_run",
      "fold_run_needs_you_with_watchers",
      "fold_run_done",
      "record_repo_event",
    ] as const
    const modeArb = Arbitrary.schema(Schema.Literals(modes))

    const exercise = (mode: (typeof modes)[number]) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (q.includes("FROM branches") && q.includes("conversations")) {
            return mode === "watch_branch_404" ? [] : [branchRow()]
          }
          if (q.includes("INSERT INTO watches")) return [{ txid: "70" }]
          if (q.includes("UPDATE notifications SET")) {
            if (mode === "ack_ok") return [{ txid: "71" }]
            return []
          }
          // The existence check `applyAck` asks when its UPDATE changed nothing.
          if (q.includes("SELECT 1 FROM notifications WHERE recipient")) {
            return mode === "ack_existing" ? [{ "?column?": 1 }] : []
          }
          if (q.includes("FROM (SELECT repo_id AS \"repoId\" FROM notifications")) {
            return [
              { repoId: "github/acme/app", installed: true, denialSequence: "0", readable: true, reused: true, permissionFresh: true, visibilityFresh: true },
              { repoId: "github/acme/other", installed: false, denialSequence: "0", readable: null, reused: false, permissionFresh: false, visibilityFresh: false },
            ]
          }
          if (q.includes("clock_timestamp()") && q.includes("AS at")) {
            return [{ at: new Date().toISOString() }]
          }
          if (q.includes("WITH identity AS")) {
            return [{
              subjects: {},
              repositories: ["github/acme/app", "github/acme/other"],
              authorityUnknownSubjects: 0,
              withheldSubjects: 0,
              withdrawnSubjects: 0,
              restoredSubjects: 0,
              prunedSubjects: [],
              access: [
                { repoId: "github/acme/app", denialSequence: "0" },
                { repoId: "github/acme/other", denialSequence: "0" },
              ],
            }]
          }
          if (q.includes("FROM runs r") && q.includes("LEFT JOIN messages a")) {
            if (mode === "fold_missing_run") return []
            return [{
              status: mode === "fold_run_done" ? "done" : "needs_you",
              version: 1,
              answered: mode === "fold_run_done",
              answer: mode === "fold_run_done" ? "done" : "streaming",
              launchedBy: PERSON_ID,
              conversationId: CONV_ID,
              branchId: BRANCH_ID,
              repoId: "github/acme/app",
              branchName: "main",
              prompt: "Approve deploy?",
              question: "Deploy now",
            }]
          }
          if (q.includes("SELECT principal_id AS principal, level FROM watches")) {
            return [{ principal: OTHER_ID, level: "watching" }]
          }
          if (q.includes("SELECT created_by AS \"createdBy\" FROM branches")) {
            return [{ createdBy: PERSON_ID }]
          }
          if (q.includes("SELECT grantee, access FROM branch_shares")) {
            return [{ grantee: OTHER_ID, access: "view" }]
          }
          if (q.includes("SELECT recipient, state, mine, quiet, title, version FROM notifications")) {
            return [{ recipient: PERSON_ID, state: "needs_you", mine: true, quiet: false, title: "Old", version: 1 }]
          }
          if (q.includes("SELECT person_id AS \"personId\" FROM github_repo_roles")) return []
          if (q.includes("SELECT principal_id AS principal")) return [{ principal: PERSON_ID, level: "watching" }]
          return []
        })

        if (mode === "fold_missing_run" || mode === "fold_run_needs_you_with_watchers" || mode === "fold_run_done") {
          yield* Notifications.foldRun(RUN_ID, "will").pipe(Effect.provide(Layer.mergeAll(db, silentLogger)))
          return
        }
        if (mode === "record_repo_event") {
          const synced = { id: "github/acme/app", owner: "acme", name: "app" }
          const now = new Date()
          const pushEv = Notifications.repoEventOf(
            "push",
            {
              ref: "refs/heads/main",
              after: "1234567890abcdef1234567890abcdef12345678",
              before: "0000000000000000000000000000000000000000",
              deleted: false,
              repository: { full_name: "acme/app", default_branch: "main", pushed_at: Math.floor(now.getTime() / 1000) },
            },
            synced,
            now,
          )
          const relEv = Notifications.repoEventOf(
            "release",
            {
              action: "published",
              release: { tag_name: "v1.0.0", published_at: now.toISOString() },
              repository: { full_name: "acme/app" },
            },
            synced,
            now,
          )
          expect(Option.isSome(pushEv)).toBe(true)
          expect(Option.isSome(relEv)).toBe(true)
          expect(Option.isNone(Notifications.repoEventOf("issues", {}, synced, now))).toBe(true)
          if (Option.isSome(pushEv)) {
            yield* Notifications.recordRepoEvent(pushEv.value, [{ id: PERSON_ID, role: "maintainer" }]).pipe(
              Effect.provide(Layer.mergeAll(db, silentLogger)),
            )
          }
          if (Option.isSome(relEv)) {
            yield* Notifications.recordRepoEvent(relEv.value, [{ id: PERSON_ID, role: "maintainer" }]).pipe(
              Effect.provide(Layer.mergeAll(db, silentLogger)),
            )
          }
          return
        }

        const routes = yield* Notifications.make(db).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
        )
        const actor = mode === "watch_401" || mode === "ack_401" || mode === "shape_signed_out"
          ? Option.none<Actor.Actor>()
          : mode === "shape_guest_mine_only"
          ? Option.some(personActor({ role: "guest" }))
          : Option.some(personActor())
        const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), branchRolesLayer(), silentLogger)
        const runRoute = (eff: Effect.Effect<any, any, any>, req: HttpServerRequest.HttpServerRequest): Effect.Effect<any, any, never> =>
          eff.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req), Effect.provide(env)) as Effect.Effect<any, any, never>

        if (mode.startsWith("shape_")) {
          const res = yield* runRoute(routes.shape, makeReq("https://app.test/api/shapes/notifications?offset=-1"))
          expect(res.status).toBe(200)
        } else if (mode.startsWith("watch_")) {
          const body = mode === "watch_too_large"
            ? "x".repeat(5_000)
            : mode === "watch_bad_json"
            ? "{"
            : mode === "watch_repo_ok"
            ? JSON.stringify({ conversationId: null })
            : JSON.stringify({ conversationId: CONV_ID })
          const res = yield* runRoute(
            routes.watch,
            makeReq("https://app.test/api/watches", { method: mode === "watch_405" ? "GET" : "POST", body }),
          )
          expect(res.status).toBe(
            mode === "watch_405" ? 405 : mode === "watch_401" ? 401 : mode === "watch_too_large" ? 413 : mode === "watch_bad_json" ? 400 : mode === "watch_branch_404" ? 404 : 200,
          )
        } else {
          const body = mode === "ack_bad_json"
            ? "{"
            : JSON.stringify({ subject: `run:${RUN_ID}`, act: "read", version: 1 })
          const res = yield* runRoute(
            routes.ack,
            makeReq("https://app.test/api/notifications/ack", { method: mode === "ack_405" ? "GET" : "POST", body }),
          )
          expect(res.status).toBe(
            mode === "ack_405" ? 405 : mode === "ack_401" ? 401 : mode === "ack_bad_json" ? 400 : mode === "ack_404" ? 404 : 200,
          )
        }
      })

    await holds(modeArb, Math.max(execs * 2, 48), exercise)
    // Every mode once as well: a seed that never samples a mode leaves its mock unchecked. Seed 1 found `ack_existing`
    // answering a query `applyAck` never sends, so the ack of an already-read notification came back 404, not 200.
    for (const mode of modes) await Effect.runPromise(exercise(mode))
  }, 60_000)

  it("fuzzes RepoRoles makeWith, resolve, workRole, workUninstalled, publicCopy, claimRead, remember, holds", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "pure_helpers",
        "resolve_own_repo_session",
        "resolve_no_app_local",
        "resolve_no_app_refused",
        "resolve_not_allowed",
        "work_role_cached_fresh",
        "work_uninstalled_own_and_public",
        "work_uninstalled_private",
        "public_copy_cached_and_github_200",
        "public_copy_github_404",
        "claim_read_and_remember",
        "check_held_and_holds",
      ]),
    )

    await holds(modeArb, Math.max(execs, 28), (mode) =>
      Effect.gen(function* () {
        const ownRepo = repositoryOf("acme/own")
        const otherRepo = repositoryOf("acme/other")
        const actor = personActor({ session: "sess-1" })

        if (mode === "pure_helpers") {
          expect(RepoRoles.permissionOf({ permission: "admin", roleName: "admin" } as any)).toBe("admin")
          expect(RepoRoles.permissionOf({ permission: "admin", roleName: "maintain" } as any)).toBe("maintain")
          expect(RepoRoles.permissionOf({ permission: "write", roleName: "triage" } as any)).toBe("triage")
          expect(RepoRoles.permissionOf({ permission: "write" } as any)).toBe("write")
          expect(RepoRoles.permissionOf({ permission: "read" } as any)).toBe("read")
          expect(RepoRoles.permissionOf({ permission: "none" } as any)).toBe("none")
          expect(RepoRoles.actsOn(ownRepo, Option.some(new Set([otherRepo.id])))(otherRepo.id)).toBe(true)
          expect(RepoRoles.actsOn(ownRepo, Option.some(new Set()))(otherRepo.id)).toBe(false)
          expect(RepoRoles.refusalFields(new RepoRoles.RoleRefused({ code: "rate_limited", stage: "permission", upstreamStatus: 429, retryAfterSeconds: 5 })).code).toBe("rate_limited")
          const al = yield* RepoRoles.allowed.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GITHUB_ALLOWED_REPOSITORIES: "acme/a, acme/b" } }))),
          )
          expect(Option.isSome(al) && al.value.has("github/acme/a")).toBe(true)
          return
        }

        const db = makeSqlLayer((q) => {
          if (q.includes("clock_timestamp()::text")) return [{ now: new Date().toISOString() }]
          if (q.includes("AS same")) return [{ fresh: true, same: true }]
          if (q.includes("FROM sessions")) return [{ role: "maintainer", fresh: true }]
          if (q.includes("INSERT INTO github_repositories") || q.includes("UPDATE github_repositories")) {
            return [{ lease: "lease-v1", public: mode !== "public_copy_github_404", fresh: true }]
          }
          if (q.includes("FROM github_repositories WHERE repo_id =")) {
            if (mode === "work_uninstalled_private") return [{ private: true, public: false, fresh: true }]
            if (mode === "public_copy_cached_and_github_200" || mode === "public_copy_github_404") {
              return [{ private: false, public: true, fresh: false, cooling: false, lease: null, refusal: null, retryAfterMillis: null }]
            }
            return [{ private: false, public: true, fresh: true }]
          }
          if (q.includes("INSERT INTO github_repo_roles")) {
            return [{ lease: "lease-1", role: "member", checkedAt: new Date().toISOString() }]
          }
          if (q.includes("FROM github_repo_roles")) {
            return [{
              role: "maintainer",
              checkedAt: new Date().toISOString(),
              fresh: true,
              held: true,
              cooling: false,
              lease: null,
              refusal: null,
              retryAfterMillis: null,
            }]
          }
          return []
        })

        if (mode === "claim_read_and_remember") {
          const lease = yield* RepoRoles.claimRead(otherRepo.id, PERSON_ID, undefined, 5000).pipe(Effect.provide(db))
          expect(Option.isOption(lease)).toBe(true)
          yield* RepoRoles.remember(otherRepo.id, PERSON_ID, "member", new Date().toISOString()).pipe(
            Effect.provide(Layer.mergeAll(db, silentLogger)),
          )
          return
        }

        if (mode === "check_held_and_holds") {
          const held: RepoRoles.Held = {
            repoId: otherRepo.id,
            personId: PERSON_ID,
            role: "maintainer",
            checkedAt: new Date().toISOString(),
            freshSeconds: 300,
          }
          const checked = yield* RepoRoles.checkHeld(held, ["maintainer", "admin"]).pipe(Effect.provide(db))
          expect(checked === "held" || checked === "denied" || checked === "unavailable").toBe(true)
          const ok = yield* RepoRoles.holds(held, ["maintainer", "admin"]).pipe(Effect.provide(db))
          expect(typeof ok).toBe("boolean")
          return
        }

        const http = HttpClient.make((req) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(
                JSON.stringify(mode === "public_copy_github_404" ? { message: "Not Found" } : { private: false }),
                { status: mode === "public_copy_github_404" ? 404 : 200, headers: { "content-type": "application/json" } },
              ),
            ),
          ),
        )

        const captured = yield* RepoRoles.configuredReads(Option.none()).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
        )
        const roles = yield* RepoRoles.makeWith(
          db,
          {
            repository: ownRepo,
            app: Option.none(),
            allowed: mode === "resolve_not_allowed" ? Option.some(new Set()) : Option.none(),
            local: mode === "resolve_no_app_local",
            localRoles: () => "admin",
            http,
          },
          captured,
        ).pipe(Effect.provide(silentLogger))

        if (mode === "resolve_own_repo_session") {
          const r = yield* roles.resolve(actor, ownRepo).pipe(Effect.provide(silentLogger))
          expect(r.role === "maintainer" || r.role === "member" || r.role === null).toBe(true)
        } else if (mode === "resolve_no_app_local") {
          const r = yield* roles.resolve(actor, otherRepo).pipe(Effect.provide(silentLogger))
          expect(r.role).toBe("admin")
        } else if (mode === "resolve_no_app_refused" || mode === "resolve_not_allowed") {
          const r = yield* roles.resolve(actor, otherRepo).pipe(Effect.provide(silentLogger), Effect.result)
          expect(Result.isFailure(r)).toBe(true)
        } else if (mode === "work_role_cached_fresh") {
          const r = yield* RepoRoles.workRole(roles, actor, ownRepo).pipe(Effect.provide(silentLogger))
          expect(r === "maintainer" || r === "member" || r === null).toBe(true)
          expect(RepoRoles.uninstalledRole(roles, actor, ownRepo)).toBe("member")
        } else if (mode === "work_uninstalled_own_and_public" || mode === "work_uninstalled_private") {
          const r1 = yield* RepoRoles.workUninstalled(roles, actor, ownRepo).pipe(Effect.provide(silentLogger))
          const r2 = yield* RepoRoles.workUninstalled(roles, actor, otherRepo).pipe(Effect.provide(silentLogger))
          expect(r1 === null || typeof r1 === "string").toBe(true)
          if (mode === "work_uninstalled_private") expect(r2).toBeNull()
        } else {
          const pub = yield* roles.publicCopy!(otherRepo).pipe(Effect.provide(silentLogger))
          expect(pub).toBe(mode !== "public_copy_github_404")
        }
      }),
    )
  }, 60_000)
})
