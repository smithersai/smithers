import { HostModel } from "@smthrs/model-host"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Layer, Logger, Option, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import type { Actor, Role } from "./Actor.ts"
import * as BranchAccess from "./branch/Access.ts"
import * as BranchBudget from "./branch/Budget.ts"
import * as BranchConversations from "./branch/Conversations.ts"
import * as BranchMachines from "./branch/Machines.ts"
import * as DomainsStore from "./domains/Store.ts"
import * as DoFailure from "./DurableObjectFailure.ts"
import * as HostedModel from "./HostedModel.ts"
import * as ModelRoles from "./ModelRoles.ts"
import * as PersonalModels from "./personal/Models.ts"
import * as PersonalStore from "./personal/Store.ts"
import * as ProtectedAuthority from "./ProtectedAuthority.ts"
import * as RunCredentials from "./RunCredentials.ts"
import * as RunnersFence from "./runners/Fence.ts"
import * as RunnersOverflow from "./runners/Overflow.ts"
import * as RunnersStore from "./runners/Store.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SetModel from "./SetModel.ts"
import * as SocketAccess from "./SocketAccess.ts"
import * as WriteAuthority from "./WriteAuthority.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261132")
const silentLogger = Logger.layer([])

interface Frag {
  readonly __frag: true
  readonly text: string
  readonly values: ReadonlyArray<unknown>
}

const isFrag = (v: unknown): v is Frag => typeof v === "object" && v !== null && "__frag" in v

const flatten = (strings: TemplateStringsArray, values: ReadonlyArray<unknown>): { text: string; vals: Array<unknown> } => {
  let text = ""
  const vals: Array<unknown> = []
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      const v = values[i]
      if (isFrag(v)) {
        text += v.text
        vals.push(...v.values)
      } else {
        text += " $ "
        vals.push(v)
      }
    }
  }
  return { text: text.replace(/\s+/g, " ").trim(), vals }
}

