// Generated cases for the e2e run's pure parts (its problem list, spend guard and redaction), the app's navigation
// paths and the browser's stack client. Each property states what the scenario must produce on its own, as a list
// or a value built from the scenario, and compares the code's answer to it whole.
import type { APIRequestContext } from "@playwright/test"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Option, Schema } from "effect"
import { HttpClient, HttpClientError, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { expect, test } from "vitest"
import { CONFIRM_401_HEADER, SESSION_CHECK_HEADER } from "../src/features/auth/contract.ts"
import { appPath } from "../src/features/navigation/paths.ts"
import * as TodosApi from "../src/features/todos/api.vibe"
import { stackRoute, TODO_STATUS_NOT_FOUND, todoStatusRoute } from "../src/features/todos/contract.ts"
import type { Sending } from "../src/features/todos/schema.ts"
import * as TodosWrites from "../src/features/todos/writes.ts"
import { RAY_HEADER } from "../src/requestRay.ts"
import * as Problems from "./problems.ts"
import * as Redact from "./redact.ts"
import * as Spend from "./spend.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? 20261130)
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 200)

const property = async <S extends Schema.Top>(schema: S, check: (scenario: S["Type"]) => Effect.Effect<void>) => {
  const report = await Effect.runPromise(
    Fuzz.run(Arbitrary.schema(schema), (scenario) => Effect.as(check(scenario), true), { seed, executions }),
  )
  expect(Fuzz.formatReport(report)).toBeUndefined()
}

const int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const ORIGIN = "https://smithers.test"
const ID = "12345678-1234-4234-8234-123456789abc"

test("the problem list holds exactly the app's 5xx, failed API requests and console errors, each declared, retried or not", () =>
  property(
    Schema.Struct({
      status: Schema.Literals([200, 404, 500, 502, 503]),
      repeats: int(1, 3),
      declare: Schema.Literals(["none", "same", "wildcard", "otherStatus", "otherPath"]),
      shapes: int(0, 4),
      retryAfter: Schema.Boolean,
      failed: Schema.Literals(["none", "reset", "aborted", "offline", "foreign", "page"]),
      console: Schema.Literals(["none", "declared", "undeclared", "fixture", "foreign5xx"]),
    }),
    (s) =>
      Effect.sync(() => {
        const problems = new Problems.Problems(ORIGIN)
        const expected: Array<Problems.Counted> = []
        const unknown = ` code=unknown ${RAY_HEADER}=none`

        for (let sent = 0; sent < s.repeats; sent++) {
          problems.note({ kind: "response", method: "POST", url: `${ORIGIN}/api/repos/${ID}/test?b=2&a=1&b=3`, status: s.status, diagnostics: { code: "internal_error", ray: "not a ray" } })
        }
        const declaredStatus = s.status >= 500 ? s.status : 500
        const annotations = [
          ...(s.declare === "same" ? [Problems.serverErrorAnnotation(declaredStatus, `/api/repos/${ID}/test`)] : []),
          ...(s.declare === "wildcard" ? [Problems.serverErrorAnnotation(declaredStatus, "/api/repos/*/test")] : []),
          ...(s.declare === "otherStatus" ? [Problems.serverErrorAnnotation(declaredStatus === 500 ? 502 : 500, "/api/repos/*/test")] : []),
          ...(s.declare === "otherPath" ? [Problems.serverErrorAnnotation(declaredStatus, "/api/repos/*/tes")] : []),
          ...(s.console === "declared" ? [Problems.consoleErrorAnnotation("expected boom")] : []),
          { type: "issue", description: "unrelated" },
        ]
        if (s.status >= 500) {
          expected.push({
            line: `${s.status} POST /api/repos/:id/test?a&b code=internal_error ${RAY_HEADER}=none`,
            count: s.repeats,
            declared: s.declare === "same" || s.declare === "wildcard",
            retried: false,
          })
        }

        for (let sent = 0; sent < s.shapes; sent++) {
          problems.note({ kind: "response", method: "GET", url: `${ORIGIN}/api/shapes/todos?offset=${sent}`, status: 503, retryAfter: s.retryAfter ? "5" : undefined })
        }
        if (s.shapes > 0) {
          expected.push({
            line: `503 GET /api/shapes/todos?offset${s.retryAfter ? " retry-after" : ""}${unknown}`,
            count: s.shapes,
            declared: false,
            retried: s.retryAfter && s.shapes <= Problems.SHAPE_RETRIES,
          })
        }

        if (s.failed === "page") {
          problems.note({ kind: "page", text: "TypeError: x is undefined", name: "TypeError" })
          expected.push({ line: "page error: TypeError: x is undefined", count: 1, declared: false, retried: false })
        } else if (s.failed !== "none") {
          problems.note({
            kind: "failed",
            method: "GET",
            url: `${s.failed === "foreign" ? "https://other.test" : ORIGIN}/api/broken`,
            error: s.failed === "aborted" ? "net::ERR_ABORTED" : s.failed === "offline" ? "net::ERR_INTERNET_DISCONNECTED" : "net::ERR_CONNECTION_RESET",
          })
          if (s.failed === "reset") {
            expected.push({ line: "failed GET /api/broken net::ERR_CONNECTION_RESET", count: 1, declared: false, retried: false })
          }
        }

        if (s.console === "declared" || s.console === "undeclared") {
          problems.note({ kind: "console", text: "[12:34:56.789] expected boom happened (#42)", url: `${ORIGIN}/app` })
          expected.push({ line: "console error: expected boom happened", count: 1, declared: s.console === "declared", retried: false })
        } else if (s.console === "fixture") {
          problems.note({ kind: "console", text: "Failed to load resource: net::ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:41234/page" })
        } else if (s.console === "foreign5xx") {
          problems.note({ kind: "console", text: "Failed to load resource: the server responded with a status of 503 ()", url: "https://cdn.test/a.js?v=1" })
          expected.push({ line: `console 503 https://cdn.test/a.js?v: Failed to load resource${unknown}`, count: 1, declared: false, retried: false })
        }

        expect(problems.list(annotations)).toEqual(expected)
        const lines = (kept: ReadonlyArray<Problems.Counted>) => kept.map((each) => `${each.line} ×${each.count}`)
        expect(problems.undeclared(annotations)).toEqual(lines(expected.filter((each) => !each.declared && !each.retried)))
        expect(problems.serverErrors(annotations)).toEqual(lines(expected.filter((each) => each.line.startsWith("50"))))
        expect(problems.report(annotations)).toEqual(expected.length === 0 ? ["problems: none"] : [
          "problems (e2e/problems.ts):",
          ...expected.map((each) => `  ${each.declared ? "declared" : each.retried ? "retried" : "UNDECLARED"} ${each.line} ×${each.count}`),
        ])
      }),
  ))

