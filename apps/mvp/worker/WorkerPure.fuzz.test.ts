import { Fuzz } from "@smthrs/fuzz"
import { ModelError, type ModelRequest } from "@smthrs/model"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { TREE_SCOPE_MAX_REPOSITORIES } from "../src/features/issues/contract.ts"
import { MCP_BLOCKED_ACTS } from "../src/features/mcp/contract.ts"
import { MODEL_ROLES, type ModelRole } from "../src/features/model/contract.ts"
import { PROTOCOLS } from "../src/features/personal-model/contract.ts"
import * as Actor from "./Actor.ts"
import { itemShape } from "./github/ItemShape.ts"
import * as TreeScope from "./github/TreeScope.ts"
import { McpToolError, McpToolRegistry } from "./mcp/Contract.ts"
import * as McpProtocol from "./mcp/Protocol.ts"
import * as ModelRefusal from "./ModelRefusal.ts"
import * as ModelTiers from "./ModelTiers.vibe"
import * as NotificationPolicy from "./NotificationPolicy.vibe"
import * as PersonalModels from "./personal/Models.vibe"
import * as Placement from "./Placement.vibe"
import * as Overflow from "./runners/Overflow.vibe"
import * as SecretKeys from "./secrets/Keys.vibe"
import * as ShapeAccess from "./ShapeAccess.vibe"
import * as SocketAccess from "./SocketAccess.ts"
import * as StackAccess from "./stack/Access.vibe"
import * as Throttle from "./Throttle.vibe"
import * as WriteAuthority from "./WriteAuthority.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

