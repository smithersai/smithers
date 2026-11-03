// The first paint's pure parts (worker/github/FirstPaint.ts): which paths and queries it answers, and that a late, failed
// or dying read is the same empty 204 as a refusal. The access matrix and the reads are worker/github/Readers.test.ts's.
import { Deferred, Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { describe, expect, test, vi } from "vitest"
import { Behind, FIRST_PAINT_HEADERS, guarded, parseFirstPaintPath, parseForm } from "./FirstPaint.ts"

const code = (error: unknown) => (error instanceof Error ? error.name : "unknown")

describe("the first paint's route", () => {
  test.each([
    ["/api/repos/acme/app/first-paint", { owner: "acme", name: "app" }],
    ["/api/repos/acme/a%2Epp/first-paint", { owner: "acme", name: "a.pp" }],
    ["/api/repos/acme/app/issues", undefined],
    ["/api/repos/acme/first-paint", undefined],
    ["/api/repos/acme/app/first-paint/7", undefined],
    ["/api/other/acme/app/first-paint", undefined],
    ["/api/repos/%E0%A4%A/app/first-paint", undefined],
    ["/api/repos/ac me/app/first-paint", undefined],
  ])("%s", (path, expected) => {
    expect(parseFirstPaintPath(path)).toEqual(expected)
  })

  test.each([
    ["issue=7", { kind: "issue", number: 7 }],
    ["list=all", { kind: "list" }],
    ["issue=2147483647", { kind: "issue", number: 2147483647 }],
    ["issue=2147483648", undefined],
    ["issue=0", undefined],
    ["issue=07", undefined],
    ["issue=-1", undefined],
    ["list=open", undefined],
    ["issue=7&list=all", undefined],
    ["issue=7&issue=8", undefined],
    ["", undefined],
    ["other=1", undefined],
  ])("?%s", (query, expected) => {
    expect(parseForm(new URLSearchParams(query))).toEqual(expected)
  })
})

describe("a read that can't paint in time answers like a refusal", () => {
  const run = (answer: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>) => {
    const fields: Record<string, string | number> = {}
    return Effect.runPromise(guarded(() => answer, fields, code, 20)).then((response) => ({ status: response.status, headers: response.headers, fields }))
  }

  test("a stalled read is never interrupted: the answer comes at the deadline, and the read finishes behind it", async () => {
    let finished = false
    let interrupted = false
    const release = Effect.runSync(Deferred.make<void>())
    const stalled = Deferred.await(release).pipe(
      Effect.andThen(Effect.sync(() => { finished = true })),
      Effect.as(HttpServerResponse.text("late")),
      Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
    )
    const behind: Array<Effect.Effect<void>> = []
    const fields: Record<string, string | number> = {}
    const started = performance.now()
    const answered = await Effect.runPromise(guarded(() => stalled, fields, code, 20).pipe(
      Effect.provideService(Behind, Behind.of({ run: (work) => Effect.sync(() => void behind.push(work)) })),
    ))
    expect(performance.now() - started).toBeLessThan(250)
    expect([answered.status, fields, finished, interrupted, behind.length]).toEqual([204, { outcome: "deadline" }, false, false, 1])
    const running = Effect.runPromise(behind[0]!)
    Effect.runSync(Deferred.succeed(release, undefined))
    await running
    expect([finished, interrupted]).toEqual([true, false])
  })

  test("what runs behind has its own bound: past it the read is interrupted, and a read that fails goes nowhere", async () => {
    let interrupted = false
    const never = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })))
    const behind: Array<Effect.Effect<void>> = []
    const keeper = Behind.of({ run: (work) => Effect.sync(() => void behind.push(work)) })
    await Effect.runPromise(guarded(() => never, {}, code, 10, "20 millis").pipe(Effect.provideService(Behind, keeper)))
    await Effect.runPromise(behind[0]!)
    await vi.waitFor(() => expect(interrupted).toBe(true))
    const failing = Effect.sleep("30 millis").pipe(Effect.andThen(Effect.fail(new TypeError("late"))))
    await Effect.runPromise(guarded(() => failing, {}, code, 10).pipe(Effect.provideService(Behind, keeper)))
    await Effect.runPromise(behind[1]!)
  })

  test("with nothing to run behind, a late read is interrupted, its cleanup never holding the answer", async () => {
    let cleaned = false
    const slowCleanup = Effect.never.pipe(Effect.onInterrupt(() => Effect.sleep("300 millis").pipe(Effect.andThen(Effect.sync(() => { cleaned = true })))))
    const started = performance.now()
    const answered = await run(slowCleanup)
    expect(answered.fields).toEqual({ outcome: "deadline" })
    expect(performance.now() - started).toBeLessThan(250)
    await vi.waitFor(() => expect(cleaned).toBe(true))
  })

  test("what a late read writes is its own: it never rewrites what the request counted, in any order", async () => {
    const release = Effect.runSync(Deferred.make<void>())
    const fields: Record<string, string | number> = { form: "issue" }
    const behind: Array<Effect.Effect<void>> = []
    const read = (own: Record<string, string | number>) => Deferred.await(release).pipe(
      Effect.andThen(Effect.sync(() => { own.outcome = "painted" })),
      Effect.as(HttpServerResponse.text("late")),
    )
    await Effect.runPromise(guarded(read, fields, code, 10).pipe(
      Effect.provideService(Behind, Behind.of({ run: (work) => Effect.sync(() => void behind.push(work)) })),
    ))
    Effect.runSync(Deferred.succeed(release, undefined))
    await Effect.runPromise(behind[0]!)
    expect(fields).toEqual({ form: "issue", outcome: "deadline" })
    // In time, what the read wrote is what is counted.
    const inTime: Record<string, string | number> = {}
    await Effect.runPromise(guarded((own) => Effect.sync(() => { own.outcome = "painted"; return HttpServerResponse.text("ok") }), inTime, code, 100))
    expect(inTime).toEqual({ outcome: "painted" })
  })

  test("an answer in time is the answer", async () => {
    const answered = await run(Effect.succeed(HttpServerResponse.text("ok")))
    expect([answered.status, answered.fields]).toEqual([200, {}])
  })

  test.each([
    ["past the deadline", Effect.never, { outcome: "deadline" }],
    ["failing", Effect.fail(new TypeError("no")), { outcome: "error", errorCode: "TypeError" }],
    ["dying", Effect.die(new RangeError("no")), { outcome: "error", errorCode: "RangeError" }],
  ] as const)("%s", async (_name, answer, fields) => {
    const answered = await run(answer)
    expect(answered.status).toBe(204)
    expect(answered.fields).toEqual(fields)
    expect(answered.headers).toMatchObject(FIRST_PAINT_HEADERS)
  })
})
