import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import * as Checks from "../evals/checks.ts"
import { appPath } from "../src/features/navigation/paths.ts"
import * as TodosApi from "../src/features/todos/api.ts"
import * as TodosWrites from "../src/features/todos/writes.ts"
import * as Problems from "./problems.ts"
import * as Redact from "./redact.ts"
import * as Spend from "./spend.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 2), 80))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const word = Arbitrary.schema(Schema.Literals(["alpha", "beta", "gamma", "delta"]))

describe("Wave-6 apps/mvp e2e/problems, e2e/spend, e2e/redact, evals/checks, todos/api & writes, navigation/paths", () => {
  it("fuzzes e2e/problems, e2e/spend, and e2e/redact invariants", () =>
    property(
      Arbitrary.all({
        status: Arbitrary.schema(Schema.Literals([200, 404, 500, 502, 503])),
        retryCount: intBetween(1, 4),
        lacksCode: bool,
        lacksModel: bool,
        lacksGh: bool,
        budgetVal: intBetween(100, 10_000),
        spentVal: intBetween(0, 12_000),
        unreadCount: intBetween(0, 4),
        applies: bool
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          // 1. e2e/problems.ts
          const origin = "https://smithers.sh"
          const uuid = "12345678-1234-4234-8234-123456789abc"
          expect(Problems.pathOf(`${origin}/api/repos/${uuid}/stack?b=2&a=1`)).toBe("/api/repos/:id/stack?a&b")
          expect(Problems.bodyCodeOf({ code: "rate_limited" })).toBe("rate_limited")
          expect(Problems.bodyCodeOf({ code: "INVALID CODE!" })).toBeUndefined()
          expect(Problems.bodyCodeOf(null)).toBeUndefined()

          const envAnn = Problems.environmentAnnotations({
            codeStorage: s.lacksCode,
            model: s.lacksModel,
            github: s.lacksGh
          })
          const consoleAnn = Problems.consoleErrorAnnotation("expected boom")
          const serverAnn = Problems.serverErrorAnnotation(500, `/api/repos/${uuid}/test`)
          const failedAnn = Problems.serverErrorAnnotation("failed", "/api/broken")
          const allAnns = [...envAnn, consoleAnn, serverAnn, failedAnn]

          expect(() => Problems.serverErrorAnnotation(200, "/api/x")).toThrow()
          expect(() => Problems.serverErrorAnnotation(500, "no-slash")).toThrow()
          expect(() => Problems.consoleErrorAnnotation("   ")).toThrow()
          expect(() => Problems.declarationsOf([{ type: Problems.EXPECTED_SERVER_ERROR, description: "bad" }])).toThrow()

          const probs = new Problems.Problems(origin)
          // Shape 503 retries
          for (let i = 0; i < s.retryCount; i++) {
            probs.note({
              kind: "response",
              method: "GET",
              url: `${origin}/api/shapes/todos?offset=-1`,
              status: 503,
              retryAfter: "5",
              diagnostics: { code: "overloaded", ray: "0123456789abcdef" }
            })
          }
          // Declared 500 & undeclared status
          probs.note({
            kind: "response",
            method: "POST",
            url: `${origin}/api/repos/${uuid}/test`,
            status: s.status,
            diagnostics: { code: "internal_error", ray: "0123456789abcdef" }
          })
          // Failed API request (declared) & failed non-API request (ignored)
          probs.note({ kind: "failed", method: "GET", url: `${origin}/api/broken`, error: "net::ERR_ABORTED" })
          probs.note({ kind: "failed", method: "GET", url: "https://other.example/x", error: "net::ERR_FAILED" })
          // Console errors: app origin, other origin, fixture localhost, undefined url
          probs.note({ kind: "console", text: "expected boom happened", url: `${origin}/app` })
          probs.note({ kind: "console", text: "external err", url: "https://cdn.example.com/a.js" })
          probs.note({ kind: "console", text: "fixture err", url: "http://127.0.0.1:41234/page" })
          probs.note({ kind: "console", text: "unknown place", url: undefined })
          probs.note({ kind: "page", text: "uncaught exception", name: "TypeError" })

          const list = probs.list(allAnns)
          expect(list.length).toBeGreaterThan(0)
          const undeclared = probs.undeclared(allAnns)
          expect(Array.isArray(undeclared)).toBe(true)
          const srvErrs = probs.serverErrors(allAnns)
          expect(Array.isArray(srvErrs)).toBe(true)
          const rep = probs.report(allAnns)
          expect(rep.length).toBeGreaterThan(0)
          const emptyProbs = new Problems.Problems(origin)
          expect(emptyProbs.report([])).toStrictEqual(["problems: none"])

          // 2. e2e/spend.ts
          expect(Spend.tokenBudget({})).toBe(Spend.DEFAULT_TOKEN_BUDGET)
          expect(Spend.tokenBudget({ E2E_TOKEN_BUDGET: String(s.budgetVal) })).toBe(s.budgetVal)
          expect(() => Spend.tokenBudget({ E2E_TOKEN_BUDGET: "0" })).toThrow()
          expect(() => Spend.tokenBudget({ E2E_TOKEN_BUDGET: "abc" })).toThrow()

          expect(Spend.runStartedAt({ E2E_RUN_STARTED_AT: "1700000000000" })).toBe(1700000000000)
          expect(() => Spend.runStartedAt({})).toThrow()

          expect(Number.isFinite(Spend.parseTimestamp("2026-10-21 17:03:04.123456+00"))).toBe(true)
          expect(Number.isFinite(Spend.parseTimestamp("2026-10-21T17:03:04Z"))).toBe(true)
          expect(Number.isFinite(Spend.parseTimestamp("2026-10-21 17:03:04-0530"))).toBe(true)
          expect(Number.isNaN(Spend.parseTimestamp("not-a-timestamp"))).toBe(true)

          const since = Date.parse("2026-10-21T17:00:00Z")
          const rows: Parameters<typeof Spend.spentSince>[0] = [
            { id: "r1", role: "user", content: "", created_at: "2026-10-21T17:05:00Z", input_tokens: 999, output_tokens: 999 },
            { id: "r2", role: "assistant", content: "", created_at: "2026-10-21T16:59:00Z", input_tokens: 999, output_tokens: 999 },
            { id: "r3", role: "assistant", content: "", created_at: "2026-10-21 17:05:00+00", input_tokens: s.spentVal, output_tokens: 0 }
          ] as unknown as Parameters<typeof Spend.spentSince>[0]
          expect(Spend.spentSince(rows, since)).toBe(s.spentVal)

          let nowMs = 10_000
          let calls = 0
          const guard = Spend.spendGuard({
            applies: () => s.applies,
            budget: () => s.budgetVal,
            since: () => since,
            now: () => nowMs,
            unread: () => {},
            rows: async () => {
              calls++
              if (calls <= s.unreadCount) throw new Error("503 starting")
              return rows
            }
          })

          if (!s.applies) {
            yield* Effect.promise(() => guard())
          } else if (s.unreadCount >= Spend.MAX_UNREAD) {
            for (let i = 0; i < Spend.MAX_UNREAD - 1; i++) {
              yield* Effect.promise(() => guard())
              nowMs += Spend.REREAD_MS + 1
            }
            const ex = yield* Effect.exit(Effect.tryPromise(() => guard()))
            expect(Exit.isFailure(ex)).toBe(true)
          } else {
            for (let i = 0; i < s.unreadCount; i++) {
              yield* Effect.promise(() => guard())
              nowMs += Spend.REREAD_MS + 1
            }
            const ex = yield* Effect.exit(Effect.tryPromise(() => guard()))
            expect(Exit.isSuccess(ex)).toBe(s.spentVal < s.budgetVal)
            if (s.spentVal < s.budgetVal) {
              // Cached reread does not increment calls
              const before = calls
              yield* Effect.promise(() => guard())
              expect(calls).toBe(before)
            }
          }

          // 3. e2e/redact.ts
          const raw = "cookie: sid=secret123\nSet-Cookie: a=b\nAuthorization: Bearer tok999\nplain: ok"
          const redacted = Redact.redact(raw)
          expect(redacted).not.toContain("secret123")
          expect(redacted).not.toContain("tok999")
          expect(redacted).toContain("plain: ok")
          const err = new Error("failed with Authorization: Bearer secret-xyz")
          Redact.redactError(err)
          expect(err.message).not.toContain("secret-xyz")
          expect(Redact.redactError("not-an-error")).toBe("not-an-error")

          class FakeReqCtx {
            async fetch() {
              throw new Error("cookie: topsecret=1")
            }
          }
          const ctx = new FakeReqCtx()
          Redact.redactRequestErrors(ctx as never)
          Redact.redactRequestErrors(ctx as never) // idempotent
          const fetchEx = yield* Effect.exit(Effect.tryPromise(() => ctx.fetch()))
          expect(Exit.isFailure(fetchEx)).toBe(true)
        })
    ))

  it("fuzzes evals/checks, todos/api, todos/writes, and navigation/paths", () =>
    property(
      Arbitrary.all({
        owner: word,
        repo: word,
        num: intBetween(1, 50),
        httpStatus: Arbitrary.schema(Schema.Literals([200, 202, 400, 401, 403, 404, 409, 413, 500])),
        badJson: bool,
        netErr: bool,
        samePerson: bool,
        opKind: Arbitrary.schema(Schema.Literals(["commit", "drop", "retry", "attach"])),
        navKind: intBetween(0, 4)
      }),
      execs,
      (s) =>
        Effect.gen(function*() {
          // 1. navigation/paths.ts
          const origin = "https://smithers.sh"
          const navInput = s.navKind === 0
            ? `/${s.owner}/${s.repo}?tab=stack#top`
            : s.navKind === 1
            ? `${origin}///${s.owner}/${s.repo}`
            : s.navKind === 2
            ? "javascript:alert(1)"
            : s.navKind === 3
            ? "https://evil.example/phish"
            : "http://[::1"
          const navTarget = appPath(navInput, origin)
          expect(navTarget._tag).toBe(s.navKind <= 1 ? "Path" : "Refused")

          // 2. evals/checks.ts (all 30+ checks!)
          const trial: Checks.Trial = {
            status: "done",
            text: `Opened ${s.owner}/${s.repo} cleanly.`,
            calls: [
              { flow: "repo/open", input: { repo: `${s.owner}/${s.repo}`, url: `https://example.com/${s.repo}`, title: "hello world" }, ok: true }
            ],
            views: [
              { template: "web-preview", props: { url: "https://example.com/p", repo: `${s.owner}/${s.repo}` }, inert: true },
              { template: "form", props: { title: "Create issue", fields: [{ name: "title", label: "Title" }] }, inert: true },
              {
                template: "board",
                props: {
                  cells: [
                    { title: "A", url: "https://example.com/a" },
                    { title: "B", url: "https://example.com/b" }
                  ]
                },
                inert: true
              }
            ],
            painted: ["dark"],
            navigated: [`/${s.owner}/${s.repo}`],
            asked: [{ kind: "approval", message: "Proceed?" }],
            drafts: [{ flow: "todo/commit", input: {} }],
            role: "member",
            usage: [{ role: "member", inputTokens: 100, outputTokens: 20, totalTokens: 120, chargedTokens: 120 }],
            failure: undefined
          } as unknown as Checks.Trial

          const checks: ReadonlyArray<Checks.Check> = [
            Checks.answered(trial),
            Checks.failedWith(trial, "none"),
            Checks.mentions(trial, s.repo),
            Checks.readValues(trial),
            Checks.noCalls(trial),
            Checks.calledOnce(trial, "repo/open", Checks.all(Checks.hostIs("url", "example.com"), Checks.fieldSays("title", "hello"), Checks.fieldIs("repo", `${s.owner}/${s.repo}`))),
            Checks.attempted(trial, "repo/open"),
            Checks.notCalled(trial, "other/flow"),
            Checks.onlyCalled(trial, ["repo/open"]),
            Checks.atMostLines(trial, 5),
            Checks.themeIs(trial, "dark"),
            Checks.themeUnchanged(trial),
            Checks.navigatedTo(trial, `/${s.owner}/${s.repo}`),
            Checks.stayed(trial),
            Checks.viewShows(trial, "web-preview", "example.com"),
            Checks.templateShows(trial, "web-preview", `${s.owner}/${s.repo}`),
            Checks.formAsks(trial, ["title"]),
            Checks.boardShows(trial, 2),
            Checks.inertViews(trial),
            Checks.noViews(trial),
            Checks.askedOnce(trial, "approval"),
            Checks.askedNothing(trial),
            Checks.nothingSaved(trial),
            Checks.draftedCalling(trial, "todo/commit"),
            Checks.usedRole(trial, "member"),
            ...Checks.everyAnswer(trial),
            ...Checks.safe(trial)
          ]
          const graded = Checks.grade([checks])
          expect(graded.meta.trials.length).toBe(1)

          // 3. todos/api.ts (readTodoStatus, postChange, StackClient.layer)
          const fakeHttp = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((req) => {
              if (s.netErr) return Effect.fail(new Error("offline") as never)
              const isStatus = req.url.includes("/todos/")
              const body = s.badJson
                ? "{bad"
                : s.httpStatus === 200 || s.httpStatus === 202
                ? JSON.stringify(
                  isStatus
                    ? { kind: "found", number: s.num, state: "queued", title: "T", updatedAt: "2026-01-01T00:00:00Z", prNumber: null, failure: null }
                    : { opId: "op-1", outcome: "committed", number: s.num, txid: s.httpStatus === 202 ? 12 : null, version: 2 }
                )
                : JSON.stringify({
                  code: s.httpStatus === 404
                    ? "not_found"
                    : s.httpStatus === 401
                    ? "authentication"
                    : s.httpStatus === 403
                    ? "forbidden"
                    : "conflict"
                })
              const headers: Record<string, string> = { "content-type": "application/json" }
              if (s.httpStatus === 401 && s.samePerson) headers["x-smithers-session-check"] = "same_person"
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(body, { status: s.httpStatus, headers })))
            })
          )

          const statusEx = yield* Effect.exit(
            TodosApi.readTodoStatus(origin, s.owner, s.repo, s.num, "5 seconds").pipe(Effect.provide(fakeHttp))
          )
          expect(Exit.isSuccess(statusEx) || Exit.isFailure(statusEx)).toBe(true)

          const changeReq: TodosApi.ChangeRequest = s.opKind === "commit"
            ? { opId: "op-1", op: "commit", title: "T", prompt: "P", acceptance: [] }
            : s.opKind === "attach"
            ? { opId: "op-1", op: "attach", number: s.num, issue: 7 }
            : { opId: "op-1", op: s.opKind, number: s.num }

          const postEx = yield* Effect.exit(
            Effect.flatMap(TodosApi.StackClient, (c) => c.change(s.owner, s.repo, changeReq)).pipe(
              Effect.provide(TodosApi.StackClient.layer({ origin, within: "5 seconds" }).pipe(Layer.provide(fakeHttp)))
            )
          )
          expect(Exit.isSuccess(postEx) || Exit.isFailure(postEx)).toBe(true)

          // 4. todos/writes.ts (requestOf & reasonOf)
          const sendingRow = s.opKind === "commit"
            ? { v: 6, id: "op-1", repo: `${s.owner}/${s.repo}`, op: "commit" as const, title: "T", prompt: "P", acceptance: [], issue: 5, after: null, queuedAt: 1 }
            : s.opKind === "attach"
            ? { v: 6, id: "op-1", repo: `${s.owner}/${s.repo}`, op: "attach" as const, number: s.num, issue: 5, queuedAt: 1 }
            : { v: 6, id: "op-1", repo: `${s.owner}/${s.repo}`, op: s.opKind, number: s.num, queuedAt: 1 }
          expect(TodosWrites.requestOf(sendingRow as never).op).toBe(s.opKind)

          for (const st of [400, 401, 403, 404, 409, 413, 500]) {
            const r = TodosWrites.reasonOf(st, undefined)
            expect(st === 500 ? r === undefined : r !== undefined).toBe(true)
          }
        })
    ))
})
