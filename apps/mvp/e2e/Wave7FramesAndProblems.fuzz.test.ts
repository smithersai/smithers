import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Frames from "./frames.ts"
import * as ProblemsMod from "./problems.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(25, Math.min(Math.ceil(baseExecs / 2), 100))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261172")

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, check: (v: A) => void) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (v) => Effect.sync(() => { check(v); return true }), { seed, executions: n })
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Wave7: e2e/frames.ts & e2e/problems.ts deep branch fuzzing", () => {
  it("fuzzes measure, combine, changedBetween, cutIdle, withoutCaptures, videoProblems, placeOfPath, titleCardOf, chaptersFileOf, chaptersIn", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bg: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
        fg: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        hasCorner: Schema.Boolean,
        hasPrev: Schema.Boolean,
        idleLen: Schema.Int.check(Schema.isBetween({ minimum: 18, maximum: 35 })),
        seconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
        chapters: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        pathKind: Schema.Literals([
          "/acme/app/tree/main",
          "/acme/app/tree/main/src/index.ts",
          "/acme/app/pulls/12",
          "/acme/app/runs/550e8400-e29b-41d4-a716-446655440000",
        ]),
        hasDescribe: Schema.Boolean,
        hasSummary: Schema.Boolean,
        hasColon: Schema.Boolean,
        endPunct: Schema.Literals(["", ".", "!", "?"]),
        fileShape: Schema.Literals(["array", "object", "null"]),
      })
    )

    const pixels = Frames.MEASURE_WIDTH * Frames.MEASURE_HEIGHT
    await holds(arb, execs, (v) => {
      const f1 = new Uint8Array(pixels).fill(v.bg)
      for (let i = 0; i < 600; i++) f1[i] = v.fg
      const f2 = new Uint8Array(pixels).fill((v.bg + 40) % 256)
      const corner = v.hasCorner ? { width: 40, height: 20 } : undefined
      const m1 = Frames.measure(f1, undefined, corner)
      const m2 = Frames.measure(f2, v.hasPrev ? f1 : undefined, corner)
      expect(m1.changed).toBe(pixels)
      expect(m2.detail).toBeGreaterThanOrEqual(0)

      const blankPane: Frames.Frame = { detail: 0, changed: 0 }
      expect(Frames.combine([blankPane, blankPane]).detail).toBe(0)
      expect(Frames.combine([blankPane, { detail: 100, changed: 50 }]).detail).toBe(100)

      // Exercise cutIdle when shown.length > pace.idle
      const idleFrames: Array<Frames.Frame> = Array.from({ length: v.idleLen }, () => ({ detail: 200, changed: 5 }))
      const repeat = Array.from({ length: v.idleLen }, () => 1)
      repeat[v.idleLen - 1] = 3
      const cut = Frames.cutIdle(repeat, idleFrames, Frames.GIF_PACE)
      expect(cut.length).toBe(v.idleLen)

      const stripped = Frames.withoutCaptures(idleFrames, [{ start: 10_000, end: 11_000 }], 9_500)
      expect(stripped.length).toBe(idleFrames.length)

      const vp = Frames.videoProblems(v.seconds, v.chapters)
      expect(Array.isArray(vp)).toBe(true)

      const place = Frames.placeOfPath(v.pathKind)
      expect(place.length).toBeGreaterThan(0)

      const title = v.hasColon ? `feature: does something${v.endPunct}` : "plain title"
      const card = Frames.titleCardOf({
        spec: "my-spec_file",
        title,
        ...(v.hasDescribe ? { describe: ["Suite", "Sub"] } : {}),
        ...(v.hasSummary ? { summary: "custom summary" } : {}),
      })
      expect(card.name.length).toBeGreaterThan(0)

      const cf = Frames.chaptersFileOf(
        card,
        { title, status: undefined, theme: "dark" },
        10,
        [{ t: 1.2, label: "Step 1" }]
      )
      expect(cf.chapters.length).toBe(2)

      const extracted = Frames.chaptersIn(
        v.fileShape === "array" ? cf.chapters : v.fileShape === "object" ? cf : null
      )
      expect(Array.isArray(extracted)).toBe(true)
    })
  })

  it("fuzzes e2e/problems.ts pathOf, placeOf, fixture, failed requests, and console resource status/failure branches", async () => {
    const ORIGIN = "https://smithers.test"
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "path_bare",
          "path_url",
          "path_bad_url",
          "failed_api",
          "failed_cancelled",
          "failed_non_api",
          "console_500_same_origin",
          "console_409_shape",
          "console_404_same_origin",
          "console_404_foreign",
          "console_404_undefined",
          "console_404_bad_url",
          "console_fail_fixture",
          "console_fail_foreign",
          "console_fail_bad_url",
        ]),
        method: Schema.Literals(["GET", "POST"]),
      })
    )

    await holds(arb, execs, (v) => {
      if (v.kind === "path_bare") {
        const p = ProblemsMod.problemOf(ORIGIN, { kind: "response", method: "GET", status: 503, url: `${ORIGIN}/api/shapes/todos?offset=1`, retryAfter: "1" })
        expect(p?.kind).toBe("server")
      } else if (v.kind === "path_url") {
        expect(ProblemsMod.pathOf("https://smithers.test/api/runs?x=1")).toBe("/api/runs?x")
      } else if (v.kind === "path_bad_url") {
        const p = ProblemsMod.problemOf(ORIGIN, { kind: "response", method: "GET", status: 500, url: "http://[::1" })
        expect(p).toBeUndefined()
      } else if (v.kind === "failed_api") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "failed",
          method: v.method,
          url: `${ORIGIN}/api/runs`,
          error: "net::ERR_CONNECTION_REFUSED",
        })
        expect(p?.kind).toBe("server")
      } else if (v.kind === "failed_cancelled") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "failed",
          method: v.method,
          url: `${ORIGIN}/api/runs`,
          error: "net::ERR_ABORTED",
        })
        expect(p).toBeUndefined()
      } else if (v.kind === "failed_non_api") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "failed",
          method: v.method,
          url: `${ORIGIN}/assets/app.js`,
          error: "net::ERR_CONNECTION_REFUSED",
        })
        expect(p).toBeUndefined()
      } else if (v.kind === "console_500_same_origin") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: `${ORIGIN}/api/runs`,
          text: "Failed to load resource: the server responded with a status of 500 ()",
        })
        expect(p).toBeUndefined()
      } else if (v.kind === "console_409_shape") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: `${ORIGIN}/api/shapes/todos`,
          text: "Failed to load resource: the server responded with a status of 409 ()",
        })
        expect(p).toBeUndefined()
      } else if (v.kind === "console_404_same_origin") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: `${ORIGIN}/api/runs`,
          text: "Failed to load resource: the server responded with a status of 404 ()",
        })
        expect(p?.kind).toBe("server")
      } else if (v.kind === "console_404_foreign") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: "https://cdn.other.test/img.png",
          text: "Failed to load resource: the server responded with a status of 404 ()",
        })
        expect(p?.kind).toBe("server")
      } else if (v.kind === "console_404_undefined") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: undefined,
          text: "Failed to load resource: the server responded with a status of 404 ()",
        })
        expect(p?.kind).toBe("server")
      } else if (v.kind === "console_404_bad_url") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: "http://[::1",
          text: "Failed to load resource: the server responded with a status of 404 ()",
        })
        expect(p?.kind).toBe("server")
      } else if (v.kind === "console_fail_fixture") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: "http://127.0.0.1:49999/fixture",
          text: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
        })
        expect(p).toBeUndefined()
      } else if (v.kind === "console_fail_foreign") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: "https://cdn.other.test/x.js",
          text: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
        })
        expect(p?.kind).toBe("console")
      } else if (v.kind === "console_fail_bad_url") {
        const p = ProblemsMod.problemOf(ORIGIN, {
          kind: "console",
          url: "http://[::1",
          text: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
        })
        expect(p?.kind).toBe("console")
      }
    })
  })
})
