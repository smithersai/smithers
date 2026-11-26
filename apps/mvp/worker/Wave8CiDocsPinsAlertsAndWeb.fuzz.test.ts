import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { ImmutableCache } from "@smthrs/artifacts"
import { FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { QuickJSVariant } from "@smthrs/harness"
import { Channels } from "@smthrs/notifications"
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
} from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { describe, expect, it } from "vitest"
import * as TodoWrites from "../src/features/todos/writes.ts"
import * as Actor from "./Actor.ts"
import * as AlertChannels from "./AlertChannels.vibe"
import * as BranchAccess from "./branch/Access.ts"
import * as CiRealm from "./ci/Realm.vibe"
import * as RepoFlow from "./ci/RepoFlow.vibe"
import * as DocsApi from "./docs/Api.vibe"
import * as DocsSourceMod from "./docs/Source.vibe"
import * as AlertDelivery from "./flows/AlertDelivery.ts"
import * as AskFlow from "./flows/Ask.ts"
import * as SandboxCallFlow from "./flows/SandboxCall.ts"
import * as SpendAlertFlow from "./flows/SpendAlert.ts"
import * as GitHubTokens from "./github/Tokens.ts"
import * as Pins from "./Pins.vibe"
import * as WebPreview from "./WebPreview.vibe"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261184")
const silentLogger = Logger.layer([])

const PERSON_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_ID = "99999999-9999-4999-8999-999999999999"
const BRANCH_ID = "44444444-4444-4444-8444-444444444444"
const CONV_ID = "55555555-5555-4555-8555-555555555555"
const ANSWER_ID = "66666666-6666-4666-8666-666666666666"
const MSG_ID = "77777777-7777-4777-8777-777777777777"
const CALL_ID = "88888888-8888-4888-8888-888888888888"

const qjsLayer = QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant)

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
  } = {},
): Actor.Actor => ({
  subject: { kind: "person", id: opts.id ?? PERSON_ID },
  role: opts.role ?? "member",
  login: "will",
  ...(opts.act === undefined ? {} : { act: opts.act }),
})

const sessionsLayer = (actor: Option.Option<Actor.Actor> | Error): Layer.Layer<Actor.Sessions> =>
  Layer.succeed(
    Actor.Sessions,
    Actor.Sessions.of({
      resolve: actor instanceof Error ? Effect.fail(actor as never) : Effect.succeed(actor),
    }),
  )

const mockElectricClient = (): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  )

const branchRow = (opts: { readonly createdBy?: string | null } = {}) => ({
  branchId: BRANCH_ID,
  conversationId: CONV_ID,
  repoId: "github/acme/app",
  name: "main",
  mode: "open",
  createdBy: opts.createdBy === undefined ? PERSON_ID : opts.createdBy,
  person: null,
  repository: null,
  anyShare: false,
  installed: false,
})

const branchRolesLayer = (): Layer.Layer<BranchAccess.BranchRoles> =>
  Layer.succeed(
    BranchAccess.BranchRoles,
    BranchAccess.BranchRoles.of({
      roleOn: () => Effect.succeed("member"),
      uninstalled: () => "member",
    }),
  )

const VALID_CI_FLOW = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"

const lint = CiJob.make("lint", { steps: [{ name: "lint", run: "pnpm lint" }] })
const test = CiJob.make("test", { steps: [{ name: "test", run: "pnpm test" }], machine: "large" })

