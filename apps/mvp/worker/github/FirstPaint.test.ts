// The first paint's pure parts (worker/github/FirstPaint.ts): which paths and queries it answers, and that a late, failed
// or dying read is the same empty 204 as a refusal. The access matrix and the reads are worker/github/Readers.test.ts's.
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import { FIRST_PAINT_HEADERS, guarded, parseFirstPaintPath, parseForm } from "./FirstPaint.ts"

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
    return Effect.runPromise(guarded(answer, fields, code, 20)).then((response) => ({ status: response.status, headers: response.headers, fields }))
  }

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
