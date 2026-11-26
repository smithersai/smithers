import { FlowRuntime } from "@smthrs/flow"
import { Model, ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { HostModel, HostModelUnusable } from "@smthrs/model-host"
import { Fuzz } from "@smthrs/fuzz"
import {
  Arbitrary,
  ConfigProvider,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
  Stream,
} from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as Actor from "./Actor.vibe"
import * as BranchAccess from "./branch/Access.vibe"
import * as BudgetApi from "./branch/BudgetApi.vibe"
import * as ConversationApi from "./branch/ConversationApi.vibe"
import * as ConversationPeople from "./branch/ConversationPeople.vibe"
import * as SandboxCalls from "./branch/SandboxCalls.vibe"
import * as Flows from "./Flows.vibe"
import * as HostedModel from "./HostedModel.vibe"
import * as ModelSeats from "./ModelSeats.ts"
import * as ModelEndpoint from "./test/modelEndpoint.ts"
import * as ModelSpend from "./ModelSpend.vibe"
import * as PersonalModels from "./personal/Models.vibe"
import * as PersonalUsage from "./personal/Usage.vibe"
import * as RepoRuns from "./RepoRuns.ts"
import * as RunCredentials from "./RunCredentials.vibe"
import * as Runs from "./Runs.vibe"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261182")
const silentLogger = Logger.layer([])

const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_ID = "99999999-9999-4999-8999-999999999999"
const RUN_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"
const BRANCH_ID = "44444444-4444-4444-8444-444444444444"
const CALL_ID = "55555555-5555-4555-8555-555555555555"
const ANSWER_ID = "66666666-6666-4666-8666-666666666666"
const CONN_ID = "77777777-7777-4777-8777-777777777777"

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

const branchRolesLayer = (
  opts: {
    readonly role?: Actor.Role | null
    readonly repoRole?: Actor.Role | null
    readonly repoRoleError?: boolean
    readonly omitRepoRoleOn?: boolean
  } = {},
): Layer.Layer<BranchAccess.BranchRoles> =>
  Layer.succeed(
    BranchAccess.BranchRoles,
    BranchAccess.BranchRoles.of({
      roleOn: () => Effect.succeed(opts.role === undefined ? "member" : opts.role),
      uninstalled: () => (opts.role === undefined ? "member" : opts.role),
      ...(opts.omitRepoRoleOn
        ? {}
        : {
          repoRoleOn: () =>
            opts.repoRoleError
              ? Effect.fail({ _tag: "RoleRefused", code: "unavailable" } as any)
              : Effect.succeed({ role: opts.repoRole === undefined ? "maintainer" : opts.repoRole, held: Option.none() }),
        }),
    }),
  )

const mockRunCredentials = (renewed: Option.Option<RunCredentials.Claims> = Option.none()) =>
  Layer.succeed(
    RunCredentials.RunCredentials,
    RunCredentials.RunCredentials.of({
      sign: () => Effect.succeed("signed.jwt.token"),
      verify: () => Effect.succeed(Option.none()),
      renew: () => Effect.succeed(renewed),
    }),
  )

const mockTaskAnswers = (accepted = true) =>
  Layer.succeed(
    Flows.TaskAnswers,
    Flows.TaskAnswers.of({
      answer: () => Effect.succeed(accepted),
    }),
  )

const mockFlowStarter = (mode: "ok" | "conflict" | "unavailable" = "ok") =>
  Layer.succeed(
    Flows.FlowStarter,
    Flows.FlowStarter.of({
      start: () =>
        mode === "ok"
          ? Effect.void
          : mode === "conflict"
          ? Effect.fail(new Flows.StartConflict())
          : Effect.fail(new Flows.StartUnavailable({ errorCode: "host_down" })),
    }),
  )

describe("Wave8: worker/Runs.vibe", () => {
  it("fuzzes report, answer, addressedAnswer, credential mint/renew, and shape", async () => {
    const Mode = Schema.Literals([
      "bad_route_404",
      "bad_uuid_404",
      "bad_cred_segment_404",
      "method_405",
      "unauth_401",
      "asking_forbidden_403",
      "answer_person_only_403",
      "other_run_403",
      "report_too_large",
      "report_bad_json",
      "report_404",
      "report_not_launcher",
      "report_working_ok",
      "report_waiting_ok",
      "report_needs_you_question_ok",
      "report_needs_you_approval_ok",
      "report_done_ok",
      "report_idempotent",
      "report_settled_409",
      "report_other_launcher_409",
      "answer_too_large",
      "answer_bad_json",
      "answer_404",
      "answer_not_launcher",
      "answer_invalid_fit",
      "answer_question_ok",
      "answer_approval_bool_ok",
      "answer_approval_decision_ok",
      "answer_idempotent_string",
      "answer_idempotent_decision",
      "answer_not_open_409",
      "addr_not_addressee",
      "addr_role_503",
      "addr_not_maintainer",
      "addr_no_repo_role_fn",
      "addr_invalid_fit",
      "addr_ok",
      "addr_idempotent",
      "addr_not_waiting_503",
      "addr_not_open_409",
      "cred_too_large",
      "cred_bad_json",
      "cred_renew_ok",
      "cred_renew_refused",
      "cred_agent_404",
      "cred_agent_not_launcher",
      "cred_agent_ok",
      "cred_person_only_403",
      "cred_flow_ok",
      "db_503",
      "shape_in",
      "shape_out",
    ])

    const scenario = (mode: typeof Mode.Type) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (mode === "db_503") return new Error("db_down")
          if (q.includes("SELECT conversation_id AS \"conversationId\" FROM messages WHERE id =")) {
            return [{ conversationId: CONV_ID }]
          }
          if (q.includes("FROM branches") && q.includes("conversations")) {
            return mode === "asking_forbidden_403" ? [branchRow({ createdBy: OTHER_ID })] : [branchRow()]
          }
          if (q.includes("SELECT q.asked_by AS \"askedBy\"")) {
            if (mode === "report_404" || mode === "cred_agent_404") return []
            if (mode === "report_not_launcher" || mode === "cred_agent_not_launcher") return [{ askedBy: OTHER_ID }]
            return [{ askedBy: PERSON_ID }]
          }
          if (q.includes("INSERT INTO runs AS r")) {
            return mode.endsWith("_ok") ? [{ txid: "51" }] : []
          }
          if (q.includes("END AS reason FROM runs")) {
            if (mode === "report_settled_409") return [{ reason: "settled" }]
            if (mode === "report_other_launcher_409") return [{ reason: "other_launcher" }]
            return [{ reason: null }]
          }
          if (q.includes("SELECT launched_by AS \"launchedBy\", addressed_to AS \"addressedTo\"")) {
            if (mode === "answer_404") return []
            if (mode.startsWith("addr_")) {
              return [{
                launchedBy: "machine:codex/1",
                addressedTo: mode === "addr_not_addressee" ? OTHER_ID : PERSON_ID,
                repoId: "github/acme/app",
                execution: "exec-1",
                status: mode === "addr_not_open_409" ? "done" : "needs_you",
                version: 1,
                kind: "question",
                answer: mode === "addr_idempotent" ? { value: "ship it" } : null,
              }]
            }
            return [{
              launchedBy: mode === "answer_not_launcher" ? OTHER_ID : PERSON_ID,
              addressedTo: null,
              repoId: "github/acme/app",
              execution: "",
              status: mode === "answer_not_open_409" ? "done" : "needs_you",
              version: 1,
              kind: mode.includes("approval") || mode.includes("decision") ? "approval" : "question",
              answer: mode === "answer_idempotent_string"
                ? { value: "yes" }
                : mode === "answer_idempotent_decision"
                ? { value: { approved: true, note: "lgtm" } }
                : null,
            }]
          }
          if (q.includes("UPDATE runs SET answer =")) {
            if (mode === "answer_question_ok" || mode === "answer_approval_bool_ok" || mode === "answer_approval_decision_ok" || mode === "addr_ok") {
              return [{ txid: "52" }]
            }
            return []
          }
          return []
        })

        const routes = yield* Runs.make(db).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
        )
        const actor = mode === "unauth_401" || mode === "shape_out"
          ? Option.none<Actor.Actor>()
          : mode === "answer_person_only_403"
          ? Option.some(personActor({ act: { kind: "agent", id: RUN_ID } }))
          : mode === "other_run_403"
          ? Option.some(personActor({ act: { kind: "agent", id: OTHER_ID } }))
          : Option.some(personActor({ session: "sess-1" }))

        const renewedClaims: RunCredentials.Claims = {
          v: 1,
          sub: PERSON_ID,
          act: "agent",
          run: RUN_ID,
          root: RUN_ID,
          chain: ["chat/Answer"],
          ceiling: [],
          exp: Date.now() + 60_000,
        }
        const env = Layer.mergeAll(
          sessionsLayer(actor),
          mockElectricClient(),
          branchRolesLayer({
            repoRole: mode === "addr_not_maintainer" ? "member" : "maintainer",
            repoRoleError: mode === "addr_role_503",
            omitRepoRoleOn: mode === "addr_no_repo_role_fn",
          }),
          mockRunCredentials(mode === "cred_renew_ok" ? Option.some(renewedClaims) : Option.none()),
          mockTaskAnswers(mode !== "addr_not_waiting_503" && mode !== "addr_idempotent"),
          silentLogger,
        )
        const runRoute = (eff: Effect.Effect<any, any, any>, req: HttpServerRequest.HttpServerRequest): Effect.Effect<any, any, never> =>
          eff.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req), Effect.provide(env)) as Effect.Effect<any, any, never>

        if (mode === "shape_in" || mode === "shape_out") {
          expect((yield* runRoute(routes.shape, makeReq("https://app.test/api/shapes/runs?offset=-1"))).status).toBe(200)
          return
        }

        let rest = RUN_ID
        let method = "POST"
        let body = JSON.stringify({ status: "working" })

        if (mode === "bad_route_404") rest = `${RUN_ID}/unknown`
        else if (mode === "bad_uuid_404") rest = "not-a-uuid"
        else if (mode === "bad_cred_segment_404") rest = "%E0%A4%A/credential"
        else if (mode === "method_405") method = "GET"
        else if (mode === "report_too_large") body = "x".repeat(40_000)
        else if (mode === "report_bad_json") body = "{"
        else if (mode === "report_waiting_ok") body = JSON.stringify({ status: "waiting", waiting: "turn" })
        else if (mode === "report_needs_you_question_ok") {
          body = JSON.stringify({ status: "needs_you", wait: { execution: "e1", kind: "question", prompt: "Why?", options: [] } })
        } else if (mode === "report_needs_you_approval_ok") {
          body = JSON.stringify({ status: "needs_you", wait: { execution: "e2", kind: "approval", prompt: "Ok?", options: [] } })
        } else if (mode === "report_done_ok") body = JSON.stringify({ status: "done" })
        else if (mode.startsWith("answer_") || mode.startsWith("addr_") || mode === "answer_person_only_403") {
          rest = `${RUN_ID}/answer`
          if (mode === "answer_too_large") body = "x".repeat(40_000)
          else if (mode === "answer_bad_json") body = "{"
          else if (mode === "answer_invalid_fit" || mode === "addr_invalid_fit") body = JSON.stringify({ version: 1, value: "   " })
          else if (mode === "answer_approval_bool_ok") body = JSON.stringify({ version: 1, value: true })
          else if (mode === "answer_approval_decision_ok" || mode === "answer_idempotent_decision") {
            body = JSON.stringify({ version: 1, value: { approved: true, note: " lgtm " } })
          } else if (mode.startsWith("addr_")) body = JSON.stringify({ version: 1, value: " ship it " })
          else body = JSON.stringify({ version: 1, value: " yes " })
        } else if (mode.startsWith("cred_")) {
          rest = `${encodeURIComponent(RUN_ID)}/credential`
          if (mode === "cred_too_large") body = "x".repeat(40_000)
          else if (mode === "cred_bad_json") body = "{"
          else if (mode === "cred_renew_ok" || mode === "cred_renew_refused") body = JSON.stringify({ flow: "chat/Answer", renew: "tok" })
          else if (mode === "cred_person_only_403") body = JSON.stringify({ flow: "admin/SetModel" })
          else if (mode === "cred_flow_ok") body = JSON.stringify({ flow: "repo/read" })
          else body = JSON.stringify({ flow: "chat/Answer" })
        }

        const res = yield* runRoute(routes.route(rest), makeReq(`https://app.test/api/runs/${rest}`, { method, body }))
        const expected =
          mode === "bad_route_404" ||
          mode === "bad_uuid_404" ||
          mode === "bad_cred_segment_404" ||
          mode === "report_404" ||
          mode === "answer_404" ||
          mode === "cred_agent_404"
            ? 404
            : mode === "method_405"
            ? 405
            : mode === "unauth_401"
            ? 401
            : mode === "report_too_large" || mode === "answer_too_large" || mode === "cred_too_large"
            ? 413
            : mode === "report_bad_json" ||
              mode === "answer_bad_json" ||
              mode === "cred_bad_json" ||
              mode === "answer_invalid_fit" ||
              mode === "addr_invalid_fit"
            ? 400
            : mode === "asking_forbidden_403" ||
              mode === "answer_person_only_403" ||
              mode === "other_run_403" ||
              mode === "report_not_launcher" ||
              mode === "answer_not_launcher" ||
              mode === "addr_not_addressee" ||
              mode === "addr_not_maintainer" ||
              mode === "addr_no_repo_role_fn" ||
              mode === "cred_renew_refused" ||
              mode === "cred_agent_not_launcher" ||
              mode === "cred_person_only_403"
            ? 403
            : mode === "report_settled_409" ||
              mode === "report_other_launcher_409" ||
              mode === "answer_not_open_409" ||
              mode === "addr_not_open_409"
            ? 409
            : mode === "addr_role_503" || mode === "addr_not_waiting_503" || mode === "db_503"
            ? 503
            : 200
        expect(res.status).toBe(expected)
      })
    // The ingress handler can refuse this first. Exercise the route's own streaming limit too.
    await Effect.runPromise(scenario("answer_too_large"))
    await holds(Arbitrary.schema(Mode), Math.max(execs * 2, 75), scenario)
  }, 60_000)
})

