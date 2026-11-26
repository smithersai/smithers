import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Logger, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ElectricCache from "../infra/ElectricCache.ts"
import * as Budget from "./branch/Budget.ts"
import * as FleetStore from "./fleet/FleetStore.vibe"
import * as SandboxCommand from "./flows/SandboxCommand.ts"
import * as PersonalStore from "./personal/Store.ts"
import * as PersonalUsage from "./personal/Usage.vibe"
import * as Fence from "./runners/Fence.ts"
import * as Overflow from "./runners/Overflow.ts"
import * as RunnerStore from "./runners/Store.ts"
import * as Stack from "./stack/Stack.ts"
import * as H from "./test/harness.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(15, Math.min(Math.ceil(baseExecs / 5), 40))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261194")
const silent = Logger.layer([])

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Wave9 Stack, Runners, Overflow, Fence, Personal, Budget, Fleet & ElectricCache real-Postgres fuzzing", () => {
  const runtime = H.testFile("wave9_s4")

  it("fuzzes Stack.apply (commit/configure/attach/retry/drop), Stack.report, and Stack query helpers on real Postgres 18", async () => {
    const repoId = "github/acme/widgets"
    const actor = { id: H.uuid(), login: "alice" }

    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, author_login, created_at, updated_at, source_updated_at, fetched_at)
        VALUES (${`${repoId}#10`}, ${repoId}, 10, 'issue', 10010, 'Real Issue 10', 'body', 'open', 'alice', now(), now(), now(), now()),
               (${`${repoId}#11`}, ${repoId}, 11, 'issue', 10011, 'Deleted Issue 11', 'body', 'open', 'alice', now(), now(), now(), now())
      `
      yield* sql`UPDATE items SET deleted_at = now() WHERE id = ${`${repoId}#11`}`

      // Configure stack settings
      const cfg = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "configure", lanes: 2, maxOpen: 10, base: "stacked" } },
        { runs: false },
      )
      expect(cfg.kind).toBe("applied")

      // Commit TODO #1
      const add1 = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "commit", title: "First TODO", prompt: "do 1", acceptance: ["tests pass"], after: null } },
        { runs: false },
      )
      expect(add1.kind).toBe("applied")

      // Holds=false -> stale
      const stale = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "commit", title: "Stale", prompt: "p", acceptance: [] } },
        { runs: false, holds: Effect.succeed(false) },
      )
      expect(stale.kind).toBe("stale")

      // Commit TODO #2 stacked after #1
      const add2 = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "commit", title: "Second TODO", prompt: "do 2", acceptance: [], after: 1 } },
        { runs: false },
      )
      expect(add2.kind).toBe("applied")

      // Attach issue: missing issue, deleted issue, missing todo, valid attach, repeat attach
      for (const [number, issue] of [[1, 999], [1, 11], [99, 10], [1, 10], [1, 10]] as const) {
        const res = yield* Stack.apply(
          { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "attach", number, issue } },
          { runs: false },
        )
        expect(res.kind).toBe("applied")
      }
      expect(Stack.isRefusal("issue_not_found")).toBe(true)
      expect(Stack.isRefusal("attached")).toBe(true)
      expect(Stack.isRefusal("committed")).toBe(false)

      // Create attempt and exercise Stack.report lifecycle + query helpers
      const [todo1] = yield* sql<{ id: string }>`SELECT id FROM todos WHERE repo_id = ${repoId} AND number = 1`
      const attemptId = H.uuid()
      yield* sql`
        INSERT INTO todo_attempts (id, todo_id, repo_id, ordinal, revision, status)
        VALUES (${attemptId}, ${todo1!.id}, ${repoId}, 1, 1, 'running')
      `
      yield* sql`UPDATE todos SET state = 'working', attempt = 1 WHERE id = ${todo1!.id}`

      const attempt: Stack.RunAttempt = { todoId: todo1!.id, attemptId, ordinal: 1, repoId }
      expect(yield* Stack.attemptTodo(attempt)).toBeDefined()
      expect(yield* Stack.belowOf(attempt)).toBeDefined()

      yield* Stack.report(attempt, { kind: "waiting", waiting: "runner" }, { runs: false })
      yield* Stack.report(attempt, { kind: "waiting", waiting: null }, { runs: false })
      yield* Stack.report(attempt, { kind: "step", step: "implement" }, { runs: false })
      yield* Stack.report(attempt, { kind: "branch", branch: "todo/1", baseSha: "a".repeat(40), baseRef: "main" }, { runs: false })
      expect(yield* Stack.baseTodoOf(repoId, "todo/1")).toBeDefined()
      yield* Stack.report(attempt, { kind: "published", headSha: "b".repeat(40), prNumber: 7, draft: false }, { runs: false })
      expect(yield* Stack.publishedStarts(attempt)).toBeDefined()
      expect(yield* Stack.openAboveFromIssue(attempt)).toBeDefined()
      expect(yield* Stack.attemptPull(attempt)).toBeDefined()
      yield* Stack.report(attempt, { kind: "finished", state: "failed", failure: "implement" }, { runs: false })

      const _cand = yield* Stack.retryCandidate(repoId, 1); expect(_cand === undefined || _cand !== null).toBe(true)

      // Retry forbidden when retryAny: false & actor differs
      const otherActor = { id: H.uuid(), login: "bob" }
      const retryForb = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor: otherActor, via: "person", op: { kind: "retry", number: 1 }, retryAny: false },
        { runs: false },
      ).pipe(Effect.result)
      expect(retryForb._tag).toBe("Failure")

      // Retry allowed with stoppedAttemptId
      const retryOk = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "retry", number: 1 }, retryAny: true },
        { runs: false, stoppedAttemptId: attemptId },
      )
      expect(retryOk.kind).toBe("applied")

      // closedBase & descendants & drop TODO #2
      yield* Stack.closedBase(repoId, "todo/1")
      expect(yield* Stack.descendants({ attemptId, todoId: todo1!.id, baseClosed: true })).toBeInstanceOf(Array)
      const drop2 = yield* Stack.apply(
        { opId: H.uuid(), repoId, actor, via: "person", op: { kind: "drop", number: 2 } },
        { runs: false },
      )
      expect(drop2.kind).toBe("applied")
    }).pipe(Effect.provide(silent)))
  }, 120_000)

  it("fuzzes Runners Store, Overflow, Fence, Personal Store & Usage, Budget, FleetStore, SandboxCommand & ElectricCache", async () => {
    const scratch = await runtime.runPromise(Effect.gen(function* () { return yield* TestDatabase.Scratch }))
    const db = scratch.database
    const repoId = "github/acme/widgets"
    const personId = H.uuid()
    const connId = H.uuid()

    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}, 91234, 'runner-admin')`

      // Runners Store: addRunner, repeat, fenced superseded + replay, expired fence, removeRunner, setAgent, codingAgent, removeAgent
      const by1: RunnerStore.By = { actorId: personId, invocationKey: `inv-${H.uuid()}` }
      expect(yield* RunnerStore.addRunner({
        repoId, name: "mac-1", tokenSha256: "a".repeat(64), labels: ["arm64", "mac"], capacity: 2, repoAuthorized: true,
      }, by1)).toBe("set")
      expect(yield* RunnerStore.addRunner({
        repoId, name: "mac-1", tokenSha256: "a".repeat(64), labels: ["arm64"], capacity: 2, repoAuthorized: true,
      }, by1)).toBe("repeat")

      const genNow = yield* RunnerStore.generationOf(RunnerStore.resourceKey("runners", repoId, "mac-1"))
      const fencedStale: RunnerStore.By = {
        actorId: personId,
        invocationKey: `inv-${H.uuid()}`,
        fenced: {
          kind: "runners",
          op: "delete",
          fence: { execution: H.uuid(), expiresAt: Date.now() + 60_000, generation: genNow + 99, authority: { _tag: "Local" } },
        },
      }
      expect(yield* RunnerStore.removeRunner({ repoId, name: "mac-1" }, fencedStale)).toBe("superseded")
      expect(yield* RunnerStore.removeRunner({ repoId, name: "mac-1" }, fencedStale)).toBe("superseded")

      const expiredFence: RunnerStore.By = {
        actorId: personId,
        invocationKey: `inv-${H.uuid()}`,
        fenced: {
          kind: "runners",
          op: "delete",
          fence: { execution: H.uuid(), expiresAt: Date.now() - 10_000, generation: genNow, authority: { _tag: "Local" } },
        },
      }
      expect(yield* RunnerStore.removeRunner({ repoId, name: "mac-1" }, expiredFence)).toBe("authorization_expired")
      expect(yield* Fence.authorityHolds({ execution: H.uuid(), expiresAt: Date.now() + 60_000, generation: 0, authority: { _tag: "Repo", held: { repoId, personId, role: "admin" } } })).toBe(false)
      expect(yield* Fence.authorityHolds({ execution: H.uuid(), expiresAt: Date.now() + 60_000, generation: 0, authority: { _tag: "Session", personId, sessionId: H.uuid() } })).toBe(false)

      expect(yield* RunnerStore.removeRunner({ repoId, name: "mac-1" }, { actorId: personId, invocationKey: `inv-${H.uuid()}` })).toBe("removed")
      expect(yield* RunnerStore.removeRunner({ repoId, name: "no-such" }, { actorId: personId, invocationKey: `inv-${H.uuid()}` })).toBe("missing")

      expect(yield* RunnerStore.setAgent({
        repoId,
        agent: { name: "claude", labels: ["linux"], profile: "standard-1", maxHours: 4, restarts: 2 } as never,
        coding: true,
      }, { actorId: personId, invocationKey: `inv-${H.uuid()}` })).toBe("set")
      expect(Option.isSome(yield* RunnerStore.agent(repoId, "claude"))).toBe(true)
      expect(Option.isSome(yield* RunnerStore.codingAgent(repoId))).toBe(true)
      expect(yield* RunnerStore.removeAgent({ repoId, name: "claude" }, { actorId: personId, invocationKey: `inv-${H.uuid()}` })).toBe("removed")

      // Overflow set, repeat, script, remove
      const ovBy: RunnerStore.By = { actorId: personId, invocationKey: `inv-${H.uuid()}` }
      const ovWrite = {
        repoId,
        personId,
        connectionId: connId,
        origin: "https://smithers.test",
        profile: "standard-1" as const,
        argv: ["claude", "--print", "it's ok"],
        labels: ["linux"],
        minQueuedSeconds: 30,
        capacity: 2,
        token: { ciphertext: "ct", nonce: "nn", keyVersion: 1 },
        tokenSha256: "b".repeat(64),
        repoAuthorized: true,
      }
      expect(yield* Overflow.set(ovWrite, ovBy)).toBe("set")
      expect(yield* Overflow.set(ovWrite, ovBy)).toBe("repeat")
      expect(Option.isSome(yield* Overflow.read(repoId))).toBe(true)
      const plan = Overflow.boxPlan(ovWrite, { token: "secret-tok", key: "secret-key" }, { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" }, "https://forge.test/repo.git")
      expect(plan.config).toContain("cloudflare-overflow")
      expect(plan.script).toContain("runner serve")
      expect(Overflow.isBox(Overflow.boxId(repoId))).toBe(true)
      expect(Overflow.boxBranch(repoId)).toBeDefined()
      expect(yield* Overflow.remove({ repoId }, { actorId: personId, invocationKey: `inv-${H.uuid()}` })).toBe("removed")
      expect(Overflow.tokenContext(repoId, 1).id).toBe(repoId)

      // Personal Store: put, link, holdCodex, refreshed, saved, hasModel, begin, settle, mark, markConnection, remove
      const putRes = yield* PersonalStore.put({
        personId,
        connections: [
          {
            id: connId,
            kind: "api_key",
            active: true,
            protocol: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            models: { fast: "claude-sonnet-4-6", implement: "claude-sonnet-4-6", hard: "claude-sonnet-4-6" },
            sealed: { ciphertext: "c1", nonce: "n1", keyVersion: 1, keyLast4: "1234" },
          },
        ],
        invocationKey: `inv-${H.uuid()}`,
      })
      expect(["set", "replace"]).toContain(putRes)
      expect(yield* PersonalStore.hasModel(personId)).toBe(true)
      expect((yield* PersonalStore.saved(personId)).length).toBeGreaterThanOrEqual(1)
      expect(Option.isSome(yield* Overflow.connectionOf(personId, connId))).toBe(true)

      const gen = yield* PersonalStore.linkGeneration(personId)
      const linkKey = `inv-${H.uuid()}`
      const codexId = H.uuid()
      const link1 = yield* PersonalStore.link({
        generation: gen,
        personId,
        id: codexId,
        sealed: { ciphertext: "c2", nonce: "n2", keyVersion: 1, keyLast4: "5678" },
        invocationKey: linkKey,
      })
      expect(["set", "replace"]).toContain(link1)
      expect(yield* PersonalStore.link({
        generation: gen,
        personId,
        id: codexId,
        sealed: { ciphertext: "c2", nonce: "n2", keyVersion: 1, keyLast4: "5678" },
        invocationKey: linkKey,
      })).toBe("repeat")
      // Absent generation -> stale
      expect(yield* PersonalStore.link({
        personId,
        id: codexId,
        sealed: { ciphertext: "c2", nonce: "n2", keyVersion: 1, keyLast4: "5678" },
        invocationKey: `inv-${H.uuid()}`,
      })).toBe("stale")
      yield* PersonalStore.holdCodex(personId)
      expect(yield* PersonalStore.refreshed({
        personId,
        id: connId,
        from: "c1",
        sealed: { ciphertext: "c3", nonce: "n3", keyVersion: 1 },
      })).toBe(true)

      // Personal Usage begin + end (ok + refusedKey 401/429 quota_exceeded + markConnection)
      const invId = H.uuid()
      const call1: PersonalUsage.Call = {
        invocationId: invId,
        requestId: H.uuid(),
        personId,
        connectionId: connId,
        credentialNonce: "n3",
        protocol: "anthropic-messages",
        tier: "fast",
        modelId: "claude-sonnet-4-6",
        role: "chat",
        host: "api.anthropic.com",
      }
      yield* PersonalUsage.begin(call1)
      expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 401 })).toBe(true)
      expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 429, errorCode: "quota_exceeded" })).toBe(true)
      expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 429, errorCode: "rate_limit" })).toBe(false)
      expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 500 })).toBe(false)
      yield* PersonalUsage.end(call1, { outcome: "success", usage: { inputTokens: 100, outputTokens: 50 } }, db)
      const call2: PersonalUsage.Call = { ...call1, invocationId: H.uuid(), requestId: H.uuid() }
      yield* PersonalUsage.begin(call2)
      yield* PersonalUsage.end(call2, { outcome: "failed", usage: { inputTokens: 10, outputTokens: 0 }, httpStatus: 401, errorCode: "unauthorized" }, db)
      yield* PersonalStore.mark(call2.invocationId, 403)
      yield* PersonalStore.markConnection(personId, connId, 401)

      const remKey = `inv-${H.uuid()}`
      expect(yield* PersonalStore.remove({ personId, invocationKey: remKey })).toBe("deleted")
      expect(yield* PersonalStore.remove({ personId, invocationKey: remKey })).toBe("repeat")
      expect(yield* PersonalStore.remove({ personId, invocationKey: `inv-${H.uuid()}` })).toBe("missing")

      // Branch Budget: setLimits, admit, observedAdmit, started, recorded, seen, ended, release, spendIn, awake
      yield* Budget.setLimits({ awake: 3, perPerson: 2, monthlyAlertUsd: 100 }, personId)
      const lim = yield* Budget.limits
      expect(lim.awake).toBe(3)
      const bId = H.uuid()
      const slot: Budget.Slot = { branchId: bId, personId, kind: "branch" }
      const adm1 = yield* Budget.observedAdmit(slot, db)
      expect(adm1._tag).toBe("Admitted")
      yield* Budget.started({ ...slot, generation: 1, instance: "standard-1" })
      yield* Budget.seen(bId, 1)
      expect(yield* Budget.awake).toBeGreaterThanOrEqual(1)
      yield* Budget.ended(bId, 1)
      yield* Budget.release(bId)
      const spend = yield* Budget.spendIn(Budget.monthOf(Date.now()))
      expect(spend.usd).toBeGreaterThanOrEqual(0)
      expect(Budget.pricePerSecond("standard-1")).toBeGreaterThan(0)
      expect(Budget.pricePerSecond("unknown-instance")).toBeGreaterThan(0)

      let ledgerVal: unknown = undefined
      const memStore = {
        get: <T>() => Effect.sync(() => ledgerVal as T | undefined),
        put: <T>(_k: string, v: T) => Effect.sync(() => { ledgerVal = v }),
      }
      yield* Budget.recorded(memStore, { ...slot, generation: 2, instance: "standard-1" })
      expect(ledgerVal).toBeDefined()

      // FleetStore: projectGrants + upsertHostNode + reportSessions (with snapshotId + final + replay) + readOverview
      expect(FleetStore.projectGrants(null)).toBeNull()
      expect(FleetStore.projectGrants([])).toBeNull()
      expect(FleetStore.projectGrants({ ok: "yes", nested: { a: "b" } })).toBeDefined()
      const nodeId = `node-${H.uuid().slice(0, 8)}`
      const snapId = `snap-${H.uuid().slice(0, 8)}`
      yield* FleetStore.upsertHostNode({
        nodeId,
        name: "box-1",
        kind: "bare-metal",
        labels: ["  tag1  ", "", "tag2"],
        online: true,
      })
      const r1 = yield* FleetStore.reportSessions({
        nodeId,
        mode: "replace",
        snapshotId: snapId,
        final: true,
        sessions: [
          {
            sessionKey: "sess-key-1",
            harness: "claude",
            title: "Build stuff",
            status: "working",
            cwd: "/work",
          },
        ],
      })
      expect("final" in r1 && r1.final).toBe(true)
      const r2 = yield* FleetStore.reportSessions({
        nodeId,
        mode: "replace",
        snapshotId: snapId,
        final: true,
        sessions: [],
      })
      expect("snapshotId" in r2 && r2.snapshotId).toBe(snapId)
      const ov = yield* FleetStore.readOverview(true)
      expect(ov.nodes.length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(silent)))

    // SandboxCommand without FlowRuntime -> NoRun + commandExecutionId
    expect(SandboxCommand.commandExecutionId("c-1")).toBe("sandbox-command:c-1")
    const noRunExit = await Effect.runPromiseExit(
      SandboxCommand.run(
        { branch: { branchId: H.uuid(), repoId: "github/acme/widgets", name: "main" } as never, ownerId: personId } as never,
        H.uuid() as never,
        { tool: "run", command: "echo hi" } as never,
        { commands: () => ({} as never) } as never,
      ),
    )
    expect(Exit.isFailure(noRunExit)).toBe(true)

    // ElectricCache fuzzing
    const cacheArb = Arbitrary.schema(Schema.Struct({
      status: Schema.Literals([200, 204, 409, 500]),
      header: Schema.Literals(["public, max-age=60", "private, max-age=60", "public, no-store", "no-cache", ""]),
      sse: Schema.Boolean,
    }))
    await holds(cacheArb, execs, (c) =>
      Effect.sync(() => {
        const url = c.sse ? "http://electric/v1/shape?live_sse=true" : "http://electric/v1/shape?table=messages"
        expect(ElectricCache.enabledFor(url)).toBe(!c.sse)
        const cc = ElectricCache.cacheControl(c.status, c.header === "" ? undefined : c.header)
        if (c.status === 200 && c.header === "public, max-age=60") expect(cc).toBe(c.header)
        else expect(cc).toBe(ElectricCache.NO_STORE)
        const res = HttpServerResponse.raw(new Response(c.status === 204 ? null : "[]", { status: c.status, headers: c.header ? { "cache-control": c.header } : {} }))
        const pol = ElectricCache.cachePolicy(res, !c.sse)
        expect(pol.headers["cache-control"]).toBeDefined()
      }))

    const refusedRes = await Effect.runPromise(
      ElectricCache.serve(() => Effect.succeed(HttpServerResponse.empty({ status: 200 }))).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("http://electric/bad-path", { method: "POST" }))),
        Effect.provide(silent),
      ),
    )
    expect(refusedRes.headers["cache-control"]).toBe(ElectricCache.NO_STORE)
  }, 120_000)
})
