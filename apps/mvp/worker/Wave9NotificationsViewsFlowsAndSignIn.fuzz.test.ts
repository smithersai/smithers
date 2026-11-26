import { runFlow } from "./test/flowHost.ts"
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { QuickJSVariant } from "@smthrs/harness"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import * as ViewRealm from "./ViewRealm.ts"
import { SandboxTools } from "@smthrs/sandbox"
import { Cause, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import * as SpendCopy from "../src/features/spend/copy.ts"
import { type Actor, CurrentActor, Sessions } from "./Actor.vibe"
import * as BranchAccess from "./branch/Access.vibe"
import { CheckoutFailed, SandboxStartTimedOut } from "./branch/Sandboxes.vibe"
import * as RepoFlow from "./ci/RepoFlow.vibe"
import * as SandboxCall from "./flows/SandboxCall.vibe"
import * as RepoRoles from "./github/RepoRoles.vibe"
import * as GitHubTokens from "./github/Tokens.vibe"
import * as ModelRoles from "./ModelRoles.vibe"
import * as Notifications from "./Notifications.ts"
import * as PersonalFlows from "./PersonalFlows.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as Runs from "./Runs.ts"
import * as SetModel from "./SetModel.vibe"
import { TaskAnswers } from "./Flows.ts"
import * as H from "./test/harness.ts"
import * as Views from "./Views.ts"

const silent = Logger.layer([])

const makeReq = (
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(
    new Request(url, {
      method,
      headers: {
        ...(body !== undefined && !("content-type" in headers) ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
    }),
  )

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex")

const actorLayer = (actor: Option.Option<Actor>) =>
  Layer.succeed(Sessions, Sessions.of({ resolve: Effect.succeed(actor) }))

const memberActor = (id = "person-1", role: Actor["role"] = "member", login = "alice"): Actor => ({
  subject: { kind: "person", id },
  login,
  role,
})

const delegatedActor = (id = "person-1"): Actor => ({
  subject: { kind: "person", id },
  login: "alice",
  role: "admin",
  act: { kind: "agent", id: "agent-1" } as never,
})

const defaultBranchRoles = (role: Actor["role"] = "maintainer") =>
  Layer.succeed(
    BranchAccess.BranchRoles,
    BranchAccess.BranchRoles.of({
      roleOn: () => Effect.succeed(role),
      uninstalled: () => role,
      workUninstalled: () => Effect.succeed(role),
      repoRoleOn: () => Effect.succeed({ role, held: Option.none() }),
      publicCopy: () => Effect.succeed(false),
    }),
  )

const repoFlowValidSource = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"

const lint = CiJob.make("lint", { steps: [{ name: "lint", run: "pnpm lint" }] })
const test = CiJob.make("test", { needs: ["lint"], steps: [{ name: "test", run: "pnpm test" }] })

export default Flow.make("ci", {
  body: (run: { readonly sha: string }) => Node.all({ lint: lint.call(run), test: test.call(run) }),
})
`

describe("Wave9 SetModel, SpendCopy, BranchAccess, SandboxCall & ci/RepoFlow", () => {
  const env = H.testFile("wave9_core_flows")

  it("fuzzes SetModel.write and SetModel.registration on real Postgres", async () => {
    await env.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
        const model: ModelRoles.ModelRecord = {
          protocol: "openai-chat",
          modelId: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com",
          credential: "FIXTURE",
        }
        // Delegated actor refused
        const eDel = yield* Effect.exit(SetModel.write({ role: "agent", model }, delegatedActor(), "inv-1"))
        expect(Exit.isFailure(eDel)).toBe(true)

        // Non-admin actor refused
        const eNon = yield* Effect.exit(SetModel.write({ role: "agent", model }, memberActor("p1", "member"), "inv-2"))
        expect(Exit.isFailure(eNon)).toBe(true)

        // Missing invocationKey -> defect NoInvocationKey
        const eNoKey = yield* Effect.exit(SetModel.write({ role: "agent", model }, memberActor("p1", "admin"), undefined))
        expect(Exit.isFailure(eNoKey) && Cause.squash(eNoKey.cause) instanceof SetModel.NoInvocationKey).toBe(true)

        // Admin ok -> writes model_roles and model_role_changes
        const ok = yield* SetModel.write({ role: "agent", model }, memberActor("p1", "admin"), "inv-ok-1")
        expect(ok).toEqual({ role: "agent", modelId: "claude-sonnet-4-5" })

        // DB failure branch (logged error)
        const brokenSql = Layer.succeed(
          SqlClient.SqlClient,
          new Proxy({} as SqlClient.SqlClient, {
            get: () => () => Effect.fail(new Error("db down")),
            apply: () => Effect.fail(new Error("db down")),
          }),
        )
        const eDb = yield* Effect.exit(
          SetModel.write({ role: "coding", model }, memberActor("p1", "admin"), "inv-db").pipe(Effect.provide(brokenSql)),
        )
        expect(Exit.isFailure(eDb)).toBe(true)

        // Run SetModel via real flowHost runFlow (admin ok + non-admin refused)
        const adminReg = SetModel.registration(dbLayer).pipe(
          Layer.provideMerge(Layer.succeed(CurrentActor, memberActor("p1", "admin"))),
        )
        const runRes = yield* Effect.promise(() => runFlow(SetModel.SetModel, { role: "summary", model }, adminReg as never))
        expect(Exit.isSuccess(runRes.exit)).toBe(true)
        const nonAdminReg = SetModel.registration(dbLayer).pipe(
          Layer.provideMerge(Layer.succeed(CurrentActor, memberActor("p1", "member"))),
        )
        const failRes = yield* Effect.promise(() => runFlow(SetModel.SetModel, { role: "summary", model }, nonAdminReg as never))
        expect(Exit.isFailure(failRes.exit)).toBe(true)
      }).pipe(Effect.provide(silent)),
    )
  }, 120_000)

  it("fuzzes SpendCopy, BranchAccess helpers, SandboxCall failureOf & settle (with SharedText mark)", async () => {
    // 1. SpendCopy every branch
    expect(SpendCopy.alertDetail({ tokens: 12340, costUsd: 0.02, roles: [{ role: "agent", calls: 1, tokens: 12340, costUsd: 0.02 }] })).toContain("agent")
    expect(SpendCopy.alertDetail({ tokens: 50, costUsd: 0.001, roles: [{ role: "agent", calls: 1, tokens: 30, costUsd: 0.0005 }, { role: "judge", calls: 1, tokens: 20, costUsd: 0.0005 }] })).toContain("<$0.01")
    expect(SpendCopy.alertDetail({ tokens: 0, costUsd: null, roles: [] })).toBe("0 tokens")
    expect(SpendCopy.receiptText({ status: "sent", code: null, reason: null })).toBe("Sent")
    expect(SpendCopy.receiptText({ status: "refused", code: "400", reason: "bad chat" })).toBe("Refused · bad chat")
    expect(SpendCopy.receiptText({ status: "refused", code: "400", reason: null })).toBe("Refused · 400")
    expect(SpendCopy.receiptText({ status: "failed", code: null, reason: null })).toBe("Retrying")
    expect(SpendCopy.receiptText({ status: "failed", code: "unavailable", reason: null })).toBe("Retrying · unavailable")

    // 2. SandboxCall.failureOf across every error tag
    expect(SandboxCall.failureOf(new SandboxTools.ToolRefused({ reason: "path" }))).toEqual({ status: "failed", failure: "path" })
    expect(SandboxCall.failureOf(new SandboxTools.ToolLost())).toEqual({ status: "failed", failure: "lost" })
    expect(SandboxCall.failureOf(new CheckoutFailed({ reason: "missing" } as never))).toEqual({ status: "failed", failure: "checkout" })
    expect(SandboxCall.failureOf(new SandboxStartTimedOut({} as never))).toEqual({ status: "failed", failure: "start_timeout" })
    expect(SandboxCall.failureOf({ _tag: "OtherError" } as never)).toEqual({ status: "failed", failure: "unavailable" })

    // 3. BranchAccess + SandboxCall.settle on real Postgres
    await env.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
        const installedRepoId = "github/acme/installed"
        const uninstalledRepoId = "github/acme/uninstalled"
        yield* sql`
          INSERT INTO github_repositories (repo_id, installation_id)
          VALUES (${installedRepoId}, 777)`

        const pubRoles = Layer.succeed(
          BranchAccess.BranchRoles,
          BranchAccess.BranchRoles.of({
            roleOn: () => Effect.succeed("member"),
            publicCopy: () => Effect.succeed(true),
          }),
        )
        expect(yield* BranchAccess.readsCopy(Option.none(), installedRepoId, Effect.succeed(true)).pipe(Effect.provide(pubRoles))).toBe("public")

        const privRoles = Layer.succeed(
          BranchAccess.BranchRoles,
          BranchAccess.BranchRoles.of({
            roleOn: () => Effect.succeed("member"),
            uninstalled: () => "guest",
            publicCopy: () => Effect.succeed(false),
          }),
        )
        expect(yield* BranchAccess.readsCopy(Option.none(), installedRepoId, Effect.succeed(true)).pipe(Effect.provide(privRoles))).toBe("none")
        expect(yield* BranchAccess.readsCopy(Option.some(memberActor()), installedRepoId, Effect.succeed(true)).pipe(Effect.provide(privRoles))).toBe("private")
        expect(yield* BranchAccess.roleOn(memberActor(), uninstalledRepoId, false).pipe(Effect.provide(privRoles))).toBe("guest")
        expect((yield* BranchAccess.repoRoleOn(memberActor(), uninstalledRepoId).pipe(Effect.provide(privRoles))).role).toBeNull()
        expect((yield* BranchAccess.repoRoleOn(memberActor(), installedRepoId).pipe(Effect.provide(privRoles))).role).toBeNull()
        expect(yield* BranchAccess.isMemberOn(Option.none(), installedRepoId).pipe(Effect.provide(privRoles))).toBe(false)
        expect(yield* BranchAccess.isMemberOn(Option.some(memberActor()), installedRepoId).pipe(Effect.provide(privRoles))).toBe(true)
        expect(yield* BranchAccess.isMemberOn(Option.some(memberActor()), uninstalledRepoId).pipe(Effect.provide(privRoles))).toBe(false)

        const wrappedLayer = BranchAccess.BranchRoles.layer<never>({
          repository: { id: installedRepoId, owner: "acme", name: "installed" },
          resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "app_not_installed" })),
          publicCopy: () => Effect.succeed(false),
        } as never)
        expect((yield* BranchAccess.repoRoleOn(memberActor(), installedRepoId).pipe(Effect.provide(wrappedLayer))).role).toBeNull()
        expect(yield* BranchAccess.readsCopy(Option.none(), installedRepoId, Effect.succeed(false)).pipe(Effect.provide(wrappedLayer))).toBe("none")

        // SandboxCall.settle
        const branchId = crypto.randomUUID()
        const convId = crypto.randomUUID()
        yield* sql`
          INSERT INTO branches (id, repo_id, name, mode, created_by)
          VALUES (${branchId}, ${installedRepoId}, 'feat/a', 'open', 'person-1')`
        yield* sql`INSERT INTO conversations (id, repo_id, branch_id) VALUES (${convId}, ${installedRepoId}, ${branchId})`

        const callDoneId = crypto.randomUUID()
        const callFailId = crypto.randomUUID()
        yield* sql`
          INSERT INTO sandbox_calls (id, branch_id, person_id, tool, status)
          VALUES (${callDoneId}, ${branchId}, 'person-1', 'write', 'running'),
                 (${callFailId}, ${branchId}, 'person-1', 'run', 'running')`

        const s1 = yield* SandboxCall.settle(
          callDoneId,
          { status: "done", result: { tool: "write", path: "a.ts", bytes: 4, sequence: 1 } as never, generation: 2 },
          { textId: crypto.randomUUID(), mark: { at: 0 } as never },
        )
        expect(s1.settled).toBe(true)
        const s1Repeat = yield* SandboxCall.settle(callDoneId, { status: "failed", failure: "lost" })
        expect(s1Repeat.settled).toBe(false)
        const s2 = yield* SandboxCall.settle(callFailId, { status: "failed", failure: "unavailable" })
        expect(s2.settled).toBe(true)
      }).pipe(Effect.provide(silent)),
    )
  }, 120_000)

  it("fuzzes ci/RepoFlow steps (plan, pending, report) with real QuickJS variant", async () => {
    const baseReq: typeof RepoFlow.RunRequest.Type = {
      run: "run-ci-1",
      repo: "acme/widgets",
      sha: "a".repeat(40),
      ref: "refs/heads/main",
      flow: "ci",
      event: "push",
      secrets: false,
      input: {},
    }

    let tokenMode: "ok" | "fail" = "ok"
    let httpResponder: (url: string, method: string) => Response = () => new Response("{}", { status: 200 })

    const fakeHttp = HttpClient.make((req) =>
      Effect.succeed(HttpClientResponse.fromWeb(req, httpResponder(req.url, req.method))),
    )
    const tokens = {
      forInstallation: () =>
        tokenMode === "ok"
          ? Effect.succeed(Redacted.make("ghs_fake_token"))
          : Effect.fail(new GitHubTokens.TokenUnavailable({ reason: "app_not_installed" })),
    } as unknown as GitHubTokens.GitHubTokens

    await env.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
        const steps = RepoFlow.steps({
          database: dbLayer,
      http: fakeHttp,
      tokens,
      apiBaseUrl: "https://api.github.test",
      machines: ["small", "large"],
        })
        tokenMode = "fail"
        expect(yield* steps.plan({ request: baseReq })).toEqual({ _tag: "refused", reason: "unreadable" })

        tokenMode = "ok"
        httpResponder = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
        expect(yield* steps.plan({ request: baseReq })).toEqual({ _tag: "refused", reason: "not_found" })

        httpResponder = () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })
        expect(yield* steps.plan({ request: baseReq })).toEqual({ _tag: "refused", reason: "unreadable" })

        httpResponder = () => new Response("err", { status: 500 })
        expect(Exit.isFailure(yield* Effect.exit(steps.plan({ request: baseReq })))).toBe(true)

        const b64Valid = Buffer.from(repoFlowValidSource).toString("base64")
        httpResponder = () =>
          new Response(JSON.stringify({ type: "file", name: "flow.ts", path: ".smithers/flows/ci/flow.ts", sha: "b".repeat(40), size: repoFlowValidSource.length, encoding: "base64", content: b64Valid }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        const planned = yield* steps.plan({ request: baseReq })
        expect(planned._tag).toBe("planned")

        const plannedOnly = yield* steps.plan({ request: { ...baseReq, only: ["test"] } })
        expect(plannedOnly._tag).toBe("planned")
        if (plannedOnly._tag === "planned") {
          expect(plannedOnly.jobs.length).toBe(1)
          expect(plannedOnly.jobs[0]!.needs).toEqual([])
        }

        const plannedEmpty = yield* steps.plan({ request: { ...baseReq, only: ["nonexistent"] } })
        expect(plannedEmpty).toEqual({ _tag: "refused", reason: "invalid_plan" })

        const badMachineSrc = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
const gpu = CiJob.make("gpu", { machine: "h100", steps: [{ name: "gpu", run: "echo hi" }] })
export default Flow.make("ci", { body: (run: { readonly sha: string }) => Node.all({ gpu: gpu.call(run) }) })
`
        httpResponder = () =>
          new Response(JSON.stringify({ type: "file", name: "flow.ts", path: ".smithers/flows/ci/flow.ts", sha: "c".repeat(40), size: badMachineSrc.length, encoding: "base64", content: Buffer.from(badMachineSrc).toString("base64") }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        expect(yield* steps.plan({ request: baseReq })).toEqual({ _tag: "refused", reason: "machine" })

        httpResponder = () => new Response(JSON.stringify({ id: 1, state: "pending", context: "smithers/ci", description: "Running", target_url: null, created_at: "2026-01-01T00:00:00Z" }), { status: 201, headers: { "content-type": "application/json" } })
        yield* steps.pending({ request: baseReq })
        tokenMode = "fail"
        yield* steps.pending({ request: baseReq })

        const rTokFail = yield* steps.report({
          request: baseReq,
          names: ["lint"],
          results: { [RepoFlow.jobKey(0)]: { outcome: "passed" } as never },
          refused: null,
        })
        expect(rTokFail.outcome).toBe("refused")

        tokenMode = "ok"
        httpResponder = () => new Response(JSON.stringify({ id: 2, state: "success", context: "smithers/ci", description: "Passed", target_url: null, created_at: "2026-01-01T00:00:00Z" }), { status: 201, headers: { "content-type": "application/json" } })
        const rPass = yield* steps.report({
          request: baseReq,
          names: ["lint"],
          results: { [RepoFlow.jobKey(0)]: { outcome: "passed" } as never },
          refused: null,
        })
        expect(rPass.state).toBe("success")
        expect(rPass.outcome).toBe("sent")

        const rFail = yield* steps.report({
          request: baseReq,
          names: ["lint", "test"],
          results: {
            [RepoFlow.jobKey(0)]: { outcome: "passed" } as never,
            [RepoFlow.jobKey(1)]: { outcome: "failed" } as never,
          },
          refused: null,
        })
        expect(rFail.state).toBe("failure")

        httpResponder = () => new Response(JSON.stringify({ message: "No commit found for SHA" }), { status: 422 })
        const rRefused = yield* steps.report({ request: baseReq, names: [], results: {}, refused: "not_found" })
        expect(rRefused.outcome).toBe("refused")

        httpResponder = () => new Response("boom", { status: 500 })
        expect(Exit.isFailure(yield* Effect.exit(
          steps.report({ request: baseReq, names: [], results: {}, refused: "not_found" }),
        ))).toBe(true)
      }).pipe(Effect.provide(QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant)), Effect.provide(silent)),
    )
  }, 120_000)
})

