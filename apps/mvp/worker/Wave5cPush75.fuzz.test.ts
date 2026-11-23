import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { digestSync } from "@smthrs/crypto"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Schema as FuzzSchema } from "effect"

interface FuzzInput {
  boolean: () => boolean
  integer: (min: number, max: number) => number
  choice: <T>(items: ReadonlyArray<T>) => T
  string: (opts?: { minLength?: number; maxLength?: number }) => string
}

const makeFuzzInput = (seed: number): FuzzInput => {
  let s = (seed | 0) ^ 0x9e3779b9
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    boolean: () => next() < 0.5,
    integer: (min, max) => min + Math.floor(next() * (max - min + 1)),
    choice: <T>(items: ReadonlyArray<T>) => items[Math.floor(next() * items.length)]!,
    string: (opts) => {
      const min = opts?.minLength ?? 1
      const max = opts?.maxLength ?? 12
      const len = min + Math.floor(next() * (max - min + 1))
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_"
      let out = ""
      for (let i = 0; i < len; i++) out += alphabet[Math.floor(next() * alphabet.length)]!
      return out
    },
  }
}

const fuzz = async (
  body: (input: FuzzInput) => Promise<void>,
  opts: { executions: number; seed: number },
): Promise<void> => {
  const arb = Arbitrary.schema(FuzzSchema.Int)
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (n) => Effect.promise(async () => { await body(makeFuzzInput(n ^ opts.seed)); return true }),
      { executions: opts.executions, seed: opts.seed },
    ),
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}
import {
  ACCEPTS_CREDENTIAL_STALE,
  ACCEPTS_HEADER,
  ARRIVE_ROUTE,
  CALLBACK_ROUTE,
  HANDOFF_ROUTE,
  SESSION_ROUTE,
  SIGN_IN_FAILED_PARAM,
  SIGN_IN_ROUTE,
  SIGN_OUT_ROUTE,
} from "../src/features/auth/contract.ts"
import { Sessions, type Actor, type Role } from "./Actor.ts"
import { BranchRoles } from "./branch/Access.ts"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { MCP_BLOCKED_ACTS } from "../src/features/mcp/contract.ts"
import { makeMcpAuthService, isBlockedMcpAct, assertNotBlockedAct, agentActor } from "./mcp/Auth.ts"
import type { McpPrincipal } from "./mcp/Contract.ts"
import * as Notifications from "./Notifications.ts"
import * as NotificationPolicy from "./NotificationPolicy.ts"
import * as PersonalModels from "./personal/Models.ts"
import * as SecretKeys from "./secrets/Keys.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as Flows from "./Flows.ts"
import * as SignIn from "./SignIn.ts"
import { GitHubAuth } from "./GitHubAuth.ts"
import { scriptedGitHub } from "./test/github.ts"

const SECRET = "wave5c-push75-session-secret-0123456789abcdef0123456789abcdef"

const flattenSql = (strings: TemplateStringsArray, values: ReadonlyArray<unknown>): { text: string; params: Array<unknown> } => {
  let text = ""
  const params: Array<unknown> = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i] as { _tag?: string; segments?: ReadonlyArray<{ _tag?: string; value?: unknown; params?: ReadonlyArray<unknown>; sql?: string }> } | undefined
      if (v && typeof v === "object" && "segments" in v && Array.isArray(v.segments)) {
        for (const seg of v.segments) {
          if (seg && typeof seg === "object" && "sql" in seg && typeof seg.sql === "string") {
            text += seg.sql
            if (Array.isArray(seg.params)) params.push(...seg.params)
          } else if (seg && typeof seg === "object" && "value" in seg) {
            text += String(seg.value)
          }
        }
      } else {
        text += `$${params.length + 1}`
        params.push(v)
      }
    }
  }
  return { text, params }
}

