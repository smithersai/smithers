import { digestSync } from "@smthrs/crypto"
import { Fuzz } from "@smthrs/fuzz"
import { type PresentationRealm } from "@smthrs/views"
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { SqlClient, SqlError } from "effect/sql"
import { describe, expect, it } from "vitest"
import { MAX_FLOWS_BODY_BYTES, MAX_SOURCE_BYTES } from "../src/features/flows-ui/contract.ts"
import { SOURCE_PATH } from "../src/features/flows-ui/source.ts"
import { MAX_VIEW_HTML_BYTES, MAX_VIEW_JSON_BYTES, SUBMIT_EVENT } from "../src/features/views/contract.ts"
import * as Actor from "./Actor.ts"
import * as BranchAccess from "./branch/Access.vibe"
import { DocsSource } from "./docs/Source.vibe"
import * as PersonalModels from "./personal/Models.vibe"
import * as PersonalFlows from "./PersonalFlows.ts"
import { SecretKeys } from "./secrets/Keys.vibe"
import * as Views from "./Views.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261181")
const silentLogger = Logger.layer([])

const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_ID = "99999999-9999-4999-8999-999999999999"
const DRAFT_ID = "22222222-2222-4222-8222-222222222222"
const FLOW_ID = "33333333-3333-4333-8333-333333333333"
const VIEW_ID = "44444444-4444-4444-8444-444444444444"
const CONV_ID = "55555555-5555-4555-8555-555555555555"
const ANSWER_ID = "66666666-6666-4666-8666-666666666666"
const QUESTION_ID = "77777777-7777-4777-8777-777777777777"
const BRANCH_ID = "88888888-8888-4888-8888-888888888888"
const CONN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

const VALID_FLOW_SOURCE = `import { Flow } from "@smthrs/flow"\nexport default Flow.make("demo", { description: "demo", body: () => ({}) })\n`
const VALID_FLOW_DIGEST = digestSync(VALID_FLOW_SOURCE)

const VALID_VIEW_CODE = `
export const interactions = {
  inc: { kind: "state" },
  send: { kind: "message" },
}
export function reduce(state, event) {
  return { count: (state?.count ?? 0) + 1 }
}
export default function View({ state }) {
  return <div>{state?.count ?? 0}</div>
}
`

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
    (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
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
  } = {},
): Actor.Actor => ({
  subject: { kind: "person", id: opts.id ?? PERSON_ID },
  role: opts.role ?? "member",
  login: "will",
  ...(opts.act === undefined ? {} : { act: opts.act }),
})

const branchRolesLayer = (role: Actor.Role | null = "member"): Layer.Layer<BranchAccess.BranchRoles> =>
  Layer.succeed(
    BranchAccess.BranchRoles,
    BranchAccess.BranchRoles.of({
      roleOn: () => Effect.succeed(role),
      uninstalled: () => role,
    }),
  )

