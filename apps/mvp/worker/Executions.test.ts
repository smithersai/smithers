import * as Cloudflare from "@alchemy.run/cloudflare"
import { GitHub } from "@smthrs/integrations"
import { ExecutionObject } from "@smthrs/platform-cloudflare"
import { RuntimeContext } from "alchemy"
import { encodeRpcError, ErrorTag } from "alchemy/Rpc"
import { ConfigProvider, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { generateKeyPairSync } from "node:crypto"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { applyExecutionId } from "../src/features/issues/contract.ts"
import { keyTail } from "../src/features/personal-model/contract.ts"
import { todoExecutionId } from "../src/features/pulls/contract.ts"
import * as Conversations from "./branch/Conversations.vibe"
import { type ToolOutcome } from "./branch/Machines.vibe"
import { GateObject, SandboxObject } from "./BranchSandboxes.vibe"
import { Tick } from "./ci/Cron.vibe"
import * as ExecutionHost from "./ExecutionHost.vibe"
import * as Executions from "./Executions.vibe"
import { ReviewRun } from "./flows/Checks.vibe"
import { Pause } from "./flows/Pause.vibe"
import { RecheckRole, recheckExecutionId } from "./flows/RecheckRole.vibe"
import * as RedactFeed from "./flows/RedactFeed.vibe"
import { SandboxCall } from "./flows/SandboxCall.vibe"
import { TerminalOpen } from "./flows/TerminalOpen.vibe"
import * as Todo from "./flows/Todo.vibe"
import * as TodoDrop from "./flows/TodoDrop.vibe"
import { pullClosed } from "./flows/TodoWait.vibe"
import * as GitHubApply from "./github/Apply.vibe"
import * as GitHubStore from "./github/Store.vibe"
import { TriageRun } from "./github/Triage.vibe"
import * as TriageStore from "./github/TriageStore.vibe"
import { Write } from "./github/Write.vibe"
import { sealContext } from "./personal/Models.vibe"
import * as PersonalStore from "./personal/Store.vibe"
import { KEY, VALUE } from "./personal/test/harness.ts"
import { OPENAI_ORIGIN, scriptedProvider } from "./personal/test/provider.ts"
import { boxId } from "./runners/Overflow.vibe"
import { SecretKeys } from "./secrets/Keys.vibe"
import * as SessionKeys from "./SessionKeys.vibe"
import * as SessionStore from "./SessionStore.vibe"
import { APP_ID, appKey, BOT_LOGIN, SCRIPTED_API, scriptedGitHub } from "./github/test/scriptedGitHub.ts"
import * as Stack from "./stack/Stack.vibe"
import { connection, objectRegistration, objectRuntime, unusedDatabase } from "./test/durableObject.ts"
import { memory } from "./test/executions.ts"

const withRuntime = Effect.provideService(RuntimeContext, objectRuntime)

const gateToolResult = {
  tool: "read", path: "README.md", content: "fixture", bytes: 7, truncated: false,
} as const

test("starts the encoded flow on its named object with the captured runtime", () =>
  Effect.runPromise(Effect.gen(function* () {
    const { storage, alarm } = memory()
    const starter = yield* Executions.starter({
      getByName: (id) => ({
        start: (intent) => Effect.gen(function* () {
          expect(id).toBe("probe")
          expect(yield* RuntimeContext).toBe(objectRuntime)
          yield* ExecutionHost.recordStart(storage, intent)
        }),
      }),
    }).pipe(withRuntime)
    const options = { executionId: "probe", payload: { label: "pause", pauseMs: 10 } }
    yield* starter.start(Pause, options)
    expect(alarm()).not.toBeNull()
    yield* starter.start(Pause, options)
    const conflict = yield* Effect.flip(starter.start(Pause, { ...options, payload: { label: "different", pauseMs: 10 } }))
    expect(conflict).toHaveProperty("_tag", "@smthrs/mvp/flows/StartConflict")
    const badPayload = yield* Effect.flip(starter.start(Pause, { ...options, payload: null }))
    expect(badPayload).toHaveProperty("_tag", "@smthrs/mvp/flows/StartUnavailable")
  })))

test("forwards the answer result and maps a Durable Object failure to AnswerUnavailable", () =>
  Effect.runPromise(Effect.gen(function* () {
    const answerer = yield* Executions.answerer({
      getByName: (id) => ({
        answer: (task, value) => Effect.gen(function* () {
          expect(yield* RuntimeContext).toBe(objectRuntime)
          expect([task, value]).toEqual(["approval", true])
          if (id === "offline") return yield* Effect.die(new Error("object unavailable"))
          return id === "parked"
        }),
      }),
    }).pipe(withRuntime)
    expect(yield* answerer.answer("parked", "approval", true)).toBe(true)
    expect(yield* answerer.answer("settled", "approval", true)).toBe(false)
    expect(yield* Effect.flip(answerer.answer("offline", "approval", true))).toHaveProperty(
      "_tag", "@smthrs/mvp/flows/AnswerUnavailable",
    )
  })))

test.each([false, true])("the Alchemy object drives and settles executions (configured: %s)", { timeout: 120_000 }, async (configured) => {
  const github = scriptedGitHub("octo", "widgets")
  const sessionSecret = "s".repeat(64)
  const provider = scriptedProvider({ status: 400, error: { type: "invalid_request_error", code: "invalid_request" } })
  const githubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const { origin } = new URL(request.url)
    if (origin === OPENAI_ORIGIN) return provider.fetch(request)
    if (origin !== SCRIPTED_API) throw new Error(`unexpected request to ${origin}`)
    const outbound = HttpClientRequest.fromWeb(request)
    const buffered = request.body === null ? outbound : HttpClientRequest.bodyUint8Array(
      outbound, new Uint8Array(await request.arrayBuffer()), request.headers.get("content-type") ?? undefined,
    )
    return Effect.runPromise(github.http.execute(buffered).pipe(
      Effect.map((response) => Option.getOrThrow(HttpClientResponse.toWeb(response))),
    ))
  }
  const settings: Record<string, string> = configured ? {
    GITHUB_APP_ID: APP_ID,
    GITHUB_API_URL: SCRIPTED_API,
    GITHUB_APP_PRIVATE_KEY: Redacted.value(await appKey()),
    GITHUB_APP_CLIENT_ID: "fixture-client",
    GITHUB_APP_CLIENT_SECRET: "fixture-client-secret",
    SESSION_SECRET: sessionSecret,
    SECRETS_KEY: Redacted.value(KEY),
    GATE_IMAGE: "fixture/gate:local",
    CODE_STORAGE_ORG: "octo",
    CODE_STORAGE_KEY: generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    }).privateKey,
    HYPERDRIVE_METRICS_TOKEN: "fixture-token",
    CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  } : {}
  const { exports, services } = objectRegistration("FlowExecution", settings)
  const started: Array<ExecutionObject.Intent> = []
  const opened: Array<string> = []
  const cancelled: Array<string> = []
  const woken: Array<string> = []
  const signalled: Array<{ readonly id: string; readonly name: string }> = []
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scratch = yield* TestDatabase.Scratch
    const url = yield* TestDatabase.serverUrl
    url.searchParams.set("options", `-c search_path=${scratch.name}`)
    const connectionString = Effect.succeed(Redacted.make(url.toString()))
    const connect = () => Effect.map(unusedDatabase(), (binding) => ({ ...binding, connectionString }))
    const namespaces = yield* Layer.build(Layer.merge(
      SandboxObject.make(Effect.succeed(Effect.die("unexpected sandbox construction"))),
      GateObject.make(Effect.succeed(Effect.die("unexpected gate construction"))),
    ))
    yield* Layer.build(Executions.live(connection, {
      homeRepository: { owner: "octo", name: "widgets" },
      repositories: new Set(),
      ...(configured ? { repoFlows: true, spendAlerts: false, hostedModel: false } : {}),
    })).pipe(Effect.provideContext(namespaces))
    const entry = exports.get("FlowExecution") as {
      readonly constructor: Effect.Effect<Effect.Effect<Executions.FlowExecutionShape, never, RuntimeContext>, never,
        Cloudflare.DurableObjectState | SandboxObject | GateObject>
    }
    expect(entry).toHaveProperty("kind", "durableObject")
    const object = (executionId: string, driveSeconds?: number) => Effect.gen(function* () {
      const { storage, alarm } = memory()
      const state = { id: { toString: () => executionId }, storage } as unknown as Cloudflare.DurableObjectState["Service"]
      const constructor = driveSeconds === undefined ? entry.constructor : entry.constructor.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
          ALCHEMY_PHASE: "runtime",
          GITHUB_REPOSITORY: "octo/widgets",
          ...settings,
          EXECUTION_DRIVE_BUDGET_SECONDS: String(driveSeconds),
        })),
      )
      const initialize = yield* constructor.pipe(
        Effect.provideContext(namespaces),
        Effect.provideService(Cloudflare.DurableObjectState, state),
        Effect.provideService(Cloudflare.Hyperdrive.Connect, connect),
      )
      return { handlers: yield* initialize, alarm, storage }
    })
    const executionId = crypto.randomUUID()
    const { handlers, alarm } = yield* object(executionId)
    expect(yield* handlers.repositoryRun()).toBeNull()
    expect(yield* handlers.wake()).toBe(false)
    expect(yield* handlers.answer("approval", true)).toBe(false)
    yield* handlers.signal("delivery")
    yield* Effect.gen(function* () {
      yield* TestClock.setTime(60_000)
      yield* handlers.alarm()
      yield* handlers.advance()
      expect(started).toHaveLength(configured ? 4 : 3)
      expect(new Set(started.map((intent) => intent.flow)).size).toBe(started.length)
    }).pipe(Effect.provide(TestClock.layer()))
    const intent = yield* ExecutionObject.intent(Pause, {
      executionId, payload: { label: "probe", pauseMs: 1 },
    })
    yield* handlers.start(intent)
    expect(yield* handlers.repositoryRun()).toBeNull()
    expect(yield* handlers.wake()).toBe(true)
    const sql = yield* SqlClient.SqlClient
    if (configured) {
      yield* handlers.advance()
    } else {
      // Leave the engine available while the app projection fails with a real SQL error.
      yield* sql`ALTER TABLE runs RENAME TO unavailable_runs`
      yield* handlers.advance().pipe(Effect.ensuring(sql`ALTER TABLE unavailable_runs RENAME TO runs`.pipe(Effect.orDie)))
      const retryAt = alarm()
      if (retryAt === null) throw new Error("settlement retry was not scheduled")
      expect(retryAt).toBeLessThan(Date.now() + ExecutionHost.settledRetentionMs - 60_000)
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(retryAt)
        yield* handlers.alarm()
      }).pipe(Effect.provide(TestClock.layer()))
    }
    const [run] = yield* sql<{ readonly status: string }>`SELECT status FROM smithers_flows.flows_runs WHERE run_id = ${executionId}`
    expect(run?.status).toBe("completed")
    expect(alarm()).toBeGreaterThan(Date.now() + ExecutionHost.settledRetentionMs - 60_000)
    yield* handlers.cancel()

    if (!configured) {
      const barrier = crypto.randomUUID()
      yield* sql`INSERT INTO feed_barriers (id, release, confirmed_by) VALUES (${barrier}, ${"abc123"}, ${"fixture"})`
      const firstRound = RedactFeed.executionIdOf(barrier)
      const { handlers: redaction } = yield* object(firstRound)
      yield* redaction.start(yield* ExecutionObject.intent(RedactFeed.RedactFeed, {
        executionId: firstRound, payload: RedactFeed.startOf(barrier),
      }))
      yield* redaction.alarm()
      const next = started.find((intent) => intent.flow === RedactFeed.RedactFeed._tag)
      if (next === undefined) throw new Error("redaction successor did not start")
      expect(next.executionId).not.toBe(firstRound)
      const [receipt] = yield* sql`
        SELECT current_execution, current_round FROM feed_barriers WHERE id = ${barrier}`
      expect(receipt).toEqual({ current_execution: next.executionId, current_round: next.payload })
    }

    const { branch } = yield* Conversations.track("github/octo/widgets", "test-branch", "open", "a".repeat(40))
    const ownerId = "person-owner"
    const target = { branchId: branch.branchId, owner: "octo", name: "widgets", branch: "test-branch" }
    if (configured) {
      const applyDelivery = (event: string, number: number) => Effect.gen(function* () {
        const deliveryId = crypto.randomUUID()
        const executionId = applyExecutionId(deliveryId)
        const { handlers: delivery } = yield* object(executionId)
        yield* delivery.start(yield* ExecutionObject.intent(GitHubApply.Apply, {
          executionId, payload: { deliveryId, repo: "octo/widgets", number, event },
        }))
        yield* delivery.alarm()
        const [run] = yield* sql<{ readonly status: string }>`SELECT status FROM smithers_flows.flows_runs WHERE run_id = ${executionId}`
        expect(run?.status).toBe("completed")
        return deliveryId
      })
      const parent = github.open("Parent", null)
      const child = github.open("Child", null)
      github.setParent(child.number, { owner: "octo", name: "widgets", number: parent.number })
      const childDelivery = yield* applyDelivery("issues", child.number)
      const parentDelivery = `${childDelivery}:github/octo/widgets#${parent.number}`
      expect(started).toContainEqual(expect.objectContaining({
        flow: GitHubApply.Apply._tag,
        executionId: applyExecutionId(parentDelivery),
        payload: { deliveryId: parentDelivery, repo: "octo/widgets", number: parent.number, event: "issues" },
      }))

      yield* TriageStore.enable("github/octo/widgets", { actorId: ownerId, login: ownerId, dailyTokens: 1_000 })
      const triageId = crypto.randomUUID()
      const { handlers: triage } = yield* object(triageId)
      yield* triage.start(yield* ExecutionObject.intent(TriageRun, {
        executionId: triageId, payload: { repo: "octo/widgets", number: child.number, trigger: "opened", key: triageId },
      }))
      yield* triage.alarm()
      expect(yield* sql`SELECT decision, decided_by FROM triage_decisions WHERE run_id = ${triageId}`).toEqual([
        { decision: "abstain", decided_by: ownerId },
      ])

      const sessionId = crypto.randomUUID()
      const personId = yield* SessionStore.upsertPerson({ id: crypto.randomUUID(), githubId: 11, login: "writer" })
      const keys = yield* SessionKeys.make(Redacted.make(sessionSecret))
      const access = yield* keys.seal(github.userToken("writer"), { id: sessionId, name: "github_access", version: 1 })
      yield* SessionStore.createSession({
        id: sessionId, tokenDigest: crypto.randomUUID(), personId, role: "member",
        roleGeneration: yield* SessionStore.roleObservation,
        access, accessExpiresAt: Date.now() - 1, refresh: null, refreshDigest: null, maxAgeSeconds: 3_600,
      })
      const writer = yield* GitHubStore.sessionToken(sessionId)
      if (Option.isNone(writer)) throw new Error("writer session is missing")
      const renewal = recheckExecutionId(sessionId, writer.value.roleCheckedAt)
      for (const body of ["Refresh the token", "Retry after the object rejects renewal"]) {
        const writeId = crypto.randomUUID()
        yield* GitHubStore.insertWrite({
          id: writeId, repoId: "github/octo/widgets", actorId: personId, sessionId, via: "person",
          payload: { op: "issue/comment", number: child.number, body }, payloadHash: writeId.replaceAll("-", "").repeat(2),
        })
        const { handlers: write } = yield* object(writeId, 3)
        yield* write.start(yield* ExecutionObject.intent(Write, { executionId: writeId, payload: { writeId } }))
        yield* write.alarm()
      }
      const renewals = started.filter((intent) => intent.flow === RecheckRole._tag)
      expect(renewals.length).toBeGreaterThanOrEqual(2)
      expect(renewals.every((intent) => intent.executionId === renewal && JSON.stringify(intent.payload) === JSON.stringify({ sessionId }))).toBe(true)
      expect(github.seen("POST", /\/issues\/\d+\/comments$/)).toHaveLength(0)

      github.push("todo-branch", { "work.txt": "change" })
      const pull = github.openPull("todo-branch")
      github.close(pull.number)
      const apply = (op: Parameters<typeof Stack.apply>[0]["op"]) => Stack.apply({
        opId: crypto.randomUUID(), repoId: "github/octo/widgets", actor: { id: ownerId, login: ownerId }, via: "person", op,
      }, { runs: true })
      const commit = (title: string) => Effect.gen(function* () {
        const result = yield* apply({ kind: "commit", title, prompt: title, acceptance: [] })
        if (result.kind !== "applied" || result.receipt.starts[0] === undefined) throw new Error(`TODO ${title} was not admitted`)
        return result.receipt.starts[0]
      })
      yield* apply({ kind: "configure", lanes: 2, maxOpen: 50, base: "independent" })
      const { attemptId, todoId, number } = yield* commit("Close pull")
      const runId = todoExecutionId(attemptId)
      yield* sql`UPDATE todos SET pr_number = ${pull.number}, run_id = ${runId} WHERE id = ${todoId}`
      yield* sql`UPDATE todo_attempts SET pr_number = ${pull.number} WHERE id = ${attemptId}`
      yield* applyDelivery("pull_request", pull.number)
      expect(signalled).toContainEqual({ id: runId, name: pullClosed(pull.number).name })
      expect(started).toContainEqual(expect.objectContaining({
        executionId: `todo-closed:${attemptId}`,
        payload: { attemptId, todoId, baseClosed: true },
      }))

      const dependent = yield* commit("Dependent")
      yield* apply({ kind: "commit", title: "Waiting", prompt: "Waiting", acceptance: [] })
      yield* sql`UPDATE todo_attempts SET branch = ${"todo-branch"} WHERE id = ${attemptId}`
      yield* sql`UPDATE todos SET branch = ${"dependent"}, base_ref = ${"todo-branch"} WHERE id = ${dependent.todoId}`
      const invalidation = started.find((intent) => intent.executionId === `todo-closed:${attemptId}`)
      if (invalidation === undefined) throw new Error("invalidation intent was not recorded")
      const { handlers: invalidate } = yield* object(invalidation.executionId)
      yield* invalidate.start(invalidation)
      yield* invalidate.alarm()
      expect(cancelled).toContain(todoExecutionId(dependent.attemptId))
      expect(started).toContainEqual(expect.objectContaining({
        flow: Todo.Todo._tag, payload: expect.objectContaining({ number: dependent.number + 1 }),
      }))

      const coding = started.find((intent) => intent.flow === Todo.Todo._tag)
      if (coding === undefined) throw new Error("released TODO did not start")
      const { handlers: code } = yield* object(coding.executionId, 4)
      yield* code.start(coding)
      yield* code.alarm()
      const routeErrors = yield* sql<{ readonly error: string }>`
        SELECT error_json AS error FROM smithers_flows.flows_attempts
        WHERE run_id = ${coding.executionId} AND error_json IS NOT NULL`
      expect(routeErrors.map(({ error }) => error)).toContainEqual(expect.stringContaining("@smthrs/mvp/todo/NoSeat"))

      yield* apply({ kind: "drop", number })
      yield* sql`UPDATE todos SET pr_number = NULL, head_sha = NULL WHERE id = ${todoId}`
      const unreported = github.openPull("todo-branch")
      const issue = github.issues.get(unreported.number)
      if (issue === undefined) throw new Error("scripted pull is missing")
      issue.body = GitHub.Issues.withWriteMarker("Unreported changes", Todo.pullKeyOf(attemptId))
      const cleanupId = `todo-drop:${attemptId}`
      const { handlers: cleanup } = yield* object(cleanupId)
      yield* cleanup.start(yield* ExecutionObject.intent(TodoDrop.Drop, { executionId: cleanupId, payload: { attemptId, todoId } }))
      yield* cleanup.alarm()
      expect(issue.state).toBe("closed")

      yield* apply({ kind: "configure", lanes: 4, maxOpen: 50, base: "independent" })
      const modelKeys = Option.getOrThrow(yield* Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layer(KEY))))
      const modelKey = yield* modelKeys.cipher.seal(Redacted.make(VALUE), sealContext(personId, modelKeys.version))
      const connectionId = crypto.randomUUID()
      yield* PersonalStore.put({
        personId,
        connections: [{
          id: connectionId, kind: "api_key", active: true, protocol: "openai-chat", baseUrl: OPENAI_ORIGIN,
          models: { fast: "fixture-coding-model" },
          sealed: { ...modelKey, keyVersion: modelKeys.version, keyLast4: keyTail(VALUE) },
        }],
        invocationKey: crypto.randomUUID(),
      })
      for (const hasOwner of [true, false]) {
        const admitted = yield* Stack.apply({
          opId: crypto.randomUUID(), repoId: "github/octo/widgets", actor: { id: personId, login: "writer" }, via: "person",
          op: { kind: "commit", title: "Inspect the model seat", prompt: "Inspect", acceptance: [] },
        }, { runs: true })
        if (admitted.kind !== "applied" || admitted.receipt.starts[0] === undefined) throw new Error("model TODO was not admitted")
        const payload = admitted.receipt.starts[0]
        // An intent can outlive its execution association. Its model call must fail closed when the owner is absent.
        const executionId = hasOwner ? todoExecutionId(payload.attemptId) : `legacy-todo:${payload.attemptId}`
        const initialRequests = provider.seen.length
        const { handlers: model } = yield* object(executionId, 6)
        yield* model.start(yield* ExecutionObject.intent(Todo.Todo, { executionId, payload }))
        yield* model.alarm()
        if (hasOwner) {
          expect(provider.seen.length).toBeGreaterThan(initialRequests)
          expect(provider.seen.at(-1)?.body.model).toBe("fixture-coding-model")
        } else {
          expect(provider.seen).toHaveLength(initialRequests)
        }
      }
      yield* sql`
        INSERT INTO agents (repo_id, name, profile, coding, updated_by)
        VALUES (${"github/octo/widgets"}, ${"fixture-agent"}, ${"fixture"}, true, ${personId})`
      yield* sql`
        INSERT INTO repo_overflow
          (repo_id, person_id, connection_id, origin, profile, argv, labels, min_queued_seconds, capacity,
           token_ciphertext, token_nonce, key_version, updated_by)
        VALUES (${"github/octo/widgets"}, ${personId}, ${connectionId}, ${OPENAI_ORIGIN}, ${"fixture"},
          ${JSON.stringify(["fixture-agent"])}::jsonb, ARRAY[]::text[], 0, 1,
          ${modelKey.ciphertext}, ${modelKey.nonce}, ${modelKeys.version}, ${personId})`
      const overflowAttempt = yield* commit("Wait for the overflow runner")
      const overflowId = todoExecutionId(overflowAttempt.attemptId)
      const { handlers: overflow } = yield* object(overflowId, 6)
      yield* overflow.start(yield* ExecutionObject.intent(Todo.Todo, { executionId: overflowId, payload: overflowAttempt }))
      yield* overflow.alarm()
      const session = started.find((intent) => intent.flow === "agent/Session")
      if (session === undefined) throw new Error("external agent session was not routed")
      const { handlers: agent } = yield* object(session.executionId, 6)
      yield* agent.start(session)
      yield* agent.alarm()
      const probe = started.find((intent) => intent.flow === "agent/Session/observe")
      if (probe === undefined) throw new Error("external agent did not route its queued-job probe")
      const { handlers: observer } = yield* object(probe.executionId, 6)
      yield* observer.start(probe)
      yield* observer.alarm()
      expect(started).toContainEqual(expect.objectContaining({
        flow: "sandbox/Keep", payload: { branchId: boxId("github/octo/widgets"), generation: 7 },
      }))

      const baseSha = github.refs.get("main")
      if (baseSha === undefined) throw new Error("scripted default branch is missing")
      const reviewBranch = "smithers/t1-review"
      const reviewSha = github.push(reviewBranch, { "src/review.ts": "export const reviewed = true" })
      const reviewPull = github.openPull(reviewBranch, "Review this change", BOT_LOGIN)
      const reviewId = crypto.randomUUID()
      const { handlers: review } = yield* object(reviewId)
      yield* review.start(yield* ExecutionObject.intent(ReviewRun, {
        executionId: reviewId, payload: {
          repoId: "github/octo/widgets", sha: reviewSha, baseSha, prNumber: reviewPull.number,
          attemptId: crypto.randomUUID(), branch: reviewBranch, ownerId: personId,
        },
      }))
      yield* review.alarm()
      const reviews = started.filter((intent) => intent.flow.startsWith("smithers-review/"))
      const seen = new Set<string>()
      for (const intent of reviews) {
        if (seen.has(intent.executionId)) continue
        seen.add(intent.executionId)
        const { handlers: round } = yield* object(intent.executionId)
        yield* round.start(intent)
        yield* round.alarm()
        reviews.push(...started.filter((next) => next.flow.startsWith("smithers-review/") && !seen.has(next.executionId)))
      }
      expect(seen.size).toBeGreaterThan(0)
      expect(woken).toContain(reviewId)
      yield* review.alarm()
      expect(github.shownStatuses(reviewSha)).toMatchObject({ "smithers/review": "failure" })

      const tickId = crypto.randomUUID()
      const { handlers: ticker } = yield* object(tickId)
      yield* ticker.start(yield* ExecutionObject.intent(Tick, { executionId: tickId, payload: { from: 60_000, until: 120_000 } }))
      yield* ticker.alarm()
      const [tick] = yield* sql<{ readonly status: string }>`SELECT status FROM smithers_flows.flows_runs WHERE run_id = ${tickId}`
      expect(tick?.status).toBe("completed")

      const callId = crypto.randomUUID()
      yield* sql`INSERT INTO sandbox_calls (id, branch_id, person_id, tool) VALUES (${callId}, ${branch.branchId}, ${ownerId}, 'read')`
      const { handlers: call } = yield* object(callId)
      yield* call.start(yield* ExecutionObject.intent(SandboxCall, {
        executionId: callId,
        payload: { callId, ownerId, branch: { ...target, machine: "gate" }, call: { tool: "read", path: "README.md" } },
      }))
      yield* call.alarm()
      const [tool] = yield* sql<{ readonly status: string; readonly result: unknown }>`SELECT status, result FROM sandbox_calls WHERE id = ${callId}`
      expect(tool).toMatchObject({ status: "done", result: gateToolResult })
      expect(started).toContainEqual(expect.objectContaining({
        flow: "sandbox/Keep", payload: { branchId: branch.branchId, generation: 8, machine: "gate" },
      }))
    } else {
      const terminalId = crypto.randomUUID()
      yield* sql`
        INSERT INTO terminal_sessions (id, branch_id, owner_id, owner_login, owner_role, status)
        VALUES (${terminalId}, ${branch.branchId}, ${ownerId}, ${ownerId}, 'member', 'opening')`
      const openId = crypto.randomUUID()
      const { handlers: terminal } = yield* object(openId)
      yield* terminal.start(yield* ExecutionObject.intent(TerminalOpen, {
        executionId: openId,
        payload: {
          terminalId, ownerId,
          branch: target,
        },
      }))
      yield* terminal.alarm()
      const [session] = yield* sql<{ readonly status: string }>`SELECT status FROM terminal_sessions WHERE id = ${terminalId}`
      expect(session?.status).toBe("open")
      expect(opened).toEqual([terminalId])
      expect(started).toContainEqual(expect.objectContaining({
        flow: "sandbox/Keep", payload: { branchId: branch.branchId, generation: 7 },
      }))

      const stack = { repoId: "github/octo/widgets", actor: { id: ownerId, login: ownerId }, via: "person" as const }
      const apply = (op: Parameters<typeof Stack.apply>[0]["op"]) =>
        Stack.apply({ ...stack, op, opId: crypto.randomUUID() }, { runs: true })
      yield* apply({ kind: "configure", lanes: 1, maxOpen: 50, base: "independent" })
      const first = yield* apply({ kind: "commit", title: "First", prompt: "First", acceptance: [] })
      yield* apply({ kind: "commit", title: "Second", prompt: "Second", acceptance: [] })
      if (first.kind !== "applied" || first.receipt.starts[0] === undefined) throw new Error("first TODO was not admitted")
      const crashedId = todoExecutionId(first.receipt.starts[0].attemptId)
      const { handlers: crashed, alarm: crashedAlarm, storage } = yield* object(crashedId)
      yield* crashed.start(yield* ExecutionObject.intent(Pause, {
        executionId: crashedId, payload: { label: "terminal receipt fixture", pauseMs: 1 },
      }))
      yield* crashed.alarm()
      // Restore the durable and engine state an incarnation can leave after a defect, before settlement is acknowledged.
      yield* Effect.flatMap(SqlClient.SqlClient, (engine) =>
        engine`UPDATE flows_runs SET status = ${"failed"} WHERE run_id = ${crashedId}`,
      ).pipe(Effect.provide(ExecutionHost.database(url.toString(), ExecutionHost.ENGINE_SCHEMA)))
      yield* storage.delete(ExecutionObject.reportedKey)
      yield* sql`ALTER TABLE todo_attempts RENAME TO unavailable_todo_attempts`
      yield* crashed.alarm().pipe(
        Effect.ensuring(sql`ALTER TABLE unavailable_todo_attempts RENAME TO todo_attempts`.pipe(Effect.orDie)),
      )
      const retry = crashedAlarm()
      if (retry === null) throw new Error("settlement retry was not scheduled")
      expect(retry).toBeLessThan(Date.now() + ExecutionHost.settledRetentionMs - 60_000)
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(retry)
        yield* crashed.alarm()
      }).pipe(Effect.provide(TestClock.layer()))
      expect(yield* sql`SELECT title, state, failure FROM todos ORDER BY number`).toEqual([
        { title: "First", state: "failed", failure: "crashed" },
        { title: "Second", state: "working", failure: null },
      ])
      const [next] = yield* sql<{ readonly id: string }>`
        SELECT a.id::text FROM todo_attempts a JOIN todos t ON t.id = a.todo_id WHERE t.title = ${"Second"}`
      if (next === undefined) throw new Error("second TODO was not admitted")
      expect(started).toContainEqual(expect.objectContaining({
        flow: "todo", executionId: todoExecutionId(next.id),
      }))
      expect(crashedAlarm()).toBe(retry + ExecutionHost.settledRetentionMs)

    }
  })).pipe(
    Effect.provide(TestDatabase.layer("executions_live")),
    Effect.provideContext(services.pipe(Context.add(Cloudflare.WorkerEnvironment, {
      FlowExecution: { getByName: (id: string) => ({
        signal: async (name: string) => { signalled.push({ id, name }) },
        cancel: async () => { cancelled.push(id) },
        wake: async () => { woken.push(id); return true },
        start: async (intent: ExecutionObject.Intent) => {
          expect(intent.executionId).toBe(id)
          started.push(intent)
          if (intent.flow === RecheckRole._tag && started.filter((entry) => entry.executionId === id).length === 2) {
            throw new Error("role renewal object unavailable")
          }
          if (configured && intent.flow === "sandbox/Keep") throw new Error("keep object unavailable")
          if (!configured && intent.flow === "todo") {
            return {
              _tag: ErrorTag,
              error: encodeRpcError(new ExecutionObject.IntentConflict({ executionId: id, message: "execution already recorded" })),
            }
          }
          return undefined
        },
      }) },
      SandboxObject: { getByName: () => ({
        wake: async () => ({ _tag: "Woken", generation: 7 }),
        session: async (id: string) => {
          opened.push(id)
          return true
        },
      }) },
      GateObject: { getByName: () => ({
        tool: async (): Promise<ToolOutcome> => ({ _tag: "Done", result: gateToolResult, generation: 8 }),
      }) },
    }))),
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
    Effect.provideService(FetchHttpClient.Fetch, githubFetch),
    withRuntime,
  ))
})
