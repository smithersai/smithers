import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Frames from "./frames.ts"
import * as ProblemsMod from "./problems.ts"
import * as Redact from "./redact.ts"
import * as Spend from "./spend.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("apps/mvp e2e pure helper fuzz invariants", () => {
  it("Frames: plan, cutIdle, holdChapters, outputStarts, chaptersOf, retime, themeFor & plainLabel uphold pacing and determinism", async () => {
    const frameArb = Schema.Struct({
      detail: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
      changed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5000 })))
    })
    const markArb = Schema.Struct({
      start: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 15_000 }))),
      dur: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3000 })))),
      label: Schema.Literals([
        "Open /app",
        "Open /acme/app/tree/main?terminal=me",
        "Click \"Share\" button",
        "Click the page",
        "Type in \"Message Smithers\" field",
        "Press Enter in \"Message Smithers\" field",
        "Maya: Step 550e8400-e29b-41d4-a716-446655440000"
      ])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        frames: Schema.Array(frameArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
        marks: Schema.Array(markArb).pipe(Schema.check(Schema.isMaxLength(10))),
        spec: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        title: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        gifBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ frames, marks, spec, title, gifBytes }) =>
          Effect.sync(() => {
            const repeat = Frames.plan(frames, Frames.GIF_PACE)
            if (repeat.length !== frames.length) return false
            // Blank frames MUST always be dropped by plan()
            for (let i = 0; i < frames.length; i++) {
              if (repeat[i]! < 0 || !Number.isInteger(repeat[i]!)) return false
              if (Frames.isBlank(frames[i]!) && repeat[i] !== 0) return false
            }
            const cut = Frames.cutIdle(repeat, frames, Frames.GIF_PACE)
            if (cut.length !== frames.length) return false
            if (cut.some((c) => c < 0)) return false

            const starts = Frames.outputStarts(cut)
            if (starts.length !== cut.length) return false
            for (let i = 1; i < starts.length; i++) {
              if (starts[i]! < starts[i - 1]!) return false
            }

            // chaptersOf: sorted non-negative timestamps, no consecutive duplicate labels, UUIDs redacted
            const realMarks: ReadonlyArray<Frames.Mark> = marks.map((m) => ({
              start: m.start,
              ...(m.dur === null ? {} : { end: m.start + m.dur }),
              label: m.label
            }))
            const chapters = Frames.chaptersOf(realMarks, 1000)
            for (let i = 0; i < chapters.length; i++) {
              if (chapters[i]!.t < 0) return false
              if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(chapters[i]!.label)) return false
              if (i > 0 && chapters[i]!.t < chapters[i - 1]!.t) return false
              if (i > 0 && chapters[i]!.label === chapters[i - 1]!.label) return false
            }
            const held = Frames.holdChapters(cut, frames, chapters, Frames.GIF_PACE.chapter)
            if (held.length !== frames.length) return false
            const retimed = Frames.retime(chapters, held)
            for (let i = 1; i < retimed.length; i++) {
              if (retimed[i]!.t < retimed[i - 1]!.t) return false
            }

            // themeFor determinism & override precedence
            const t1 = Frames.themeFor(spec, title)
            const t2 = Frames.themeFor(spec, title)
            if (t1 !== t2 || (t1 !== "light" && t1 !== "dark")) return false
            if (Frames.themeFor(spec, title, [{ type: "theme", description: "dark" }]) !== "dark") return false
            if (Frames.themeFor(spec, title, [{ type: "theme", description: "light" }]) !== "light") return false

            // problems detects oversize GIFs
            const probs = Frames.problems(frames, gifBytes)
            if (gifBytes > Frames.MAX_GIF_BYTES && !probs.some((p) => p.startsWith("too big:"))) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Problems: pathOf strips query values & UUIDs, bodyCodeOf bounds identifiers, and shape retry allowance caps at SHAPE_RETRIES", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 200, maximum: 599 }))),
        retryCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        secretVal: Schema.Literals(["supersecret123", "private-org", "token_xyz"]),
        rawCode: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
          Schema.Literals(["rate_limited", "app_not_installed", "BAD_UPPER", "<html>error</html>", ""])
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, retryCount, secretVal, rawCode }) =>
          Effect.sync(() => {
            const url = `https://app.test/api/shapes/550e8400-e29b-41d4-a716-446655440000?z=${secretVal}&a=${secretVal}`
            const p = ProblemsMod.pathOf(url)
            // Query values and UUIDs MUST never leak into pathOf
            if (p.includes(secretVal) || p.includes("550e8400")) return false
            if (p !== "/api/shapes/:id?a&z") return false

            const bc = ProblemsMod.bodyCodeOf({ code: rawCode })
            if (bc !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(bc)) return false

            // Problems tracker shape retry allowance: <= SHAPE_RETRIES is excused, > SHAPE_RETRIES is UNDECLARED
            const tracker = new ProblemsMod.Problems("https://app.test")
            for (let i = 0; i < retryCount; i++) {
              tracker.note({
                kind: "response",
                method: "GET",
                url: `https://app.test/api/shapes/items?offset=${i}`,
                status: 503,
                retryAfter: "5"
              })
            }
            const undeclared = tracker.undeclared([])
            if (retryCount <= ProblemsMod.SHAPE_RETRIES && undeclared.length !== 0) return false
            if (retryCount > ProblemsMod.SHAPE_RETRIES && undeclared.length === 0) return false

            // Non-5xx responses from origin are never problems
            const obs = ProblemsMod.problemOf("https://app.test", {
              kind: "response",
              method: "GET",
              url: "https://app.test/api/health",
              status
            })
            if ((status >= 500) !== (obs !== undefined)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Spend.parseTimestamp/spentSince/tokenBudget & Redact.redact NEVER leak cookie/authorization secrets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        year: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2020, maximum: 2030 }))),
        month: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
        day: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 28 }))),
        hour: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 23 }))),
        inTok: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
        outTok: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
        role: Schema.Literals(["user", "assistant", "system"]),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(8), Schema.isMaxLength(40))),
        headerName: Schema.Literals(["cookie", "Cookie", "set-cookie", "Set-Cookie", "authorization", "Authorization"]),
        budgetEnv: Schema.Union([Schema.Undefined, Schema.Literals(["", "1000", "0", "-5", "abc", "1.5"])])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ year, month, day, hour, inTok, outTok, role, secret, headerName, budgetEnv }) =>
          Effect.sync(() => {
            const pad = (n: number) => String(n).padStart(2, "0")
            const pgTs = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:15:30.123456+00`
            const parsed = Spend.parseTimestamp(pgTs)
            if (!Number.isFinite(parsed)) return false
            const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:15:30.123Z`
            if (parsed !== Date.parse(iso)) return false

            const spent = Spend.spentSince(
              [{
                id: "m1",
                role,
                text: "ok",
                status: "done",
                question_id: null,
                failure: null,
                position: "1",
                created_at: pgTs,
                input_tokens: String(inTok),
                output_tokens: String(outTok)
              }],
              parsed
            )
            if (spent !== (role === "assistant" ? inTok + outTok : 0)) return false
            if (
              Spend.spentSince([{
                id: "m2",
                role: "assistant",
                text: "ok",
                status: "done",
                question_id: null,
                failure: null,
                position: "2",
                created_at: pgTs,
                input_tokens: String(inTok),
                output_tokens: String(outTok)
              }], parsed + 1) !== 0
            ) {
              return false
            }

            // tokenBudget validation
            if (budgetEnv === undefined || budgetEnv === "") {
              if (Spend.tokenBudget({ E2E_TOKEN_BUDGET: budgetEnv }) !== Spend.DEFAULT_TOKEN_BUDGET) return false
            } else if (budgetEnv === "1000") {
              if (Spend.tokenBudget({ E2E_TOKEN_BUDGET: budgetEnv }) !== 1000) return false
            } else {
              let threw = false
              try {
                Spend.tokenBudget({ E2E_TOKEN_BUDGET: budgetEnv })
              } catch {
                threw = true
              }
              if (!threw) return false
            }

            // Redact MUST strip single-line secret values after Cookie / Set-Cookie / Authorization
            const cleanSecret = secret.replace(/[\n\u001b]/g, "x")
            const logLine = `Request failed\n  ${headerName}: Bearer ${cleanSecret}\n  other: keep`
            const redacted = Redact.redact(logLine)
            if (redacted.includes(cleanSecret)) return false
            if (!redacted.includes("[redacted]") || !redacted.includes("other: keep")) return false
            const err = Redact.redactError(new Error(logLine)) as Error
            if (err.message.includes(cleanSecret)) return false
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