test("the spend guard counts the run's answers, reads at most once a minute and stops at the budget or three failed reads", () =>
  property(
    Schema.Struct({
      applies: Schema.Boolean,
      budget: int(1, 400),
      failures: int(0, 4),
      zone: Schema.Literals(["Z", "+00", "+0530", "-08:00"]),
      rows: Schema.Array(Schema.Struct({
        role: Schema.Literals(["assistant", "user"]),
        secondsAfter: int(-3, 3),
        input: int(0, 100),
        output: int(0, 100),
        dated: Schema.Boolean,
      })).check(Schema.isMaxLength(5)),
    }),
    (s) =>
      Effect.gen(function* () {
        const since = Date.UTC(2026, 9, 21, 17, 0, 0)
        const offsetMinutes = s.zone === "+0530" ? 330 : s.zone === "-08:00" ? -480 : 0
        // Postgres' text form of an instant, as a clock `offsetMinutes` from UTC shows it, to the microsecond.
        const written = (at: number) =>
          `${new Date(at + offsetMinutes * 60_000).toISOString().replace("T", " ").replace("Z", "")}456${s.zone}`
        const rows = s.rows.map((row, index) => ({
          id: `row-${index}`,
          role: row.role,
          text: "",
          status: "done",
          question_id: null,
          failure: null,
          position: String(index),
          input_tokens: String(row.input),
          output_tokens: row.output === 0 ? null : String(row.output),
          ...(row.dated ? { created_at: written(since + row.secondsAfter * 1_000) } : {}),
        }))
        const spent = s.rows.reduce(
          (total, row) => row.role === "assistant" && row.dated && row.secondsAfter >= 0 ? total + row.input + row.output : total,
          0,
        )
        for (const row of s.rows) expect(Spend.parseTimestamp(written(since + row.secondsAfter * 1_000))).toBe(since + row.secondsAfter * 1_000)
        expect(Spend.spentSince(rows, since)).toBe(spent)

        let now = 1_000_000
        let reads = 0
        const unread: Array<unknown> = []
        const guard = Spend.spendGuard({
          applies: () => s.applies,
          budget: () => s.budget,
          since: () => since,
          now: () => now,
          unread: (error) => void unread.push(error),
          rows: () => {
            reads += 1
            return reads <= s.failures ? Promise.reject(new Error(`unread ${reads}`)) : Promise.resolve(rows)
          },
        })
        /** How one test's guard ends: nothing, or the error it stops the test with. */
        const guarded = Effect.promise(() => guard().then(() => undefined, (error: unknown) => error))
        const over = spent >= s.budget ? new Spend.SpendBudgetSpent(spent, s.budget) : undefined

        for (let call = 1; call <= s.failures + 1; call++) {
          const stopped = yield* guarded
          if (!s.applies) expect(stopped).toBeUndefined()
          else if (call <= s.failures) expect(stopped).toEqual(call >= Spend.MAX_UNREAD ? new Spend.SpendUnknown(call) : undefined)
          else expect(stopped).toEqual(over)
          expect(reads).toBe(s.applies ? call : 0)
          now += Spend.REREAD_MS
        }
        expect(unread).toEqual(s.applies ? Array.from({ length: s.failures }, (_, index) => new Error(`unread ${index + 1}`)) : [])

        // Within a minute of a read the guard answers from it; a minute on, it reads again.
        now -= 1
        expect(yield* guarded).toEqual(s.applies ? over : undefined)
        expect(reads).toBe(s.applies ? s.failures + 1 : 0)
        now += 1
        expect(yield* guarded).toEqual(s.applies ? over : undefined)
        expect(reads).toBe(s.applies ? s.failures + 2 : 0)
      }),
  ))