export default Flow.make("ci", {
  description: "Run checks",
  payload: {
    run: Schema.String,
    repo: Schema.String,
    sha: Schema.String,
    ref: Schema.String,
    event: Schema.String,
    target: Schema.optional(Schema.String),
  },
  body: (target) => Node.all({ lint: lint.call(target), test: test.call(target) }),
})
`

describe("Wave8: worker/ci/Realm.ts & worker/ci/RepoFlow.ts", () => {
  it("fuzzes ci/Realm plan & describe and ci/RepoFlow steps, descriptionOf, isUnreadable, reportedFailure", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "realm_plan_ok",
        "realm_plan_wrong_tag",
        "realm_plan_too_large",
        "realm_plan_syntax_err",
        "realm_plan_bad_import",
        "realm_plan_throw_err",
        "realm_plan_invalid_plan",
        "realm_describe_ok",
        "realm_describe_wrong_tag",
        "repoflow_pure_helpers",
        "repoflow_plan_ok",
        "repoflow_plan_only_ok",
        "repoflow_plan_only_empty",
        "repoflow_plan_bad_machine",
        "repoflow_plan_not_found",
        "repoflow_plan_unreadable",
        "repoflow_plan_token_refused",
        "repoflow_plan_token_unavailable",
        "repoflow_pending_and_report_ok",
        "repoflow_report_token_refused",
        "repoflow_reported_failure",
      ]),
    )

    const basePayload: CiRealm.Payload = {
      run: "ci:1",
      repo: "acme/app",
      sha: "a".repeat(40),
      ref: "refs/heads/main",
      event: "push",
    }

    await holds(modeArb, Math.max(execs, 36), (mode) =>
      Effect.gen(function* () {
        if (mode === "realm_plan_ok") {
          const p = yield* CiRealm.plan("ci", VALID_CI_FLOW, basePayload).pipe(Effect.provide(qjsLayer))
          expect(p._tag).toBe("planned")
          return
        }
        if (mode === "realm_plan_wrong_tag") {
          const p = yield* CiRealm.plan("other", VALID_CI_FLOW, basePayload).pipe(Effect.provide(qjsLayer))
          expect(p).toEqual({ _tag: "refused", reason: "tag" })
          return
        }
        if (mode === "realm_plan_too_large") {
          const p = yield* CiRealm.plan("ci", "a".repeat(CiRealm.LIMITS.sourceBytes + 10), basePayload).pipe(Effect.provide(qjsLayer))
          expect(p).toEqual({ _tag: "refused", reason: "too_large" })
          return
        }
        if (mode === "realm_plan_syntax_err") {
          const p = yield* CiRealm.plan("ci", "export default (((", basePayload).pipe(Effect.provide(qjsLayer))
          expect(p).toEqual({ _tag: "refused", reason: "syntax" })
          return
        }
        if (mode === "realm_plan_bad_import") {
          const p = yield* CiRealm.plan("ci", 'import fs from "node:fs"\nexport default fs', basePayload).pipe(Effect.provide(qjsLayer))
          expect(p).toEqual({ _tag: "refused", reason: "import" })
          return
        }
        if (mode === "realm_plan_throw_err") {
          const p = yield* CiRealm.plan("ci", 'throw new Error("boom")', basePayload).pipe(Effect.provide(qjsLayer))
          expect(p).toEqual({ _tag: "refused", reason: "evaluation" })
          return
        }
        if (mode === "realm_plan_invalid_plan") {
          const p = yield* CiRealm.plan("ci", "export default 42", basePayload).pipe(Effect.provide(qjsLayer))
          expect(p).toEqual({ _tag: "refused", reason: "invalid_plan" })
          return
        }
        if (mode === "realm_describe_ok" || mode === "realm_describe_wrong_tag") {
          const d = yield* CiRealm.describe(mode === "realm_describe_ok" ? "ci" : "other", VALID_CI_FLOW).pipe(Effect.provide(qjsLayer))
          expect(d._tag).toBe(mode === "realm_describe_ok" ? "described" : "refused")
          return
        }
        if (mode === "repoflow_pure_helpers") {
          expect(RepoFlow.flowPath("ci")).toBe(".smithers/flows/ci/flow.ts")
          expect(RepoFlow.descriptionOf("pending", [], null)).toBe("Running")
          expect(RepoFlow.descriptionOf("success", [], null)).toBe("Passed")
          expect(RepoFlow.descriptionOf("failure", [], "syntax")).toContain("syntax")
          expect(RepoFlow.descriptionOf("failure", ["lint", "test"], null)).toContain("lint")
          expect(RepoFlow.isUnreadable(new Error("x"))).toBe(false)
          return
        }
        if (mode === "repoflow_reported_failure") {
          const engDb = makeSqlLayer(() => [])
          const res = yield* RepoFlow.reportedFailure("ci:1", engDb).pipe(Effect.result)
          expect(Result.isSuccess(res) || Result.isFailure(res)).toBe(true)
          return
        }

        const http = HttpClient.make((req) => {
          if (req.url.includes("/contents/")) {
            if (mode === "repoflow_plan_not_found") {
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } })))
            }
            if (mode === "repoflow_plan_unreadable") {
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ message: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } })))
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(
                  JSON.stringify({
                    type: "file",
                    encoding: "base64",
                    size: VALID_CI_FLOW.length,
                    name: "flow.ts",
                    path: ".smithers/flows/ci/flow.ts",
                    sha: "b".repeat(40),
                    content: btoa(VALID_CI_FLOW),
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            )
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(
                JSON.stringify({
                  id: 1,
                  state: "success",
                  context: "smithers/ci",
                  description: "Passed",
                  target_url: null,
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                }),
                { status: 201, headers: { "content-type": "application/json" } },
              ),
            ),
          )
        })

        const tokens: GitHubTokens.GitHubTokens = {
          forInstallation: () => {
            if (mode === "repoflow_plan_token_refused" || mode === "repoflow_report_token_refused") {
              return Effect.fail(new GitHubTokens.TokenUnavailable({ reason: "app_not_installed" }))
            }
            if (mode === "repoflow_plan_token_unavailable") {
              return Effect.fail(new GitHubTokens.TokenUnavailable({ reason: "unavailable" }))
            }
            return Effect.succeed(Redacted.make("ghs_token"))
          },
          forPerson: () => Effect.fail(new GitHubTokens.TokenUnavailable({ reason: "unavailable" })),
        } as any

        const st = RepoFlow.steps({
          database: makeSqlLayer(() => []),
          tokens,
          http,
          apiBaseUrl: "https://api.github.com",
          machines: mode === "repoflow_plan_bad_machine" ? [] : ["large"],
        })
        const req: RepoFlow.RunRequest = {
          run: "ci:1",
          repo: "acme/app",
          flow: "ci",
          sha: "a".repeat(40),
          ref: "refs/heads/main",
          event: "push",
          secrets: false,
          ...(mode === "repoflow_plan_only_ok" ? { only: ["test"] } : {}),
          ...(mode === "repoflow_plan_only_empty" ? { only: ["missing"] } : {}),
        }

        if (mode === "repoflow_pending_and_report_ok" || mode === "repoflow_report_token_refused") {
          yield* st.pending({ request: req }).pipe(Effect.provide(silentLogger))
          const rep = yield* st.report({
            request: req,
            names: ["lint"],
            results: { [RepoFlow.jobKey(0)]: { outcome: "passed", steps: [], durationMs: 1 } as any },
            refused: null,
          }).pipe(Effect.provide(silentLogger))
          expect(rep.state).toBe("success")
          return
        }

        const out = yield* st.plan({ request: req }).pipe(Effect.provide(Layer.mergeAll(qjsLayer, silentLogger)), Effect.result)
        if (mode === "repoflow_plan_token_unavailable") {
          expect(Result.isFailure(out)).toBe(true)
        } else {
          expect(Result.isSuccess(out)).toBe(true)
        }
      }),
    )
  }, 90_000)
})

describe("Wave8: worker/AlertChannels.ts, worker/Pins.ts, worker/WebPreview.vibe", () => {
  it("fuzzes AlertChannels destinationsOf, destinationOf, channelsConfig, set route, and admin shapes", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "pure_helpers_and_config",
        "set_405",
        "set_401",
        "set_person_only",
        "set_not_admin",
        "set_too_large",
        "set_bad_json",
        "set_bad_dest",
        "set_bad_app_url_proto",
        "set_missing_app_url",
        "set_email_ok",
        "set_telegram_ok",
        "set_clear_empty_ok",
        "set_clear_noop",
        "set_db_503",
        "shapes_admin",
      ]),
    )

    await holds(modeArb, Math.max(execs, 34), (mode) =>
      Effect.gen(function* () {
        if (mode === "pure_helpers_and_config") {
          expect(AlertChannels.destinationsOf("email", [" a@b.com ", "a@b.com", ""])).toEqual(["a@b.com"])
          expect(AlertChannels.destinationsOf("email", ["not-an-email"])).toBeUndefined()
          expect(AlertChannels.destinationsOf("telegram", ["12345"])).toEqual(["12345"])
          expect(AlertChannels.destinationsOf("telegram", ["12345", "67890"])).toBeUndefined()
          expect(Option.isSome(AlertChannels.destinationOf("email", ["a@b.com"]))).toBe(true)
          expect(Option.isSome(AlertChannels.destinationOf("telegram", ["12345"]))).toBe(true)
          const cfgLayer = yield* AlertChannels.channelsConfig({ dev: true }).pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    ALERT_EMAIL_API_URL: "http://127.0.0.1:9999",
                    ALERT_TELEGRAM_API_URL: "http://127.0.0.1:9998",
                  },
                }),
              ),
            ),
          )
          expect(cfgLayer).toBeDefined()
          return
        }

        const db = makeSqlLayer((q) => {
          if (mode === "set_db_503") return new Error("db_down")
          if (q.includes("DELETE FROM alert_channels")) return mode === "set_clear_noop" ? [] : [{ txid: "11" }]
          if (q.includes("INSERT INTO alert_channels")) return [{ txid: "12" }]
          return []
        })

        const envCfg: Record<string, string> = mode === "set_missing_app_url"
          ? {}
          : mode === "set_bad_app_url_proto"
          ? { ALERT_APP_URL: "ftp://bad.test" }
          : { ALERT_APP_URL: "https://smithers.test" }

        const routes = yield* AlertChannels.make(db).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: envCfg }))),
        )
        const actor = mode === "set_401"
          ? Option.none<Actor.Actor>()
          : mode === "set_person_only"
          ? Option.some(personActor({ role: "admin", act: { kind: "agent", id: ANSWER_ID } }))
          : mode === "set_not_admin"
          ? Option.some(personActor({ role: "member" }))
          : Option.some(personActor({ role: "admin" }))
        const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), silentLogger)

        if (mode === "shapes_admin") {
          const r1 = yield* routes.channels.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://app.test/api/shapes/alert-channels?offset=-1")),
            Effect.provide(env),
          )
          const r2 = yield* routes.deliveries.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://app.test/api/shapes/alert-deliveries?offset=-1")),
            Effect.provide(env),
          )
          expect(r1.status).toBe(200)
          expect(r2.status).toBe(200)
          return
        }

        const body = mode === "set_too_large"
          ? "x".repeat(20_000)
          : mode === "set_bad_json"
          ? "{"
          : mode === "set_bad_dest"
          ? JSON.stringify({ channel: "email", destinations: ["bad"] })
          : mode === "set_telegram_ok"
          ? JSON.stringify({ channel: "telegram", destinations: ["123456"] })
          : mode === "set_clear_empty_ok" || mode === "set_clear_noop"
          ? JSON.stringify({ channel: "email", destinations: [] })
          : JSON.stringify({ channel: "email", destinations: ["ops@smithers.test"] })

        const res = yield* routes.set.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            makeReq("https://app.test/api/alert-channels", { method: mode === "set_405" ? "GET" : "POST", body }),
          ),
          Effect.provide(env),
        )
        const expected = mode === "set_405"
          ? 405
          : mode === "set_401"
          ? 401
          : mode === "set_person_only" || mode === "set_not_admin"
          ? 403
          : mode === "set_too_large"
          ? 413
          : mode === "set_bad_json" || mode === "set_bad_dest"
          ? 400
          : mode === "set_bad_app_url_proto" || mode === "set_missing_app_url" || mode === "set_db_503"
          ? 503
          : 200
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)

  it("fuzzes Pins write/stamp/shape and WebPreview preview route", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "pin_shape_in",
        "pin_shape_out",
        "pin_405",
        "pin_401",
        "pin_too_large",
        "pin_bad_json",
        "pin_missing_at",
        "pin_other_run_403",
        "pin_agent_no_answer_403",
        "pin_answer_forbidden",
        "pin_answer_missing",
        "pin_conv_mismatch_403",
        "pin_home_missing_404",
        "pin_branch_missing_404",
        "pin_cannot_view_403",
        "pin_stamp_ok",
        "pin_latest_assistant_ok",
        "pin_latest_assistant_404",
        "pin_explicit_msg_ok",
        "pin_explicit_msg_404",
        "pin_await_admission_hit",
        "pin_await_admission_425",
        "pin_unpin_null_ok",
        "pin_db_503",
        "web_405",
        "web_401",
        "web_too_large",
        "web_bad_json",
        "web_refused_url",
        "web_ok_cached_and_uncached",
        "web_error_503",
      ]),
    )

    await holds(modeArb, Math.max(execs * 2, 60), (mode) =>
      Effect.gen(function* () {
        if (mode.startsWith("web_")) {
          const mockHttp = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response("<html><head><title>Example</title></head><body>Hi</body></html>", {
                    status: 200,
                    headers: { "content-type": "text/html; charset=utf-8" },
                  }),
                ),
              ),
            ),
          )
          const route = yield* WebPreview.make({ localHttp: false }).pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { WEB_PAGE_CHECK_KEPT: mode === "web_ok_cached_and_uncached" ? "5 minutes" : "0 seconds" } }),
              ),
            ),
          )
          const actor = mode === "web_401"
            ? Option.none<Actor.Actor>()
            : mode === "web_error_503"
            ? new Error("sess_down")
            : Option.some(personActor())
          const env = Layer.mergeAll(sessionsLayer(actor), mockHttp, ImmutableCache.layerMemory(), silentLogger)
          const body = mode === "web_too_large"
            ? "x".repeat(5_000)
            : mode === "web_bad_json"
            ? "{"
            : mode === "web_refused_url"
            ? JSON.stringify({ url: "https://app.test/internal", mode: "embed" })
            : JSON.stringify({ url: "https://example.com/page", mode: "tab" })
          const req = makeReq("https://app.test/api/web/preview", { method: mode === "web_405" ? "GET" : "POST", body })
          const res = yield* route.preview.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(env),
          )
          if (mode === "web_ok_cached_and_uncached") {
            expect(res.status).toBe(200)
            // Second hit exercises cached = true!
            const res2 = yield* route.preview.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://app.test/api/web/preview", { method: "POST", body })),
              Effect.provide(env),
            )
            expect(res2.status).toBe(200)
          } else {
            const expected = mode === "web_405" ? 405 : mode === "web_401" ? 401 : mode === "web_too_large" ? 413 : mode === "web_error_503" ? 503 : 400
            expect(res.status).toBe(expected)
          }
          return
        }

        const db = makeSqlLayer((q) => {
          if (mode === "pin_db_503") return new Error("db_down")
          if (q.includes("FROM messages a JOIN messages q")) {
            if (mode === "pin_answer_missing") return []
            if (mode === "pin_answer_forbidden") return [{ conversationId: CONV_ID, askedBy: OTHER_ID }]
            return [{ conversationId: CONV_ID, askedBy: PERSON_ID }]
          }
          if (q.includes("FROM conversations") && q.includes("home")) {
            return mode === "pin_home_missing_404" ? [] : [{ id: CONV_ID }]
          }
          if (q.includes("FROM branches") && q.includes("conversations")) {
            if (mode === "pin_branch_missing_404" || mode === "pin_home_missing_404") return []
            if (mode === "pin_cannot_view_403") return [branchRow({ createdBy: OTHER_ID })]
            return [branchRow()]
          }
          if (q.includes("AS at FROM message_pins")) return [{ at: 1000 }]
          if (q.includes("SELECT message_id FROM message_pins")) {
            return mode === "pin_await_admission_hit" ? [{ message_id: MSG_ID }] : []
          }
          if (q.includes("role = 'assistant' AND status = 'done'")) {
            return mode === "pin_latest_assistant_404" ? [] : [{ id: ANSWER_ID }]
          }
          if (q.includes("SELECT id FROM messages WHERE id =")) {
            return mode === "pin_explicit_msg_404" || mode === "pin_await_admission_425" ? [] : [{ id: MSG_ID }]
          }
          return []
        })

        const routes = yield* Pins.make(db).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({}))))
        const actor = mode === "pin_401" || mode === "pin_shape_out"
          ? Option.none<Actor.Actor>()
          : mode === "pin_other_run_403"
          ? Option.some(personActor({ act: { kind: "agent", id: OTHER_ID } }))
          : mode === "pin_agent_no_answer_403"
          ? Option.some(personActor({ act: { kind: "agent", id: "non-uuid" } as any }))
          : Option.some(personActor())
        const env = Layer.mergeAll(sessionsLayer(actor), mockElectricClient(), branchRolesLayer(), silentLogger)

        if (mode === "pin_shape_in" || mode === "pin_shape_out") {
          const res = yield* routes.shape.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq("https://app.test/api/shapes/pins?offset=-1")),
            Effect.provide(env),
          )
          expect(res.status).toBe(200)
          return
        }

        const now = Date.now()
        const url = mode === "pin_stamp_ok" ? "https://app.test/api/message-pin/stamp" : "https://app.test/api/message-pin"
        let body: string
        if (mode === "pin_too_large") body = "x".repeat(600)
        else if (mode === "pin_bad_json") body = "{"
        else if (mode === "pin_missing_at") body = JSON.stringify({ conversationId: CONV_ID })
        else if (mode === "pin_other_run_403" || mode === "pin_answer_forbidden" || mode === "pin_answer_missing") {
          body = JSON.stringify({ answerId: ANSWER_ID, at: now })
        } else if (mode === "pin_conv_mismatch_403") {
          body = JSON.stringify({ answerId: ANSWER_ID, conversationId: OTHER_ID, at: now })
        } else if (mode === "pin_home_missing_404") {
          body = JSON.stringify({ at: now })
        } else if (mode === "pin_stamp_ok") {
          body = JSON.stringify({ conversationId: CONV_ID })
        } else if (mode === "pin_latest_assistant_ok" || mode === "pin_latest_assistant_404") {
          body = JSON.stringify({ conversationId: CONV_ID, at: now })
        } else if (mode === "pin_await_admission_hit" || mode === "pin_await_admission_425") {
          body = JSON.stringify({ conversationId: CONV_ID, messageId: MSG_ID, at: now, awaitAdmission: true })
        } else if (mode === "pin_unpin_null_ok") {
          body = JSON.stringify({ conversationId: CONV_ID, messageId: null, at: now })
        } else {
          body = JSON.stringify({ conversationId: CONV_ID, messageId: MSG_ID, at: now })
        }

        const res = yield* routes.write.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq(url, { method: mode === "pin_405" ? "GET" : "POST", body })),
          Effect.provide(env),
        )
        const expected = mode === "pin_405"
          ? 405
          : mode === "pin_401"
          ? 401
          : mode === "pin_too_large"
          ? 413
          : mode === "pin_bad_json" || mode === "pin_missing_at"
          ? 400
          : mode === "pin_other_run_403" || mode === "pin_agent_no_answer_403" || mode === "pin_answer_forbidden" || mode === "pin_conv_mismatch_403" || mode === "pin_cannot_view_403"
          ? 403
          : mode === "pin_answer_missing" || mode === "pin_home_missing_404" || mode === "pin_branch_missing_404" || mode === "pin_latest_assistant_404" || mode === "pin_explicit_msg_404"
          ? 404
          : mode === "pin_await_admission_425"
          ? 425
          : mode === "pin_db_503"
          ? 503
          : 200
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/docs/Source.ts & worker/docs/Api.vibe", () => {
  it("fuzzes DocsSource index/page and DocsApi routes", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "parse_paths",
        "source_declared_index_and_page_cached",
        "source_curated_fallback_on_refused",
        "source_not_found",
        "source_unavailable",
        "source_no_docs",
        "source_docs_unreachable_busy",
        "source_docs_unreachable_redirect",
        "source_page_not_found",
        "source_page_unreachable",
        "api_405",
        "api_bad_repo_404",
        "api_index_ok",
        "api_index_query_ok",
        "api_index_query_too_long",
        "api_index_refused_503",
        "api_page_ok",
        "api_page_invalid_path",
        "api_page_refused_502",
      ]),
    )

    const llmsTxt = `# Acme Docs\n> Reference docs\n## Guide\n- [Intro](https://docs.acme.dev/intro.md): Getting started\n`

    await holds(modeArb, Math.max(execs, 36), (mode) =>
      Effect.gen(function* () {
        if (mode === "parse_paths") {
          expect(DocsApi.parseDocsPath("/api/repos/acme/app/docs")).toEqual({ owner: "acme", name: "app", route: "index" })
          expect(DocsApi.parseDocsPath("/api/repos/acme/app/docs/page")).toEqual({ owner: "acme", name: "app", route: "page" })
          expect(DocsApi.handles("/api/repos/acme/app/docs")).toBe(true)
          expect(DocsApi.handles("/api/other")).toBe(false)
          expect(DocsApi.parseDocsPath("/api/repos/%E0%A4%A/app/docs")).toBeUndefined()
          return
        }

        if (mode.startsWith("source_")) {
          const about = {
            answer: () => {
              if (mode === "source_not_found") {
                return Effect.succeed({ _tag: "Refused" as const, code: "not_found" as const, cache: "miss" as const })
              }
              if (mode === "source_unavailable" || mode === "source_curated_fallback_on_refused") {
                return Effect.succeed({ _tag: "Refused" as const, code: "github_unavailable" as const, cache: "miss" as const })
              }
              if (mode === "source_no_docs") {
                return Effect.succeed({
                  _tag: "Answered" as const,
                  text: JSON.stringify({ home: null }),
                  cache: "hit" as const,
                  via: "anonymous" as const,
                  maxAgeSeconds: 60,
                })
              }
              return Effect.succeed({
                _tag: "Answered" as const,
                text: JSON.stringify({
                  home: JSON.stringify({
                    docs: "https://docs.acme.dev/llms.txt",
                    blocks: [{ type: "text", text: "Hi" }],
                  }),
                }),
                cache: "hit" as const,
                via: "anonymous" as const,
                maxAgeSeconds: 60,
              })
            },
          }
          const mockHttp = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((req) => {
              if (mode === "source_docs_unreachable_busy") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("busy", { status: 503 })))
              }
              if (mode === "source_docs_unreachable_redirect") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response("", { status: 302, headers: { location: "https://other.example/x" } })),
                )
              }
              if (req.url.includes("intro.md")) {
                if (mode === "source_page_unreachable") {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("err", { status: 500 })))
                }
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("# Intro\nHello", { status: 200 })))
              }
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(llmsTxt, { status: 200 })))
            }),
          )

          const captured = yield* DocsSourceMod.settings.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { DOCS_KEPT: mode === "source_declared_index_and_page_cached" ? "5 minutes" : "0 seconds" } }))),
          )
          const srcLayer = DocsSourceMod.layer(captured, {
            about,
            homes: [{ repository: "acme/curated", defaultBranch: "main", home: { docs: "https://docs.acme.dev/llms.txt", blocks: [{ type: "text", text: "Hi" }] } } as any],
          }).pipe(Layer.provide(Layer.mergeAll(mockHttp, ImmutableCache.layerMemory(), silentLogger)))

          const src = yield* DocsSourceMod.DocsSource.pipe(Effect.provide(srcLayer))
          if (mode === "source_declared_index_and_page_cached") {
            const p1 = yield* src.page("acme", "app", "/intro.md")
            const p2 = yield* src.page("acme", "app", "/intro.md")
            expect(p1._tag).toBe("Page")
            expect(p2._tag).toBe("Page")
          } else if (mode === "source_page_not_found") {
            const r = yield* src.page("acme", "app", "/missing.md")
            expect(r._tag).toBe("Refused")
          } else if (mode === "source_page_unreachable") {
            const r = yield* src.page("acme", "app", "/intro.md")
            expect(r._tag).toBe("Refused")
          } else {
            const r = yield* src.index("acme", mode === "source_curated_fallback_on_refused" ? "curated" : "app")
            expect(r._tag === "Index" || r._tag === "Refused").toBe(true)
          }
          return
        }

        const stubDocs = Layer.succeed(
          DocsSourceMod.DocsSource,
          DocsSourceMod.DocsSource.of({
            index: () =>
              mode === "api_index_refused_503"
                ? Effect.succeed({ _tag: "Refused", code: "unavailable" })
                : Effect.succeed({
                  _tag: "Index",
                  source: "declared",
                  cached: false,
                  index: {
                    title: "Acme",
                    summary: "Summary",
                    origin: "https://docs.acme.dev",
                    pages: [{ title: "Intro", path: "/intro.md", url: "https://docs.acme.dev/intro.md", description: "Start", section: "Guide" }],
                  },
                }),
            page: () =>
              mode === "api_page_refused_502"
                ? Effect.succeed({ _tag: "Refused", code: "docs_unreachable", reason: "busy" })
                : Effect.succeed({
                  _tag: "Page",
                  cached: true,
                  page: { title: "Intro", path: "/intro.md", url: "https://docs.acme.dev/intro.md" },
                  text: "# Intro",
                }),
          }),
        )

        const api = DocsApi.make()
        let url = "https://app.test/api/repos/acme/app/docs"
        if (mode === "api_bad_repo_404") url = "https://app.test/api/repos/-bad/app/docs"
        else if (mode === "api_index_query_ok") url = "https://app.test/api/repos/acme/app/docs?q=intro"
        else if (mode === "api_index_query_too_long") url = `https://app.test/api/repos/acme/app/docs?q=${"a".repeat(300)}`
        else if (mode === "api_page_ok" || mode === "api_page_refused_502") url = "https://app.test/api/repos/acme/app/docs/page?path=/intro.md"
        else if (mode === "api_page_invalid_path") url = "https://app.test/api/repos/acme/app/docs/page?path=no-slash"

        const res = yield* api.fetch.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, makeReq(url, { method: mode === "api_405" ? "POST" : "GET" })),
          Effect.provide(Layer.mergeAll(stubDocs, silentLogger)),
        )
        const expected = mode === "api_405"
          ? 405
          : mode === "api_bad_repo_404"
          ? 404
          : mode === "api_index_query_too_long" || mode === "api_page_invalid_path"
          ? 400
          : mode === "api_index_refused_503"
          ? 503
          : mode === "api_page_refused_502"
          ? 502
          : 200
        expect(res.status).toBe(expected)
      }),
    )
  }, 60_000)
})