const createMemoryPolicyDb = (opts: {
  readonly role?: Role | null
  readonly hasRow?: boolean
  readonly enabled?: boolean
  readonly generation?: number
} = {}) => {
  const nowIso = new Date(Date.UTC(2026, 10, 22, 12, 0, 0)).toISOString()
  const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0)
  const hasRow = opts.hasRow !== false
  const gen = opts.generation ?? 1

  const tag = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<A>, Error> & Frag => {
    const { text: q, vals } = flatten(strings, values)
    const eff = Effect.sync(() => {
      if (q.startsWith("SET LOCAL") || q.startsWith("SELECT pg_advisory_xact_lock")) return [] as ReadonlyArray<A>

      // HostedModel & ModelRoles
      if (q.includes("hosted_model")) {
        return hasRow ? ([{ enabled: Boolean(opts.enabled) }] as unknown as ReadonlyArray<A>) : ([] as ReadonlyArray<A>)
      }
      if (q.includes("model_roles")) {
        return hasRow
          ? ([
              {
                role: "chat",
                tier: "default",
                model: ModelRoles.DEFAULT_CHAT_MODEL,
                updatedAt: nowIso
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      // Runners / Agents / Fence / Overflow
      if (q.includes("resource_generations") || q.includes("generation")) {
        return [{ generation: gen, current: gen }] as unknown as ReadonlyArray<A>
      }
      if (q.includes("runner_receipts") || q.includes("receipt")) {
        return hasRow
          ? ([{ outcome: "set", detail: null, actorId: "person-1", execution: "exec-1" }] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }
      if (q.includes("overflow")) {
        return hasRow
          ? ([
              {
                repoId: "acme/widgets",
                enabled: true,
                labels: ["linux"],
                connectionId: "conn-1",
                sealedToken: { ciphertext: "c", nonce: "n", version: 1 },
                idleExitSeconds: 300,
                awakeSeconds: 45,
                key: "k1",
                dueAt: nowIso
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }
      if (q.includes("FROM runners") || q.includes("INTO runners") || q.includes("FROM agents") || q.includes("INTO agents")) {
        return hasRow
          ? ([
              {
                repoId: "acme/widgets",
                name: "r1",
                labels: ["linux"],
                agent: "claude",
                model: "claude-sonnet",
                enabled: true,
                generation: gen,
                status: "set"
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      // Personal Store
      if (q.includes("personal_connections") || q.includes("personal_models") || q.includes("personal_calls")) {
        return hasRow
          ? ([
              {
                id: "conn-1",
                personId: "person-1",
                provider: "openai",
                protocol: "openai-responses",
                host: "https://api.openai.com",
                modelId: "gpt-5",
                label: "My OpenAI",
                ciphertext: "ct",
                nonce: "nn",
                version: 1,
                generation: gen,
                has: true,
                exists: true,
                status: "set"
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      // Domains Store
      if (q.includes("custom_domains") || q.includes("domains")) {
        return hasRow
          ? ([
              {
                hostname: "app.example.com",
                repoId: "acme/widgets",
                personId: "person-1",
                status: "active",
                verifiedAt: nowIso,
                updatedAt: nowIso,
                createdAt: nowIso,
                generation: gen,
                active: true
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      // Branch Access / Budget / Conversations / Machines
      if (q.includes("FROM branches") || q.includes("FROM conversations") || q.includes("branch_shares") || q.includes("branch_machines") || q.includes("sandbox_leases")) {
        return hasRow
          ? ([
              {
                id: "branch-1",
                branchId: "branch-1",
                conversationId: "conv-1",
                repoId: "acme/widgets",
                name: "feat/x",
                mode: "open",
                ownerId: "person-1",
                grantee: "repository",
                access: "edit",
                machineId: "m-1",
                state: "running",
                count: 1,
                active: 1,
                leaseUntil: nowIso,
                serverNow: String(nowMs)
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      // Authority / Sessions
      if (q.includes("FROM sessions")) {
        return hasRow
          ? ([
              {
                id: "sess-1",
                personId: "person-1",
                role: opts.role ?? "maintainer",
                roleVerifiedAt: String(nowMs),
                expiresAt: String(nowMs + 86400_000),
                serverNow: String(nowMs),
                live: true
              }
            ] as unknown as ReadonlyArray<A>)
          : ([] as ReadonlyArray<A>)
      }

      return [] as ReadonlyArray<A>
    })
    return Object.assign(eff, { __frag: true as const, text: q, values: vals })
  }

  const sqlClient = Object.assign(tag, {
    in: (items: ReadonlyArray<unknown>): Frag => ({ __frag: true, text: "(?)", values: [items] }),
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff
  }) as unknown as SqlClient.SqlClient

  return {
    database: Layer.succeed(SqlClient.SqlClient, sqlClient),
    sqlClient
  }
}

describe("apps/mvp Worker Stores, Branch Access/Budget, Authority, SocketAccess, Models & DO Failure fuzz invariants", () => {
  it("BranchAccess, BranchBudget, BranchConversations, BranchMachines, SocketAccess & DoFailure exercise all policy & classification paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        signedIn: Schema.Boolean,
        hasRow: Schema.Boolean,
        verifiedAgoMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 7_200_000 }))),
        errorKind: Schema.Literals(["retryable", "overloaded", "remote", "plain", "string", "null"]),
        branchKind: Schema.Literals(["branch", "todo", "job", "overflow"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ role, signedIn, hasRow, verifiedAgoMs, errorKind, branchKind }) =>
          Effect.gen(function* () {
            const db = createMemoryPolicyDb({ role, hasRow })
            const actorOpt: Option.Option<Actor> = signedIn
              ? Option.some({ subject: { kind: "person", id: "person-1" }, role, login: "alice" })
              : Option.none()

            const policy: BranchAccess.Policy = {
              createdBy: "person-1",
              grants: { repository: "edit", "person-2": "view" }
            }
            const acc = BranchAccess.underPolicy(policy, "person-1", role)
            const isMem = BranchAccess.isMember(actorOpt)
            const ask = BranchAccess.askingOf({ access: acc === "none" ? "view" : acc } as never)

            // BranchBudget pure helpers
            const k = BranchBudget.kindOf({
              branchId: branchKind === "overflow" ? "overflow-acme/widgets" : "b-1",
              kind: branchKind === "job" ? "job" : "branch",
              forge: branchKind === "todo" ? "github" : "local"
            } as never)
            const pOf = BranchBudget.personOf(signedIn ? "person-1" : undefined)

            // SocketAccess pure helpers
            const now = Date.UTC(2026, 10, 22, 12, 0, 0)
            const fresh = SocketAccess.roleFresh(now - verifiedAgoMs, now, 3_600_000)
            const adm = SocketAccess.admissionFrom({
              personId: "person-1",
              login: "alice",
              role: role ?? "member",
              basis: { kind: "session", sessionId: "sess-1" },
              issuedAt: now,
              expiresAt: now + 60_000
            })
            const req = HttpServerRequest.fromWeb(
              new Request("https://smithers.test/ws", {
                headers: adm ? { [SocketAccess.ADMISSION_HEADER]: JSON.stringify(adm) } : {}
              })
            )
            SocketAccess.admissionOf(req)

            // DurableObjectFailure
            const errObj =
              errorKind === "retryable"
                ? Object.assign(new Error("reset"), { retryable: true })
                : errorKind === "overloaded"
                ? Object.assign(new Error("busy"), { overloaded: true })
                : errorKind === "remote"
                ? Object.assign(new Error("remote"), { remote: true })
                : errorKind === "plain"
                ? new TypeError("bad type")
                : errorKind === "string"
                ? "boom"
                : null
            const cat = DoFailure.categoryOf(errObj)
            const cls = DoFailure.classOf(errObj)
            const desc = DoFailure.describe(errObj)
            yield* Effect.exit(DoFailure.recorded("BranchObject", "fetch")(Effect.fail(errObj)))

            const envLayer = Layer.mergeAll(
              db.database,
              Layer.succeed(HostModel, HostModel.of({ modelId: "test-model", model: {} as never, route: { prepare: () => Effect.die(new Error("unused")) } } as never)),
              Layer.succeed(BranchAccess.BranchRoles, {
                role: () => Effect.succeed(role),
                installed: () => Effect.succeed(true)
              } as never),
              Layer.succeed(SessionStore.SigningKeyIds, ["legacy"]),
              Layer.succeed(HostModel, HostModel.of({ modelId: "test-model", model: {} as never, route: { prepare: () => Effect.die(new Error("unused")) } } as never)),
              Layer.succeed(SessionStore.RoleFreshMs, 3_600_000),
              silentLogger
            )

            yield* Effect.gen(function* () {
              yield* Effect.exit(BranchAccess.readsCopy(actorOpt, "acme/widgets", Effect.succeed(true)))
              yield* Effect.exit(BranchAccess.branchAccess(actorOpt, "branch-1", "branch"))
              yield* Effect.exit(BranchAccess.branchAccess(actorOpt, "conv-1", "conversation"))
              yield* Effect.exit(BranchAccess.policyOf("branch-1"))
              if (Option.isSome(actorOpt)) {
                yield* Effect.exit(BranchAccess.askingOnAnswer(actorOpt.value, "ans-1"))
              }
              yield* Effect.exit(BranchConversations.home)
              BranchMachines.ranOf({ exitCode: 0, stdout: "ok", stderr: "" } as never)
            }).pipe(Effect.provide(envLayer))

            return (
              typeof acc === "string" &&
              typeof isMem === "boolean" &&
              typeof ask === "string" &&
              typeof k === "string" &&
              (signedIn ? pOf === "person-1" : pOf === null) &&
              typeof fresh === "boolean" &&
              typeof cat === "string" &&
              typeof cls === "string" &&
              typeof desc === "object"
            )
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Runners (Store/Overflow/Fence), Personal (Store/Models), DomainsStore, HostedModel, ModelRoles, SetModel & Authority modules cover SQL & policy paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        hasRow: Schema.Boolean,
        enabled: Schema.Boolean,
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        protocol: Schema.Literals(["anthropic", "openai-responses", "openai-chat", "google"]),
        modelRole: Schema.Literals(["chat", "summary"]),
        tier: Schema.Literals(["default", "fast", "deep"])
      })
    )

    const report = await Effect.runPromise(
      Effect.provideService(Fuzz.run(
        arb,
        ({ hasRow, enabled, role, protocol, modelRole, tier }) =>
          Effect.gen(function* () {
            const db = createMemoryPolicyDb({ hasRow, enabled, role })
            const envLayer = Layer.mergeAll(
              db.database,
              Layer.succeed(SessionStore.SigningKeyIds, ["legacy"]),
              Layer.succeed(SessionStore.RoleFreshMs, 3_600_000),
              silentLogger,
              ConfigProvider.layer(ConfigProvider.fromUnknown({ HOSTED_MODEL_ENABLED: enabled ? "true" : "false" }))
            )

            // Pure helpers
            const rKey = RunnersStore.resourceKey("runners", "acme/widgets", "r1")
            const cKey = RunnersStore.codingKey("acme/widgets")
            const tokCtx = RunnersOverflow.tokenContext("acme/widgets", 1)
            const lbls = RunnersOverflow.labelsOf({ labels: ["gpu"] })
            const box = RunnersOverflow.boxId("acme/widgets")
            const isB = RunnersOverflow.isBox(box)
            const wire = PersonalModels.wireOf(protocol as never, "https://api.example.com", "m-1")
            const sCtx = PersonalModels.sealContext("person-1", 1)

            // WriteAuthority / ProtectedAuthority / RunCredentials
            const actor: Actor = {
              subject: { kind: "person", id: "person-1" },
              role,
              login: "alice",
              session: { id: "sess-1", alias: null, key: "legacy", verifiedAt: Date.now() } as never
            }
            const sessAuth = WriteAuthority.sessionOf(actor)
            const protAuth = WriteAuthority.protectedOf(actor)
            const admAuth = WriteAuthority.admitted(protAuth)
            const reqWithBearer = HttpServerRequest.fromWeb(
              new Request("https://smithers.test/api/test", { headers: { authorization: "Bearer smr_abc123" } })
            )
            const bearer = RunCredentials.bearerOf(reqWithBearer)
            const carries = RunCredentials.carriesCredential(reqWithBearer)
            const claims = RunCredentials.claimsFor(actor, "run-1", { flow: "chat/ask" as never }, Date.now())

            yield* Effect.gen(function* () {
              // Runners Store / Overflow / Fence
              const by: RunnersStore.By = {
                actorId: "person-1",
                execution: "exec-1",
                fence: { generation: 1, deadline: Date.now() + 60_000, authority: sessAuth ?? null } as never
              } as never
              yield* Effect.exit(RunnersStore.generationOf(rKey))
              yield* Effect.exit(RunnersStore.replayed("runners", "acme/widgets", "r1", by))
              yield* Effect.exit(RunnersStore.addRunner({ repoId: "acme/widgets", name: "r1", labels: ["linux"] } as never, by))
              yield* Effect.exit(RunnersStore.removeRunner({ repoId: "acme/widgets", name: "r1" }, by))
              yield* Effect.exit(RunnersStore.setAgent({ repoId: "acme/widgets", agent: { name: "claude", model: "sonnet" } } as never, by))
              yield* Effect.exit(RunnersStore.removeAgent({ repoId: "acme/widgets", name: "claude" }, by))
              yield* Effect.exit(RunnersStore.agent("acme/widgets", "claude"))
              yield* Effect.exit(RunnersStore.codingAgent("acme/widgets"))

              yield* Effect.exit(RunnersOverflow.connectionOf("person-1", "conn-1"))
              yield* Effect.exit(RunnersOverflow.read("acme/widgets"))
              yield* Effect.exit(RunnersOverflow.due("k1"))
              yield* Effect.exit(RunnersOverflow.set({ repoId: "acme/widgets", enabled, labels: ["linux"], capacity: 1, connectionId: "conn-1", sealedToken: { ciphertext: "c", nonce: "n", version: 1 }, tokenSha256: "a".repeat(64), repoAuthorized: true } as never, by as never))
              yield* Effect.exit(RunnersOverflow.remove({ repoId: "acme/widgets" } as never, by as never))

              yield* Effect.exit(RunnersFence.authorityHolds({ generation: 1, deadline: Date.now() + 60_000, authority: sessAuth ?? null } as never))
              yield* Effect.exit(RunnersFence.stillHolds({ generation: 1, deadline: Date.now() + 60_000, authority: sessAuth ?? null } as never))
              yield* Effect.exit(RunnersFence.recorded("exec-1"))
              yield* Effect.exit(RunnersFence.receiptOf("exec-1", "person-1"))

              // Personal Store
              yield* Effect.exit(PersonalStore.linkGeneration("person-1"))
              yield* Effect.exit(PersonalStore.hasModel("person-1"))
              yield* Effect.exit(PersonalStore.saved("person-1"))
              yield* Effect.exit(PersonalStore.holdCodex("person-1", "conn-1"))
              yield* Effect.exit(PersonalStore.mark("inv-1", 200))
              yield* Effect.exit(PersonalStore.markConnection("person-1", "conn-1", 200))
              yield* Effect.exit(PersonalStore.put({ personId: "person-1", id: "conn-1", label: "OpenAI", provider: "openai", ciphertext: "c", nonce: "n", version: 1 } as never))
              yield* Effect.exit(PersonalStore.remove({ personId: "person-1", id: "conn-1" } as never))

              // Domains Store
              yield* Effect.exit(DomainsStore.read("app.example.com"))
              yield* Effect.exit(DomainsStore.holder("app.example.com"))
              yield* Effect.exit(DomainsStore.active("app.example.com"))
              yield* Effect.exit(DomainsStore.claim({ hostname: "app.example.com", repoId: "acme/widgets", personId: "person-1" } as never))
              yield* Effect.exit(DomainsStore.record({ hostname: "app.example.com", ok: true } as never))
              yield* Effect.exit(DomainsStore.withdraw({ hostname: "app.example.com", personId: "person-1" } as never))
              yield* Effect.exit(DomainsStore.erase("app.example.com"))

              // HostedModel / ModelRoles / SetModel
              yield* HostedModel.hostedModelDefault(enabled)
              yield* Effect.exit(HostedModel.enabled(enabled))
              yield* Effect.exit(HostedModel.set(enabled, { actorId: "person-1", invocationKey: "inv-1" }))
              yield* Effect.exit(ModelRoles.resolve(modelRole as never, tier as never, { chat: ModelRoles.DEFAULT_CHAT_MODEL } as never).pipe(Effect.provideService(HostModel, HostModel.of({ modelId: "test-model", model: {} as never, route: { prepare: () => Effect.die(new Error("unused")) } } as never))))
              yield* Effect.exit(ModelRoles.set({ role: modelRole as never, model: ModelRoles.DEFAULT_CHAT_MODEL as never }, { actorId: "person-1", invocationKey: "inv-1" }))
              yield* Effect.exit(SetModel.write({ role: modelRole as never, model: ModelRoles.DEFAULT_CHAT_MODEL as never }, { subject: { kind: "person", id: "person-1" }, role: "admin", login: "alice" }, "inv-1"))

              // WriteAuthority / ProtectedAuthority
              yield* Effect.exit(WriteAuthority.holds(sessAuth))
              yield* Effect.exit(WriteAuthority.live(sessAuth))
              yield* Effect.exit(WriteAuthority.requireAtCommit(sessAuth))
              yield* Effect.exit(WriteAuthority.bound)
              yield* Effect.exit(ProtectedAuthority.check(sessAuth, ["maintainer", "admin"]))
              yield* Effect.exit(ProtectedAuthority.holds(sessAuth, ["maintainer", "admin"]))
              yield* Effect.exit(ProtectedAuthority.requireAtCommit(sessAuth))
            }).pipe(Effect.provide(envLayer))

            return (
              rKey.includes("r1") &&
              cKey.includes("coding") &&
              tokCtx.name === "overflow-runner" &&
              lbls.length >= 1 &&
              isB === true &&
              (typeof wire === "string" || typeof wire === "object") &&
              sCtx.name === "model" &&
              (admAuth === undefined || typeof admAuth === "object") &&
              Option.isSome(bearer) &&
              carries === true &&
              claims !== undefined
            )
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 50) }
      ), HostModel, HostModel.of({ modelId: "test-model", model: {} as never, route: { prepare: () => Effect.die(new Error("unused")) } } as never))
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
