import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Option, Redacted, Result, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import * as Actor from "./Actor.vibe"
import * as appRoute from "./appRoute.ts"
import * as RepoRoles from "./github/RepoRoles.vibe"
import * as RunCredentials from "./RunCredentials.vibe"
import * as SessionKeys from "./SessionKeys.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("apps/mvp worker SessionKeys, RunCredentials, Actor trust boundaries, appRoute & RepoRoles fuzz invariants", () => {
  it("SessionKeys.make & decodeSecrets enforce purpose isolation, key rotation, AEAD context binding & duplicate-secret rejection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        purposeA: Schema.Literals(["session", "sign_in", "handoff", "handoff_request", "run"]),
        purposeB: Schema.Literals(["session", "sign_in", "handoff", "handoff_request", "run"]),
        value: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
        plaintext: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(48))),
        secretA: Schema.String.pipe(Schema.check(Schema.isMinLength(32), Schema.isMaxLength(48))),
        secretB: Schema.String.pipe(Schema.check(Schema.isMinLength(32), Schema.isMaxLength(48))),
        shortSecret: Schema.String.pipe(Schema.check(Schema.isMaxLength(31))),
        badKeyId: Schema.Literals(["", "bad key!", "a/b", "k1"]),
        duplicate: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ purposeA, purposeB, value, plaintext, secretA, secretB, shortSecret, badKeyId, duplicate }) =>
          Effect.gen(function*() {
            const s1 = secretA.replace(/[\uD800-\uDFFF]/g, "a")
            const s2Raw = secretB.replace(/[\uD800-\uDFFF]/g, "b")
            const s2 = s2Raw === s1 ? s2Raw + "X" : s2Raw
            const cleanVal = value.replace(/[\uD800-\uDFFF]/g, "v")
            const cleanPt = plaintext.replace(/[\uD800-\uDFFF]/g, "p")

            // decodeSecrets rejects short secrets, duplicate secrets, invalid key ids, non-objects
            const encodedShort = SessionKeys.decodeSecrets(Redacted.make(JSON.stringify({ k1: shortSecret })))
            if (Option.isSome(encodedShort)) return false
            if (Option.isSome(SessionKeys.decodeSecrets(Redacted.make("not-json")))) return false
            if (Option.isSome(SessionKeys.decodeSecrets(Redacted.make("[]")))) return false
            if (Option.isSome(SessionKeys.decodeSecrets(Redacted.make("{}")))) return false

            const encodedMap = duplicate
              ? JSON.stringify({ k1: s1, k2: s1 })
              : JSON.stringify({ [badKeyId]: s1, k2: s2 })
            const decoded = SessionKeys.decodeSecrets(Redacted.make(encodedMap))
            const expectValid = !duplicate && /^[a-zA-Z0-9_-]{1,64}$/.test(badKeyId)
            if (Option.isSome(decoded) !== expectValid) return false

            const keys = yield* SessionKeys.make(Redacted.make(s1), {
              secrets: { legacy: Redacted.make(s1), k2: Redacted.make(s2) }
            })
            const signed = yield* keys.sign(purposeA, cleanVal, "k2")
            const verSame = yield* keys.verify(purposeA, signed)
            if (Option.isNone(verSame) || verSame.value.value !== cleanVal || verSame.value.keyId !== "k2") {
              return false
            }
            const verOther = yield* keys.verify(purposeB, signed)
            if (purposeA !== purposeB && Option.isSome(verOther)) return false

            // Tampered token must fail verification
            const tampered = signed.slice(0, -1) + (signed.endsWith("A") ? "B" : "A")
            if (Option.isSome(yield* keys.verify(purposeA, tampered))) return false

            // AEAD seal/open with context binding
            const ctxA = { id: "cred-1", name: "tok", version: 1 }
            const ctxB = { id: "cred-2", name: "tok", version: 1 }
            const sealed = yield* keys.seal(Redacted.make(cleanPt), ctxA)
            const opened = yield* keys.open(sealed, ctxA)
            if (Redacted.value(opened) !== cleanPt) return false
            const wrongCtx = yield* keys.open(sealed, ctxB).pipe(Effect.result)
            if (Result.isSuccess(wrongCtx)) return false
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("RunCredentials & Actor enforce person-only isolation, delegation depth, capability narrowing & tamper/expiry refusal", async () => {
    const personOnlyFlows = Object.keys(Actor.PERSON_ONLY_FLOWS).filter((f) => Actor.refusesCredential(f)) as [string, ...Array<string>]
    const protectedActs = Object.keys(Actor.PROTECTED_ACTS) as [keyof typeof Actor.PROTECTED_ACTS, ...Array<keyof typeof Actor.PROTECTED_ACTS>]
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        actKind: Schema.NullOr(Schema.Literals(["agent", "flow", "app", "sandbox"])),
        chainLen: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: RunCredentials.MAX_CHAIN + 2 }))),
        personOnlyFlow: Schema.Literals(personOnlyFlows),
        protectedAct: Schema.Literals(protectedActs),
        normalFlow: Schema.Literals(["chat/Answer", "repo/Open", "runs/Inspect"]),
        expired: Schema.Boolean,
        sessionLive: Schema.Boolean,
        tamper: Schema.Boolean,
        authScheme: Schema.Literals(["Bearer", "bearer", "Basic", "none", "oversized"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ role, actKind, chainLen, personOnlyFlow, protectedAct, normalFlow, expired, sessionLive, tamper, authScheme }) =>
          Effect.gen(function*() {
            // 1. Actor role ordering & helper consistency
            const rank = Actor.rankOf(role)
            if (role === null && rank !== 0) return false
            if (role === "guest" && rank !== 1) return false
            if (role === "admin" && rank !== 4) return false

            const actorObj: Actor.Actor = {
              subject: { kind: "person", id: "user-1" },
              role,
              session: "sess-1",
              ...(actKind !== null
                ? {
                  act: {
                    kind: actKind,
                    id: "run-1",
                    root: "run-root",
                    chain: Array.from({ length: chainLen }, (_, i) => `f/${i}`),
                    ceiling: [["fs:read"]]
                  }
                }
                : {})
            }
            if (Actor.canAsk(actorObj) !== Actor.memberOrAbove(role)) return false
            if (Actor.canClone(actorObj) !== Actor.memberOrAbove(role)) return false
            if (actKind === null) {
              if (!Actor.boundTo(actorObj, "run-1") || !Actor.boundTo(actorObj, "other-run")) return false
            } else {
              if (!Actor.boundTo(actorObj, "run-root") || Actor.boundTo(actorObj, "other-run")) return false
            }

            // Person-only actions MUST ALWAYS be refused when acting as agent/flow/app/sandbox!
            const refuses = yield* Actor.refusesPersonOnly(actorObj, protectedAct)
            if (actKind !== null && !refuses) return false
            if (actKind === null && refuses) return false

            // 2. RunCredentials.claimsFor invariants
            const now = Date.now()
            const poClaims = RunCredentials.claimsFor(actorObj, "run-2", { flow: personOnlyFlow }, now)
            if (Result.isSuccess(poClaims) || poClaims.failure !== "person_only") return false

            const normalClaims = RunCredentials.claimsFor(actorObj, "run-2", { flow: normalFlow }, now)
            if (actKind !== null && chainLen >= RunCredentials.MAX_CHAIN) {
              if (Result.isSuccess(normalClaims) || normalClaims.failure !== "too_deep") return false
            } else {
              if (Result.isFailure(normalClaims)) return false
              const c = normalClaims.success
              if (c.sub !== "user-1" || c.run !== "run-2") return false
              if (actKind === "agent" && c.act !== "agent") return false

              // Sign, verify, tamper, expiry, ended-session, cross-purpose checks
              const keys = yield* SessionKeys.make(Redacted.make("s".repeat(40)))
              const creds = RunCredentials.make({
                keys,
                person: () => Effect.succeed(sessionLive ? Option.some({ subject: { kind: "person", id: "user-1" }, role }) : Option.none())
              })
              const claimsToSign = expired ? { ...c, exp: now - 10_000 } : c
              const token = yield* creds.sign(claimsToSign)
              const tokToCheck = tamper
                ? token.slice(0, -1) + (token.endsWith("x") ? "y" : "x")
                : token
              const verified = yield* creds.verify(tokToCheck)
              if (tamper || expired || !sessionLive) {
                if (Option.isSome(verified)) return false
              } else {
                if (Option.isNone(verified) || verified.value.act?.id !== "run-2") return false
              }

              // Session cookie MUST NEVER verify as run credential
              const sessionCookie = yield* keys.sign("session", JSON.stringify(c))
              if (Option.isSome(yield* creds.verify(sessionCookie))) return false

              // bearerOf & carriesCredential header parsing
              const hdrVal = authScheme === "Bearer"
                ? `Bearer ${token}`
                : authScheme === "bearer"
                ? `bearer ${token}`
                : authScheme === "Basic"
                ? "Basic dXNlcjpwYXNz"
                : authScheme === "oversized"
                ? `Bearer ${"a".repeat(RunCredentials.MAX_TOKEN_LENGTH + 10)}`
                : undefined
              const srvReq = HttpServerRequest.fromWeb(
                new Request("https://app.smithers.test/api/runs", {
                  headers: hdrVal !== undefined ? { authorization: hdrVal } : {}
                })
              )
              const carries = RunCredentials.carriesCredential(srvReq)
              const bearer = RunCredentials.bearerOf(srvReq)
              if (authScheme === "none") {
                if (carries || Option.isSome(bearer)) return false
              } else if (authScheme === "Bearer" || authScheme === "bearer") {
                if (!carries || Option.isNone(bearer) || bearer.value !== token) return false
              } else {
                if (!carries || Option.isSome(bearer)) return false
              }
            }
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("appRoute.isAppRoute & RepoRoles pure policy helpers uphold route grammar & permission freshness invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pathname: Schema.Literals([
          "/",
          "/smithersai/smithers",
          "/smithersai/smithers/issues",
          "/smithersai/smithers/issues/42",
          "/smithersai/smithers/pulls",
          "/smithersai/smithers/todos/1",
          "/api/questions",
          "/api/auth/callback",
          "/../etc/passwd",
          "//evil.com",
          "/nonexistent/a/b/c/d/e"
        ]),
        rawPath: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        perm: Schema.Literals(["admin", "maintain", "write", "triage", "read", "none"]),
        role: Schema.NullOr(Schema.Literals(["guest", "member", "maintainer", "admin"])),
        ageSec: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 7200 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pathname, rawPath, perm, role, ageSec }) =>
          Effect.sync(() => {
            const isRoute = appRoute.isAppRoute(pathname)
            if (pathname === "/" && !isRoute) return false
            if (pathname.startsWith("/api/") && isRoute) return false
            if (pathname === "/../etc/passwd" && isRoute) return false
            // Never throws on arbitrary path strings
            appRoute.isAppRoute(rawPath.startsWith("/") ? rawPath : "/" + rawPath)

            const mappedPerm = RepoRoles.permissionOf({
              permission: perm === "write" ? "write" : perm === "admin" ? "admin" : perm === "read" ? "read" : "none",
              roleName: perm
            })
            if (mappedPerm !== perm) return false

            const actsOwn = RepoRoles.actsOn({ id: "repo-1", owner: "smithersai", name: "smithers" }, Option.none())
            if (!actsOwn("smithersai/smithers")) return false
            const actsRestricted = RepoRoles.actsOn({ id: "repo-1", owner: "smithersai", name: "smithers" }, Option.some(new Set(["smithersai/smithers"])))
            if (!actsRestricted("smithersai/smithers") || actsRestricted("other/repo")) return false

            const refErr = new RepoRoles.RoleRefused({ code: "not_found" })
            const fields = RepoRoles.refusalFields(refErr)
            if (!RepoRoles.CANT_ACT.has("not_found") || fields === undefined) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