test("a token budget and a run's start are whole positive numbers or the run refuses to start", () =>
  property(
    Schema.Struct({
      form: Schema.Literals(["unset", "empty", "whole", "zero", "negative", "fraction", "word", "huge"]),
      tokens: int(1, 5_000_000),
    }),
    (s) =>
      Effect.sync(() => {
        const named: Record<typeof s.form, string | undefined> = {
          unset: undefined,
          empty: "",
          whole: String(s.tokens),
          zero: "0",
          negative: `-${s.tokens}`,
          fraction: `${s.tokens}.5`,
          word: `${s.tokens} tokens`,
          huge: `${s.tokens}e300`,
        }
        const value = named[s.form]
        const budget = () => Spend.tokenBudget({ E2E_TOKEN_BUDGET: value })
        if (s.form === "unset" || s.form === "empty") expect(budget()).toBe(Spend.DEFAULT_TOKEN_BUDGET)
        else if (s.form === "whole") expect(budget()).toBe(s.tokens)
        else expect(budget).toThrow(`E2E_TOKEN_BUDGET is "${value}": it must be a whole number of tokens above 0`)

        const started = () => Spend.runStartedAt({ E2E_RUN_STARTED_AT: value })
        if (s.form === "whole" || s.form === "fraction" || s.form === "huge") expect(started()).toBe(Number(value))
        else expect(started).toThrow("E2E_RUN_STARTED_AT is unset")
      }),
  ))

const HEADERS = ["cookie", "Set-Cookie", "AUTHORIZATION", "Proxy-Authorization", "x-request-id", "accept", "cookies-seen"] as const
/** The headers whose values a call log may not keep: a name that only starts or ends like one keeps its value. */
const SENSITIVE: ReadonlyArray<string> = ["cookie", "Set-Cookie", "AUTHORIZATION", "Proxy-Authorization"]