const sessionsLayer = (actor: Option.Option<Actor.Actor> | Error): Layer.Layer<Actor.Sessions> =>
  Layer.succeed(
    Actor.Sessions,
    Actor.Sessions.of({
      resolve: actor instanceof Error ? Effect.fail(actor as never) : Effect.succeed(actor),
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

const branchRow = (
  opts: {
    readonly mode?: "open" | "locked" | "restricted"
    readonly createdBy?: string | null
    readonly person?: "view" | "edit" | null
    readonly repository?: "view" | "edit" | null
    readonly installed?: boolean
  } = {},
) => ({
  branchId: BRANCH_ID,
  conversationId: CONV_ID,
  repoId: "github/acme/app",
  name: "main",
  mode: opts.mode ?? "open",
  createdBy: opts.createdBy === undefined ? PERSON_ID : opts.createdBy,
  person: opts.person ?? null,
  repository: opts.repository ?? null,
  anyShare: false,
  installed: opts.installed ?? false,
})

describe("Wave8: worker/PersonalFlows.ts", () => {
  it("fuzzes pure helpers: withAnswers, nameAllowed, saveRefusal, writeRefusal", async () => {
    const caseArb = Arbitrary.schema(
      Schema.Literals([
        "reserved_name",
        "bad_name",
        "too_large",
        "bad_digest",
        "not_ready",
        "no_checks",
        "failed_check",
        "blocking_unanswered",
        "blocking_answered",
        "no_files",
        "two_files",
        "wrong_path",
        "wrong_text",
        "wrong_draft_name",
        "ok",
      ]),
    )

    await holds(caseArb, Math.max(execs, 30), (c) =>
      Effect.sync(() => {
        expect(PersonalFlows.nameAllowed("my-flow")).toBe(true)
        expect(PersonalFlows.nameAllowed("app")).toBe(false)
        expect(PersonalFlows.nameAllowed("Bad_Name")).toBe(false)

        const merged = PersonalFlows.withAnswers(
          [
            { id: "q1", text: "Name?", assumed: "a", blocking: true },
            { id: "q2", text: "Extra?", assumed: "b", blocking: false },
          ],
          [
            { id: "q1", value: "alpha" },
            { id: "missing", value: "ignored" },
          ],
        )
        expect(merged[0]?.answer).toBe("alpha")
        expect(merged[1]?.answer).toBeUndefined()

        const baseDraft = {
          actorId: PERSON_ID,
          status: "ready",
          round: 1,
          request: "make a flow",
          name: "my-flow",
          files: [{ path: SOURCE_PATH, text: VALID_FLOW_SOURCE }],
          checks: [{ ok: true }],
          questions: [{ id: "q1", text: "Q?", assumed: "a", blocking: false }],
          flowId: null,
          deleted: false,
          savedRevision: null,
        }
        const baseSave = {
          draftId: DRAFT_ID,
          name: "my-flow",
          description: "desc",
          source: VALID_FLOW_SOURCE,
          digest: VALID_FLOW_DIGEST,
        }
        const bigSource = "a".repeat(MAX_SOURCE_BYTES + 16)

        if (c === "reserved_name") {
          expect(PersonalFlows.saveRefusal(baseDraft, { ...baseSave, name: "app" })).toBe("name")
          expect(PersonalFlows.writeRefusal({ name: "app", revision: 1, description: "d", source: VALID_FLOW_SOURCE, digest: VALID_FLOW_DIGEST })).toBe("name")
        } else if (c === "bad_name") {
          expect(PersonalFlows.saveRefusal(baseDraft, { ...baseSave, name: "INVALID" })).toBe("name")
        } else if (c === "too_large") {
          expect(PersonalFlows.saveRefusal(baseDraft, { ...baseSave, source: bigSource, digest: digestSync(bigSource) })).toBe("too_large")
          expect(PersonalFlows.writeRefusal({ name: "my-flow", revision: 1, description: "d", source: bigSource, digest: digestSync(bigSource) })).toBe("too_large")
        } else if (c === "bad_digest") {
          expect(PersonalFlows.saveRefusal(baseDraft, { ...baseSave, digest: "0".repeat(64) })).toBe("digest")
          expect(PersonalFlows.writeRefusal({ name: "my-flow", revision: 1, description: "d", source: VALID_FLOW_SOURCE, digest: "0".repeat(64) })).toBe("digest")
        } else if (c === "not_ready") {
          expect(PersonalFlows.saveRefusal({ ...baseDraft, status: "drafting" }, baseSave)).toBe("not_ready")
        } else if (c === "no_checks") {
          expect(PersonalFlows.saveRefusal({ ...baseDraft, checks: [] }, baseSave)).toBe("checks")
        } else if (c === "failed_check") {
          expect(PersonalFlows.saveRefusal({ ...baseDraft, checks: [{ ok: false }] }, baseSave)).toBe("checks")
        } else if (c === "blocking_unanswered") {
          expect(
            PersonalFlows.saveRefusal(
              { ...baseDraft, questions: [{ id: "q1", text: "Q?", assumed: "a", blocking: true }] },
              baseSave,
            ),
          ).toBe("needs_you")
        } else if (c === "blocking_answered") {
          expect(
            PersonalFlows.saveRefusal(
              { ...baseDraft, questions: [{ id: "q1", text: "Q?", assumed: "a", blocking: true, answer: "yes" }] },
              baseSave,
            ),
          ).toBeUndefined()
        } else if (c === "no_files") {
          expect(PersonalFlows.saveRefusal({ ...baseDraft, files: [] }, baseSave)).toBe("not_draft")
        } else if (c === "two_files") {
          expect(
            PersonalFlows.saveRefusal(
              { ...baseDraft, files: [{ path: SOURCE_PATH, text: VALID_FLOW_SOURCE }, { path: "b.ts", text: "" }] },
              baseSave,
            ),
          ).toBe("not_draft")
        } else if (c === "wrong_path") {
          expect(
            PersonalFlows.saveRefusal({ ...baseDraft, files: [{ path: "other.ts", text: VALID_FLOW_SOURCE }] }, baseSave),
          ).toBe("not_draft")
        } else if (c === "wrong_text") {
          expect(
            PersonalFlows.saveRefusal({ ...baseDraft, files: [{ path: SOURCE_PATH, text: "different" }] }, baseSave),
          ).toBe("not_draft")
        } else if (c === "wrong_draft_name") {
          expect(PersonalFlows.saveRefusal({ ...baseDraft, name: "other-flow" }, baseSave)).toBe("not_draft")
        } else {
          expect(PersonalFlows.saveRefusal(baseDraft, baseSave)).toBeUndefined()
          expect(PersonalFlows.writeRefusal({ name: "my-flow", revision: 1, description: "d", source: VALID_FLOW_SOURCE, digest: VALID_FLOW_DIGEST })).toBeUndefined()
        }
      }),
    )
  })

  it("fuzzes all flows/* and flow-drafts/* HTTP routes and shapes", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "list_ok",
        "list_405",
        "list_401",
        "list_503",
        "source_latest_ok",
        "source_rev_ok",
        "source_flowid_ok",
        "source_flowid_rev_ok",
        "source_404",
        "source_400_name",
        "source_400_rev",
        "source_400_flowid",
        "source_405",
        "save_new_ok",
        "save_edit_ok",
        "save_edit_gone",
        "save_taken",
        "save_already_saved_ok",
        "save_already_saved_no_receipt",
        "save_race_deleted",
        "save_race_saved",
        "save_race_refused",
        "save_404",
        "save_403",
        "save_refused_409",
        "save_refused_413",
        "save_bad_json",
        "save_too_large_body",
        "save_405",
        "write_ok",
        "write_missing",
        "write_stale",
        "write_idempotent",
        "write_refused_409",
        "write_refused_413",
        "write_bad_json",
        "write_405",
        "delete_ok",
        "delete_404",
        "delete_405",
        "flows_unknown",
        "draft_list_ok",
        "draft_list_405",
        "draft_get_ok",
        "draft_get_404",
        "draft_get_deleted",
        "draft_get_403",
        "draft_put_405",
        "draft_post_ok",
        "draft_post_bad_json",
        "draft_post_too_large",
        "draft_post_403",
        "draft_post_deleted",
        "draft_post_settled",
        "draft_post_stale_round",
        "draft_post_existing",
        "answers_ok",
        "answers_noop",
        "answers_person_only",
        "answers_404",
        "answers_403",
        "answers_settled",
        "answers_stale_round",
        "answers_405",
        "answers_bad_json",
        "draft_del_ok",
        "draft_del_404",
        "draft_del_403",
        "draft_del_race_deleted",
        "draft_del_race_settled",
        "draft_del_405",
        "drafts_unknown",
        "shapes_signed_in",
        "shapes_signed_out",
      ]),
    )

    await holds(modeArb, Math.max(execs * 2, 90), (mode) =>
      Effect.gen(function* () {
        let draftReads = 0
        const readyDraftRow = {
          actorId: PERSON_ID,
          status: "ready",
          round: 2,
          request: "make demo",
          name: "my-flow",
          files: [{ path: SOURCE_PATH, text: VALID_FLOW_SOURCE }],
          checks: [{ ok: true }],
          questions: [{ id: "q1", text: "Pick", assumed: "x", blocking: false }],
          flowId: mode === "save_edit_ok" || mode === "save_edit_gone" ? FLOW_ID : null,
          deleted: false,
          savedRevision: null,
        }

        const db = makeSqlLayer((q) => {
          if (mode === "list_503") return new Error("db_down")
          if (q.includes("FROM flows WHERE owner_id")) {
            return [{ id: FLOW_ID, name: "my-flow", revision: 1, description: "d", placement: "client" }]
          }
          if (q.includes("FROM flow_drafts WHERE actor_id")) {
            return [{ id: DRAFT_ID, name: "my-flow", request: "r", status: "ready" }]
          }
          if (q.includes("LEFT JOIN flow_revisions r ON")) {
            if (mode === "write_missing") return []
            if (mode === "write_stale") return [{ id: FLOW_ID, digest: "other-digest" }]
            return [{ id: FLOW_ID, digest: VALID_FLOW_DIGEST }]
          }
          if (q.includes("JOIN flow_revisions r")) {
            return mode === "source_404"
              ? []
              : [{ flowId: FLOW_ID, name: "my-flow", revision: 1, digest: VALID_FLOW_DIGEST, source: VALID_FLOW_SOURCE }]
          }
          if (q.includes("SELECT id, scope, repo_id")) {
            return [{
              id: DRAFT_ID,
              scope: "person",
              repoId: null,
              target: null,
              name: "my-flow",
              request: "r",
              status: "ready",
              round: 1,
              summary: null,
              files: [],
              checks: [],
              questions: [],
              failure: null,
              flowId: null,
              createdAt: "2026-10-20T00:00:00Z",
              updatedAt: "2026-10-20T00:00:00Z",
            }]
          }
          if (q.includes("FROM flow_drafts WHERE id =")) {
            draftReads += 1
            if (mode === "save_404" || mode === "draft_get_404" || mode === "answers_404" || mode === "draft_del_404") return []
            if (mode === "save_403" || mode === "draft_get_403" || mode === "draft_post_403" || mode === "answers_403" || mode === "draft_del_403") {
              return [{ ...readyDraftRow, actorId: OTHER_ID }]
            }
            if (mode === "draft_get_deleted" || mode === "draft_post_deleted") return [{ ...readyDraftRow, deleted: true }]
            if (mode === "save_already_saved_ok") return [{ ...readyDraftRow, status: "saved", flowId: FLOW_ID, savedRevision: 2 }]
            if (mode === "save_already_saved_no_receipt") return [{ ...readyDraftRow, status: "saved", flowId: FLOW_ID, savedRevision: null }]
            if (mode === "save_race_deleted") return draftReads === 1 ? [readyDraftRow] : [{ ...readyDraftRow, deleted: true }]
            if (mode === "save_race_saved") return draftReads === 1 ? [readyDraftRow] : [{ ...readyDraftRow, status: "saved", flowId: FLOW_ID, savedRevision: 3 }]
            if (mode === "save_race_refused") return draftReads === 1 ? [readyDraftRow] : [{ ...readyDraftRow, status: "drafting" }]
            if (mode === "save_refused_409") return [{ ...readyDraftRow, status: "drafting" }]
            if (mode === "draft_post_settled" || mode === "answers_settled") return [{ ...readyDraftRow, status: "proposed" }]
            if (mode === "draft_post_stale_round") return [{ ...readyDraftRow, round: 5 }]
            if (mode === "draft_post_existing") return [{ ...readyDraftRow, round: 2 }]
            if (mode === "answers_stale_round") return [{ ...readyDraftRow, status: "drafting", round: 2 }]
            if (mode === "draft_del_race_deleted") return draftReads === 1 ? [readyDraftRow] : [{ ...readyDraftRow, deleted: true }]
            if (mode === "draft_del_race_settled") return draftReads === 1 ? [readyDraftRow] : [{ ...readyDraftRow, status: "saved" }]
            return [readyDraftRow]
          }
          if (q.includes("INSERT INTO flows (")) {
            if (mode === "save_taken") {
              return new SqlError.SqlError({
                reason: new SqlError.UniqueViolation({
                  message: "dup",
                  constraint: "flows_owner_name",
                  cause: new Error("dup"),
                }),
              })
            }
            return []
          }
          if (q.includes("UPDATE flows SET revision = revision + 1, name =")) {
            return mode === "save_edit_gone" ? [] : [{ revision: 2 }]
          }
          if (q.includes("INSERT INTO flow_revisions")) {
            return [{ txid: "42" }]
          }
          if (q.includes("UPDATE flow_drafts SET status = 'saved'")) {
            return [{ txid: "43" }]
          }
          if (q.includes("UPDATE flows SET revision = revision + 1, description =")) {
            return mode === "write_ok" ? [{ id: FLOW_ID, revision: 2 }] : []
          }
          if (q.includes("LEFT JOIN flow_revisions r ON")) {
            if (mode === "write_missing") return []
            if (mode === "write_stale") return [{ id: FLOW_ID, digest: "other-digest" }]
            return [{ id: FLOW_ID, digest: VALID_FLOW_DIGEST }]
          }
          if (q.includes("UPDATE flows SET deleted_at")) {
            return mode === "delete_ok" ? [{ txid: "44" }] : []
          }
          if (q.includes("INSERT INTO flow_drafts AS d")) {
            return mode === "draft_post_ok" ? [{ txid: "45" }] : []
          }
          if (q.includes("UPDATE flow_drafts SET questions =")) {
            return mode === "answers_ok" ? [{ txid: "46" }] : []
          }
          if (q.includes("UPDATE flow_drafts SET deleted_at")) {
            return mode === "draft_del_ok" ? [{ txid: "47" }] : []
          }
          return []
        })

        const routes = yield* PersonalFlows.make(db).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
        )
        const actor = mode === "list_401" || mode === "shapes_signed_out"
          ? Option.none<Actor.Actor>()
          : mode === "answers_person_only"
          ? Option.some(personActor({ act: { kind: "agent", id: ANSWER_ID } }))
          : Option.some(personActor())
        const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), silentLogger)

        const runRoute = (eff: Effect.Effect<any, any, any>, req: HttpServerRequest.HttpServerRequest): Effect.Effect<any, any, never> =>
          eff.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req), Effect.provide(env)) as Effect.Effect<any, any, never>

        const saveBody = JSON.stringify({
          draftId: DRAFT_ID,
          name: "my-flow",
          description: "desc",
          source: VALID_FLOW_SOURCE,
          digest: VALID_FLOW_DIGEST,
        })
        const writeBody = JSON.stringify({
          name: "my-flow",
          revision: 1,
          description: "desc",
          source: VALID_FLOW_SOURCE,
          digest: VALID_FLOW_DIGEST,
        })
        const draftBody = JSON.stringify({
          scope: "person",
          round: 2,
          request: "make demo",
          name: "my-flow",
          status: "ready",
          summary: "done",
          files: [{ path: SOURCE_PATH, text: VALID_FLOW_SOURCE }],
          checks: [{ check: "parses", ok: true }],
          questions: [],
          failure: null,
          flowId: null,
        })
        const answersBody = JSON.stringify({ round: 2, answers: [{ id: "q1", value: "yes" }] })

        if (mode === "list_ok") {
          expect((yield* runRoute(routes.flows(""), makeReq("https://app.test/api/flows"))).status).toBe(200)
        } else if (mode === "list_405") {
          expect((yield* runRoute(routes.flows(""), makeReq("https://app.test/api/flows", { method: "POST" }))).status).toBe(405)
        } else if (mode === "list_401") {
          expect((yield* runRoute(routes.flows(""), makeReq("https://app.test/api/flows"))).status).toBe(401)
        } else if (mode === "list_503") {
          expect((yield* runRoute(routes.flows(""), makeReq("https://app.test/api/flows"))).status).toBe(503)
        } else if (mode === "source_latest_ok") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source?name=my-flow"))).status).toBe(200)
        } else if (mode === "source_rev_ok") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source?name=my-flow&revision=1"))).status).toBe(200)
        } else if (mode === "source_flowid_ok") {
          expect((yield* runRoute(routes.flows("source"), makeReq(`https://app.test/api/flows/source?name=my-flow&flowId=${FLOW_ID}`))).status).toBe(200)
        } else if (mode === "source_flowid_rev_ok") {
          expect((yield* runRoute(routes.flows("source"), makeReq(`https://app.test/api/flows/source?name=my-flow&revision=1&flowId=${FLOW_ID}`))).status).toBe(200)
        } else if (mode === "source_404") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source?name=my-flow"))).status).toBe(404)
        } else if (mode === "source_400_name") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source?name=BAD"))).status).toBe(400)
        } else if (mode === "source_400_rev") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source?name=my-flow&revision=0"))).status).toBe(400)
        } else if (mode === "source_400_flowid") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source?name=my-flow&flowId=nope"))).status).toBe(400)
        } else if (mode === "source_405") {
          expect((yield* runRoute(routes.flows("source"), makeReq("https://app.test/api/flows/source", { method: "POST" }))).status).toBe(405)
        } else if (mode === "save_405") {
          expect((yield* runRoute(routes.flows("save"), makeReq("https://app.test/api/flows/save"))).status).toBe(405)
        } else if (mode === "save_bad_json") {
          expect((yield* runRoute(routes.flows("save"), makeReq("https://app.test/api/flows/save", { method: "POST", body: "{" }))).status).toBe(400)
        } else if (mode === "save_too_large_body") {
          expect((yield* runRoute(routes.flows("save"), makeReq("https://app.test/api/flows/save", { method: "POST", body: "x".repeat(MAX_FLOWS_BODY_BYTES + 16) }))).status).toBe(413)
        } else if (mode === "save_refused_413") {
          const big = "x".repeat(MAX_SOURCE_BYTES + 10)
          const b = JSON.stringify({ draftId: DRAFT_ID, name: "my-flow", description: "d", source: big, digest: digestSync(big) })
          expect((yield* runRoute(routes.flows("save"), makeReq("https://app.test/api/flows/save", { method: "POST", body: b }))).status).toBe(413)
        } else if (mode.startsWith("save_")) {
          const res = yield* runRoute(routes.flows("save"), makeReq("https://app.test/api/flows/save", { method: "POST", body: saveBody }))
          const expected = mode === "save_new_ok" || mode === "save_edit_ok" || mode === "save_already_saved_ok" || mode === "save_race_saved"
            ? 200
            : mode === "save_404" || mode === "save_race_deleted"
            ? 404
            : mode === "save_403"
            ? 403
            : mode === "save_already_saved_no_receipt"
            ? 503
            : 409
          expect(res.status).toBe(expected)
        } else if (mode === "write_405") {
          expect((yield* runRoute(routes.flows("write"), makeReq("https://app.test/api/flows/write"))).status).toBe(405)
        } else if (mode === "write_bad_json") {
          expect((yield* runRoute(routes.flows("write"), makeReq("https://app.test/api/flows/write", { method: "POST", body: "bad" }))).status).toBe(400)
        } else if (mode === "write_refused_409") {
          const b = JSON.stringify({ name: "app", revision: 1, description: "d", source: VALID_FLOW_SOURCE, digest: VALID_FLOW_DIGEST })
          expect((yield* runRoute(routes.flows("write"), makeReq("https://app.test/api/flows/write", { method: "POST", body: b }))).status).toBe(409)
        } else if (mode === "write_refused_413") {
          const big = "x".repeat(MAX_SOURCE_BYTES + 10)
          const b = JSON.stringify({ name: "my-flow", revision: 1, description: "d", source: big, digest: digestSync(big) })
          expect((yield* runRoute(routes.flows("write"), makeReq("https://app.test/api/flows/write", { method: "POST", body: b }))).status).toBe(413)
        } else if (mode.startsWith("write_")) {
          const res = yield* runRoute(routes.flows("write"), makeReq("https://app.test/api/flows/write", { method: "POST", body: writeBody }))
          expect(res.status).toBe(mode === "write_missing" ? 404 : mode === "write_stale" ? 409 : 200)
        } else if (mode === "delete_ok" || mode === "delete_404" || mode === "delete_405") {
          const res = yield* runRoute(
            routes.flows(`${FLOW_ID}/delete`),
            makeReq(`https://app.test/api/flows/${FLOW_ID}/delete`, { method: mode === "delete_405" ? "GET" : "POST" }),
          )
          expect(res.status).toBe(mode === "delete_ok" ? 200 : mode === "delete_404" ? 404 : 405)
        } else if (mode === "flows_unknown") {
          expect((yield* runRoute(routes.flows("not-a-uuid/delete"), makeReq("https://app.test/api/flows/bad"))).status).toBe(404)
          expect((yield* runRoute(routes.flows(`${FLOW_ID}/other`), makeReq("https://app.test/api/flows/bad"))).status).toBe(404)
        } else if (mode === "draft_list_ok" || mode === "draft_list_405") {
          const res = yield* runRoute(
            routes.drafts(""),
            makeReq("https://app.test/api/flow-drafts", { method: mode === "draft_list_405" ? "POST" : "GET" }),
          )
          expect(res.status).toBe(mode === "draft_list_ok" ? 200 : 405)
        } else if (mode.startsWith("draft_get_") || mode === "draft_put_405") {
          const res = yield* runRoute(
            routes.drafts(DRAFT_ID),
            makeReq(`https://app.test/api/flow-drafts/${DRAFT_ID}`, { method: mode === "draft_put_405" ? "PUT" : "GET" }),
          )
          expect(res.status).toBe(
            mode === "draft_get_ok" ? 200 : mode === "draft_get_403" ? 403 : mode === "draft_put_405" ? 405 : 404,
          )
        } else if (mode === "draft_post_bad_json") {
          expect((yield* runRoute(routes.drafts(DRAFT_ID), makeReq(`https://app.test/api/flow-drafts/${DRAFT_ID}`, { method: "POST", body: "{" }))).status).toBe(400)
        } else if (mode === "draft_post_too_large") {
          const big = JSON.stringify({
            scope: "person",
            round: 2,
            request: "r",
            name: "my-flow",
            status: "ready",
            summary: null,
            files: [{ path: SOURCE_PATH, text: "a".repeat(MAX_SOURCE_BYTES + 10) }],
            checks: [],
            questions: [],
            failure: null,
            flowId: null,
          })
          expect((yield* runRoute(routes.drafts(DRAFT_ID), makeReq(`https://app.test/api/flow-drafts/${DRAFT_ID}`, { method: "POST", body: big }))).status).toBe(413)
        } else if (mode.startsWith("draft_post_")) {
          const res = yield* runRoute(routes.drafts(DRAFT_ID), makeReq(`https://app.test/api/flow-drafts/${DRAFT_ID}`, { method: "POST", body: draftBody }))
          const expected = mode === "draft_post_ok" || mode === "draft_post_existing"
            ? 200
            : mode === "draft_post_403"
            ? 403
            : mode === "draft_post_deleted"
            ? 404
            : 409
          expect(res.status).toBe(expected)
        } else if (mode.startsWith("answers_")) {
          const res = yield* runRoute(
            routes.drafts(`${DRAFT_ID}/answers`),
            makeReq(`https://app.test/api/flow-drafts/${DRAFT_ID}/answers`, {
              method: mode === "answers_405" ? "GET" : "POST",
              body: mode === "answers_bad_json" ? "{" : answersBody,
            }),
          )
          const expected = mode === "answers_ok" || mode === "answers_noop"
            ? 200
            : mode === "answers_405"
            ? 405
            : mode === "answers_bad_json"
            ? 400
            : mode === "answers_404"
            ? 404
            : mode === "answers_403" || mode === "answers_person_only"
            ? 403
            : 409
          expect(res.status).toBe(expected)
        } else if (mode.startsWith("draft_del_")) {
          const res = yield* runRoute(
            routes.drafts(`${DRAFT_ID}/delete`),
            makeReq(`https://app.test/api/flow-drafts/${DRAFT_ID}/delete`, { method: mode === "draft_del_405" ? "GET" : "POST" }),
          )
          const expected = mode === "draft_del_ok"
            ? 200
            : mode === "draft_del_405"
            ? 405
            : mode === "draft_del_403"
            ? 403
            : mode === "draft_del_race_settled"
            ? 409
            : 404
          expect(res.status).toBe(expected)
        } else if (mode === "drafts_unknown") {
          expect((yield* runRoute(routes.drafts("bad-id"), makeReq("https://app.test/api/flow-drafts/bad"))).status).toBe(404)
          expect((yield* runRoute(routes.drafts(`${DRAFT_ID}/extra/more`), makeReq("https://app.test/api/flow-drafts/bad"))).status).toBe(404)
          expect((yield* runRoute(routes.drafts(`${DRAFT_ID}/unknown`), makeReq("https://app.test/api/flow-drafts/bad"))).status).toBe(404)
        } else {
          expect((yield* runRoute(routes.flowsShape, makeReq("https://app.test/api/shapes/flows?offset=-1"))).status).toBe(200)
          expect((yield* runRoute(routes.draftsShape, makeReq("https://app.test/api/shapes/flow-drafts?offset=-1"))).status).toBe(200)
        }
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/Views.ts", () => {
  it("fuzzes stateViewId, localHttpConfig, policyFor, add, state, shape, and askFrom", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "pure_helpers",
        "shape_named",
        "shape_home",
        "shape_bad_uuid",
        "shape_db_fail",
        "add_405",
        "add_401",
        "add_too_large_outer",
        "add_bad_json",
        "add_too_large_form",
        "add_form_refused",
        "add_form_ok",
        "add_form_existing",
        "add_form_id_taken",
        "add_repo_ok",
        "add_issues_ok",
        "add_webpage_ok",
        "add_webpage_refused_url",
        "add_link_local_http",
        "add_docs_refused_url",
        "add_docs_bad_target",
        "add_docs_already_added",
        "add_docs_refused_unavailable",
        "add_docs_refused_unreachable",
        "add_docs_refused_other",
        "add_docs_site_refused",
        "add_docs_ok_truncated",
        "add_answer_id",
        "add_precheck_forbidden",
        "add_conv_not_found",
        "add_lock_forbidden",
        "add_gen_kept",
        "add_gen_state_too_large",
        "add_gen_check_fail",
        "add_gen_render_fail",
        "add_gen_html_too_large",
        "add_gen_ok",
        "add_gen_conflict_existing",
        "add_gen_conflict_taken",
        "add_db_503",
        "state_405",
        "state_401",
        "state_too_large",
        "state_bad_json",
        "state_not_found",
        "state_forbidden",
        "state_existing_move",
        "state_undeclared",
        "state_stale",
        "state_interact_fail",
        "state_interact_huge_html",
        "state_ok",
        "state_db_503",
        "ask_from_missing",
        "ask_from_wrong_conv",
        "ask_from_form_undeclared",
        "ask_from_form_invalid_values",
        "ask_from_form_submitted_other",
        "ask_from_form_ok",
        "ask_from_form_resend",
        "ask_from_gen_message",
        "ask_from_gen_message_no_data",
        "ask_from_gen_undeclared",
        "ask_from_other_template",
      ]),
    )

    await holds(modeArb, Math.max(execs * 2, 90), (mode) =>
      Effect.gen(function* () {
        if (mode === "pure_helpers") {
          expect(Views.stateViewId(`/api/views/${VIEW_ID.toUpperCase()}/state`)).toBe(VIEW_ID)
          expect(Views.stateViewId("/api/views/not-uuid/state")).toBeUndefined()
          expect(Views.stateViewId("/api/views/other")).toBeUndefined()
          const lh = yield* Views.localHttpConfig(true).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
          )
          expect(lh).toBe(true)
          const pol = Views.policyFor(makeReq("https://app.test/api/views"), false)
          expect(pol).toEqual({ localHttp: false, appOrigin: "https://app.test" })
          return
        }

        const realmImpl: PresentationRealm.Realm = {
          components: ["div", "span", "p", "button"] as any,
          render: ({ state }) => {
            if (mode === "add_gen_render_fail") {
              return Effect.fail({
                _tag: "RenderError",
                reason: "render",
                limit: "steps",
                detail: Redacted.make("too many steps"),
              } as any)
            }
            if (mode === "add_gen_html_too_large") {
              return Effect.succeed("x".repeat(MAX_VIEW_HTML_BYTES + 10))
            }
            return Effect.succeed(`<div>${JSON.stringify(state)}</div>`)
          },
          interact: ({ state }) => {
            if (mode === "state_interact_fail") {
              return Effect.fail({ _tag: "RenderError", reason: "boom", detail: Redacted.make("boom") } as any)
            }
            if (mode === "state_interact_huge_html") {
              return Effect.succeed({ state, html: "h".repeat(MAX_VIEW_HTML_BYTES + 10) })
            }
            return Effect.succeed({ state: { count: 2 }, html: "<div>2</div>" })
          },
        }

        const docsLayer = Layer.succeed(
          DocsSource,
          DocsSource.of({
            index: () => Effect.succeed({ _tag: "Refused", code: "no_docs" } as any),
            page: () => {
              if (mode === "add_docs_refused_unavailable") {
                return Effect.succeed({ _tag: "Refused", code: "unavailable" } as any)
              }
              if (mode === "add_docs_refused_unreachable") {
                return Effect.succeed({ _tag: "Refused", code: "docs_unreachable" } as any)
              }
              if (mode === "add_docs_refused_other") {
                return Effect.succeed({ _tag: "Refused", code: "not_found" } as any)
              }
              if (mode === "add_docs_site_refused") {
                return Effect.succeed({
                  _tag: "Page",
                  page: { url: "javascript:alert(1)", title: "Bad", path: "/intro" },
                  text: "hello",
                } as any)
              }
              return Effect.succeed({
                _tag: "Page",
                page: { url: "https://docs.example.com/intro", title: "Intro", path: "/intro" },
                text: "a".repeat(70_000),
              } as any)
            },
          }),
        )

        let accessChecks = 0
        const db = makeSqlLayer((q) => {
          if (mode === "add_db_503" || mode === "state_db_503" || mode === "shape_db_fail") {
            return new Error("db_down")
          }
          if (q.includes("FROM conversations") && q.includes("home")) {
            return [{ id: CONV_ID }]
          }
          if (q.includes("FROM messages a JOIN messages q") && q.includes("a.role = 'assistant'")) {
            return [{ conversationId: CONV_ID }]
          }
          if (q.includes("FROM branches") && q.includes("conversations")) {
            accessChecks += 1
            if (mode === "add_conv_not_found") return []
            if (mode === "add_precheck_forbidden" || mode === "state_forbidden") {
              return [branchRow({ createdBy: OTHER_ID })]
            }
            if (mode === "add_lock_forbidden") {
              return accessChecks === 1 ? [branchRow()] : [branchRow({ createdBy: OTHER_ID })]
            }
            return [branchRow()]
          }
          if (q.includes("SELECT id FROM views WHERE id =") && q.includes("template = 'docs'")) {
            return mode === "add_docs_already_added" ? [{ id: VIEW_ID }] : []
          }
          if (q.includes("SELECT interactions FROM views")) {
            if (mode === "add_gen_kept" || mode === "add_gen_conflict_existing") {
              return [{ interactions: { inc: { kind: "state" } } }]
            }
            return []
          }
          if (q.includes("INSERT INTO views")) {
            if (
              mode === "add_form_existing" ||
              mode === "add_form_id_taken" ||
              mode === "add_gen_conflict_existing" ||
              mode === "add_gen_conflict_taken"
            ) {
              return []
            }
            return [{ txid: "101" }]
          }
          if (q.includes("AS same FROM views")) {
            return [{ same: mode === "add_form_existing" }]
          }
          if (q.includes("SELECT template, conversation_id AS \"conversationId\", code, props, state, interactions, revision")) {
            if (mode === "state_not_found") return []
            return [{
              template: "generated",
              conversationId: CONV_ID,
              code: VALID_VIEW_CODE,
              props: {},
              state: { count: 1 },
              interactions: { inc: { kind: "state" } },
              revision: 1,
            }]
          }
          if (q.includes("FROM view_moves")) {
            return mode === "state_existing_move" ? [{ revision: 2 }] : []
          }
          if (q.includes("UPDATE views SET state =") && q.includes("RETURNING")) {
            return [{ txid: "102", revision: 2 }]
          }
          if (q.includes("SELECT template, conversation_id AS \"conversationId\", props, state, interactions")) {
            if (mode === "ask_from_missing") return []
            if (mode === "ask_from_wrong_conv") {
              return [{ template: "form", conversationId: OTHER_ID, props: { schema: {} }, state: null, interactions: null }]
            }
            if (mode.startsWith("ask_from_form_")) {
              return [{
                template: "form",
                conversationId: CONV_ID,
                props: {
                  schema: {
                    type: "object",
                    properties: { title: { type: "string", title: "Title" } },
                    required: ["title"],
                  },
                },
                state: mode === "ask_from_form_submitted_other"
                  ? { submitted: true, questionId: OTHER_ID }
                  : mode === "ask_from_form_resend"
                  ? { submitted: true, questionId: QUESTION_ID }
                  : { submitted: false },
                interactions: null,
              }]
            }
            if (mode.startsWith("ask_from_gen_")) {
              return [{
                template: "generated",
                conversationId: CONV_ID,
                props: { schema: {} },
                state: null,
                interactions: { send: { kind: "message" }, inc: { kind: "state" } },
              }]
            }
            return [{ template: "webpage", conversationId: CONV_ID, props: { schema: {} }, state: null, interactions: null }]
          }
          if (q.includes("WITH question AS")) {
            return mode === "ask_from_form_resend" ? [] : [{ txid: "103", attempt: "103" }]
          }
          if (q.includes("FROM messages q LEFT JOIN messages a")) {
            return [{
              role: "user",
              text: "Submit",
              answerId: ANSWER_ID,
              askedBy: PERSON_ID,
              conversationId: CONV_ID,
              sameView: true,
            }]
          }
          return []
        })

        if (mode.startsWith("ask_from_")) {
          const baseQuestion = {
            id: QUESTION_ID,
            answerId: ANSWER_ID,
            conversationId: CONV_ID,
            text: "Submit",
            askedBy: PERSON_ID,
          }
          const src = mode === "ask_from_form_undeclared"
            ? { viewId: VIEW_ID, event: "other" }
            : mode.startsWith("ask_from_form_")
            ? { viewId: VIEW_ID, event: SUBMIT_EVENT }
            : mode === "ask_from_gen_undeclared"
            ? { viewId: VIEW_ID, event: "inc" }
            : { viewId: VIEW_ID, event: "send" }
          const data = mode === "ask_from_form_invalid_values"
            ? { title: 123 as any }
            : mode === "ask_from_gen_message_no_data"
            ? undefined
            : { title: "Hello" }
          const res = yield* Views.askFrom(baseQuestion, src, data).pipe(
            Effect.provide(db),
            Effect.result,
          )
          if (mode === "ask_from_form_ok" || mode === "ask_from_form_resend" || mode === "ask_from_gen_message" || mode === "ask_from_gen_message_no_data") {
            expect(Result.isSuccess(res)).toBe(true)
          } else {
            expect(Result.isFailure(res)).toBe(true)
          }
          return
        }

        const routes = yield* Views.make(db, {
          localHttp: mode === "add_link_local_http",
          realm: Effect.succeed(realmImpl),
        }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))))

        const actor = mode === "add_401" || mode === "state_401"
          ? Option.none<Actor.Actor>()
          : Option.some(personActor())
        const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), docsLayer, branchRolesLayer(), silentLogger)
        const runRoute = (eff: Effect.Effect<any, any, any>, req: HttpServerRequest.HttpServerRequest): Effect.Effect<any, any, never> =>
          eff.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req), Effect.provide(env)) as Effect.Effect<any, any, never>

        if (mode.startsWith("shape_")) {
          const url = mode === "shape_named"
            ? `https://app.test/api/shapes/views?offset=-1&conversation=${CONV_ID}`
            : mode === "shape_bad_uuid"
            ? "https://app.test/api/shapes/views?offset=-1&conversation=not-a-uuid"
            : "https://app.test/api/shapes/views?offset=-1"
          const res = yield* runRoute(routes.shape, makeReq(url))
          expect(res.status).toBe(mode === "shape_db_fail" ? 503 : 200)
          return
        }

        if (mode.startsWith("state_")) {
          const body = mode === "state_too_large"
            ? "x".repeat(40_000)
            : mode === "state_bad_json"
            ? "{"
            : JSON.stringify({
                moveId: "m1",
                revision: mode === "state_stale" ? 0 : 1,
                event: { name: mode === "state_undeclared" ? "nope" : "inc" },
              })
          const res = yield* runRoute(
            routes.state(VIEW_ID),
            makeReq(`https://app.test/api/views/${VIEW_ID}/state`, {
              method: mode === "state_405" ? "GET" : "POST",
              body,
            }),
          )
          const expected = mode === "state_ok" || mode === "state_existing_move"
            ? 200
            : mode === "state_405"
            ? 405
            : mode === "state_401"
            ? 401
            : mode === "state_too_large"
            ? 413
            : mode === "state_bad_json" || mode === "state_undeclared"
            ? 400
            : mode === "state_not_found"
            ? 404
            : mode === "state_forbidden"
            ? 403
            : mode === "state_stale"
            ? 409
            : mode === "state_db_503"
            ? 503
            : 422
          expect(res.status).toBe(expected)
          return
        }

        let payload: unknown = {
          id: VIEW_ID,
          conversationId: CONV_ID,
          template: "form",
          props: {
            title: "Form",
            submitLabel: "Send",
            schema: { type: "object", properties: { name: { type: "string", title: "Name" } } },
          },
        }
        if (mode === "add_form_refused") {
          payload = {
            id: VIEW_ID,
            conversationId: CONV_ID,
            template: "form",
            props: { title: "Bad", submitLabel: "Send", schema: { type: "object", properties: {} } },
          }
        } else if (mode === "add_too_large_form") {
          payload = {
            id: VIEW_ID,
            conversationId: CONV_ID,
            template: "form",
            props: {
              title: "Big",
              submitLabel: "Send",
              schema: {
                type: "object",
                properties: { a: { type: "string", description: "x".repeat(35_000) } },
              },
            },
          }
        } else if (mode === "add_repo_ok") {
          payload = { id: VIEW_ID, conversationId: CONV_ID, template: "repo", props: { repo: "acme/app" } }
        } else if (mode === "add_issues_ok") {
          payload = { id: VIEW_ID, conversationId: CONV_ID, template: "issues", props: { repo: "acme/app" } }
        } else if (mode === "add_webpage_ok") {
          payload = { id: VIEW_ID, conversationId: CONV_ID, template: "webpage", props: { url: "https://example.com/page", title: "Ex" } }
        } else if (mode === "add_webpage_refused_url") {
          payload = { id: VIEW_ID, conversationId: CONV_ID, template: "webpage", props: { url: "https://app.test/secret" } }
        } else if (mode === "add_link_local_http") {
          payload = { id: VIEW_ID, template: "link", props: { url: "http://localhost:3000/test" } }
        } else if (mode === "add_docs_refused_url") {
          payload = { id: VIEW_ID, conversationId: CONV_ID, template: "docs", props: { url: "https://app.test/docs", repository: "acme/app", path: "/intro" } }
        } else if (mode === "add_docs_bad_target") {
          payload = { id: VIEW_ID, conversationId: CONV_ID, template: "docs", props: { url: "https://docs.example.com/intro" } }
        } else if (mode.startsWith("add_docs_")) {
          payload = {
            id: VIEW_ID,
            conversationId: CONV_ID,
            template: "docs",
            props: { url: "https://docs.example.com/intro", repository: "acme/app", path: "/intro" },
          }
        } else if (mode === "add_answer_id") {
          payload = { id: VIEW_ID, answerId: ANSWER_ID, template: "repo", props: { repo: "acme/app" } }
        } else if (mode.startsWith("add_gen_")) {
          payload = {
            id: VIEW_ID,
            conversationId: CONV_ID,
            template: "generated",
            title: "Counter",
            size: "inline",
            code: mode === "add_gen_check_fail" ? "export default function() { return eval('1') }" : VALID_VIEW_CODE,
            props: { k: "v" },
            state: mode === "add_gen_state_too_large" ? { big: "s".repeat(MAX_VIEW_JSON_BYTES + 20) } : { count: 0 },
          }
        }

        const body = mode === "add_too_large_outer"
          ? "x".repeat(300_000)
          : mode === "add_bad_json"
          ? "{"
          : JSON.stringify(payload)
        const res = yield* runRoute(
          routes.add,
          makeReq("https://app.test/api/views", { method: mode === "add_405" ? "GET" : "POST", body }),
        )
        const expected =
          mode === "add_form_ok" ||
          mode === "add_repo_ok" ||
          mode === "add_issues_ok" ||
          mode === "add_webpage_ok" ||
          mode === "add_link_local_http" ||
          mode === "add_docs_already_added" ||
          mode === "add_docs_ok_truncated" ||
          mode === "add_answer_id" ||
          mode === "add_gen_ok"
            ? 202
            : mode === "add_form_existing" || mode === "add_gen_kept" || mode === "add_gen_conflict_existing"
            ? 200
            : mode === "add_405"
            ? 405
            : mode === "add_401"
            ? 401
            : mode === "add_too_large_outer" || mode === "add_too_large_form"
            ? 413
            : mode === "add_form_id_taken" || mode === "add_gen_conflict_taken"
            ? 409
            : mode === "add_precheck_forbidden" || mode === "add_lock_forbidden"
            ? 403
            : mode === "add_conv_not_found"
            ? 404
            : mode === "add_docs_refused_unavailable" || mode === "add_db_503"
            ? 503
            : mode === "add_docs_refused_unreachable"
            ? 502
            : mode === "add_gen_state_too_large" ||
              mode === "add_gen_check_fail" ||
              mode === "add_gen_render_fail" ||
              mode === "add_gen_html_too_large"
            ? 422
            : 400
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/personal/Models.ts", () => {
  it("fuzzes wireOf, sealContext, PersonalModels.none, and PersonalModels.layer open/openConnection", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "pure_wire_and_none",
        "open_empty",
        "open_no_model",
        "open_keys_off",
        "open_bad_cipher",
        "open_plan_fail",
        "open_ok_and_stream_err",
        "open_db_fail",
        "conn_missing",
        "conn_null_protocol",
        "conn_no_model",
        "conn_ok",
      ]),
    )

    const secret = Redacted.make("0123456789abcdef0123456789abcdef")
    const keysLayer = SecretKeys.layer(secret)

    await holds(modeArb, Math.max(execs, 28), (mode) =>
      Effect.gen(function* () {
        if (mode === "pure_wire_and_none") {
          expect(PersonalModels.wireOf("openai-chat", "api.openai.com", "gpt-5")).toBe("openai-responses")
          expect(PersonalModels.wireOf("openai-chat", "example.com", "gpt-5")).toBe("openai-chat")
          expect(PersonalModels.wireOf("anthropic-messages", "api.anthropic.com", "claude-sonnet-4-6")).toBe("anthropic-messages")
          expect(PersonalModels.sealContext(PERSON_ID, 2)).toEqual({ id: `person:${PERSON_ID}`, name: "model", version: 2 })
          const noneRes = yield* Effect.flatMap(PersonalModels.PersonalModels, (pm) =>
            Effect.all([pm.open(PERSON_ID, "fast"), pm.openConnection(PERSON_ID, CONN_ID)]),
          ).pipe(Effect.provide(PersonalModels.PersonalModels.none))
          expect(Option.isNone(noneRes[0])).toBe(true)
          expect(Option.isNone(noneRes[1])).toBe(true)
          return
        }

        const keysOpt = yield* SecretKeys.pipe(Effect.provide(keysLayer))
        const sealed = Option.isSome(keysOpt)
          ? yield* keysOpt.value.cipher.seal(Redacted.make("sk-test-1234567890"), PersonalModels.sealContext(PERSON_ID, 1))
          : { ciphertext: "bad", nonce: "bad" }

        const makeRow = (overrides: Record<string, unknown> = {}) => ({
          id: CONN_ID,
          kind: "api_key",
          active: true,
          protocol: "openai-chat",
          baseUrl: "https://api.openai.com/v1",
          fastModel: "gpt-4o-mini",
          implementModel: "gpt-5",
          hardModel: "gpt-5",
          keyLast4: "7890",
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          keyVersion: 1,
          position: 0,
          failedAt: null,
          failureCode: null,
          createdAt: "2026-10-20T00:00:00Z",
          updatedAt: "2026-10-20T00:00:00Z",
          ...overrides,
        })

        const db = makeSqlLayer(() => {
          if (mode === "open_db_fail") return new Error("db_down")
          if (mode === "open_empty" || mode === "conn_missing") return []
          if (mode === "open_no_model" || mode === "conn_no_model") {
            return [makeRow({ baseUrl: "https://custom.invalid/v1", fastModel: null, implementModel: null, hardModel: null })]
          }
          if (mode === "open_bad_cipher") return [makeRow({ ciphertext: "corrupt", nonce: "corrupt" })]
          if (mode === "open_plan_fail") return [makeRow({ baseUrl: "http://evil.example.com/v1" })]
          if (mode === "conn_null_protocol") return [makeRow({ protocol: null, baseUrl: null, kind: "codex" })]
          return [makeRow()]
        })

        const layer = PersonalModels.PersonalModels.layer(db).pipe(
          Layer.provide(mode === "open_keys_off" ? SecretKeys.off : keysLayer),
        )

        const eff = mode.startsWith("conn_")
          ? Effect.flatMap(PersonalModels.PersonalModels, (pm) => pm.openConnection(PERSON_ID, CONN_ID))
          : Effect.flatMap(PersonalModels.PersonalModels, (pm) => pm.open(PERSON_ID, "fast"))

        const exit = yield* eff.pipe(Effect.provide(layer), Effect.exit)

        if (mode === "open_empty" || mode === "conn_missing" || mode === "conn_null_protocol") {
          expect(Exit.isSuccess(exit) && Option.isNone(exit.value)).toBe(true)
        } else if (mode === "open_ok_and_stream_err" || mode === "conn_ok") {
          expect(Exit.isSuccess(exit) && Option.isSome(exit.value)).toBe(true)
          if (mode === "open_ok_and_stream_err" && Exit.isSuccess(exit) && Option.isSome(exit.value)) {
            const failFetch = Layer.succeed(
              FetchHttpClient.Fetch,
              () => Promise.reject(new Error("network_down")),
            )
            const streamExit = yield* Stream.runDrain(
              exit.value.value.model.stream({ messages: [{ role: "user", content: "hi" }] } as any),
            ).pipe(Effect.provide(failFetch), Effect.exit)
            expect(Exit.isFailure(streamExit)).toBe(true)
          }
        } else {
          expect(Exit.isFailure(exit)).toBe(true)
        }
      }),
    )
  }, 60_000)
})