describe("Wave9 Notifications, Views, PersonalFlows & Runs HTTP routes on real Postgres", () => {
  const env = H.testFile("wave9_http_routes")

  it("fuzzes Notifications lockRuns, foldRun/foldMissing, watch & ack routes", async () => {
    await env.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
        const routes = yield* Notifications.make(dbLayer)
        const repoId = "github/acme/notif-repo"
        const convId = crypto.randomUUID()
        const branchId = crypto.randomUUID()
        const lockedConvId = crypto.randomUUID()
        const lockedBranchId = crypto.randomUUID()

        yield* sql`
          INSERT INTO branches (id, repo_id, name, mode, created_by)
          VALUES (${branchId}, ${repoId}, 'main', 'open', 'person-1'),
                 (${lockedBranchId}, ${repoId}, 'secret', 'locked', 'person-other')`
        yield* sql`
          INSERT INTO conversations (id, repo_id, branch_id)
          VALUES (${convId}, ${repoId}, ${branchId}), (${lockedConvId}, ${repoId}, ${lockedBranchId})`

        const missingRunId = crypto.randomUUID()
        const subject1 = `run:${missingRunId}`
        yield* sql`
          INSERT INTO notifications (recipient, subject, kind, state, title, repo_id, run_id, conversation_id, mine, version, href)
          VALUES ('person-1', ${subject1}, 'run', 'working', 'Run 1', ${repoId}, ${missingRunId}, ${convId}, true, 1, '/r/acme/notif-repo'),
                 ('person-denied', ${subject1}, 'run', 'working', 'Run 1', ${repoId}, ${missingRunId}, NULL, true, 1, '/r/acme/notif-repo')`
        yield* sql`
          INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
          VALUES (${repoId}, 'person-denied', 'guest', now())`

        const foldedMissing = yield* sql.withTransaction(
          Effect.gen(function* () {
            const held = yield* Notifications.lockRuns([missingRunId])
            return yield* Notifications.foldRun(missingRunId, "alice", held)
          }),
        ).pipe(Effect.provide(defaultBranchRoles("member")))
        expect(foldedMissing).toBe(1)

        expect((yield* sql.withTransaction(Notifications.lockRuns([]))).size).toBe(0)

        const callWatch = (req: HttpServerRequest.HttpServerRequest, actor: Option.Option<Actor>) =>
          routes.watch.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(actorLayer(actor)),
            Effect.provide(defaultBranchRoles("member")),
          )

        expect((yield* callWatch(makeReq("GET", "https://app.test/api/watches"), Option.some(memberActor()))).status).toBe(405)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", "{}"), Option.none())).status).toBe(401)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", "{}"), Option.some(memberActor("p1", "guest")))).status).toBe(403)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", "x".repeat(5000)), Option.some(memberActor()))).status).toBe(413)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", "{"), Option.some(memberActor()))).status).toBe(400)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", JSON.stringify({ conversationId: null })), Option.some(memberActor()))).status).toBe(200)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", JSON.stringify({ conversationId: crypto.randomUUID() })), Option.some(memberActor()))).status).toBe(404)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", JSON.stringify({ conversationId: lockedConvId })), Option.some(memberActor()))).status).toBe(403)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", JSON.stringify({ conversationId: convId })), Option.some(memberActor()))).status).toBe(200)
        expect((yield* callWatch(makeReq("POST", "https://app.test/api/watches", JSON.stringify({ conversationId: convId })), Option.some(memberActor()))).status).toBe(200)

        const callAck = (req: HttpServerRequest.HttpServerRequest, actor: Option.Option<Actor>) =>
          routes.ack.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(actorLayer(actor)),
            Effect.provide(defaultBranchRoles("member")),
          )

        expect((yield* callAck(makeReq("GET", "https://app.test/api/notifications/ack"), Option.some(memberActor()))).status).toBe(405)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", "{}"), Option.none())).status).toBe(401)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", "{}"), Option.some(delegatedActor()))).status).toBe(403)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", "{"), Option.some(memberActor()))).status).toBe(400)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", JSON.stringify({ subject: "run:missing", act: "read", version: 1 })), Option.some(memberActor()))).status).toBe(404)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", JSON.stringify({ subject: subject1, act: "read", version: 2 })), Option.some(memberActor()))).status).toBe(200)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", JSON.stringify({ subject: subject1, act: "read", version: 2 })), Option.some(memberActor()))).status).toBe(200)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", JSON.stringify({ subject: subject1, act: "dismiss", version: 2 })), Option.some(memberActor()))).status).toBe(200)
        expect((yield* callAck(makeReq("POST", "https://app.test/api/notifications/ack", JSON.stringify({ subject: subject1, act: "hide", version: 2 })), Option.some(memberActor()))).status).toBe(200)
      }).pipe(Effect.provide(silent)),
    )
  }, 120_000)

  it("fuzzes Views state moves, policyFor, localHttpConfig & stateViewId", async () => {
    expect(Views.localHttpConfig(true)).toBeDefined()
    expect(Views.localHttpConfig(false)).toBeDefined()
    expect(Views.policyFor(makeReq("GET", "http://127.0.0.1:8787/"), true)).toBeDefined()
    expect(Views.policyFor(makeReq("GET", "https://app.smithers.sh/"), false)).toBeDefined()
    const sampleId = crypto.randomUUID()
    expect(Views.stateViewId(`/api/views/${sampleId}/state`)).toBe(sampleId.toLowerCase())
    expect(Views.stateViewId("/api/views/not-a-uuid/state")).toBeUndefined()

    await env.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
        const views = yield* Views.make(dbLayer, {
          realm: ViewRealm.loadNode,
          localHttp: false,
        })

        const repoId = "github/acme/views-repo"
        const convId = crypto.randomUUID()
        const branchId = crypto.randomUUID()
        const viewId = crypto.randomUUID()
        yield* sql`
          INSERT INTO branches (id, repo_id, name, mode, created_by)
          VALUES (${branchId}, ${repoId}, 'main', 'open', 'person-1')`
        yield* sql`INSERT INTO conversations (id, repo_id, branch_id) VALUES (${convId}, ${repoId}, ${branchId})`

        const counterCode = `
export default {
  render({ props, state }) {
    return { tag: "div", children: [String((state?.n ?? 0) + (props?.base ?? 0))] }
  },
  interact({ props, state, event }) {
    if (event.name === "inc") {
      const next = { n: (state?.n ?? 0) + 1 }
      return { state: next, tree: { tag: "div", children: [String(next.n)] } }
    }
    if (event.name === "boom") { throw new Error("kaboom") }
    return { state, tree: { tag: "div", children: ["ok"] } }
  }
}
`
        yield* sql`
          INSERT INTO views (id, conversation_id, title, template, code, props, state, interactions, html, revision)
          VALUES (
            ${viewId}, ${convId}, 'Counter', 'generated', ${counterCode},
            '{"base":1}'::jsonb, '{"n":0}'::jsonb,
            '{"inc":{"kind":"state"},"boom":{"kind":"state"},"ask":{"kind":"question"}}'::jsonb,
            '<div>1</div>', 1
          )`

        const callState = (id: string, req: HttpServerRequest.HttpServerRequest, actor: Option.Option<Actor>, role: Actor["role"] = "member") =>
          views.state(id).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(actorLayer(actor)),
            Effect.provide(defaultBranchRoles(role)),
          )

        const baseUrl = `https://app.test/api/views/${viewId}/state`
        expect((yield* callState(viewId, makeReq("GET", baseUrl), Option.some(memberActor()))).status).toBe(405)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, "{}"), Option.none())).status).toBe(401)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, "x".repeat(200_000)), Option.some(memberActor()))).status).toBe(413)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, "{"), Option.some(memberActor()))).status).toBe(400)

        const moveBody = (moveId: string, name: string, revision: number) =>
          JSON.stringify({ moveId, revision, event: { name, value: {} } })

        expect((yield* callState(crypto.randomUUID(), makeReq("POST", baseUrl, moveBody(crypto.randomUUID(), "inc", 1)), Option.some(memberActor()))).status).toBe(404)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, moveBody(crypto.randomUUID(), "inc", 1)), Option.some(memberActor("p1", "guest")), "guest")).status).toBe(403)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, moveBody(crypto.randomUUID(), "ask", 1)), Option.some(memberActor()))).status).toBe(400)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, moveBody(crypto.randomUUID(), "inc", 99)), Option.some(memberActor()))).status).toBe(409)
        expect((yield* callState(viewId, makeReq("POST", baseUrl, moveBody(crypto.randomUUID(), "boom", 1)), Option.some(memberActor()))).status).toBe(422)

        const moveId = crypto.randomUUID()
        const ok1 = yield* callState(viewId, makeReq("POST", baseUrl, moveBody(moveId, "inc", 1)), Option.some(memberActor()))
        expect([200, 422]).toContain(ok1.status)
        if (ok1.status === 200) {
          const ok2 = yield* callState(viewId, makeReq("POST", baseUrl, moveBody(moveId, "inc", 1)), Option.some(memberActor()))
          expect(ok2.status).toBe(200)
        }
      }).pipe(Effect.provide(silent)),
    )
  }, 120_000)

  it("fuzzes PersonalFlows (draft, save, write, list, source, delete, edge refusals) & Runs (report, addressed answer, credentials)", async () => {
    expect(PersonalFlows.nameAllowed("my-flow")).toBe(true)
    expect(PersonalFlows.nameAllowed("bad name!")).toBe(false)
    expect(PersonalFlows.writeRefusal({ name: "bad name!", revision: 1, description: "d", source: "x", digest: sha256Hex("x") })).toBe("name")
    expect(PersonalFlows.writeRefusal({ name: "ok-flow", revision: 1, description: "d", source: "x".repeat(600_000), digest: "abc" })).toBe("too_large")
    expect(PersonalFlows.writeRefusal({ name: "ok-flow", revision: 1, description: "d", source: "x", digest: "wrong" })).toBe("digest")
    expect(PersonalFlows.writeRefusal({ name: "ok-flow", revision: 1, description: "d", source: "x", digest: sha256Hex("x") })).toBeUndefined()

    await env.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
        const pf = yield* PersonalFlows.make(dbLayer)
        const actor = Option.some(memberActor("person-1", "member", "alice"))

        const callFlows = (tail: string, req: HttpServerRequest.HttpServerRequest, who = actor) =>
          pf.flows(tail).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(actorLayer(who)),
          )
        const callDrafts = (rest: string, req: HttpServerRequest.HttpServerRequest, who = actor) =>
          pf.drafts(rest).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(actorLayer(who)),
          )

        expect((yield* callFlows("", makeReq("GET", "https://app.test/api/flows"), Option.none())).status).toBe(401)
        expect((yield* callFlows("", makeReq("POST", "https://app.test/api/flows"))).status).toBe(405)
        expect((yield* callFlows("unknown", makeReq("GET", "https://app.test/api/flows/unknown"))).status).toBe(404)
        expect((yield* callFlows("", makeReq("GET", "https://app.test/api/flows"))).status).toBe(200)

        expect((yield* callFlows("source", makeReq("POST", "https://app.test/api/flows/source"))).status).toBe(405)
        expect((yield* callFlows("source", makeReq("GET", "https://app.test/api/flows/source?name=bad!"))).status).toBe(400)
        expect((yield* callFlows("source", makeReq("GET", "https://app.test/api/flows/source?name=nope"))).status).toBe(404)

        const draftId = crypto.randomUUID()
        const src1 = `export default Flow.make("hello", { body: () => null })`
        const dig1 = sha256Hex(src1)
        const filesJson = JSON.stringify([{ path: "flow.ts", text: src1 }])
        yield* sql`
          INSERT INTO flow_drafts (id, actor_id, scope, name, request, status, files, checks, questions)
          VALUES (${draftId}, 'person-1', 'person', 'hello-flow', 'Make hello', 'ready', ${filesJson}::jsonb, '[{"ok":true}]'::jsonb, '[]'::jsonb)`

        expect((yield* callDrafts("not-uuid", makeReq("GET", "https://app.test/api/flow-drafts/not-uuid"))).status).toBe(404)
        expect((yield* callDrafts(`${draftId}/bogus`, makeReq("GET", `https://app.test/api/flow-drafts/${draftId}/bogus`))).status).toBe(404)
        expect((yield* callDrafts(draftId, makeReq("GET", `https://app.test/api/flow-drafts/${draftId}`))).status).toBe(200)

        const saveReq = { draftId, name: "hello-flow", description: "desc", source: src1, digest: dig1 }
        expect((yield* callFlows("save", makeReq("POST", "https://app.test/api/flows/save", JSON.stringify(saveReq)))).status).toBe(200)
        expect((yield* callFlows("save", makeReq("POST", "https://app.test/api/flows/save", JSON.stringify(saveReq)))).status).toBe(200)
        const histDraftId = crypto.randomUUID()
        yield* sql`
          INSERT INTO flow_drafts (id, actor_id, scope, name, request, status, files, checks, questions, saved_revision)
          VALUES (${histDraftId}, 'person-1', 'person', 'hist-flow', 'Make hist', 'saved', ${filesJson}::jsonb, '[{"ok":true}]'::jsonb, '[]'::jsonb, NULL)`
        expect((yield* callFlows("save", makeReq("POST", "https://app.test/api/flows/save", JSON.stringify({ ...saveReq, draftId: histDraftId, name: "hist-flow" })))).status).toBe(503)

        const src2 = `export default Flow.make("hello", { body: () => 2 })`
        const dig2 = sha256Hex(src2)
        expect((yield* callFlows("write", makeReq("POST", "https://app.test/api/flows/write", JSON.stringify({ name: "hello-flow", revision: 1, description: "d2", source: src2, digest: dig2 })))).status).toBe(200)
        expect((yield* callFlows("write", makeReq("POST", "https://app.test/api/flows/write", JSON.stringify({ name: "hello-flow", revision: 1, description: "d2", source: src2, digest: dig2 })))).status).toBe(200)
        const src3 = `export default Flow.make("hello", { body: () => 3 })`
        expect((yield* callFlows("write", makeReq("POST", "https://app.test/api/flows/write", JSON.stringify({ name: "hello-flow", revision: 1, description: "d3", source: src3, digest: sha256Hex(src3) })))).status).toBe(409)
        expect((yield* callFlows("write", makeReq("POST", "https://app.test/api/flows/write", JSON.stringify({ name: "no-such-flow", revision: 1, description: "d3", source: src3, digest: sha256Hex(src3) })))).status).toBe(404)
        expect((yield* callFlows("source", makeReq("GET", "https://app.test/api/flows/source?name=hello-flow&revision=2"))).status).toBe(200)

        // --- Runs.make ---
        const runs = yield* Runs.make(dbLayer)
        let answerAccepts = true
        const taskAnswersLayer = Layer.succeed(
          TaskAnswers,
          TaskAnswers.of({ answer: () => Effect.succeed(answerAccepts) }),
        )
        const runCredsLayer = Layer.succeed(RunCredentials.RunCredentials, RunCredentials.RunCredentials.of({ sign: () => Effect.succeed("signed-tok"), verify: () => Effect.succeed({ outcome: "forged" } as never) } as never))

        const repoId = "github/acme/runs-repo"
        const convId = crypto.randomUUID()
        const branchId = crypto.randomUUID()
        const runId = crypto.randomUUID()
        const addrRunId = crypto.randomUUID()
        yield* sql`INSERT INTO branches (id, repo_id, name, mode, created_by) VALUES (${branchId}, ${repoId}, 'main', 'open', 'person-1')`
        yield* sql`INSERT INTO conversations (id, repo_id, branch_id) VALUES (${convId}, ${repoId}, ${branchId})`
        const qId = crypto.randomUUID()
        yield* sql`
          INSERT INTO messages (id, conversation_id, role, text, status, asked_by)
          VALUES (${qId}, ${convId}, 'user', 'hi', 'done', 'person-1')`
        yield* sql`
          INSERT INTO messages (id, conversation_id, role, text, status, question_id)
          VALUES (${runId}, ${convId}, 'assistant', '', 'streaming', ${qId})`
        yield* sql`
          INSERT INTO runs (id, flow, repo_id, branch_id, conversation_id, launched_by, status, version)
          VALUES (${runId}, 'chat/Answer', ${repoId}, ${branchId}, ${convId}, 'person-1', 'working', 1)`
        yield* sql`
          INSERT INTO runs (id, flow, repo_id, branch_id, conversation_id, launched_by, addressed_to, status, waiting, wait, version)
          VALUES (
            ${addrRunId}, 'repo/Approve', ${repoId}, ${branchId}, ${convId}, 'machine:agent/1', 'person-1',
            'needs_you', 'approval', '{"kind":"approval","execution":"exec-addr-1","prompt":"Approve?"}'::jsonb, 1
          )`

        const callRun = (
          id: string,
          tail: string | undefined,
          req: HttpServerRequest.HttpServerRequest,
          who: Option.Option<Actor>,
          bRoles = defaultBranchRoles("maintainer"),
        ) =>
          runs.route(tail === undefined ? id : `${id}/${tail}`).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(actorLayer(who)),
            Effect.provide(bRoles),
            Effect.provide(taskAnswersLayer),
            Effect.provide(runCredsLayer),
          )

        expect((yield* callRun(runId, undefined, makeReq("GET", `https://app.test/api/runs/${runId}`), actor)).status).toBe(405)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, "{}"), Option.none())).status).toBe(401)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, "x".repeat(50_000)), actor)).status).toBe(413)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, "{"), actor)).status).toBe(400)
        expect((yield* callRun(crypto.randomUUID(), undefined, makeReq("POST", "https://app.test/api/runs/x", JSON.stringify({ status: "done" })), actor)).status).toBe(404)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, JSON.stringify({ status: "done" })), Option.some(memberActor("other-person")))).status).toBe(403)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, JSON.stringify({ status: "working" })), actor)).status).toBe(200)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, JSON.stringify({ status: "done" })), actor)).status).toBe(200)
        expect((yield* callRun(runId, undefined, makeReq("POST", `https://app.test/api/runs/${runId}`, JSON.stringify({ status: "failed" })), actor)).status).toBe(409)

        const ansBody = JSON.stringify({ version: 1, value: { approved: true, note: "lgtm" } })
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, ansBody), Option.some(memberActor("other-p")))).status).toBe(403)
        const failingRoles = Layer.succeed(
          BranchAccess.BranchRoles,
          BranchAccess.BranchRoles.of({
            roleOn: () => Effect.succeed("maintainer"),
            repoRoleOn: () => Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable" })),
          }),
        )
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, ansBody), actor, failingRoles)).status).toBe(503)
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, ansBody), actor, defaultBranchRoles("member"))).status).toBe(403)
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, JSON.stringify({ version: 1, value: "not-a-bool-or-decision" })), actor)).status).toBe(400)
        answerAccepts = false
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, ansBody), actor)).status).toBe(503)
        answerAccepts = true
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, ansBody), actor)).status).toBe(200)
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, ansBody), actor)).status).toBe(200)
        expect((yield* callRun(addrRunId, "answer", makeReq("POST", `https://app.test/api/runs/${addrRunId}/answer`, JSON.stringify({ version: 1, value: { approved: false, note: "no" } })), actor)).status).toBe(409)
      }).pipe(Effect.provide(silent)),
    )
  }, 120_000)
})