test("redaction replaces every cookie and authorization value and nothing else, in text, errors and request contexts", () =>
  property(
    Schema.Struct({
      lines: Schema.Array(Schema.Struct({
        name: Schema.Literals(HEADERS),
        value: Schema.Literals(["sid=secret123; theme=dark", "Bearer tok999", "plain-value"]),
        spaced: Schema.Boolean,
      })).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
      fails: Schema.Boolean,
    }),
    (s) =>
      Effect.gen(function* () {
        const text = s.lines.map((line) => `${line.name}:${line.spaced ? "  " : ""}${line.value}`).join("\n")
        const safe = s.lines
          .map((line) => `${line.name}:${line.spaced ? "  " : ""}${SENSITIVE.includes(line.name) ? "[redacted]" : line.value}`)
          .join("\n")
        expect(Redact.redact(text)).toBe(safe)
        expect(Redact.redact(safe)).toBe(safe)

        const error = new Error(text)
        error.stack = `Error: ${text}\n    at call log`
        expect(Redact.redactError(error)).toBe(error)
        expect([error.message, error.stack]).toEqual([safe, `Error: ${safe}\n    at call log`])
        expect(Redact.redactError(text)).toBe(text)

        // A class of this run only, as Playwright's request context is one class: patching one instance covers all.
        class Context {
          calls = 0
          async fetch(url: string) {
            this.calls += 1
            if (s.fails) throw new Error(text)
            return `${url} ${text}`
          }
        }
        const [first, second] = [new Context(), new Context()]
        Redact.redactRequestErrors(first as unknown as APIRequestContext)
        const patched = Context.prototype.fetch
        Redact.redactRequestErrors(second as unknown as APIRequestContext)
        expect(Context.prototype.fetch).toBe(patched)
        const answer = yield* Effect.promise(() => second.fetch("/api/x").then((value) => ({ value }), (thrown: unknown) => ({ thrown })))
        expect(answer).toEqual(s.fails ? { thrown: new Error(safe) } : { value: `/api/x ${text}` })
        expect([first.calls, second.calls]).toEqual([0, 1])
      }),
  ))

test("app/navigate takes this app's own paths and refuses every other origin, scheme and non-URL", () =>
  property(
    Schema.Struct({
      owner: Schema.Literals(["octocat", "acme"]),
      repo: Schema.Literals(["Spoon-Knife", "widgets"]),
      form: Schema.Literals(["path", "bare", "full", "slashes", "protocolRelative", "otherOrigin", "otherPort", "javascript", "data", "mailto", "malformed"]),
      query: Schema.Boolean,
      hash: Schema.Boolean,
    }),
    (s) =>
      Effect.sync(() => {
        const tail = `${s.owner}/${s.repo}${s.query ? "?tab=stack&q=a%20b" : ""}${s.hash ? "#top" : ""}`
        const to: Record<typeof s.form, string> = {
          path: `/${tail}`,
          bare: tail,
          full: `${ORIGIN}/${tail}`,
          slashes: `${ORIGIN}///${tail}`,
          protocolRelative: `//evil.test/${tail}`,
          otherOrigin: `https://evil.test/${tail}`,
          otherPort: `${ORIGIN}:8443/${tail}`,
          javascript: `javascript:alert("${tail}")`,
          data: `data:text/html,${tail}`,
          mailto: `mailto:${s.owner}@evil.test`,
          malformed: `http://[::1/${tail}`,
        }
        const refused: Partial<Record<typeof s.form, "origin" | "scheme" | "invalid">> = {
          protocolRelative: "origin",
          otherOrigin: "origin",
          otherPort: "origin",
          javascript: "scheme",
          data: "scheme",
          mailto: "scheme",
          malformed: "invalid",
        }
        const reason = refused[s.form]
        expect(appPath(to[s.form], ORIGIN)).toEqual(reason === undefined ? { _tag: "Path", path: `/${tail}` } : { _tag: "Refused", reason })
      }),
  ))

const TAKEN = { txid: 12, opId: "op-1", outcome: "committed", number: 7 } as const
const FOUND = {
  kind: "found", number: 7, state: "working", step: "implement", attempt: 1, branch: "smithers/todo-7", prNumber: null,
  failure: null, note: null, runId: "todo:attempt-1", updatedAt: "2026-10-21T17:00:00Z",
} as const