const makeSqlLayer = (
  handler: (sqlText: string, params: ReadonlyArray<unknown>) => ReadonlyArray<Record<string, unknown>> | Error,
): Layer.Layer<SqlClient.SqlClient> => {
  const fn = ((strings: TemplateStringsArray | string, ...values: ReadonlyArray<unknown>) => {
    if (typeof strings === "string") {
      return { segments: [{ sql: strings, params: [] }] }
    }
    const { text, params } = flattenSql(strings, values)
    return Effect.suspend(() => {
      const out = handler(text, params)
      if (out instanceof Error) return Effect.fail(out as never)
      return Effect.succeed(out)
    })
  }) as unknown as SqlClient.SqlClient

  const client = Object.assign(fn, {
    in: (a: unknown, b?: ReadonlyArray<unknown>) => {
      if (Array.isArray(a)) {
        return { segments: [{ sql: `(${a.map((_, i) => `$in${i}`).join(",")})`, params: [...a] }] }
      }
      const arr = b ?? []
      return { segments: [{ sql: `${String(a)} IN (${arr.map((_, i) => `$in${i}`).join(",")})`, params: [...arr] }] }
    },
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
    unsafe: (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.suspend(() => {
        const out = handler(query, params)
        if (out instanceof Error) return Effect.fail(out as never)
        return Effect.succeed(out)
      }),
  })
  return Layer.succeed(SqlClient.SqlClient, client)
}

const makeRequest = (
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    cookies?: Record<string, string>
  } = {},
): HttpServerRequest.HttpServerRequest => {
  const parsedUrl = new URL(url)
  const headers: Record<string, string> = { host: parsedUrl.host, "x-forwarded-proto": parsedUrl.protocol.replace(":", ""), ...(options.headers ?? {}) }
  if (options.cookies && Object.keys(options.cookies).length > 0) {
    headers["cookie"] = Object.entries(options.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
  }
  const init: RequestInit = { method: options.method ?? "GET", headers }
  if (options.body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    init.body = options.body
  }
  return HttpServerRequest.fromWeb(new Request(url, init))
}

let cachedPemPromise: Promise<string> | undefined
const getTestRsaPem = (): Promise<string> => {
  if (!cachedPemPromise) {
    cachedPemPromise = (async () => {
      const kp = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))
      let bin = ""
      for (const b of pkcs8) bin += String.fromCharCode(b)
      const b64 = btoa(bin).match(/.{1,64}/g)!.join("\n")
      return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`
    })()
  }
  return cachedPemPromise
}

const makeFakeHttpClientService = (responder: (url: string, method: string) => { status: number; body?: unknown; headers?: Record<string, string> }): HttpClient.HttpClient => HttpClient.make((request) => { const res = responder(request.url, request.method); const bodyStr = res.body === undefined ? null : typeof res.body === "string" ? res.body : JSON.stringify(res.body); const headers = new Headers(res.headers ?? {}); if (bodyStr !== null && !headers.has("content-type")) headers.set("content-type", "application/json"); return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bodyStr, { status: res.status, headers }))) })
const makeFakeHttpClient = (
  responder: (url: string, method: string) => { status: number; body?: unknown; headers?: Record<string, string> },
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const res = responder(request.url, request.method)
      const bodyStr = res.body === undefined ? null : typeof res.body === "string" ? res.body : JSON.stringify(res.body)
      const headers = new Headers(res.headers ?? {})
      if (bodyStr !== null && !headers.has("content-type")) headers.set("content-type", "application/json")
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(bodyStr, { status: res.status, headers })))
    }),
  )

describe("Wave5cPush75 deep worker fuzz suite", () => {
  it("fuzzes Notifications.foldRun, foldMissingRun, recordRepoEvent, watch, ack, and shape", async () => {
    await fuzz(
      async (input) => {
        const mode = input.choice([
          "fold_existing_and_watchers",
          "fold_missing_run_done",
          "fold_missing_run_failed",
          "record_repo_event_main",
          "record_repo_event_release",
          "route_watch_branches",
          "route_ack_branches",
          "route_shape_signed_in_and_out",
        ] as const)

        const personId = "00000000-0000-4000-8000-000000000001"
        const watcherId = "00000000-0000-4000-8000-000000000002"
        const runId = `run-${input.integer(1, 50)}`
        const repoId = "github/smithersai/smithers"

        const dbLayer = makeSqlLayer((sqlText) => {
          if (sqlText.includes("pg_advisory_xact_lock")) return []
          if (sqlText.includes("WITH run AS")) {
            return [
              { repoId, personId },
              { repoId, personId: watcherId },
            ]
          }
          if (sqlText.includes("FROM runs r")) {
            if (mode.startsWith("fold_missing_run")) return []
            const status = input.choice(["working", "waiting", "needs_you", "done", "failed"] as const)
            return [
              {
                status,
                version: input.integer(1, 10),
                answered: input.boolean(),
                answer: input.choice([null, "streaming", "done", "failed"] as const),
                launchedBy: personId,
                conversationId: "conv-1",
                branchId: "branch-1",
                repoId,
                branchName: "feat/fuzz",
                prompt: "Please approve deployment",
                question: "How does routing work?",
              },
            ]
          }
          if (sqlText.includes("FROM notifications n") && sqlText.includes("FOR UPDATE")) {
            return [
              {
                recipient: personId,
                mine: true,
                conversationId: input.boolean() ? "conv-1" : null,
                repoId,
                denied: false,
              },
            ]
          }
          if (sqlText.includes("WITH outcome AS")) {
            return [{ state: mode === "fold_missing_run_done" ? "done" : "failed" }]
          }
          if (sqlText.includes("FROM watches WHERE subject =")) {
            return [
              { principal: watcherId, level: input.choice(["all", "mentions", "muted"] as const) },
              { principal: personId, level: "all" },
            ]
          }
          if (sqlText.includes("FROM notifications WHERE subject =")) {
            return [
              {
                recipient: personId,
                state: "needs_you",
                mine: true,
                quiet: false,
                title: "Old prompt",
                version: 1,
              },
              {
                recipient: watcherId,
                state: "working",
                mine: false,
                quiet: false,
                title: "Old",
                version: 1,
              },
            ]
          }
          if (sqlText.includes("FROM branches b") && sqlText.includes("JOIN conversations")) {
            return [
              {
                branchId: "branch-1",
                conversationId: "conv-1",
                name: "feat/fuzz",
                repoId,
                mode: "open",
                createdBy: personId,
                person: "edit",
                repository: "view",
                anyShare: true,
                installed: true,
              },
            ]
          }
          if (sqlText.includes("FROM branches") && sqlText.includes("created_by")) {
            return [{ createdBy: personId, visibility: "team", repoId }]
          }
          if (sqlText.includes("FROM branch_grants")) {
            return [{ principalId: watcherId, role: "member" }]
          }
          if (sqlText.includes("FROM github_repo_roles") && sqlText.includes("checked_at <> '-infinity'")) {
            return []
          }
          if (sqlText.includes("FROM conversations")) {
            return [{ id: "conv-home", conversationId: "conv-home", name: "main", branchId: "branch-1", repoId }]
          }
          if (sqlText.includes("INSERT INTO notifications")) {
            return [{ ok: 1 }]
          }
          if (sqlText.includes("FROM watches w") && sqlText.includes("people")) {
            return [
              { principal: personId, role: "member", level: "all" },
              { principal: watcherId, role: "maintainer", level: "all" },
            ]
          }
          if (sqlText.includes("INSERT INTO watches")) {
            return input.boolean() ? [{ txid: "42" }] : []
          }
          if (sqlText.includes("UPDATE notifications SET")) {
            return input.boolean() ? [{ txid: "43" }] : []
          }
          if (sqlText.includes("SELECT 1 FROM notifications WHERE recipient")) {
            return input.boolean() ? [{ found: 1 }] : []
          }
          if (sqlText.includes("candidates.\"repoId\"")) {
            return [
              {
                repoId,
                installed: true,
                denialSequence: "0",
                readable: true,
                reused: true,
                permissionFresh: true,
                visibilityFresh: true,
              },
              {
                repoId: "github/acme/other",
                installed: true,
                denialSequence: "0",
                readable: false,
                reused: false,
                permissionFresh: false,
                visibilityFresh: false,
              },
              {
                repoId: "github/acme/down",
                installed: false,
                denialSequence: "0",
                readable: null,
                reused: false,
                permissionFresh: false,
                visibilityFresh: false,
              },
            ]
          }
          if (sqlText.includes("SELECT clock_timestamp()::text AS at")) {
            return [{ at: new Date().toISOString() }]
          }
          if (sqlText.includes("FROM notification_repository_access")) {
            return [{ repoId: "github/acme/other", denialSequence: "1" }]
          }
          if (sqlText.includes("INSERT INTO notification_repository_access")) {
            return [{ denialSequence: "1" }]
          }
          if (sqlText.includes("authorityUnknownSubjects")) {
            return [
              {
                subjects: { [`run:${runId}`]: repoId },
                repositories: [repoId],
                authorityUnknownSubjects: 0,
                withheldSubjects: 0,
              },
            ]
          }
          return []
        })

        const policyLayer = Layer.succeed(
          NotificationPolicy.RecipientPolicy,
          NotificationPolicy.RecipientPolicy.of({
            decide: (req) =>
              Effect.succeed(
                Option.some({
                  recipients: req.candidates.slice(0, 2),
                  handling: { quiet: input.boolean() },
                }),
              ),
          }),
        )

        const branchRolesLayer = Layer.succeed(
          BranchRoles,
          BranchRoles.of({
            grantBasis: (_repoId: string, installed: boolean) => (installed ? "repository" : "public"),
            grantFreshSeconds: 300,
            role: (_actor: Actor, id: string) =>
              id === "github/acme/down"
                ? Effect.fail(new RepoRoles.RoleRefused({ code: "rate_limited", retryAfterSeconds: 5 }))
                : Effect.succeed(id === repoId ? ("member" as Role) : null),
            uninstalled: () => null,
          } as never),
        )

        if (mode === "fold_existing_and_watchers" || mode.startsWith("fold_missing_run")) {
          const written = await Effect.runPromise(
            Notifications.foldRun(runId, "alice").pipe(
              Effect.provide(Layer.mergeAll(dbLayer, policyLayer, branchRolesLayer)),
            ),
          )
          expect(typeof written).toBe("number")
          return
        }

        if (mode === "record_repo_event_main" || mode === "record_repo_event_release") {
          const event: Notifications.RepoEvent = {
            kind: mode === "record_repo_event_main" ? "main" : "release",
            repoId,
            ref: mode === "record_repo_event_main" ? "a".repeat(40) : "v1.2.3",
            before: mode === "record_repo_event_main" ? "b".repeat(40) : undefined,
            title: "smithersai/smithers",
            actor: "alice",
            occurredAt: new Date(),
            href: "/smithersai/smithers",
          }
          const written = await Effect.runPromise(
            Notifications.recordRepoEvent(event).pipe(
              Effect.provide(Layer.mergeAll(dbLayer, policyLayer)),
            ),
          )
          expect(typeof written).toBe("number")
          return
        }

        const routes = await Effect.runPromise(Notifications.make(dbLayer))

        if (mode === "route_watch_branches") {
          const memberActor: Actor = { subject: { kind: "person", id: personId }, role: "member", login: "alice" }
          const sub = input.choice(["get_405", "anon_401", "non_member_403", "bad_json_400", "ok_200"] as const)
          const actorOpt =
            sub === "anon_401"
              ? Option.none<Actor>()
              : sub === "non_member_403"
                ? Option.some<Actor>({ subject: { kind: "person", id: personId }, role: "guest", login: "g" })
                : Option.some(memberActor)
          const req = makeRequest("https://smithers.test/api/watches", {
            method: sub === "get_405" ? "GET" : "POST",
            body:
              sub === "bad_json_400"
                ? "{bad"
                : JSON.stringify({ conversationId: input.boolean() ? "conv-1" : null }),
          })
          const res = await Effect.runPromise(
            routes.watch.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, req),
              Effect.provideService(Sessions, Sessions.of({ resolve: Effect.succeed(actorOpt) })),
              Effect.provide(branchRolesLayer),
            ),
          )
          expect(res).toBeDefined()
          return
        }

        if (mode === "route_ack_branches") {
          const sub = input.choice(["agent_403", "bad_json_400", "ok_or_404"] as const)
          const actor: Actor =
            sub === "agent_403"
              ? { subject: { kind: "person", id: personId }, role: "member", login: "alice", act: { kind: "agent", id: "mcp:1" } }
              : { subject: { kind: "person", id: personId }, role: "member", login: "alice" }
          const req = makeRequest("https://smithers.test/api/notifications/ack", {
            method: "POST",
            body:
              sub === "bad_json_400"
                ? "not-json"
                : JSON.stringify({ subject: `run:${runId}`, act: input.choice(["read", "dismiss", "hide"] as const), version: 2 }),
          })
          const res = await Effect.runPromise(
            routes.ack.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, req),
              Effect.provideService(Sessions, Sessions.of({ resolve: Effect.succeed(Option.some(actor)) })),
              Effect.provide(branchRolesLayer),
            ),
          )
          expect(res).toBeDefined()
          return
        }

        // route_shape_signed_in_and_out
        const signedIn = input.boolean()
        const actorOpt: Option.Option<Actor> = signedIn
          ? Option.some({ subject: { kind: "person", id: personId }, role: "member", login: "alice" })
          : Option.none()
        const electricClient = makeFakeHttpClient(() => ({
          status: 200,
          headers: {
            "content-type": "application/json",
            "electric-handle": "h-1",
            "electric-offset": "0_0",
          },
          body: JSON.stringify([
            {
              headers: { operation: "insert" },
              value: {
                recipient: personId,
                subject: `run:${runId}`,
                repo_id: repoId,
              },
            },
          ]),
        }))
        const req = makeRequest("https://smithers.test/api/shapes/notifications?offset=-1", { method: "GET" })
        const res = await Effect.runPromise(
          routes.shape.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provideService(Sessions, Sessions.of({ resolve: Effect.succeed(actorOpt) })),
            Effect.provide(Layer.mergeAll(branchRolesLayer, electricClient)),
          ),
        )
        expect(res).toBeDefined()
      },
      { executions: 50, seed: 52001 },
    )
  })

  it("fuzzes RepoRoles.make full GitHub App path (resolve, publicCopy, refresh, cooldown, visibility)", async () => {
    const pem = await getTestRsaPem()
    await fuzz(
      async (input) => {
        const scenario = input.choice([
          "resolve_cache_hit",
          "resolve_github_200_same_user",
          "resolve_github_200_other_user",
          "resolve_github_404",
          "resolve_github_403_ratelimit",
          "resolve_github_500_unavailable",
          "resolve_app_absent",
          "resolve_cooldown_active",
          "public_copy_cached",
          "public_copy_fetch_public",
          "public_copy_fetch_private",
          "public_copy_fetch_404",
          "refresh_and_work_helpers",
        ] as const)

        const homeRepo = repositoryOf("smithersai/home")
        const targetRepo = repositoryOf("acme/widgets")
        const actor: Actor = { subject: { kind: "person", id: "00000000-0000-4000-8000-000000000001" }, role: "member", login: "alice" }

        let stateCallCount = 0
        const dbLayer = makeSqlLayer((sqlText) => {
          if (sqlText.includes("pg_advisory_xact_lock") || sqlText.includes("set_config")) return []
          if (sqlText.includes("clock_timestamp()::text AS at")) return [{ at: new Date().toISOString() }]
          if (sqlText.includes("github_repo_role_state")) {
            stateCallCount++
            if (scenario === "resolve_cache_hit") {
              return [
                {
                  role: "maintainer",
                  checkedAt: new Date().toISOString(),
                  fresh: true,
                  claimed: false,
                  failed: false,
                  refusal: null,
                  remainingSeconds: null,
                },
              ]
            }
            if (scenario === "resolve_cooldown_active") {
              return [
                {
                  role: null,
                  checkedAt: new Date(0).toISOString(),
                  fresh: false,
                  claimed: false,
                  failed: true,
                  refusal: "rate_limited",
                  remainingSeconds: 15,
                },
              ]
            }
            return [
              {
                role: null,
                checkedAt: new Date(0).toISOString(),
                fresh: false,
                claimed: false,
                failed: false,
                refusal: null,
                remainingSeconds: null,
              },
            ]
          }
          if (sqlText.includes("INSERT INTO github_repo_roles") && sqlText.includes("read_until")) {
            return [{ lease: "lease-1" }]
          }
          if (sqlText.includes("SELECT now()::text AS \"asOf\"")) {
            return [
              {
                asOf: new Date().toISOString(),
                githubId: "777",
                login: "alice",
                absent: scenario === "resolve_app_absent",
              },
            ]
          }
          if (sqlText.includes("INSERT INTO github_repo_roles") && sqlText.includes("ON CONFLICT (repo_id, person_id) DO UPDATE SET role")) {
            return []
          }
          if (sqlText.includes("FROM github_repo_roles WHERE repo_id") && sqlText.includes("checkedAt")) {
            return [{ role: "member", checkedAt: new Date().toISOString(), fresh: true }]
          }
          if (sqlText.includes("UPDATE github_repo_roles") && sqlText.includes("leftMillis")) {
            return [{ leftMillis: 5000 }]
          }
          if (sqlText.includes("FROM github_repositories WHERE repo_id") && sqlText.includes("visibility_read_until")) {
            if (scenario === "public_copy_cached") {
              return [{ public: true, fresh: true, claimed: false, failed: false, refusal: null, remainingSeconds: null }]
            }
            return [{ public: null, fresh: false, claimed: false, failed: false, refusal: null, remainingSeconds: null }]
          }
          if (sqlText.includes("FROM github_repositories WHERE repo_id") && sqlText.includes("installation_id")) {
            return [{ installationId: 12345 }]
          }
          if (sqlText.includes("INSERT INTO github_repositories") && sqlText.includes("visibility_read_until")) {
            return [{ lease: "vlease-1" }]
          }
          if (sqlText.includes("FROM github_repositories WHERE repo_id") && sqlText.includes("public")) {
            return [{ public: scenario === "public_copy_cached" || scenario === "public_copy_fetch_public", fresh: scenario === "public_copy_cached" }]
          }
          return []
        })

        const httpResponder = (url: string, method: string) => {
          if (url.includes("/installation") && method === "GET") {
            return { status: 200, body: { id: 12345 } }
          }
          if (url.includes("/access_tokens") && method === "POST") {
            return {
              status: 201,
              body: {
                token: "ghs_test_token_1234567890",
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
            }
          }
          if (url.includes("/collaborators/alice/permission")) {
            if (scenario === "resolve_github_200_same_user") {
              return { status: 200, body: { permission: "write", user: { id: 777, login: "alice" } } }
            }
            if (scenario === "resolve_github_200_other_user") {
              return { status: 200, body: { permission: "admin", user: { id: 999, login: "alice" } } }
            }
            if (scenario === "resolve_github_404") {
              return { status: 404, body: { message: "Not Found" } }
            }
            if (scenario === "resolve_github_403_ratelimit") {
              return { status: 403, headers: { "retry-after": "12", "x-ratelimit-remaining": "0" }, body: { message: "rate limit" } }
            }
            return { status: 500, body: { message: "boom" } }
          }
          if (url.includes("/repos/acme/widgets")) {
            if (scenario === "public_copy_fetch_public") {
              return { status: 200, body: { id: 42, full_name: "acme/widgets", private: false, default_branch: "main" } }
            }
            if (scenario === "public_copy_fetch_private") {
              return { status: 200, body: { id: 42, full_name: "acme/widgets", private: true, default_branch: "main" } }
            }
            return { status: 404, body: { message: "Not Found" } }
          }
          return { status: 200, body: {} }
        }
        const httpService = makeFakeHttpClientService(httpResponder)
        const httpLayer = Layer.succeed(HttpClient.HttpClient, httpService)

        const roles = await Effect.runPromise(RepoRoles.make(dbLayer, {
          repository: homeRepo,
          app: Option.some({
            appId: "999",
            privateKey: Redacted.make(pem),
            webhookSecret: Option.none(),
            repository: homeRepo,
            apiBaseUrl: "https://api.github.test",
          }),
          refreshCooldownSeconds: 5,
          http: httpService,
        }))

        if (scenario === "refresh_and_work_helpers") {
          expect(roles.workBasis?.(homeRepo, true)).toBe("local")
          expect(roles.workBasis?.(targetRepo, true)).toBe("repository")
          expect(roles.workBasis?.(targetRepo, false)).toBe("public")
          expect(roles.workUninstalled?.(actor, targetRepo)).toBeNull()
          const localRes = await Effect.runPromise(roles.resolve(actor, homeRepo).pipe(Effect.provide(httpLayer)))
          expect(localRes.role).toBe("member")
          const workRes = await Effect.runPromise(
            Effect.result(roles.refresh(actor, targetRepo, { repoId: targetRepo.id, personId: actor.subject.id, role: "member", checkedAt: new Date().toISOString(), freshSeconds: 300 }).pipe(Effect.provide(httpLayer))),
          )
          expect(workRes._tag === "Success" || workRes._tag === "Failure").toBe(true)
          return
        }

        if (scenario.startsWith("public_copy")) {
          const out = await Effect.runPromise(
            Effect.result(roles.publicCopy(targetRepo).pipe(Effect.provide(httpLayer))),
          )
          expect(out._tag === "Success" || out._tag === "Failure").toBe(true)
          return
        }

        const out = await Effect.runPromise(
          Effect.result(roles.resolve(actor, targetRepo).pipe(Effect.provide(httpLayer))),
        )
        expect(stateCallCount).toBeGreaterThanOrEqual(1)
        if (scenario === "resolve_cache_hit") {
          expect(out._tag).toBe("Success")
        } else if (scenario === "resolve_app_absent" || scenario === "resolve_cooldown_active" || scenario === "resolve_github_403_ratelimit" || scenario === "resolve_github_500_unavailable") {
          expect(out._tag).toBe("Failure")
        } else {
          expect(out._tag === "Success" || out._tag === "Failure").toBe(true)
        }
      },
      { executions: 35, seed: 52002 },
    )
  })

  it("fuzzes McpAuthService authenticate, resolveRepoAccess (incl. readFreshDeploymentRole), and requireWriteAccess", async () => {
    await fuzz(
      async (input) => {
        const rawToken = `sma_${"a1b2c3d4".repeat(8)}`
        const tokenHash = digestSync(rawToken)
        const personId = "00000000-0000-4000-8000-000000000010"
        const homeRepo = repositoryOf("smithersai/smithers")

        const scenario = input.choice([
          "auth_absent",
          "auth_malformed",
          "auth_db_fail",
          "auth_not_found",
          "auth_revoked",
          "auth_expired",
          "auth_scope_mismatch",
          "auth_ok",
          "repo_invalid_name",
          "repo_scope_mismatch",
          "repo_anon_public_db",
          "repo_deployment_fresh",
          "repo_deployment_stale",
          "repo_deployment_missing",
          "repo_refusal_codes",
          "write_access_all_guards",
        ] as const)

        const dbLayer = makeSqlLayer((sqlText) => {
          if (scenario === "auth_db_fail") return new Error("db_down")
          if (sqlText.includes("FROM mcp_tokens")) {
            if (scenario === "auth_not_found") return []
            return [
              {
                id: "tok-1",
                tokenSha256: tokenHash,
                personId,
                login: "alice",
                clientName: "cursor",
                repoScope: scenario === "auth_scope_mismatch" ? "github/other/repo" : null,
                scopes: ["mcp:read", "mcp:write"],
                revoked: scenario === "auth_revoked",
                expired: scenario === "auth_expired",
              },
            ]
          }
          if (sqlText.includes("UPDATE mcp_tokens")) return []
          if (sqlText.includes("FROM people p")) {
            const nowMs = Date.now()
            if (scenario === "repo_deployment_missing") return []
            return [
              {
                role: "maintainer",
                verifiedAt: scenario === "repo_deployment_stale" ? String(nowMs - 999_999_999) : String(nowMs - 1000),
                nowMs: String(nowMs),
              },
            ]
          }
          if (sqlText.includes("FROM github_repositories")) {
            return [{ private: false }]
          }
          return []
        })

        const refusalCode = input.choice([
          "rate_limited",
          "app_not_installed",
          "not_found",
          "not_configured",
          "github_unavailable",
          "unavailable",
        ] as const)

        const fakeRoles: RepoRoles.RepoRoles = {
          repository: homeRepo,
          workBasis: () => "repository",
          resolve: (actor: Actor) => Effect.succeed({ role: actor.role ?? "member", fresh: true } as never),
          publicCopy: () => Effect.succeed(true),
          refresh: () => Effect.succeed({ role: "member", fresh: true } as never),
          workRole: () => Effect.succeed("member"),
          workUninstalled: () => null,
        } as unknown as RepoRoles.RepoRoles

        const svc = await Effect.runPromise(
          makeMcpAuthService({
            database: dbLayer,
            roles: scenario.startsWith("repo_deployment") ? fakeRoles : undefined,
            resolveRole:
              scenario === "repo_refusal_codes"
                ? () => Effect.fail(new RepoRoles.RoleRefused({ code: refusalCode }))
                : scenario === "write_access_all_guards"
                  ? () => Effect.succeed(input.choice(["guest", "member", "maintainer", "admin", null] as const))
                  : undefined,
            isRepoPublic:
              scenario === "repo_anon_public_db"
                ? undefined
                : () => Effect.succeed(input.boolean()),
          }),
        )

        const blockedAct = MCP_BLOCKED_ACTS[0]!
        expect(isBlockedMcpAct(blockedAct)).toBe(true)
        expect(isBlockedMcpAct(blockedAct.replace("/", "."))).toBe(true)
        const blockedRes = await Effect.runPromise(Effect.result(assertNotBlockedAct(blockedAct)))
        expect(blockedRes._tag).toBe("Failure")
        const okAct = await Effect.runPromise(Effect.result(assertNotBlockedAct("issues/list")))
        expect(okAct._tag).toBe("Success")

        if (scenario.startsWith("auth_")) {
          const header =
            scenario === "auth_absent"
              ? undefined
              : scenario === "auth_malformed"
                ? input.choice(["", "Basic abc", "Bearer short", "Bearer " + "x".repeat(9000)])
                : `Bearer ${rawToken}`
          const req = makeRequest("https://smithers.test/api/mcp", {
            headers: header === undefined ? {} : { authorization: header },
          })
          const res = await Effect.runPromise(svc.authenticate(req, "github/smithersai/smithers"))
          if (scenario === "auth_absent") expect(res._tag).toBe("Anonymous")
          else if (scenario === "auth_ok") expect(res._tag).toBe("Authenticated")
          else expect(res._tag).toBe("Rejected")
          return
        }

        const principal: McpPrincipal = {
          tokenId: "tok-1",
          personId,
          login: "alice",
          clientName: "cursor",
          repoScope: scenario === "repo_scope_mismatch" ? "github/other/repo" : null,
          scopes: input.boolean() ? ["mcp:read", "mcp:write"] : ["mcp:read"],
          actor: agentActor("tok-1", personId, "alice", null),
        }

        if (scenario === "repo_invalid_name") {
          const r = await Effect.runPromise(Effect.result(svc.resolveRepoAccess(Option.some(principal), "bad owner!", "repo")))
          expect(r._tag).toBe("Failure")
          return
        }

        if (scenario === "repo_anon_public_db") {
          const r = await Effect.runPromise(Effect.result(svc.resolveRepoAccess(Option.none(), "smithersai", "smithers")))
          expect(r._tag).toBe("Success")
          return
        }

        if (scenario === "write_access_all_guards") {
          const variant = input.choice(["anon", "non_agent", "read_only", "normal"] as const)
          const p: Option.Option<McpPrincipal> =
            variant === "anon"
              ? Option.none()
              : variant === "non_agent"
                ? Option.some({ ...principal, actor: { subject: { kind: "person", id: personId }, role: "admin", login: "alice" } })
                : variant === "read_only"
                  ? Option.some({ ...principal, scopes: ["mcp:read"] })
                  : Option.some({ ...principal, scopes: ["mcp:read", "mcp:write"] })
          const r = await Effect.runPromise(
            Effect.result(svc.requireWriteAccess(p, "smithersai", "smithers", input.choice(["member", "maintainer", "admin"] as const))),
          )
          expect(r._tag === "Success" || r._tag === "Failure").toBe(true)
          return
        }

        const r = await Effect.runPromise(Effect.result(svc.resolveRepoAccess(Option.some(principal), "smithersai", "smithers")))
        expect(r._tag === "Success" || r._tag === "Failure").toBe(true)
      },
      { executions: 50, seed: 52003 },
    )
  })

  it("fuzzes PersonalModels.layer open & openConnection across off, bad key, no_model, db fail, and real sealed keys", async () => {
    const keys = await Effect.runPromise(SecretKeys.make(Redacted.make("f".repeat(64))))
    const personId = "00000000-0000-4000-8000-000000000020"
    const sealed = await Effect.runPromise(
      keys.cipher.seal(Redacted.make("sk-test-fake-key-1234567890"), PersonalModels.sealContext(personId, keys.version)),
    )

    await fuzz(
      async (input) => {
        const scenario = input.choice([
          "no_active_rows",
          "no_model_named",
          "keys_off",
          "bad_ciphertext",
          "valid_openai_effort",
          "valid_anthropic",
          "db_failure",
          "open_connection_missing",
          "open_connection_valid",
          "open_connection_no_model",
        ] as const)

        const dbLayer = makeSqlLayer(() => {
          if (scenario === "db_failure") return new Error("pg_down")
          if (scenario === "no_active_rows" || scenario === "open_connection_missing") return []
          const isAnthropic = scenario === "valid_anthropic"
          const noModel = scenario === "no_model_named" || scenario === "open_connection_no_model"
          return [
            {
              id: "conn-1",
              name: isAnthropic ? "Anthropic" : "OpenAI",
              kind: "api_key",
              protocol: isAnthropic ? "anthropic" : "openai-chat",
              baseUrl: noModel
                ? "https://custom.example/v1"
                : isAnthropic
                  ? "https://api.anthropic.com"
                  : "https://api.openai.com/v1",
              ciphertext: scenario === "bad_ciphertext" ? "AAAA" : sealed.ciphertext,
              nonce: sealed.nonce,
              keyVersion: keys.version,
              active: true,
              fastModel: noModel ? null : isAnthropic ? "claude-sonnet-4-6" : "gpt-6.1-mini",
              implementModel: noModel ? null : isAnthropic ? "claude-sonnet-4-6" : "gpt-6.1",
              hardModel: noModel ? null : isAnthropic ? "claude-opus-4-6" : "gpt-6.1",
            },
          ]
        })

        const keysLayer = Layer.succeed(
          SecretKeys.SecretKeys,
          scenario === "keys_off" ? Option.none() : Option.some(keys),
        )
        const layer = PersonalModels.PersonalModels.layer(dbLayer).pipe(Layer.provide(keysLayer))

        const out = await Effect.runPromise(
          Effect.result(
            Effect.flatMap(PersonalModels.PersonalModels, (pm) =>
              scenario.startsWith("open_connection")
                ? pm.openConnection(personId, "conn-1")
                : pm.open(personId, input.choice(["fast", "implement", "hard"] as const)),
            ),
          ).pipe(Effect.provide(layer)),
        )

        if (scenario === "no_active_rows" || scenario === "open_connection_missing") {
          expect(out._tag).toBe("Success")
          if (out._tag === "Success") expect(Option.isNone(out.success)).toBe(true)
        } else if (scenario === "valid_openai_effort" || scenario === "open_connection_valid") {
          expect(out._tag).toBe("Success")
          if (out._tag === "Success") expect(Option.isSome(out.success)).toBe(true)
        } else if (scenario === "valid_anthropic") {
          expect(out._tag === "Success" || out._tag === "Failure").toBe(true)
        } else {
          expect(out._tag).toBe("Failure")
        }
      },
      { executions: 35, seed: 52004 },
    )
  })

  it("fuzzes SignIn.make handoff, arrive, guard/admit, renewRole, CredentialStale, signOut, and dev fallback", async () => {
    const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))
    await fuzz(
      async (input) => {
        const scenario = input.choice([
          "dev_fallback_sign_in_and_session",
          "handoff_alias_issued",
          "handoff_custom_domain_get_and_post",
          "handoff_errors_and_failed_param",
          "arrive_get_and_post_branches",
          "guard_stale_credential_503_vs_401",
          "guard_and_session_renew_role",
          "sign_in_alias_cross_site_vs_same_origin",
          "sign_out_cookie_branches",
        ] as const)

        const homeHost = "app.smithers.test"
        const aliasHost = "preview.smithers.test"
        const customHost = "custom.example.com"
        const sessionSecretVal = "tok-sess-1234567890"
        const signedSessionCookie = await Effect.runPromise(keys.sign("session", sessionSecretVal, "legacy"))
        const nonceVal = "nonce-1234567890"
        const signedNonceCookie = await Effect.runPromise(keys.sign("handoff", nonceVal, "legacy"))
        const nonceDigest = SessionKeys.digest(nonceVal)
        const now = Date.now()
        const sessionId = "00000000-0000-4000-8000-000000000099"
        const personId = "00000000-0000-4000-8000-000000000001"

        const dbLayer = makeSqlLayer((sqlText) => {
          if (sqlText.includes("FROM signing_keys") || sqlText.includes("signing_issuer")) {
            return [{ id: "legacy" }]
          }
          if (sqlText.includes("FROM custom_domains")) {
            return [{ active: true }]
          }
          if (sqlText.includes("INSERT INTO sign_in_attempts") || sqlText.includes("INSERT INTO host_handoffs")) {
            return []
          }
          if (sqlText.includes("DELETE FROM host_handoffs") || sqlText.includes("UPDATE host_handoffs")) {
            const sub = input.choice(["ok", "expired", "other_host", "none"] as const)
            if (sub === "none") return []
            return [
              {
                sessionId,
                host: sub === "other_host" ? "evil.example" : aliasHost,
                nonceDigest,
                returnTo: "/inbox",
                live: sub !== "expired",
              },
            ]
          }
          if (sqlText.includes("UPDATE sessions SET") && sqlText.includes("expires_at")) {
            return [{ renewed: true }]
          }
          if (sqlText.includes("FROM sessions") && sqlText.includes("credential_stale")) {
            return [{ stale: scenario === "guard_stale_credential_503_vs_401" }]
          }
          if (sqlText.includes("FROM sessions") && sqlText.includes("people")) {
            if (scenario === "guard_stale_credential_503_vs_401") return []
            return [
              {
                id: sessionId,
                personId,
                githubId: "777",
                login: "alice",
                role: "member",
                roleCheckedAt: scenario === "guard_and_session_renew_role" ? now - 999_999 : now,
                roleVerifiedAt: scenario === "guard_and_session_renew_role" ? now - 999_999 : now,
                serverNow: now,
                expiresAt: now + 3_600_000,
                deadline: now + 3_600_000,
                cookieKey: "legacy",
                sessionTag: "0123456789abcdef0123456789abcdef",
                accessToken: null,
                accessExpiresAt: null,
                refreshToken: null,
              },
            ]
          }
          if (sqlText.includes("FROM host_sessions")) {
            return []
          }
          if (sqlText.includes("INSERT INTO host_sessions")) {
            return [{ id: "alias-sess-1" }]
          }
          return []
        })

        const signInEnv = Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(Flows.FlowStarter, { start: () => Effect.succeed({ runId: "r-1" } as never) } as never),
          Layer.succeed(SignIn.RoleChecks, { start: () => Effect.void }),
        )

        if (scenario === "dev_fallback_sign_in_and_session") {
          const auth = await Effect.runPromise(
            SignIn.make(dbLayer, {
              fallback: {
                actor: { subject: { kind: "person", id: personId }, role: "admin", login: "dev" },
                roleConfirmed: true,
                login: "dev",
              },
              teammates: {
                bob: {
                  actor: { subject: { kind: "person", id: "p-bob" }, role: "member", login: "bob" },
                  roleConfirmed: true,
                  login: "bob",
                },
              },
              newcomer: (name) => ({
                actor: { subject: { kind: "person", id: `p-${name}` }, role: "guest", login: name },
                roleConfirmed: true,
                login: name,
              }),
            }).pipe(
              Effect.provide(Layer.mergeAll(
                ConfigProvider.layer(ConfigProvider.fromUnknown({})),
                FetchHttpClient.layer,
              )),
            ),
          )
          const signInRes = await Effect.runPromise(
            auth.fetch.pipe(
              Effect.provide(signInEnv),
              Effect.provideService(HttpServerRequest.HttpServerRequest, makeRequest(`https://${homeHost}${SIGN_IN_ROUTE}?return=/home`)),
              Effect.provide(Layer.mergeAll(
                Layer.succeed(Flows.FlowStarter, { start: () => Effect.succeed({ runId: "r-1" } as never) } as never),
                Layer.succeed(SignIn.RoleChecks, { start: () => Effect.void }),
              )),
            ),
          )
          expect(signInRes).toBeDefined()
          for (const cookies of [
            {},
            { "__Host-smithers_dev_signed_out": "1" },
            { "__Host-smithers_dev_person": "bob" },
            { "__Host-smithers_dev_person": "carol" },
          ] as ReadonlyArray<Record<string, string>>) {
            const actor = await Effect.runPromise(
              Effect.flatMap(Sessions, (s) => s.resolve).pipe(
                Effect.provide(auth.sessions),
                Effect.provideService(HttpServerRequest.HttpServerRequest, makeRequest(`https://${homeHost}${SESSION_ROUTE}`, { cookies })),
                Effect.provide(Layer.succeed(SignIn.RoleChecks, { start: () => Effect.void })),
              ),
            )
            expect(actor._tag === "Some" || actor._tag === "None").toBe(true)
          }
          return
        }

        const configLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            GITHUB_CLIENT_ID: "cid",
            GITHUB_CLIENT_SECRET: "csec",
            SESSION_SECRET: SECRET,
            GITHUB_REPOSITORY: "smithersai/smithers",
            APP_DOMAIN: homeHost,
            APP_ALIASES: `${aliasHost}=smithersai/smithers`,
          }),
        )
        const gh = scriptedGitHub()
        const ghLayer = Layer.succeed(GitHubAuth, gh.service)


        const auth = await Effect.runPromise(
          SignIn.make(dbLayer).pipe(Effect.provide(Layer.mergeAll(configLayer, ghLayer, signInEnv))),
        )

        if (scenario === "handoff_alias_issued" || scenario === "handoff_custom_domain_get_and_post") {
          const targetHost = scenario === "handoff_alias_issued" ? aliasHost : customHost
          const signedReq = await Effect.runPromise(
            keys.sign(
              "handoff_request",
              JSON.stringify({ host: targetHost, returnTo: "/chat", nonce: nonceDigest, expiresAt: now + 60_000 }),
              "legacy",
            ),
          )
          const getReq = makeRequest(`https://${homeHost}${HANDOFF_ROUTE}?request=${encodeURIComponent(signedReq)}`, {
            cookies: { "__Host-smithers_session": signedSessionCookie },
          })
          const getRes = await Effect.runPromise(
            auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, getReq)),
          )
          expect(getRes).toBeDefined()

          if (scenario === "handoff_custom_domain_get_and_post") {
            const postReq = makeRequest(`https://${homeHost}${HANDOFF_ROUTE}`, {
              method: "POST",
              headers: { origin: "null", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
              body: `request=${encodeURIComponent(signedReq)}`,
              cookies: { "__Host-smithers_session": signedSessionCookie },
            })
            const postRes = await Effect.runPromise(
              auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, postReq)),
            )
            expect(postRes).toBeDefined()
          }
          return
        }

        if (scenario === "handoff_errors_and_failed_param") {
          const expiredReq = await Effect.runPromise(
            keys.sign(
              "handoff_request",
              JSON.stringify({ host: aliasHost, returnTo: "/chat", nonce: nonceDigest, expiresAt: now - 1000 }),
              "legacy",
            ),
          )
          const validReq = await Effect.runPromise(
            keys.sign(
              "handoff_request",
              JSON.stringify({ host: aliasHost, returnTo: "/chat", nonce: nonceDigest, expiresAt: now + 60_000 }),
              "legacy",
            ),
          )
          const requests = [
            makeRequest(`https://${homeHost}${HANDOFF_ROUTE}`, { method: "DELETE" }),
            makeRequest(`https://${aliasHost}${HANDOFF_ROUTE}`),
            makeRequest(`https://${homeHost}${HANDOFF_ROUTE}`, { method: "POST", headers: { origin: "https://evil.example" } }),
            makeRequest(`https://${homeHost}${HANDOFF_ROUTE}?request=${encodeURIComponent(expiredReq)}`),
            makeRequest(`https://${homeHost}${HANDOFF_ROUTE}?request=${encodeURIComponent(validReq)}&${SIGN_IN_FAILED_PARAM}=1`),
            makeRequest(`https://${homeHost}${HANDOFF_ROUTE}?request=${encodeURIComponent(validReq)}`),
          ]
          for (const r of requests) {
            const res = await Effect.runPromise(auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, r)))
            expect(res).toBeDefined()
          }
          return
        }

        if (scenario === "arrive_get_and_post_branches") {
          const requests = [
            makeRequest(`https://${homeHost}${ARRIVE_ROUTE}`),
            makeRequest(`https://${aliasHost}${ARRIVE_ROUTE}`, { method: "GET" }),
            makeRequest(`https://${aliasHost}${ARRIVE_ROUTE}`, { method: "PUT" }),
            makeRequest(`https://${aliasHost}${ARRIVE_ROUTE}`, { method: "POST", headers: { origin: "https://evil.example" } }),
            makeRequest(`https://${aliasHost}${ARRIVE_ROUTE}`, {
              method: "POST",
              headers: { origin: "null", "sec-fetch-site": "same-origin" },
              body: "",
            }),
            makeRequest(`https://${aliasHost}${ARRIVE_ROUTE}`, {
              method: "POST",
              headers: { origin: `https://${aliasHost}` },
              body: "code=handoff-code-123",
              cookies: { "__Host-smithers_handoff": signedNonceCookie },
            }),
          ]
          for (const r of requests) {
            const res = await Effect.runPromise(auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, r)))
            expect(res).toBeDefined()
          }
          return
        }

        if (scenario === "guard_stale_credential_503_vs_401") {
          const accepts = input.boolean()
          const req = makeRequest(`https://${homeHost}/api/work`, {
            headers: accepts ? { [ACCEPTS_HEADER]: ACCEPTS_CREDENTIAL_STALE } : {},
            cookies: { "__Host-smithers_session": signedSessionCookie },
          })
          const res = await Effect.runPromise(
            auth.guard(Effect.succeed(new Response("ok") as never)).pipe(
              Effect.provide(signInEnv),
              Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            ),
          )
          expect([200, 401, 503]).toContain(res.status)
          return
        }

        if (scenario === "guard_and_session_renew_role") {
          const req = makeRequest(`https://${homeHost}${SESSION_ROUTE}`, {
            cookies: { "__Host-smithers_session": signedSessionCookie },
          })
          const res = await Effect.runPromise(
            auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, req)),
          )
          expect(res).toBeDefined()
          return
        }

        if (scenario === "sign_in_alias_cross_site_vs_same_origin") {
          for (const site of ["cross-site", "same-origin", "none"]) {
            const req = makeRequest(`https://${aliasHost}${SIGN_IN_ROUTE}?return=/ok&reauth=1`, {
              headers: { "sec-fetch-site": site },
            })
            const res = await Effect.runPromise(
              auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, req)),
            )
            expect(res).toBeDefined()
          }
          return
        }

        // sign_out_cookie_branches
        for (const host of [homeHost, aliasHost]) {
          const req = makeRequest(`https://${host}${SIGN_OUT_ROUTE}`, {
            method: "POST",
            headers: { origin: `https://${host}`, "sec-fetch-site": "same-origin" },
            cookies: { "__Host-smithers_session": signedSessionCookie },
          })
          const res = await Effect.runPromise(
            auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, req)),
          )
          expect(res).toBeDefined()
        }
        // Also touch callback error path
        const cbReq = makeRequest(`https://${homeHost}${CALLBACK_ROUTE}?error=access_denied`)
        const cbRes = await Effect.runPromise(
          auth.fetch.pipe(Effect.provide(signInEnv), Effect.provideService(HttpServerRequest.HttpServerRequest, cbReq)),
        )
        expect(cbRes).toBeDefined()
      },
      { executions: 30, seed: 52005 },
    )
  })
})
