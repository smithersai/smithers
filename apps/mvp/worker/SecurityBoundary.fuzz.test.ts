import { Fuzz } from "@smthrs/fuzz"
import { ModelError, ModelRequest } from "@smthrs/model"
import { Arbitrary, Effect, Layer, Logger, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { MCP_BLOCKED_ACTS, MCP_PROTOCOL_VERSIONS } from "../src/features/mcp/contract.ts"
import { isAppRoute } from "./appRoute.ts"
import * as RegistryEgress from "./branch/RegistryEgress.ts"
import * as Dns from "./domains/Dns.ts"
import { McpToolError, McpToolRegistry } from "./mcp/Contract.ts"
import * as McpProtocol from "./mcp/Protocol.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as Throttle from "./Throttle.vibe"
import { internalNames } from "../src/features/chat/productWords.ts"
import * as ModelRefusal from "./ModelRefusal.ts"
import * as ModelTiers from "./ModelTiers.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("apps/mvp Worker SecurityBoundary fuzz invariants (Throttle, appRoute, RegistryEgress, SessionKeys, Dns, MCP Protocol)", () => {
  it("Throttle.routeOf, networkOf (IPv4/IPv6/mapped), and make enforce rate limits and fail open on limiter failure", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ipKind: Schema.Literals(["ipv4", "ipv4Bad", "ipv6", "mapped", "mappedFull", "garbage", "missing"]),
        o1: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        o2: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        o3: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        o4: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        routeKind: Schema.Literals(["shape", "telemetry", "broker", "unthrottled", "emptyShape"]),
        limiterOutcome: Schema.Literals(["admitted", "limited", "error"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ipKind, o1, o2, o3, o4, routeKind, limiterOutcome }) =>
          Effect.gen(function*() {
            const ip = ipKind === "ipv4"
              ? `${o1}.${o2}.${o3}.${o4}`
              : ipKind === "ipv4Bad"
              ? `${o1 + 256}.${o2}.${o3}.${o4}`
              : ipKind === "ipv6"
              ? `2001:db8:${o1.toString(16)}::${o4.toString(16)}`
              : ipKind === "mapped"
              ? `::ffff:${o1}.${o2}.${o3}.${o4}`
              : ipKind === "mappedFull"
              ? `0:0:0:0:0:ffff:${o1}.${o2}.${o3}.${o4}`
              : ipKind === "garbage"
              ? "not-an-ip:::"
              : undefined

            const headers: Record<string, string | undefined> = ip === undefined ? {} : { "cf-connecting-ip": ip }
            const net = Throttle.networkOf(headers)
            if (ipKind === "ipv4" || ipKind === "mapped" || ipKind === "mappedFull") {
              if (net !== `${o1}.${o2}.${o3}.0/24`) return false
            } else if (ipKind === "ipv6") {
              if (net !== `2001:db8:${o1.toString(16)}::/48`) return false
            } else {
              if (net !== "unknown") return false
            }

            const url = routeKind === "shape"
              ? `/api/shapes/todos?offset=-1`
              : routeKind === "telemetry"
              ? `/api/telemetry/v1/traces`
              : routeKind === "broker"
              ? `/api/auth/callback?state=ghb_abc`
              : routeKind === "emptyShape"
              ? `/api/shapes/`
              : `/api/health`
            const route = Throttle.routeOf(url)
            if (routeKind === "shape" && route !== "shape") return false
            if (routeKind === "telemetry" && route !== "telemetry") return false
            if (routeKind === "unthrottled" && route !== undefined) return false
            if (routeKind === "emptyShape" && route !== undefined) return false

            const seenKeys: Array<string> = []
            const limiter: Throttle.Limiter = {
              limit: ({ key }) => {
                seenKeys.push(key)
                if (limiterOutcome === "error") return Effect.fail(new Error("limiter down"))
                return Effect.succeed({ success: limiterOutcome === "admitted" })
              }
            }
            const throttle = Throttle.make({ shape: limiter, telemetry: limiter, broker: limiter, attach: limiter, "attach-mcp": limiter, waitlist: limiter })
            const req = HttpServerRequest.fromWeb(
              new Request(`https://app.smithers.sh${url}`, {
                method: "GET",
                headers: ip === undefined ? {} : { "cf-connecting-ip": ip }
              })
            )
            const res = yield* throttle(req)
            if (route === undefined) {
              return Option.isNone(res) && seenKeys.length === 0
            }
            if (seenKeys.length !== 1 || seenKeys[0] !== net) return false
            if (limiterOutcome === "limited") {
              return Option.isSome(res) && res.value.status === 429 && res.value.headers["retry-after"] === "60"
            }
            return Option.isNone(res)
          }),
        { executions, seed }
      ).pipe(Effect.provide(Logger.layer([])))
    )
    const failure = Fuzz.formatReport(report); if (failure !== undefined) throw new Error(failure); expect(report._tag).toBe("Passed")
  })

  it("appRoute.isAppRoute validates repo slugs, issue/todo numbers, pull tabs, and rejects invalid/wildcard paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["root", "repo", "issue", "todo", "pullTab", "random"]),
        owner: Schema.Literals(["octocat", "smithersai", "..", "bad owner", "a\u0000b"]),
        repo: Schema.Literals(["smithers", "app.js", "..", ".git", "bad/repo"]),
        num: Schema.Literals(["1", "42", "0", "-1", "abc", "999999999999999999"]),
        tab: Schema.Literals(["conversation", "commits", "files", "checks", "bogus"]),
        raw: Schema.String.check(Schema.isMaxLength(48))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, owner, repo, num, tab, raw }) =>
          Effect.sync(() => {
            if (kind === "root") {
              return isAppRoute("/") === true
            }
            if (kind === "repo") {
              const valid = /^[a-zA-Z0-9._-]+$/.test(owner) && /^[a-zA-Z0-9._-]+$/.test(repo) &&
                owner !== ".." && repo !== ".." && repo !== ".git"
              const res = isAppRoute(`/${owner}/${repo}`)
              if (!valid && res) return false
              return typeof res === "boolean"
            }
            if (kind === "issue") {
              const res = isAppRoute(`/octocat/smithers/issues/${num}`)
              const expected = num === "1" || num === "42"
              return res === expected
            }
            if (kind === "todo") {
              const res = isAppRoute(`/octocat/smithers/stack/${num}`)
              const expected = num === "1" || num === "42"
              return res === expected
            }
            if (kind === "pullTab") {
              const res = isAppRoute(`/octocat/smithers/pulls/1/${tab}`)
              if (tab === "conversation" || tab === "bogus") return res === false
              return typeof res === "boolean"
            }
            const clean = raw.startsWith("/") ? raw : `/${raw}`
            const res = isAppRoute(clean)
            return typeof res === "boolean"
          }),
        { executions, seed: seed + 1 }
      )
    )
    const failure = Fuzz.formatReport(report); if (failure !== undefined) throw new Error(failure); expect(report._tag).toBe("Passed")
  })

  it("RegistryEgress allows only exact HOSTS without secrets and refuses all other hosts with 403", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Literals([
          ...RegistryEgress.HOSTS,
          "evil.example.com",
          "registry.npmjs.org.evil.com",
          "169.254.169.254",
          "localhost",
          "127.0.0.1",
          "api.anthropic.com"
        ]),
        method: Schema.Literals(["GET", "POST", "HEAD"]),
        secretsOn: Schema.Boolean,
        branchKind: Schema.Literals(["branch", "job", "none"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ host, method, secretsOn, branchKind }) =>
          Effect.gen(function*() {
            const branch = branchKind === "none"
              ? undefined
              : ({ kind: branchKind } as Parameters<typeof RegistryEgress.secretsEgress>[0])
            const usesSecrets = RegistryEgress.secretsEgress(branch, secretsOn)
            if (usesSecrets !== (secretsOn && branchKind !== "job")) return false

            const trust = RegistryEgress.trustOf("/ca.crt")
            if (trust.NODE_EXTRA_CA_CERTS !== "/ca.crt" || trust.DPRINT_CERT !== "/ca.crt") return false

            let forwarded = false
            const fakeHttp = HttpClient.make((req) =>
              Effect.sync(() => {
                forwarded = true
                return HttpClientResponse.fromWeb(req, new Response("ok", { status: 200 }))
              })
            )
            const req = HttpServerRequest.fromWeb(
              new Request(`https://${host}/pkg`, { method })
            )
            const res = yield* RegistryEgress.forward(req).pipe(
              Effect.provideService(HttpClient.HttpClient, fakeHttp)
            )
            const allowed = (RegistryEgress.HOSTS as ReadonlyArray<string>).includes(host)
            if (allowed) {
              return forwarded && res.status === 200
            }
            return !forwarded && res.status === 403
          }),
        { executions, seed: seed + 2 }
      ).pipe(Effect.provide(Logger.layer([])))
    )
    const failure = Fuzz.formatReport(report); if (failure !== undefined) throw new Error(failure); expect(report._tag).toBe("Passed")
  })

  it("SessionKeys.decodeSecrets & sign/verify/seal/open uphold integrity, purpose isolation, and key-map validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        purposeA: Schema.Literals(["session", "sign_in", "handoff", "handoff_request", "run"]),
        purposeB: Schema.Literals(["session", "sign_in", "handoff", "handoff_request", "run"]),
        payload: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(48)),
        keyId: Schema.Literals(["k1", "k2"]),
        badJson: Schema.Literals([
          "not-json",
          "[]",
          "{}",
          JSON.stringify({ "bad key": "a".repeat(32) }),
          JSON.stringify({ k1: "too-short" }),
          JSON.stringify({ k1: "x".repeat(32), k2: "x".repeat(32) }),
          JSON.stringify({ k1: 12345 })
        ])
      })
    )
    const keys = await Effect.runPromise(
      SessionKeys.make(Redacted.make("s".repeat(40)), {
        secrets: {
          k1: Redacted.make("1".repeat(40)),
          k2: Redacted.make("2".repeat(40))
        }
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ purposeA, purposeB, payload, keyId, badJson }) =>
          Effect.gen(function*() {
            if (Option.isSome(SessionKeys.decodeSecrets(Redacted.make(badJson)))) return false
            const goodJson = JSON.stringify({ k1: "a".repeat(32), k2: "b".repeat(32) })
            const decoded = SessionKeys.decodeSecrets(Redacted.make(goodJson))
            if (Option.isNone(decoded) || Object.keys(decoded.value).length !== 2) return false

            const signed = yield* keys.sign(purposeA, payload, keyId)
            const ok = yield* keys.verify(purposeA, signed)
            if (Option.isNone(ok) || ok.value.value !== payload || ok.value.keyId !== keyId) return false

            const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`
            const bad = yield* keys.verify(purposeA, tampered)
            if (Option.isSome(bad)) return false

            if (purposeA !== purposeB) {
              const cross = yield* keys.verify(purposeB, signed)
              if (Option.isSome(cross)) return false
            }

            const sealed = yield* keys.seal(Redacted.make(payload), {
              id: keyId, name: purposeA, version: 1
            })
            const opened = yield* keys.open(sealed, {
              id: keyId, name: purposeA, version: 1
            }).pipe(Effect.option)
            if (Option.isNone(opened) || Redacted.value(opened.value) !== payload.toWellFormed()) return false

            const wrongCtx = yield* keys.open(sealed, {
              id: keyId === "k1" ? "k2" : "k1", name: purposeA, version: 1
            }).pipe(Effect.option)
            return Option.isNone(wrongCtx)
          }),
        { executions: Math.min(executions, 80), seed: seed + 3 }
      )
    )
    const failure = Fuzz.formatReport(report); if (failure !== undefined) throw new Error(failure); expect(report._tag).toBe("Passed")
  })

  it("domains/Dns.pointsAt & make handle trailing dots, case, non-CNAME records, HTTP errors, and malformed JSON", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        target: Schema.Literals(["edge.smithers.sh", "EDGE.SMITHERS.SH."]),
        answerType: Schema.Literals([1, 5, 16]),
        answerData: Schema.Literals(["edge.smithers.sh.", "edge.smithers.sh", "EDGE.SMITHERS.SH.", "other.example.com."]),
        httpMode: Schema.Literals(["ok", "malformed", "status500", "networkFail"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ target, answerType, answerData, httpMode }) =>
          Effect.gen(function*() {
            const expectedMatch = answerType === 5 &&
              answerData.toLowerCase().replace(/\.$/, "") === target.toLowerCase().replace(/\.$/, "")
            const ans = { Status: 0, Answer: [{ type: answerType, data: answerData }] }
            if (Dns.pointsAt(target, ans) !== expectedMatch) return false

            const fakeHttp = HttpClient.make((req) => {
              if (httpMode === "networkFail") {
                return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req, description: "offline" }) }))
              }
              if (httpMode === "status500") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("err", { status: 500 })))
              }
              if (httpMode === "malformed") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{bad", { status: 200 })))
              }
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify(ans), { status: 200 })))
            })
            const provider = yield* Dns.make({ zone: "smithers.sh.", target }).pipe(
              Effect.provideService(HttpClient.HttpClient, fakeHttp)
            )
            const res = yield* provider.ensure("custom.example.com").pipe(Effect.result)
            if (httpMode === "ok") {
              return res._tag === "Success" &&
                res.success.verification === (expectedMatch ? "active" : "pending") &&
                res.success.certificate === "unmanaged"
            }
            return res._tag === "Failure" && res.failure._tag === "@smthrs/mvp/domains/ProviderUnavailable"
          }),
        { executions, seed: seed + 4 }
      )
    )
    const failure = Fuzz.formatReport(report); if (failure !== undefined) throw new Error(failure); expect(report._tag).toBe("Passed")
  })

  it("mcp/Protocol.handleMcpMessage enforces JSON-RPC 2.0, blocked person-only acts, auth 401 challenge, and version negotiation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "badJson",
          "batch",
          "badVersion",
          "notification",
          "initialize",
          "ping",
          "listTools",
          "callBlocked",
          "callOk",
          "callUnauth",
          "callBadParams",
          "unknownMethod"
        ]),
        version: Schema.Literals([...MCP_PROTOCOL_VERSIONS, "1999-01-01", ""]),
        blockedIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Math.max(0, MCP_BLOCKED_ACTS.length - 1) })),
        blockedSep: Schema.Literals(["/", "_", "."]),
        id: Schema.NullOr(Schema.Literals(["req-1", 42]))
      })
    )
    const fakeRegistry = Layer.succeed(
      McpToolRegistry,
      McpToolRegistry.of({
        listTools: () => Effect.succeed([{ name: "repo/read", description: "read", inputSchema: { type: "object" } }]),
        callTool: (name) =>
          name === "needs/auth"
            ? Effect.fail(new McpToolError({ code: "authentication", message: "sign in" }))
            : Effect.succeed({ content: [{ type: "text", text: "ok" }] })
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, version, blockedIdx, blockedSep, id }) =>
          Effect.gen(function*() {
            const negotiated = McpProtocol.negotiateVersion(version)
            if ((MCP_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(version)) {
              if (negotiated !== version) return false
            } else if (negotiated !== McpProtocol.LATEST_PROTOCOL_VERSION) {
              return false
            }

            const blockedAct = MCP_BLOCKED_ACTS[blockedIdx] ?? "pull/merge"
            const blockedVariant = blockedAct.replace(/\//g, blockedSep)
            if (!McpProtocol.isBlockedAct(blockedVariant)) return false

            const body = kind === "badJson"
              ? "{not-json"
              : kind === "batch"
              ? JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])
              : kind === "badVersion"
              ? JSON.stringify({ jsonrpc: "1.0", id, method: "ping" })
              : kind === "notification"
              ? JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
              : kind === "initialize"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: version } })
              : kind === "ping"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })
              : kind === "listTools"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })
              : kind === "callBlocked"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: blockedVariant, arguments: {} } })
              : kind === "callOk"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "repo/read", arguments: {} } })
              : kind === "callUnauth"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "needs/auth", arguments: {} } })
              : kind === "callBadParams"
              ? JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "repo/read", arguments: "not-obj" } })
              : JSON.stringify({ jsonrpc: "2.0", id, method: "no/such/method" })

            const res = yield* McpProtocol.handleMcpMessage(
              { body, principal: Option.none() },
              "https://app.smithers.sh",
              { owner: "octocat", name: "smithers" }
            ).pipe(Effect.provide(fakeRegistry))

            if (kind === "badJson" || kind === "batch" || kind === "badVersion") {
              return res.status === 400
            }
            if (kind === "notification") {
              return res.status === 202
            }
            if (kind === "callUnauth") {
              const www = res.headers["www-authenticate"] ?? ""
              return res.status === 401 && www.includes("resource_metadata=")
            }
            return res.status === 200
          }),
        { executions, seed: seed + 5 }
      ).pipe(Effect.provide(Logger.layer([])))
    )
    const failure = Fuzz.formatReport(report); if (failure !== undefined) throw new Error(failure); expect(report._tag).toBe("Passed")
  })

  it("ModelRefusal, ModelTiers, and agent/words.internalNames uphold terminal refusals, effort gating, and product-word filtering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        httpStatus: Schema.Literals([400, 402, 429, 500, 503]),
        code: Schema.Literals(["rate_limited", "quota_exceeded", "out_of_credit", "provider_internal"]),
        modelId: Schema.Literals([
          "claude-sonnet-4-6",
          "anthropic/claude-opus-4-6",
          "openai/gpt-5",
          "o3-mini",
          "gpt-4.1-mini",
          "gemini-2.5-flash"
        ]),
        hasToolAfterUser: Schema.Boolean,
        fencedCode: Schema.Boolean,
        leakToken: Schema.Literals(["ctx.call", "flow_failed", "WebPageRefused", "12345678-1234-1234-1234-123456789abc", "plain prose"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ httpStatus, code, modelId, hasToolAfterUser, fencedCode, leakToken }) =>
          Effect.gen(function*() {
            const err = new ModelError.ModelError({
              code,
              message: "provider error",
              httpStatus,
              retryAfterMillis: 5_000
            })
            const fin = ModelRefusal.final(err)
            if (httpStatus === 402 || code === "quota_exceeded" || code === "out_of_credit") {
              if (fin.retryAfterMillis !== undefined) return false
              if (httpStatus === 402 && code !== "quota_exceeded" && fin.code !== "out_of_credit") return false
            } else {
              if (fin !== err) return false
            }
            if (ModelRefusal.finalFailure(err) !== fin && httpStatus !== 402 && code !== "quota_exceeded" && code !== "out_of_credit") return false

            const messages: Array<ModelRequest.Message> = [
              ModelRequest.Message.user("hi"),
              ...(hasToolAfterUser ? [ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "t1", content: "ok" }))] : [])
            ]
            const req = ModelRequest.ModelRequest.make({
              modelId,
              system: [],
              messages,
              tools: [],
              params: ModelRequest.GenerationParams.make({})
            })
            if (ModelTiers.heavy(req) !== hasToolAfterUser) return false
            const takesEffort = ModelTiers.acceptsEffort(modelId)
            const eff = yield* ModelTiers.effortFor("agent", ModelTiers.ROLE_TIERS.agent, req, modelId)
            if (hasToolAfterUser && takesEffort && eff !== "high") return false
            if (!takesEffort && eff !== undefined) return false

            const text = fencedCode ? `Here is code:\n\`\`\`ts\n${leakToken}\n\`\`\`\nDone.` : `Result: ${leakToken} ok`
            const found = internalNames(text)
            if (fencedCode) {
              if (found.length !== 0) return false
            } else if (leakToken !== "plain prose") {
              if (!found.includes(leakToken)) return false
            } else {
              if (found.length !== 0) return false
            }
            return true
          }),
        { executions, seed: seed + 6 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