test("the stack client sends one change and reads its answer, a refusal's code, or nothing it can trust", () =>
  property(
    Schema.Struct({
      status: Schema.Literals([200, 202, 400, 401, 403, 404, 409, 413, 429, 500]),
      body: Schema.Literals(["taken", "found", "refusal", "notJson", "empty"]),
      code: Schema.Literals(["authentication", "forbidden", "stack_full", TODO_STATUS_NOT_FOUND, "rate_limited"]),
      samePerson: Schema.Boolean,
      offline: Schema.Boolean,
      op: Schema.Literals(["commit", "commitOnIssue", "drop", "retry", "attach"]),
      number: int(1, 50),
    }),
    (s) =>
      Effect.gen(function* () {
        const sent: Array<HttpClientRequest.HttpClientRequest> = []
        const body = { taken: JSON.stringify(TAKEN), found: JSON.stringify(FOUND), refusal: JSON.stringify({ code: s.code }), notJson: "{bad", empty: "{}" }[s.body]
        const client = HttpClient.make((request) => {
          sent.push(request)
          return s.offline
            ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "offline" }) }))
            : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, {
              status: s.status,
              headers: s.samePerson ? { [SESSION_CHECK_HEADER]: "same_person" } : {},
            })))
        })
        const ok = s.status === 200 || s.status === 202

        // The queued row becomes the route's body: a commit's text, or the number a drop, retry or attach names.
        const row: Sending = {
          v: 4, id: "op-1", repo: "octo/hello", repoId: "github/octo/hello", queuedAt: 1,
          op: s.op === "commitOnIssue" ? "commit" : s.op,
          title: "Title", prompt: "Prompt", acceptance: ["passes"], number: s.number,
          ...(s.op === "commitOnIssue" || s.op === "attach" ? { issue: 5 } : {}),
          ...(s.op === "commitOnIssue" ? { after: null } : {}),
        }
        const change = TodosWrites.requestOf(row)
        expect(change).toEqual(
          s.op === "commit"
            ? { opId: "op-1", op: "commit", title: "Title", prompt: "Prompt", acceptance: ["passes"] }
            : s.op === "commitOnIssue"
            ? { opId: "op-1", op: "commit", title: "Title", prompt: "Prompt", acceptance: ["passes"], issue: 5, after: null }
            : s.op === "attach"
            ? { opId: "op-1", op: "attach", number: s.number, issue: 5 }
            : { opId: "op-1", op: s.op, number: s.number },
        )
        expect(Object.keys(change).sort()).toEqual(
          (s.op === "commit" ? ["opId", "op", "title", "prompt", "acceptance"]
            : s.op === "commitOnIssue" ? ["opId", "op", "title", "prompt", "acceptance", "issue", "after"]
            : s.op === "attach" ? ["opId", "op", "number", "issue"] : ["opId", "op", "number"]).sort(),
        )

        const posted = yield* Effect.exit(
          Effect.flatMap(TodosApi.StackClient, (stack) => stack.change("octo", "hello", change)).pipe(
            Effect.provide(TodosApi.StackClient.layer({ origin: ORIGIN, within: "5 seconds" })),
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        )
        expect(sent.map((request) => [request.method, request.url, request.headers[CONFIRM_401_HEADER]])).toEqual([
          ["POST", `${ORIGIN}${stackRoute("octo", "hello")}`, "1"],
        ])
        // A refusal is compared field by field: what the outbox reads to decide between Not sent, held and retry.
        const refusal = (exit: typeof posted) => {
          const { status, code, sessionCheck } = Option.getOrThrow(Exit.findErrorOption(exit))
          return { refused: { status, code, sessionCheck } }
        }
        expect(Exit.isSuccess(posted) ? posted.value : refusal(posted)).toStrictEqual(
          s.offline
            ? { refused: { status: undefined, code: undefined, sessionCheck: undefined } }
            : ok
            ? s.body === "taken" ? TAKEN : { refused: { status: s.status, code: undefined, sessionCheck: undefined } }
            : { refused: {
              status: s.status,
              code: s.body === "refusal" ? s.code : undefined,
              sessionCheck: s.samePerson ? "same_person" : undefined,
            } },
        )

        const read = yield* Effect.exit(
          TodosApi.readTodoStatus(ORIGIN, "octo", "hello", s.number, "5 seconds").pipe(
            Effect.provideService(HttpClient.HttpClient, client),
          ),
        )
        expect(sent[1]?.url).toBe(`${ORIGIN}${todoStatusRoute("octo", "hello", s.number)}`)
        const named = s.body === "refusal" ? s.code : undefined
        expect(Exit.isSuccess(read) ? read.value : Option.getOrThrow(Exit.findErrorOption(read)).reason).toEqual(
          s.offline
            ? "unavailable"
            : s.status === 200
            ? s.body === "found" ? FOUND : "unavailable"
            : s.status === 404 && named === TODO_STATUS_NOT_FOUND
            ? { kind: "not_found", number: s.number }
            : s.status === 401 && named === "authentication"
            ? "authentication"
            : s.status === 403 && named === "forbidden"
            ? "forbidden"
            : "unavailable",
        )

        // What the outbox does with the refusal: a code it never sends again wins, then the status, else it retries.
        const never: Partial<Record<number, string>> = { 400: "invalid", 401: "authentication", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large" }
        const final = named === "authentication" || named === "forbidden" || named === "stack_full"
        expect(TodosWrites.reasonOf(s.status, named)).toBe(final ? named : never[s.status])
        expect(TodosWrites.reasonOf(undefined, undefined)).toBeUndefined()
      }),
  ))