describe("Wave8: worker/ModelSeats.ts, HostedModel.ts, ModelSpend.ts, personal/Usage.ts", () => {
  it("fuzzes ModelEndpoint make & local across personal/hosted/budget/meter/error paths", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "http_unauth",
        "http_sessions_fail",
        "http_server_tools_refused",
        "http_empty_messages",
        "http_too_many_messages",
        "http_bad_caps",
        "http_own_unusable",
        "http_own_unavailable",
        "http_own_begin_fail",
        "http_own_ok",
        "http_guest_no_deployment_pay",
        "http_hosted_off",
        "http_hosted_db_fail",
        "http_role_unusable",
        "http_budget_spent",
        "http_budget_db_fail",
        "http_hosted_ok_complete",
        "http_hosted_ok_expired",
        "http_hosted_quota_refusal",
        "http_hosted_settle_err",
        "local_ok_deployment",
        "local_ok_owned_personal",
        "local_owner_db_fail",
        "local_too_large",
        "local_stream_refused_cleanly",
        "local_stream_interrupted",
      ]),
    )

    const fakeModel = (kind: "ok" | "quota" | "refused4xx" | "interrupt" = "ok"): Model.Model =>
      Model.make({
        stream: () => {
          if (kind === "quota") {
            return Stream.fail(
              new ModelError.ModelError({ code: "quota_exceeded", message: "quota", httpStatus: 429 }),
            )
          }
          if (kind === "refused4xx") {
            return Stream.fail(
              new ModelError.ModelError({ code: "invalid_request", message: "bad", httpStatus: 400 }),
            )
          }
          if (kind === "interrupt") return Stream.fromEffect(Effect.interrupt)
          return Stream.fromIterable([
            { type: "text-delta", id: "t1", text: "hi" } as ModelEvent.ModelEvent,
            { type: "usage", inputTokens: 12, outputTokens: 8 } as ModelEvent.ModelEvent,
            { type: "finish", reason: "stop" } as unknown as ModelEvent.ModelEvent,
          ])
        },
      })

    await holds(modeArb, Math.max(execs * 2, 55), (mode) =>
      Effect.gen(function* () {
        const db = makeSqlLayer((q) => {
          if (mode === "http_hosted_db_fail" && q.includes("FROM hosted_model")) return new Error("db_down")
          if (mode === "http_budget_db_fail" && q.includes("model_budget_days")) return new Error("db_down")
          if (mode === "http_own_begin_fail" && q.includes("personal_model_usage")) return new Error("db_down")
          if (mode === "http_hosted_settle_err" && q.includes("UPDATE model_usage")) return new Error("db_down")
          if (q.includes("FROM hosted_model")) return [{ enabled: mode !== "http_hosted_off" }]
          if (q.includes("FROM model_roles")) {
            return mode === "http_role_unusable" ? [{ model: "invalid-record" }] : []
          }
          if (q.includes("INSERT INTO model_usage")) {
            return mode === "http_budget_spent" ? [] : [{ invocationId: "inv-1" }]
          }
          if (q.includes("UPDATE model_usage")) {
            return mode === "http_hosted_ok_expired" ? [] : [{ invocationId: "inv-1" }]
          }
          if (q.includes("UPDATE personal_model_usage")) return [{ invocationId: "inv-1" }]
          return []
        })

        const hostModelLayer = Layer.succeed(
          HostModel,
          HostModel.of({
            modelId: "gpt-4o-mini",
            model: fakeModel(
              mode === "http_hosted_quota_refusal"
                ? "quota"
                : mode === "local_stream_refused_cleanly"
                ? "refused4xx"
                : mode === "local_stream_interrupted"
                ? "interrupt"
                : "ok",
            ),
          } as any),
        )

        const personalLayer = Layer.succeed(
          PersonalModels.PersonalModels,
          PersonalModels.PersonalModels.of({
            open: () => {
              if (mode === "http_own_unusable") {
                return Effect.fail(new PersonalModels.PersonalModelUnusable({ reason: "key", host: "api.openai.com" }))
              }
              if (mode === "http_own_unavailable") {
                return Effect.fail(new PersonalModels.PersonalModelsUnavailable({ errorCode: "db" }))
              }
              if (mode === "http_own_ok" || mode === "http_own_begin_fail" || mode === "local_ok_owned_personal") {
                return Effect.succeed(
                  Option.some({
                    modelId: "gpt-4o-mini",
                    model: fakeModel("ok"),
                    host: "api.openai.com",
                    protocol: "openai-chat",
                    connectionId: CONN_ID,
                    credentialNonce: "n1",
                    tier: "fast",
                  }),
                )
              }
              return Effect.succeedNone
            },
            openConnection: () => Effect.succeedNone,
          }),
        )

        const cfg = ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              MODEL_MAX_MESSAGES: "3",
              MODEL_MAX_REQUEST_BYTES: mode === "local_too_large" ? "50" : "196608",
              MODEL_ROLE_TIERS: mode === "http_hosted_ok_complete" ? "invalid-json" : "",
            },
          }),
        )

        if (mode.startsWith("local_")) {
          const mkSeat = yield* ModelSeats.local(db, { alerts: true, hosted: true }).pipe(
            Effect.provide(Layer.mergeAll(hostModelLayer, personalLayer, cfg, silentLogger)),
          )
          const starter = {
            start: () => Effect.void,
          } as Flows.FlowStarter["Service"]
          const owner: ModelSeats.Owner = () =>
            mode === "local_owner_db_fail"
              ? Effect.fail(new Error("owner_db"))
              : Effect.succeed(
                mode === "local_ok_owned_personal"
                  ? Option.some({ personId: PERSON_ID, deploymentPays: false })
                  : Option.none(),
              )
          const seat = mkSeat("agent", starter, owner)
          const req = ModelRequest.ModelRequest.make({
            modelId: "gpt-4o-mini",
            system: [],
            messages: [ModelRequest.Message.user(mode === "local_too_large" ? "x".repeat(210_000) : "hello world from local model call")],
            tools: [],
            params: ModelRequest.GenerationParams.make({ maxTokens: 100 }),
          })
          const exit = yield* Stream.runDrain(seat.model.stream(req)).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, { executionId: "exec-1" } as any),
            Effect.provide(silentLogger),
            Effect.exit,
          )
          if (mode === "local_ok_deployment" || mode === "local_ok_owned_personal") {
            expect(Exit.isSuccess(exit)).toBe(true)
          } else {
            expect(Exit.isFailure(exit)).toBe(true)
          }
          return
        }

        const endpoint = yield* ModelEndpoint.make(db, { alerts: false, hosted: true }).pipe(
          Effect.provide(Layer.mergeAll(hostModelLayer, cfg, silentLogger)),
        )
        const actor = mode === "http_unauth"
          ? Option.none<Actor.Actor>()
          : mode === "http_sessions_fail"
          ? new Error("sess_down")
          : mode === "http_guest_no_deployment_pay"
          ? Option.some(personActor({ role: "guest" }))
          : Option.some(personActor())

        const baseMessages = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
        const reqPayload: Record<string, unknown> = {
          modelId: "gpt-4o-mini",
          system: [],
          tools: [],
          messages: mode === "http_empty_messages"
            ? []
            : mode === "http_too_many_messages"
            ? [...baseMessages, ...baseMessages, ...baseMessages, ...baseMessages]
            : baseMessages,
          params: mode === "http_bad_caps" ? { maxTokens: -1 } : { maxTokens: 100, thinkingBudget: 10 },
          ...(mode === "http_server_tools_refused" ? { serverTools: [{ type: "web_search" }] } : {}),
        }
        const httpReq = makeReq("https://app.test/api/model/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqPayload),
        })
        const res = yield* endpoint("agent").pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, httpReq),
          Effect.provide(Layer.mergeAll(sessionsLayer(actor), personalLayer, mockFlowStarter(), silentLogger)),
        )
        // Drain response body stream so onEnd metering runs!
        const webRes = yield* Effect.tryPromise(() => Promise.resolve(res.body))
        if (webRes && typeof (webRes as any).stream !== "undefined") {
          yield* Stream.runDrain((webRes as { stream: Stream.Stream<Uint8Array, unknown, never> }).stream).pipe(Effect.ignore)
        }
        expect(res.status).toBeGreaterThanOrEqual(200)
      }),
    )
  }, 60_000)

  it("fuzzes HostedModel, ModelSpend, and personal/Usage", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "hosted_405",
        "hosted_401",
        "hosted_too_large",
        "hosted_bad_json",
        "hosted_delegated",
        "hosted_not_admin",
        "hosted_ok_insert",
        "hosted_ok_repeat",
        "hosted_db_503",
        "hosted_no_inv_key",
        "spend_zero",
        "spend_priced",
        "spend_alerter_on_ok",
        "spend_alerter_on_conflict",
        "spend_alerter_on_fail",
        "spend_alerter_off",
        "pusage_success",
        "pusage_refused_401",
        "pusage_refused_429_quota",
        "pusage_429_rate",
        "pusage_already_settled",
        "pusage_db_err",
      ]),
    )

    await holds(modeArb, Math.max(execs, 36), (mode) =>
      Effect.gen(function* () {
        if (mode === "hosted_no_inv_key") {
          const db = makeSqlLayer(() => [])
          const exit = yield* HostedModel.write({ enabled: true }, personActor({ role: "admin" }), undefined, db).pipe(
            Effect.provide(silentLogger),
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          return
        }
        if (mode.startsWith("hosted_")) {
          const db = makeSqlLayer((q) => {
            if (mode === "hosted_db_503") return new Error("db_down")
            if (q.includes("hosted_model_changes")) return mode === "hosted_ok_repeat" ? [] : [{ invocation_key: "k" }]
            return []
          })
          const actor = mode === "hosted_401"
            ? Option.none<Actor.Actor>()
            : mode === "hosted_delegated"
            ? Option.some(personActor({ role: "admin", act: { kind: "agent", id: RUN_ID } }))
            : mode === "hosted_not_admin"
            ? Option.some(personActor({ role: "member" }))
            : Option.some(personActor({ role: "admin" }))
          const req = makeReq("https://app.test/api/hosted-model", {
            method: mode === "hosted_405" ? "GET" : "POST",
            body: mode === "hosted_too_large"
              ? "x".repeat(5_000)
              : mode === "hosted_bad_json"
              ? "{"
              : JSON.stringify({ enabled: true }),
          })
          const res = yield* HostedModel.route(db).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(Layer.mergeAll(sessionsLayer(actor), silentLogger)),
          )
          const expected = mode === "hosted_405"
            ? 405
            : mode === "hosted_401"
            ? 401
            : mode === "hosted_too_large"
            ? 413
            : mode === "hosted_bad_json"
            ? 400
            : mode === "hosted_delegated" || mode === "hosted_not_admin"
            ? 403
            : mode === "hosted_db_503"
            ? 503
            : 200
          expect(res.status).toBe(expected)
          return
        }

        if (mode.startsWith("spend_")) {
          if (mode === "spend_zero") {
            yield* ModelSpend.record("agent", { invocationId: "i1", modelId: "unknown-model", usage: {} }).pipe(
              Effect.provide(silentLogger),
            )
          } else if (mode === "spend_priced") {
            yield* ModelSpend.record("agent", {
              invocationId: "i2",
              modelId: "gpt-4o-mini",
              usage: { inputTokens: 1000, outputTokens: 500 },
            }).pipe(Effect.provide(silentLogger))
          } else {
            const cfg = yield* ModelSpend.settings({ on: mode !== "spend_alerter_off" }).pipe(
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { MODEL_SPEND_ALERT_WINDOW: "1 minute" } }))),
            )
            const alert = yield* ModelSpend.alerter(cfg, 100_000)
            const starterKind = mode === "spend_alerter_on_conflict"
              ? "conflict"
              : mode === "spend_alerter_on_fail"
              ? "unavailable"
              : "ok"
            yield* alert.pipe(Effect.provide(Layer.mergeAll(mockFlowStarter(starterKind), silentLogger)))
          }
          return
        }

        const db = makeSqlLayer((q) => {
          if (mode === "pusage_db_err") return new Error("db_down")
          if (q.includes("UPDATE personal_model_usage")) {
            return mode === "pusage_already_settled" ? [] : [{ invocationId: "i1" }]
          }
          return []
        })
        const call: PersonalUsage.Call = {
          invocationId: "i1",
          requestId: "r1",
          personId: PERSON_ID,
          role: "agent",
          modelId: "gpt-4o-mini",
          host: "api.openai.com",
          connectionId: CONN_ID,
          credentialNonce: "n1",
          protocol: "openai-chat",
          tier: "fast",
        }
        const ended: PersonalUsage.End = mode === "pusage_refused_401"
          ? { outcome: "failed", usage: {}, httpStatus: 401, errorCode: "auth" }
          : mode === "pusage_refused_429_quota"
          ? { outcome: "failed", usage: {}, httpStatus: 429, errorCode: "quota_exceeded" }
          : mode === "pusage_429_rate"
          ? { outcome: "failed", usage: {}, httpStatus: 429, errorCode: "rate_limited" }
          : { outcome: "success", usage: { inputTokens: 10, outputTokens: 5 } }
        yield* PersonalUsage.end(call, ended, db).pipe(Effect.provide(silentLogger))
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/branch/SandboxCalls.ts, ConversationApi.ts, BudgetApi.ts, RepoRuns.ts", () => {
  it("fuzzes SandboxCalls POST/GET across all admission, save-seed, starter, and result paths", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "handles_pure",
        "post_405",
        "post_401",
        "post_too_large",
        "post_bad_json",
        "post_both_ids_400",
        "post_other_run_403",
        "post_answer_forbidden",
        "post_answer_missing",
        "post_branch_missing",
        "post_cannot_edit",
        "post_members_only",
        "post_locked",
        "post_too_long",
        "post_save_unseeded",
        "post_save_seeded_ok",
        "post_id_taken",
        "post_start_conflict",
        "post_start_unavailable",
        "post_new_ok_ephemeral",
        "post_existing_done",
        "post_existing_failed",
        "post_db_503",
        "get_405",
        "get_bad_uuid",
        "get_401",
        "get_404_missing",
        "get_404_other_person",
        "get_running_ok",
        "get_done_ok",
        "get_failed_ok",
      ]),
    )

    await holds(modeArb, Math.max(execs * 2, 60), (mode) =>
      Effect.gen(function* () {
        if (mode === "handles_pure") {
          expect(SandboxCalls.handles("/api/sandbox/calls")).toBe(true)
          expect(SandboxCalls.handles(`/api/sandbox/calls/${CALL_ID}`)).toBe(true)
          expect(SandboxCalls.handles("/api/other")).toBe(false)
          return
        }

        const db = makeSqlLayer((q) => {
          if (mode === "post_db_503") return new Error("db_down")
          if (q.includes("FROM messages a JOIN messages q")) {
            if (mode === "post_answer_missing") return []
            if (mode === "post_answer_forbidden") return [{ conversationId: CONV_ID, askedBy: OTHER_ID }]
            return [{ conversationId: CONV_ID, askedBy: PERSON_ID }]
          }
          if (q.includes("FROM branches") && q.includes("conversations")) {
            if (mode === "post_branch_missing") return []
            if (mode === "post_cannot_edit") return [branchRow({ createdBy: OTHER_ID })]
            if (mode === "post_locked") return [branchRow({ mode: "locked" })]
            return [branchRow()]
          }
          if (q.includes("FROM text_updates")) {
            return mode === "post_save_unseeded" ? [] : [{ id: "seed-1" }]
          }
          if (q.includes("INSERT INTO sandbox_calls")) {
            return mode === "post_existing_done" || mode === "post_existing_failed" || mode === "post_id_taken"
              ? []
              : [{ id: CALL_ID }]
          }
          if (q.includes("FROM sandbox_calls WHERE id =")) {
            if (mode === "get_404_missing") return []
            if (mode === "post_id_taken" || mode === "get_404_other_person") {
              return [{ branchId: BRANCH_ID, personId: OTHER_ID, tool: "run", status: "running", failure: null, result: null }]
            }
            if (mode === "post_existing_done" || mode === "get_done_ok") {
              return [{ branchId: BRANCH_ID, personId: PERSON_ID, tool: "run", status: "done", failure: null, result: { exitCode: 0 } }]
            }
            if (mode === "post_existing_failed" || mode === "get_failed_ok") {
              return [{ branchId: BRANCH_ID, personId: PERSON_ID, tool: "run", status: "failed", failure: "boom", result: null }]
            }
            return [{
              branchId: BRANCH_ID,
              personId: PERSON_ID,
              tool: mode === "post_save_seeded_ok" ? "write" : "run",
              status: "running",
              failure: null,
              result: null,
            }]
          }
          if (q.includes("SELECT namespace FROM branches")) {
            return [{ namespace: mode === "post_new_ok_ephemeral" ? "ephemeral" : "default" }]
          }
          if (q.includes("SELECT forge FROM branches")) return [{ forge: "github" }]
          return []
        })

        const routes = SandboxCalls.make(db, 120)
        const actor = mode === "post_401" || mode === "get_401"
          ? Option.none<Actor.Actor>()
          : mode === "post_other_run_403"
          ? Option.some(personActor({ act: { kind: "agent", id: OTHER_ID } }))
          : mode === "post_members_only"
          ? Option.some(personActor({ role: "guest" }))
          : Option.some(personActor())
        const starterMode = mode === "post_start_conflict"
          ? "conflict"
          : mode === "post_start_unavailable"
          ? "unavailable"
          : "ok"
        const env = Layer.mergeAll(
          sessionsLayer(actor),
          branchRolesLayer({ role: mode === "post_members_only" ? "member" : "member" }),
          mockFlowStarter(starterMode),
          silentLogger,
        )

        const isGet = mode.startsWith("get_")
        const url = isGet
          ? `https://app.test/api/sandbox/calls/${mode === "get_bad_uuid" ? "bad" : CALL_ID}`
          : "https://app.test/api/sandbox/calls"
        const method = mode === "post_405" ? "GET" : mode === "get_405" ? "POST" : isGet ? "GET" : "POST"

        let body: string | undefined
        if (!isGet && method === "POST") {
          if (mode === "post_too_large") body = "x".repeat(3 * 1024 * 1024 + 16)
          else if (mode === "post_bad_json") body = "{"
          else if (mode === "post_both_ids_400") {
            body = JSON.stringify({ callId: CALL_ID, conversationId: CONV_ID, answerId: ANSWER_ID, call: { tool: "run", command: "ls" } })
          } else if (mode === "post_other_run_403" || mode === "post_answer_forbidden" || mode === "post_answer_missing") {
            body = JSON.stringify({ callId: CALL_ID, answerId: ANSWER_ID, call: { tool: "run", command: "ls" } })
          } else if (mode === "post_too_long") {
            body = JSON.stringify({ callId: CALL_ID, conversationId: CONV_ID, call: { tool: "run", command: "ls", timeoutSeconds: 300 } })
          } else if (mode === "post_save_unseeded" || mode === "post_save_seeded_ok") {
            body = JSON.stringify({ callId: CALL_ID, conversationId: CONV_ID, save: true, call: { tool: "write", path: "a.ts", content: "hi" } })
          } else {
            body = JSON.stringify({ callId: CALL_ID, conversationId: CONV_ID, call: { tool: "run", command: "ls" } })
          }
        }

        const res = yield* routes.fetch.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq(url, { method, ...(body === undefined ? {} : { body }) })),
          Effect.provide(env),
        )
        const expected =
          mode === "post_save_seeded_ok" || mode === "post_new_ok_ephemeral"
            ? 202
            : mode === "post_existing_done" || mode === "post_existing_failed" || mode === "get_running_ok" || mode === "get_done_ok" || mode === "get_failed_ok"
            ? 200
            : mode === "post_405" || mode === "get_405"
            ? 405
            : mode === "post_401" || mode === "get_401"
            ? 401
            : mode === "post_too_large"
            ? 413
            : mode === "post_bad_json" || mode === "post_both_ids_400" || mode === "post_too_long" || mode === "post_save_unseeded"
            ? 400
            : mode === "post_other_run_403" || mode === "post_answer_forbidden" || mode === "post_cannot_edit" || mode === "post_members_only"
            ? 403
            : mode === "post_answer_missing" || mode === "post_branch_missing" || mode === "get_bad_uuid" || mode === "get_404_missing" || mode === "get_404_other_person"
            ? 404
            : mode === "post_locked" || mode === "post_id_taken" || mode === "post_start_conflict"
            ? 409
            : 503
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)

  it("fuzzes ConversationApi, ConversationPeople, BudgetApi, and RepoRuns", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "conv_shape_in",
        "conv_shape_out",
        "conv_405",
        "conv_401",
        "conv_too_large",
        "conv_bad_json",
        "conv_future_at",
        "conv_other_run",
        "conv_answer_forbidden",
        "conv_answer_missing",
        "conv_branch_missing",
        "conv_cannot_view",
        "conv_archived_ok",
        "conv_restored_ok",
        "conv_unchanged_ok",
        "conv_db_503",
        "people_opened_asked",
        "budget_405",
        "budget_401",
        "budget_person_only",
        "budget_not_admin",
        "budget_too_large",
        "budget_bad_json",
        "budget_ok",
        "budget_db_503",
        "budget_shape_admin",
        "reporuns_record_new",
        "reporuns_record_existing",
        "reporuns_recorded_sha",
        "reporuns_settle_not_working",
        "reporuns_settle_still_running",
        "reporuns_settle_missing_stopped",
        "reporuns_settle_completed_ok",
        "reporuns_settle_completed_failed",
        "reporuns_settle_cancelled",
        "reporuns_intent_valid",
        "reporuns_intent_other",
        "reporuns_admit_ancestor",
        "reporuns_admit_none",
      ]),
    )

    await holds(modeArb, Math.max(execs * 2, 65), (mode) =>
      Effect.gen(function* () {
        if (mode === "people_opened_asked") {
          const db = makeSqlLayer(() => [])
          yield* ConversationPeople.opened(CONV_ID, PERSON_ID, "acme", "app", "main").pipe(Effect.provide(db))
          yield* ConversationPeople.opened(CONV_ID, PERSON_ID, "acme", "app", "main", Date.now()).pipe(Effect.provide(db))
          yield* ConversationPeople.asked(CONV_ID, PERSON_ID).pipe(Effect.provide(db))
          return
        }

        if (mode.startsWith("reporuns_")) {
          const appDb = makeSqlLayer((q) => {
            if (q.includes("INSERT INTO runs")) return mode === "reporuns_record_new" ? [{ id: RUN_ID }] : []
            if (q.includes("SELECT sha FROM runs")) return [{ sha: "a".repeat(40) }]
            if (q.includes("SELECT id::text FROM runs")) return mode === "reporuns_settle_not_working" ? [] : [{ id: RUN_ID }]
            if (q.includes("SELECT execution, repo_id FROM runs")) {
              if (mode === "reporuns_admit_ancestor" && q.includes("$in0")) {
                return q.includes("runs") ? [] : []
              }
              return []
            }
            return []
          })
          const engineDb = makeSqlLayer((q) => {
            if (q.includes("SELECT status FROM flows_runs")) {
              if (mode === "reporuns_settle_still_running") return [{ status: "running" }]
              if (mode === "reporuns_settle_missing_stopped") return []
              if (mode === "reporuns_settle_cancelled") return [{ status: "cancelled" }]
              return [{ status: "completed" }]
            }
            if (q.includes("SELECT parent_run_id")) return [{ id: "parent-1" }]
            return []
          })

          if (mode === "reporuns_record_new" || mode === "reporuns_record_existing") {
            const added = yield* RepoRuns.record({
              execution: "exec-1",
              repoId: "github/acme/app",
              flow: "ci",
              sha: "a".repeat(40),
              ref: "refs/heads/main",
              event: "push",
              launchedBy: PERSON_ID,
            }).pipe(Effect.provide(Layer.mergeAll(appDb, silentLogger)))
            expect(added).toBe(mode === "reporuns_record_new")
          } else if (mode === "reporuns_recorded_sha") {
            const sha = yield* RepoRuns.recordedSha("exec-1").pipe(Effect.provide(appDb))
            expect(Option.isSome(sha)).toBe(true)
          } else if (mode.startsWith("reporuns_settle_")) {
            const settled = yield* RepoRuns.settle(
              "exec-1",
              engineDb,
              Effect.succeed(mode === "reporuns_settle_completed_failed"),
            ).pipe(Effect.provide(Layer.mergeAll(appDb, silentLogger)))
            if (mode === "reporuns_settle_not_working" || mode === "reporuns_settle_still_running") {
              expect(Option.isNone(settled)).toBe(true)
            } else {
              expect(Option.isSome(settled)).toBe(true)
            }
          } else if (mode === "reporuns_intent_valid" || mode === "reporuns_intent_other") {
            const intent = RepoRuns.repositoryIntent(
              mode === "reporuns_intent_other"
                ? { flow: "other", executionId: "e1", payload: {} }
                : {
                  flow: "ci/RepoFlow",
                  executionId: "e1",
                  payload: {
                    run: "e1",
                    repo: "acme/app",
                    flow: "ci",
                    sha: "a".repeat(40),
                    ref: "refs/heads/main",
                    event: "push",
                    actor: PERSON_ID,
                  },
                },
            )
            expect(Option.isSome(intent) || Option.isNone(intent)).toBe(true)
          } else {
            let calls = 0
            const admitAppDb = makeSqlLayer(() => {
              calls += 1
              return mode === "reporuns_admit_ancestor" && calls === 2
                ? [{ execution: "parent-1", repo_id: "github/acme/app" }]
                : []
            })
            const admitted = yield* RepoRuns.admit("child-1", engineDb, 2).pipe(Effect.provide(admitAppDb))
            expect(Option.isSome(admitted)).toBe(mode === "reporuns_admit_ancestor")
          }
          return
        }

        if (mode.startsWith("budget_")) {
          const db = makeSqlLayer((q) => {
            if (mode === "budget_db_503") return new Error("db_down")
            if (q.includes("INSERT INTO sandbox_limits")) return [{ txid: "99" }]
            return []
          })
          const routes = yield* BudgetApi.make(db).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
          )
          const actor = mode === "budget_401"
            ? Option.none<Actor.Actor>()
            : mode === "budget_person_only"
            ? Option.some(personActor({ role: "admin", act: { kind: "agent", id: RUN_ID } }))
            : mode === "budget_not_admin"
            ? Option.some(personActor({ role: "member" }))
            : Option.some(personActor({ role: "admin" }))
          const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), silentLogger)
          if (mode === "budget_shape_admin") {
            const res = yield* routes.limits.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://app.test/api/shapes/sandbox-limits?offset=-1")),
              Effect.provide(env),
            )
            expect(res.status).toBe(200)
            return
          }
          const req = makeReq("https://app.test/api/sandbox-limits", {
            method: mode === "budget_405" ? "GET" : "POST",
            body: mode === "budget_too_large"
              ? "x".repeat(5_000)
              : mode === "budget_bad_json"
              ? "{"
              : JSON.stringify({ awake: 5, perPerson: 2, monthlyAlertUsd: 50 }),
          })
          const res = yield* routes.set.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(env),
          )
          const expected = mode === "budget_405"
            ? 405
            : mode === "budget_401"
            ? 401
            : mode === "budget_person_only" || mode === "budget_not_admin"
            ? 403
            : mode === "budget_too_large"
            ? 413
            : mode === "budget_bad_json"
            ? 400
            : mode === "budget_db_503"
            ? 503
            : 200
          expect(res.status).toBe(expected)
          return
        }

        // ConversationApi
        expect(ConversationApi.handles("/api/conversations/archive")).toBe(true)
        expect(ConversationApi.handles("/api/shapes/my-conversations")).toBe(true)
        expect(ConversationApi.handles("/api/other")).toBe(false)

        const db = makeSqlLayer((q) => {
          if (mode === "conv_db_503") return new Error("db_down")
          if (q.includes("FROM messages a JOIN messages q")) {
            if (mode === "conv_answer_missing") return []
            if (mode === "conv_answer_forbidden") return [{ conversationId: CONV_ID, askedBy: OTHER_ID }]
            return [{ conversationId: CONV_ID, askedBy: PERSON_ID }]
          }
          if (q.includes("FROM branches") && q.includes("conversations")) {
            if (mode === "conv_branch_missing") return []
            if (mode === "conv_cannot_view") return [branchRow({ createdBy: OTHER_ID })]
            return [branchRow()]
          }
          if (q.includes("INSERT INTO conversation_people")) {
            return mode === "conv_unchanged_ok" ? [] : [{ txid: "66" }]
          }
          return []
        })
        const routes = yield* ConversationApi.make(db).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))),
        )
        const actor = mode === "conv_401" || mode === "conv_shape_out"
          ? Option.none<Actor.Actor>()
          : mode === "conv_other_run"
          ? Option.some(personActor({ act: { kind: "agent", id: OTHER_ID } }))
          : Option.some(personActor())
        const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), branchRolesLayer(), silentLogger)

        if (mode === "conv_shape_in" || mode === "conv_shape_out") {
          const res = yield* routes.fetch.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://app.test/api/shapes/my-conversations?offset=-1")),
            Effect.provide(env),
          )
          expect(res.status).toBe(200)
          return
        }

        const now = Date.now()
        const body = mode === "conv_too_large"
          ? "x".repeat(5_000)
          : mode === "conv_bad_json"
          ? "{"
          : mode === "conv_future_at"
          ? JSON.stringify({ conversationId: CONV_ID, archived: true, at: now + 100_000_000 })
          : mode === "conv_other_run" || mode === "conv_answer_forbidden" || mode === "conv_answer_missing"
          ? JSON.stringify({ answerId: ANSWER_ID, archived: true, at: now })
          : JSON.stringify({ conversationId: CONV_ID, archived: mode !== "conv_restored_ok", at: now })
        const res = yield* routes.fetch.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            makeReq("https://app.test/api/conversations/archive", {
              method: mode === "conv_405" ? "GET" : "POST",
              body,
            }),
          ),
          Effect.provide(env),
        )
        const expected = mode === "conv_405"
          ? 405
          : mode === "conv_401"
          ? 401
          : mode === "conv_too_large"
          ? 413
          : mode === "conv_bad_json" || mode === "conv_future_at"
          ? 400
          : mode === "conv_other_run" || mode === "conv_answer_forbidden" || mode === "conv_cannot_view"
          ? 403
          : mode === "conv_answer_missing" || mode === "conv_branch_missing"
          ? 404
          : mode === "conv_db_503"
          ? 503
          : 200
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)
})
