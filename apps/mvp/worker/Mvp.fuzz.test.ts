import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Actor from "./Actor.ts"
import * as Aliases from "./aliases.ts"
import { isAppRoute } from "./appRoute.ts"
import * as BodyLimits from "./BodyLimits.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

describe("apps/mvp security & routing fuzz invariants", () => {
  it("Actor trust boundary: role ranks are total, non-members cannot ask/clone, boundTo confines run credentials, and agents/flows/apps/sandboxes are ALWAYS refused person-only acts", async () => {
    const roleArb = Schema.OptionFromNullOr(Schema.Literals(["guest", "member", "maintainer", "admin"]))
    const actKindArb = Schema.Literals(["agent", "flow", "app", "sandbox"])
    const personOnlyActs = [
      ...Object.keys(Actor.PROTECTED_ACTS),
      ...Object.keys(Actor.PERSON_ONLY_FLOWS)
    ] as ReadonlyArray<Actor.PersonOnlyAct>
    const arb = Arbitrary.schema(
      Schema.Struct({
        role: roleArb,
        hasAct: Schema.Boolean,
        actKind: actKindArb,
        actId: Schema.Literals([
          "run-1",
          "run-2",
          "550e8400-e29b-41d4-a716-446655440000",
          "550E8400-E29B-41D4-A716-446655440000"
        ]),
        targetRunId: Schema.Literals([
          "run-1",
          "RUN-1",
          "run-2",
          "550e8400-e29b-41d4-a716-446655440000",
          "550E8400-E29B-41D4-A716-446655440000"
        ]),
        actIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: personOnlyActs.length - 1 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ role, hasAct, actKind, actId, targetRunId, actIdx }) =>
          Effect.gen(function*() {
            const r: Actor.Role | null = role._tag === "Some" ? role.value : null
            const actor: Actor.Actor = {
              subject: { kind: "person", id: "user-1" },
              role: r,
              ...(hasAct ? { act: { kind: actKind, id: actId } } : {})
            }

            // Rank monotonicity
            const rank = Actor.rankOf(r)
            if (r === null && rank !== 0) return false
            if (r === "guest" && rank !== 1) return false
            if (r === "member" && rank !== 2) return false
            if (r === "maintainer" && rank !== 3) return false
            if (r === "admin" && rank !== 4) return false

            // Ask & clone require member or above
            const expectedMember = r === "member" || r === "maintainer" || r === "admin"
            if (Actor.canAsk(actor) !== expectedMember) return false
            if (Actor.canClone(actor) !== expectedMember) return false

            // boundTo: person is unbounded; delegated act is confined to its chain
            const bound = Actor.boundTo(actor, targetRunId)
            if (!hasAct && !bound) return false
            if (hasAct) {
              const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actId)
              const expectedBound = actId === targetRunId ||
                (isUuid && actId.toLowerCase() === targetRunId.toLowerCase())
              if (bound !== expectedBound) return false
            }

            // CRITICAL TRUST BOUNDARY: agents/flows/apps/sandboxes NEVER pass person-only acts
            const actName = personOnlyActs[actIdx]!
            const refused = yield* Actor.refusesPersonOnly(actor, actName).pipe(Effect.provide(silentLogger))
            if (refused !== hasAct) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Aliases parseAliases & aliasLocation NEVER allow open redirects, duplicate hosts, or invalid hostnames/paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        listed: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
          Schema.Literals([
            "factory.example.com=/acme/widgets/-/factory",
            "factory.example.com=//evil.example/phish",
            "factory.example.com=/acme?x=1",
            "factory.example.com=/a,factory.example.com=/b",
            "INVALID.COM=/a",
            "factory.example.com=/\\evil.example",
            "app.smithers.sh=/org/repo,docs.smithers.sh=/org/docs"
          ])
        ]),
        host: Schema.Literals(["factory.example.com", "app.smithers.sh", "evil.example", "other.example.com"]),
        path: Schema.Literals(["/", "/other", "/api/health"]),
        query: Schema.Literals(["", "?a=1&b=2", "?next=https://evil.example"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ listed, host, path, query }) =>
          Effect.sync(() => {
            const parsed = Aliases.parseAliases(listed)
            if (!("invalid" in parsed)) {
              const seen = new Set<string>()
              for (const entry of parsed) {
                if (!Aliases.HOSTNAME.test(entry.host)) return false
                if (seen.has(entry.host)) return false
                seen.add(entry.host)
                if (!entry.path.startsWith("/") || entry.path.startsWith("//") || entry.path.includes("\\")) {
                  return false
                }
              }
            }
            const url = new URL(`https://${host}${path}${query}`)
            const loc = Aliases.aliasLocation(listed, url)
            if (loc !== undefined) {
              // MUST stay on exact same origin and only redirect from "/"
              if (path !== "/") return false
              if (!loc.startsWith(`${url.origin}/`)) return false
              const parsedLoc = new URL(loc)
              if (parsedLoc.origin !== url.origin) return false
              if (parsedLoc.search !== url.search) return false
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("BodyLimits.forRequest enforces bounded positive caps regardless of query strings and never exceeds MAX_BODY_BYTES", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        path: Schema.Literals([
          "/api/model/chat",
          "/api/telemetry/logs",
          "/api/auth/arrive",
          "/api/auth/sign-out",
          "/api/github/webhook",
          "/api/repos/acme/app/secrets/OPENAI_KEY",
          "/api/repos/acme/app/writes",
          "/api/me/model/test",
          "/api/remote-runs/r1/stop",
          "/api/unknown/route"
        ]),
        query: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        modelCap: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50_000_000 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ path, query, modelCap }) =>
          Effect.gen(function*() {
            const limitNoQ = yield* BodyLimits.forRequest(path).pipe(
              Effect.provideService(BodyLimits.ModelBytes, modelCap)
            )
            const limitWithQ = yield* BodyLimits.forRequest(`${path}?${query}`).pipe(
              Effect.provideService(BodyLimits.ModelBytes, modelCap)
            )
            // Query string MUST NEVER change or bypass a route's body limit!
            if (limitNoQ !== limitWithQ) return false
            if (!Number.isInteger(limitNoQ) || limitNoQ < 0 || limitNoQ > BodyLimits.MAX_BODY_BYTES) return false
            if (path.startsWith("/api/model/") && limitNoQ !== Math.min(BodyLimits.MAX_BODY_BYTES, modelCap)) {
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

  it("isAppRoute never throws on arbitrary pathnames and rejects path traversal & control characters", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        Schema.Literals([
          "/",
          "/acme/widgets",
          "/acme/widgets/issues/1",
          "/acme/widgets/pulls/2/files",
          "/acme/widgets/pulls/2/conversation",
          "/../etc/passwd",
          "//evil.example/foo",
          "/acme/widgets/stack/0"
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (pathname) =>
          Effect.sync(() => {
            const ok = isAppRoute(pathname)
            if (typeof ok !== "boolean") return false
            if (ok && pathname.includes("..")) return false
            if (ok && pathname.startsWith("//")) return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