describe("apps/mvp worker pure & Effect-layer fuzz invariants", () => {
  it("Throttle.networkOf collapses IPv4 /24, IPv6 /48, and IPv4-mapped IPv6 identically, and Throttle.make enforces 429 on limit", async () => {
    const octet = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 })))
    const hextet = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 0xfffe })))
    const arb = Arbitrary.schema(
      Schema.Struct({
        a: octet,
        b: octet,
        c: octet,
        d1: octet,
        d2: octet,
        h1: hextet,
        h2: hextet,
        h3: hextet,
        h4: hextet,
        junkIp: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        routeUrl: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
          Schema.Literals([
            "/api/shapes/messages?offset=-1",
            "/api/shapes/",
            "/api/telemetry/logs",
            "/api/health",
            "/api/auth/session"
          ])
        ]),
        allowed: Schema.Boolean,
        limiterFails: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ a, b, c, d1, d2, h1, h2, h3, h4, junkIp, routeUrl, allowed, limiterFails }) =>
          Effect.gen(function*() {
            const v4a = Throttle.networkOf({ "cf-connecting-ip": `${a}.${b}.${c}.${d1}` })
            const v4b = Throttle.networkOf({ "cf-connecting-ip": `${a}.${b}.${c}.${d2}` })
            const expectedV4 = `${a}.${b}.${c}.0/24`
            if (v4a !== expectedV4 || v4b !== expectedV4) return false

            // IPv4-mapped IPv6 MUST collapse to the exact same IPv4 /24 network
            const mappedDotted = Throttle.networkOf({ "cf-connecting-ip": `::ffff:${a}.${b}.${c}.${d1}` })
            const hex1 = (a * 256 + b).toString(16)
            const hex2 = (c * 256 + d1).toString(16)
            const mappedHex = Throttle.networkOf({ "cf-connecting-ip": `0:0:0:0:0:ffff:${hex1}:${hex2}` })
            if (mappedDotted !== expectedV4 || mappedHex !== expectedV4) return false

            // IPv6 /48 invariance across lower 80 bits
            const s1 = h1.toString(16)
            const s2 = h2.toString(16)
            const s3 = h3.toString(16)
            const s4 = h4.toString(16)
            const v6Full = Throttle.networkOf({ "cf-connecting-ip": `${s1}:${s2}:${s3}:${s4}:0:0:0:1` })
            const v6Short = Throttle.networkOf({ "cf-connecting-ip": `${s1}:${s2}:${s3}::1` })
            if (v6Full !== `${s1}:${s2}:${s3}::/48` || v6Short !== v6Full) return false

            // Arbitrary junk never throws and either returns a valid CIDR or "unknown"
            const junkNet = Throttle.networkOf({ "cf-connecting-ip": junkIp })
            if (junkNet !== "unknown" && !junkNet.endsWith("/24") && !junkNet.endsWith("/48")) return false

            // routeOf classification
            const route = Throttle.routeOf(routeUrl)
            if (
              routeUrl.startsWith("/api/shapes/") &&
              routeUrl.split("?")[0]!.length > "/api/shapes/".length &&
              route !== "shape"
            ) return false

            // Throttle.make pre-filter behavior: returns Option<429> when limited, None otherwise
            const limiter: Throttle.Limiter = {
              limit: () => limiterFails ? Effect.fail(new Error("boom")) : Effect.succeed({ success: allowed })
            }
            const throttle = Throttle.make({ shape: limiter, telemetry: limiter, broker: limiter, attach: limiter, "attach-mcp": limiter, waitlist: limiter })
            const req = HttpServerRequest.fromWeb(
              new Request("https://app.example/api/shapes/messages", {
                headers: { "cf-connecting-ip": `${a}.${b}.${c}.${d1}` }
              })
            )
            const resOpt = yield* throttle(req).pipe(Effect.provide(silentLogger))
            if (!limiterFails && !allowed) {
              if (Option.isNone(resOpt)) return false
              if (resOpt.value.status !== 429 || resOpt.value.headers["retry-after"] !== "60") return false
            } else {
              if (Option.isSome(resOpt)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ShapeAccess & StackAccess enforce admin/member boundaries, person-only mutations, and 503 on store failure", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        signedIn: Schema.Boolean,
        storeFails: Schema.Boolean,
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        hasAct: Schema.Boolean,
        actKind: Schema.Literals(["agent", "flow", "app", "sandbox"])
      })
    )
    const dummyReq = HttpServerRequest.fromWeb(new Request("https://app.example/api/shapes/admin"))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ signedIn, storeFails, role, hasAct, actKind }) =>
          Effect.gen(function*() {
            const actorVal: Actor.Actor = {
              subject: { kind: "person", id: "p-1" },
              role,
              ...(hasAct ? { act: { kind: actKind, id: "run-1" } } : {})
            }
            const sessions = Actor.Sessions.of({
              resolve: storeFails
                ? Effect.fail(new Actor.SessionsUnavailable({ errorCode: "db_down" }))
                : Effect.succeed(signedIn ? Option.some(actorVal) : Option.none())
            })
            const adminExit = yield* Effect.exit(
              ShapeAccess.admin.pipe(
                Effect.provideService(Actor.Sessions, sessions),
                Effect.provideService(HttpServerRequest.HttpServerRequest, dummyReq)
              )
            )
            if (storeFails) {
              if (!Exit.isFailure(adminExit)) return false
            } else if (signedIn && role === "admin" && !hasAct) {
              if (!Exit.isSuccess(adminExit)) return false
            } else {
              if (!Exit.isFailure(adminExit)) return false
            }

            // StackAccess invariants: agents NEVER mayChange or mayConfigure
            if (hasAct && (StackAccess.mayChange(actorVal) || StackAccess.mayConfigure(actorVal))) return false
            if (StackAccess.viaOf(actorVal) !== (hasAct ? "agent" : "person")) return false
            if (StackAccess.mayConfigure(actorVal) && !StackAccess.mayRetryAny(actorVal)) return false
            if (
              StackAccess.mayRead(signedIn ? Option.some(actorVal) : Option.none()) !==
                (signedIn && Actor.canAsk(actorVal))
            ) return false

            // WriteAuthority pure helpers
            if (WriteAuthority.sessionOf(actorVal) !== undefined) return false
            const withSess: Actor.Actor = { ...actorVal, session: "s-1", alias: "a-1" }
            const prot = WriteAuthority.protectedOf(withSess)
            if (prot === null || prot.sessionId !== "s-1" || prot.alias !== "a-1") return false
            const missingAdmitted = yield* WriteAuthority.admitted(undefined).pipe(
              Effect.provideService(SqlClient.SqlClient, undefined as never)
            )
            if (missingAdmitted !== false) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SocketAccess: roleFresh, leaseFrom, ended, personMatches & forward/admissionOf strip spoofed x-smithers-* headers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        verifiedAt: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })))),
        now: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
        freshMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 600_000 }))),
        expiresAt: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000 })))),
        principal: Schema.Literals(["user-1", "user-2"]),
        expected: Schema.Union([Schema.Undefined, Schema.Literals(["user-1", "user-2", "user-3"])]),
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"]))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ verifiedAt, now, freshMs, expiresAt, principal, expected, role }) =>
          Effect.sync(() => {
            const fresh = SocketAccess.roleFresh(verifiedAt, now, freshMs)
            if (verifiedAt === null && fresh) return false
            if (verifiedAt !== null && fresh !== (now - verifiedAt <= freshMs)) return false

            const admission: SocketAccess.Admission = {
              session: "sess-1",
              alias: null,
              expiresAt,
              admittedAt: now,
              principal,
              role,
              basis: { kind: "run", repoId: "github/acme/app" },
              access: "member"
            }
            const lease = SocketAccess.leaseFrom(admission, now)
            if (lease > now + SocketAccess.LEASE_MS) return false
            if (expiresAt !== null && lease > expiresAt) return false
            if (SocketAccess.ended(admission, now) !== (expiresAt !== null && expiresAt <= now)) return false
            if (SocketAccess.admissionFrom(admission) === undefined) return false
            if (SocketAccess.admissionFrom({ invalid: true }) !== undefined) return false

            const req = HttpServerRequest.fromWeb(
              new Request("https://app.example/ws", {
                headers: {
                  "x-smithers-spoof": "evil",
                  [SocketAccess.ADMISSION_HEADER]: "forged",
                  "x-keep": "ok"
                }
              })
            )
            const forwarded = SocketAccess.forward(req, admission, { "x-smithers-extra": "trusted" })
            if (forwarded.headers["x-smithers-spoof"] !== undefined) return false
            if (forwarded.headers["x-keep"] !== "ok") return false
            if (forwarded.headers["x-smithers-extra"] !== "trusted") return false
            const decoded = SocketAccess.admissionOf(forwarded)
            if (decoded === undefined || decoded.principal !== principal || decoded.role !== role) return false

            const actor: Actor.Actor = { subject: { kind: "person", id: principal }, role }
            if (SocketAccess.personMatches(actor, expected) !== (expected === undefined || expected === principal)) {
              return false
            }
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ModelTiers & ModelRefusal uphold heavy-turn detection, effort precedence, and terminal 402/quota refusal normalization", async () => {
    const effortArb = Schema.Union([Schema.Undefined, Schema.Literals(["low", "medium", "high"])])
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: Schema.Literals(MODEL_ROLES),
        msgRoles: Schema.Array(Schema.Literals(["user", "assistant", "tool", "system"])).pipe(
          Schema.check(Schema.isMaxLength(8))
        ),
        modelId: Schema.Literals([
          "claude-sonnet-5",
          "anthropic/claude-opus-5-5",
          "openai/gpt-5",
          "gpt-6.1-sol",
          "o3-mini",
          "gpt-oss-120b",
          "gpt-4.1-mini",
          "llama-3.3-70b"
        ]),
        recordEffort: effortArb,
        reqEffort: effortArb,
        httpStatus: Schema.Union([Schema.Undefined, Schema.Literals([400, 402, 429, 500, 503])]),
        errCode: ModelError.ModelErrorCode
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ role, msgRoles, modelId, recordEffort, reqEffort, httpStatus, errCode }) =>
          Effect.gen(function*() {
            const request = {
              messages: msgRoles.map((r) => ({ role: r, content: [] })),
              params: reqEffort === undefined ? {} : { reasoningEffort: reqEffort }
            } as unknown as ModelRequest.ModelRequest
            const isHeavy = ModelTiers.heavy(request)
            const lastUser = msgRoles.lastIndexOf("user")
            const lastTool = msgRoles.lastIndexOf("tool")
            if (isHeavy !== (lastTool > lastUser)) return false

            const route = ModelTiers.ROLE_TIERS[role as ModelRole]
            const eff = yield* ModelTiers.effortFor(role as ModelRole, route, request, modelId, recordEffort)
            if (recordEffort !== undefined && eff !== recordEffort) return false
            if (!ModelTiers.acceptsEffort(modelId) && recordEffort === undefined && eff !== reqEffort) return false
            if ((modelId.includes("gpt-4.1") || modelId.includes("llama")) && ModelTiers.acceptsEffort(modelId)) {
              return false
            }

            const err = new ModelError.ModelError({
              code: errCode,
              message: "provider error",
              ...(httpStatus === undefined ? {} : { httpStatus }),
              retryAfterMillis: 5000
            })
            const fin = ModelRefusal.final(err)
            const isTerminal = httpStatus === 402 || errCode === "quota_exceeded" || errCode === "out_of_credit"
            if (isTerminal) {
              if (fin.retryAfterMillis !== undefined) return false
              if (httpStatus === 402 && errCode !== "quota_exceeded" && fin.code !== "out_of_credit") return false
              if (ModelRefusal.final(fin).code !== fin.code) return false
            } else {
              if (fin !== err) return false
            }
            if (ModelRefusal.finalFailure(err)._tag !== fin._tag) return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("NotificationPolicy.select always falls back safely on missing/failing/malformed/oversized policies and deduplicates recipients", async () => {
    const idArb = Schema.Literals(["user-1", "user-2", "user-3", "user-4"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["none", "empty", "valid", "malformed", "excess", "fail", "oversized"]),
        defaults: Schema.Array(idArb).pipe(Schema.check(Schema.isMaxLength(4))),
        picked: Schema.Array(idArb).pipe(Schema.check(Schema.isMaxLength(6))),
        quiet: Schema.Union([Schema.Undefined, Schema.Boolean])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, defaults, picked, quiet }) =>
          Effect.gen(function*() {
            const req: NotificationPolicy.Request = {
              repoId: "github/acme/app",
              kind: "needs_you",
              subject: "issue#1",
              revision: "rev-1",
              candidates: mode === "oversized" ? Array.from({ length: 51 }, (_, i) => `u-${i}`) : ["user-1", "user-2"],
              defaults
            }
            const layer = mode === "none"
              ? Layer.empty
              : Layer.succeed(
                NotificationPolicy.RecipientPolicy,
                NotificationPolicy.RecipientPolicy.of({
                  decide: () => {
                    if (mode === "empty") return Effect.succeed(Option.none())
                    if (mode === "fail") return Effect.fail(new Error("policy crashed"))
                    if (mode === "malformed") return Effect.succeed(Option.some({ recipients: ["bad id with space!"] }))
                    if (mode === "excess") return Effect.succeed(Option.some({ recipients: picked, extraField: 123 }))
                    return Effect.succeed(
                      Option.some({
                        recipients: picked,
                        ...(quiet === undefined ? {} : { handling: { quiet } })
                      })
                    )
                  }
                })
              )
            const sel = yield* NotificationPolicy.select(req).pipe(Effect.provide(layer), Effect.provide(silentLogger))
            if (mode === "valid") {
              if (sel.source !== "policy") return false
              if (sel.recipients.length !== new Set(picked).size) return false
              if (sel.quiet !== quiet) return false
            } else {
              if (sel.source !== "default") return false
              if (sel.recipients.length !== defaults.length) return false
              if (mode === "oversized" && sel.reason !== "policy-unavailable") return false
              if (mode === "fail" && sel.reason !== "policy-failed") return false
              if ((mode === "malformed" || mode === "excess") && sel.reason !== "policy-malformed") return false
            }
            return true
          }),
        { seed: seed + 4, executions: Math.min(executions, 200) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("McpProtocol.handleMcpMessage enforces JSON-RPC 2.0 validation, blocks MCP_BLOCKED_ACTS (with / _ . normalization), and emits 401 RFC 9728 challenges", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "garbage",
          "bad_version",
          "notification",
          "initialize",
          "ping",
          "tools_list",
          "blocked_tool",
          "auth_tool_anon",
          "ok_tool",
          "unknown_method",
          "bad_params"
        ]),
        rawBody: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        protoVer: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
          Schema.Literals(["2025-11-25", "2025-06-18", "2024-01-01"])
        ]),
        blockedAct: Schema.Literals(MCP_BLOCKED_ACTS),
        sep: Schema.Literals(["/", "_", "."])
      })
    )
    const registry = McpToolRegistry.of({
      listTools: () => Effect.succeed([]),
      callTool: (name) =>
        name === "needs_auth"
          ? Effect.fail(new McpToolError({ code: "authentication", message: "sign in" }))
          : Effect.succeed({ content: [{ type: "text", text: `ok:${name}` }] })
    })
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, rawBody, protoVer, blockedAct, sep }) =>
          Effect.gen(function*() {
            const blockedName = blockedAct.replaceAll("/", sep)
            if (!McpProtocol.isBlockedAct(blockedName)) return false
            const negotiated = McpProtocol.negotiateVersion(protoVer)
            if (negotiated !== "2025-11-25" && negotiated !== "2025-06-18" && negotiated !== "2025-03-26") return false

            const body = (() => {
              switch (kind) {
                case "garbage":
                  return `{not-json:${rawBody}`
                case "bad_version":
                  return JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" })
                case "notification":
                  return JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
                case "initialize":
                  return JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: { protocolVersion: protoVer }
                  })
                case "ping":
                  return JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "ping" })
                case "tools_list":
                  return JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
                case "blocked_tool":
                  return JSON.stringify({
                    jsonrpc: "2.0",
                    id: 3,
                    method: "tools/call",
                    params: { name: blockedName, arguments: {} }
                  })
                case "auth_tool_anon":
                  return JSON.stringify({
                    jsonrpc: "2.0",
                    id: 4,
                    method: "tools/call",
                    params: { name: "needs_auth", arguments: {} }
                  })
                case "ok_tool":
                  return JSON.stringify({
                    jsonrpc: "2.0",
                    id: 5,
                    method: "tools/call",
                    params: { name: "repo/read", arguments: {} }
                  })
                case "unknown_method":
                  return JSON.stringify({ jsonrpc: "2.0", id: 6, method: "no/such/method" })
                case "bad_params":
                  return JSON.stringify({
                    jsonrpc: "2.0",
                    id: 7,
                    method: "tools/call",
                    params: { name: "repo/read", arguments: "not-obj" }
                  })
              }
            })()
            const res = yield* McpProtocol.handleMcpMessage(
              { body, principal: Option.none() },
              "https://smithers.sh"
            ).pipe(Effect.provideService(McpToolRegistry, registry), Effect.provide(silentLogger))

            if ((kind === "garbage" || kind === "bad_version") && res.status !== 400) return false
            if (kind === "notification" && res.status !== 202) return false
            if (kind === "auth_tool_anon") {
              if (res.status !== 401) return false
              const www = res.headers["www-authenticate"] ?? ""
              if (!www.includes("resource_metadata=\"https://smithers.sh/.well-known/oauth-protected-resource\"")) {
                return false
              }
            }
            if (
              (kind === "ping" || kind === "initialize" || kind === "tools_list" || kind === "ok_tool" ||
                kind === "blocked_tool") &&
              res.status !== 200
            ) return false
            return true
          }),
        { seed: seed + 5, executions: Math.min(executions, 200) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SecretKeys.make: short keys die, valid keys round-trip AES-256-GCM seal/unseal and reject tampered context", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        keySuffix: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        plaintext: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        repoId: Schema.Literals(["github/acme/app", "github/acme/other"]),
        name: Schema.Literals(["OPENAI_KEY", "STRIPE_KEY"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ keySuffix, plaintext, repoId, name }) =>
          Effect.gen(function*() {
            const secretKey = `0123456789abcdef0123456789abcdef${keySuffix}`
            const keys = yield* SecretKeys.make(Redacted.make(secretKey))
            const ctx = { id: repoId, name, version: keys.version }
            const wellFormed = plaintext.toWellFormed()
            const sealed = yield* keys.cipher.seal(Redacted.make(wellFormed), ctx)
            const opened = yield* keys.cipher.open(sealed, ctx)
            if (Redacted.value(opened) !== wellFormed) return false

            const wrongCtx = { id: `${repoId}-other`, name, version: keys.version }
            const wrongExit = yield* Effect.exit(keys.cipher.open(sealed, wrongCtx).pipe(Effect.provide(silentLogger)))
            if (Exit.isSuccess(wrongExit)) return false

            const p1 = yield* keys.minter.derive("scope-1", name)
            const p2 = yield* keys.minter.derive("scope-1", name)
            if (p1 !== p2) return false
            if (wellFormed.length >= 8 && p1.includes(wellFormed)) return false
            return true
          }),
        { seed: seed + 6, executions: 60 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")

    const shortExit = await Effect.runPromiseExit(SecretKeys.make(Redacted.make("too-short")))
    expect(Exit.isFailure(shortExit)).toBe(true)
  })

  it("TreeScope, ItemShape, Placement, Overflow & PersonalModels uphold BFS distance, SQL parameterization, and protocol mapping invariants", async () => {
    const repoIds = ["github/acme/a", "github/acme/b", "github/acme/c", "github/acme/d", "github/acme/e"] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({
            child: Schema.Literals(repoIds),
            parent: Schema.Literals(repoIds)
          })
        ).pipe(Schema.check(Schema.isMaxLength(10))),
        selected: Schema.NullOr(
          Schema.Union([
            Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
            Schema.Literals(["1", "42", "0", "-1", "1; DROP TABLE items--", "99999999999"])
          ])
        ),
        shapePath: Schema.Literals(["/api/shapes/items", "/api/shapes/comments", "/api/shapes/other"]),
        protocol: Schema.Literals(PROTOCOLS),
        host: Schema.Literals(["api.openai.com", "api.anthropic.com", "openrouter.ai", "gateway.example.com"]),
        modelId: Schema.Literals(["gpt-5", "claude-sonnet-5", "kimi-k2"]),
        labels: Schema.Array(Schema.Literals(["linux", "gpu", "cloudflare", "x64"])).pipe(
          Schema.check(Schema.isMaxLength(5))
        ),
        hint: Schema.NullOr(Placement.LocationHint)
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ edges, selected, shapePath, protocol, host, modelId, labels, hint }) =>
          Effect.sync(() => {
            const ordered = TreeScope.byDistance("github/acme/a", edges)
            if (ordered[0] !== "github/acme/a") return false
            if (ordered.length !== new Set(ordered).size) return false
            const edgeNodes = new Set<string>(edges.flatMap((e) => [e.child, e.parent]))
            for (const id of ordered.slice(1)) {
              if (!edgeNodes.has(id)) return false
            }
            const ans = TreeScope.answer(ordered, new Set(["github/acme/a"]))
            if (ans.repos.length > TREE_SCOPE_MAX_REPOSITORIES) return false
            if (ans.truncated !== (ordered.length > TREE_SCOPE_MAX_REPOSITORIES)) return false
            if (ans.repos.length + ans.omitted.length !== ordered.length) return false

            const parsedTs = TreeScope.parseTreeScopePath("/api/repos/acme/app/issues/tree-scope")
            if (parsedTs === undefined || parsedTs.owner !== "acme" || parsedTs.name !== "app") return false
            if (TreeScope.parseTreeScopePath("/api/repos/%ZZ/app/issues/tree-scope") !== undefined) return false

            const shaped = itemShape(shapePath, "repo_id = $1", "github/acme/app", selected)
            if (shaped !== undefined) {
              if (shaped.where.includes("DROP") || shaped.where.includes(";")) return false
              if (shaped.params["1"] !== "github/acme/app") return false
            }

            const outLabels = Overflow.labelsOf({ labels })
            if (!outLabels.includes(Overflow.LABEL)) return false
            if (outLabels.length !== new Set(outLabels).size) return false
            const bid = Overflow.boxId("github/acme/app")
            if (!Overflow.isBox(bid)) return false

            const wire = PersonalModels.wireOf(protocol, host, modelId)
            if (typeof wire !== "string" || wire.length === 0) return false
            const sc = PersonalModels.sealContext("p-1", 1)
            if (sc.id !== "person:p-1" || sc.version !== 1) return false

            let receivedHint: string | undefined
            const ns = Placement.placed(
              {
                getByName: (_name: string, opts?: { readonly locationHint?: Placement.LocationHint }) => {
                  receivedHint = opts?.locationHint
                  return "stub"
                }
              },
              hint === null ? Option.none() : Option.some(hint)
            )
            ns.getByName("exec-1")
            if (receivedHint !== (hint ?? undefined)) return false
            return true
          }),
        { seed: seed + 7, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