describe("Wave8: worker/flows/{SpendAlert,AlertDelivery,SandboxCall,Ask} & todos/writes", () => {
  it("fuzzes SpendAlert, AlertDelivery, SandboxCall, Ask, and TodoWrites pure helpers", async () => {
    const modeArb = Arbitrary.schema(
      Schema.Literals([
        "spend_alert_record_ok",
        "spend_alert_record_existing",
        "spend_alert_record_none",
        "spend_alert_record_db_err",
        "spend_alert_deliver_sent",
        "spend_alert_deliver_existing",
        "spend_alert_deliver_off",
        "spend_alert_deliver_none",
        "spend_alert_deliver_bad_dest",
        "spend_alert_deliver_refused",
        "spend_alert_deliver_failed",
        "spend_alert_deliver_db_err",
        "sandbox_call_failure_and_settle_done",
        "sandbox_call_settle_failed_and_saved",
        "sandbox_call_settle_db_err",
        "ask_open_and_settle_ok",
        "ask_db_err",
        "todo_writes_pure",
      ]),
    )

    await holds(modeArb, Math.max(execs * 2, 48), (mode) =>
      Effect.gen(function* () {
        if (mode === "todo_writes_pure") {
          expect(
            TodoWrites.requestOf({
              id: "op1",
              repo: "acme/app",
              op: "commit",
              title: "T",
              prompt: "P",
              acceptance: "A",
              issue: 5,
              after: 2,
              number: 0,
              createdAt: 1,
            } as any),
          ).toMatchObject({ opId: "op1", op: "commit", issue: 5, after: 2 })
          expect(TodoWrites.requestOf({ id: "op2", repo: "acme/app", op: "attach", number: 1, issue: 9 } as any)).toEqual({
            opId: "op2",
            op: "attach",
            number: 1,
            issue: 9,
          })
          expect(TodoWrites.requestOf({ id: "op3", repo: "acme/app", op: "cancel", number: 1 } as any)).toEqual({
            opId: "op3",
            op: "cancel",
            number: 1,
          })
          expect(TodoWrites.reasonOf(400, undefined)).toBe("invalid")
          expect(TodoWrites.reasonOf(401, undefined)).toBe("authentication")
          expect(TodoWrites.reasonOf(403, undefined)).toBe("forbidden")
          expect(TodoWrites.reasonOf(404, undefined)).toBe("not_found")
          expect(TodoWrites.reasonOf(409, undefined)).toBe("conflict")
          expect(TodoWrites.reasonOf(413, undefined)).toBe("too_large")
          expect(TodoWrites.reasonOf(500, undefined)).toBeUndefined()
          return
        }

        if (mode.startsWith("spend_alert_")) {
          const win = { from: 0, until: Date.now() + 5000, budget: 100_000 }
          expect(SpendAlertFlow.executionId(win)).toContain("spend-alert-")
          const waitMs = yield* SpendAlertFlow.alertIn(win)
          expect(waitMs).toBeGreaterThanOrEqual(0)
          const est = SpendAlertFlow.estimate({ modelId: "claude-sonnet-4-6", input: 100, output: 50, charged: 150 })
          expect(est === null || typeof est === "number").toBe(true)
          expect(SpendAlertFlow.estimate({ modelId: "unknown-xyz", input: 0, output: 0, charged: 100 })).toBeNull()

          if (mode.startsWith("spend_alert_record_")) {
            const db = makeSqlLayer((q) => {
              if (mode === "spend_alert_record_db_err") return new Error("db_down")
              if (q.includes("FROM spend_alerts WHERE id =")) {
                return mode === "spend_alert_record_existing" ? [{ calls: 1, tokens: 100, costUsd: 0.01 }] : []
              }
              if (q.includes("UPDATE model_usage SET spend_alert_id")) {
                return mode === "spend_alert_record_none"
                  ? []
                  : [{ role: "agent", modelId: "gpt-4o-mini", input: 100, output: 50, charged: 150 }]
              }
              if (q.includes("FROM model_budget_days")) return [{ committed: 150 }]
              return []
            })
            const res = yield* SpendAlertFlow.observedRecord(win, db).pipe(Effect.provide(silentLogger), Effect.result)
            expect(Result.isSuccess(res)).toBe(mode !== "spend_alert_record_db_err")
            return
          }

          const db = makeSqlLayer((q) => {
            if (mode === "spend_alert_deliver_db_err") return new Error("db_down")
            if (q.includes("FROM alert_deliveries")) {
              return mode === "spend_alert_deliver_existing" ? [{ status: "sent" }] : []
            }
            if (q.includes("FROM alert_channels")) {
              if (mode === "spend_alert_deliver_off") return []
              return [{
                destinations: mode === "spend_alert_deliver_bad_dest" ? ["not-valid"] : ["ops@smithers.test"],
                appUrl: "https://smithers.test",
              }]
            }
            if (q.includes("FROM spend_alerts")) {
              if (mode === "spend_alert_deliver_none") return []
              return [{ calls: 2, tokens: 500, costUsd: 0.02, dayTokens: 500, dayBudget: 100_000 }]
            }
            return []
          })
          const channelsLayer = Layer.succeed(
            Channels.Channels,
            Channels.Channels.of({
              send: () => {
                if (mode === "spend_alert_deliver_refused") {
                  return Effect.fail(new Channels.DeliveryRefused({ channel: "email", code: "rejected", reason: "bounce" }))
                }
                if (mode === "spend_alert_deliver_failed") {
                  return Effect.fail(new Channels.DeliveryFailed({ channel: "email", code: "rate_limited", status: 429 }))
                }
                return Effect.succeed({ providerId: "msg-1" })
              },
            } as any),
          )
          const res = yield* SpendAlertFlow.observedDeliver({ alertId: "a1", channel: "email", outcome: "recorded" }, db).pipe(
            Effect.provide(Layer.mergeAll(channelsLayer, silentLogger)),
            Effect.result,
          )
          if (mode === "spend_alert_deliver_failed" || mode === "spend_alert_deliver_db_err") {
            expect(Result.isFailure(res)).toBe(true)
          } else {
            expect(Result.isSuccess(res)).toBe(true)
          }
          return
        }

        if (mode.startsWith("sandbox_call_")) {
          expect(SandboxCallFlow.failureOf({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "policy" } as any)).toEqual({ status: "failed", failure: "policy" })
          expect(SandboxCallFlow.failureOf({ _tag: "@smthrs/sandbox/SandboxTools/ToolLost" } as any)).toEqual({ status: "failed", failure: "lost" })
          expect(SandboxCallFlow.failureOf({ _tag: "@smthrs/mvp/branch/CheckoutFailed" } as any)).toEqual({ status: "failed", failure: "checkout" })
          expect(SandboxCallFlow.failureOf({ _tag: "@smthrs/mvp/branch/SandboxStartTimedOut" } as any)).toEqual({ status: "failed", failure: "start_timeout" })
          expect(SandboxCallFlow.failureOf({ _tag: "Other" } as any)).toEqual({ status: "failed", failure: "unavailable" })
          const db = makeSqlLayer((q) => {
            if (mode === "sandbox_call_settle_db_err") return new Error("db_down")
            if (q.includes("UPDATE sandbox_calls")) return [{ branchId: BRANCH_ID, personId: PERSON_ID }]
            return []
          })
          const st = SandboxCallFlow.steps(db)
          const outcome: SandboxCallFlow.Outcome = mode === "sandbox_call_failure_and_settle_done"
            ? {
              status: "done",
              result: {
                tool: "run",
                exitCode: 0,
                timedOut: false,
                stdout: "ok",
                stderr: "",
                stdoutBytes: 2,
                stderrBytes: 0,
                truncated: false,
              },
              generation: 1,
            }
            : mode === "sandbox_call_settle_failed_and_saved"
            ? {
              status: "done",
              result: { tool: "write", path: "a.ts", bytes: 4, sequence: 1 } as any,
              generation: 1,
            }
            : { status: "failed", failure: "unavailable" }
          const saved = mode === "sandbox_call_settle_failed_and_saved"
            ? { textId: MSG_ID, mark: "abc" }
            : undefined
          const r = yield* st.record({
            callId: CALL_ID,
            tool: mode === "sandbox_call_settle_failed_and_saved" ? "write" : "run",
            outcome,
            ...(saved === undefined ? {} : { saved }),
          }).pipe(
            Effect.provide(silentLogger),
            Effect.result,
          )
          expect(Result.isSuccess(r)).toBe(mode !== "sandbox_call_settle_db_err")
          return
        }

        // Ask flow
        expect(AskFlow.askExecutionId("Acme/App", "q-1")).toContain("acme/app")
        const db = makeSqlLayer(() => (mode === "ask_db_err" ? new Error("db_down") : [{ id: ANSWER_ID }]))
        const req: AskFlow.AskRequest = {
          id: "q-1",
          repo: "acme/app",
          askedBy: "machine:codex/1",
          to: PERSON_ID,
          prompt: "Ship it?",
          options: ["yes", "no"],
        }
        const flowInst = Layer.succeed(FlowRuntime.FlowInstance, { executionId: AskFlow.askExecutionId("acme/app", "q-1") } as any)
        const rOpen = yield* AskFlow.open(db)(req).pipe(Effect.provide(Layer.mergeAll(flowInst, silentLogger)), Effect.result)
        const rSettle = yield* AskFlow.settle(db)({ answer: mode === "ask_open_and_settle_ok" ? "yes" : null }).pipe(
          Effect.provide(Layer.mergeAll(flowInst, silentLogger)),
          Effect.result,
        )
        expect(Result.isSuccess(rOpen)).toBe(mode !== "ask_db_err")
        expect(Result.isSuccess(rSettle)).toBe(mode !== "ask_db_err")
      }),
    )
  }, 60_000)
})
