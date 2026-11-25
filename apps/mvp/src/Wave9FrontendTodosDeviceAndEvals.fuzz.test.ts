import * as AuthContract from "./features/auth/contract"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Logger, Schema } from "effect"
import { rmSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Checks from "../evals/checks.ts"
import * as DeviceIdentity from "./device/identity.ts"
import * as CoeditSaved from "./features/coedit/saved.ts"
import * as PersonalContract from "./features/personal-model/contract.ts"
import { ChangeNotTaken, StackClient } from "./features/todos/api.ts"
import * as TodoWrites from "./features/todos/writes.ts"
import { held, OutboxWrites } from "./outbox.ts"
import * as DeviceFixture from "./test/deviceFixture.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 3), 60))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261195")
const silent = Logger.layer([])

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const makeTrial = (overrides: Partial<Checks.Trial> = {}): Checks.Trial => ({
  status: "done",
  failure: null,
  text: "Here is your answer.\nLine two.",
  calls: [{ flow: "repo/Open", status: "completed", input: { url: "https://sub.example.com/a", title: "Hello World", count: 3 } }],
  painted: ["dark"],
  navigated: ["/acme/widgets"],
  views: [
    {
      template: "generated",
      url: "https://sub.example.com/page",
      props: { repo: "acme/widgets", schema: { properties: { email: { title: "Email address" } }, required: ["email"] } },
      interactions: { move: { kind: "state" } },
      html: `<button data-event="move:0">A</button><button data-event="move:1">B</button><img src="data:image/png;base64,iVBORw0KGgo=" />`,
    },
  ],
  asked: [{ kind: "choice", prompt: "Pick", value: "a" }],
  drafts: [{ name: "my-flow", status: "ready", checks: [{ check: "compile", ok: true }], source: "Flow.make('x', ... repo/Open)" }],
  usage: [{ role: "chat", modelId: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 20, chargedTokens: 30 }],
  ...overrides,
} as Checks.Trial)

describe("Wave9 evals/checks.ts comprehensive fuzzing", () => {
  it("fuzzes every check, HTML inertness filter, CSS escape parser, form/board/draft/usage checks, and grading", async () => {
    const base = makeTrial()
    expect(Checks.answered(base).pass).toBe(true)
    expect(Checks.failedWith(makeTrial({ status: "failed", failure: "rate_limited" }), "rate_limited").pass).toBe(true)
    expect(Checks.failedWith(base, "rate_limited").pass).toBe(false)
    expect(Checks.mentions(base, "ANSWER").pass).toBe(true)
    expect(Checks.readValues(base).pass).toBe(true)
    expect(Checks.readValues(makeTrial({ text: "[object Object]" })).pass).toBe(false)
    expect(Checks.noCalls(makeTrial({ calls: [] })).pass).toBe(true)
    expect(Checks.noCalls(base).pass).toBe(false)

    const pred = Checks.all(
      Checks.hostIs("url", "example.com"),
      Checks.fieldSays("title", "hello"),
      Checks.fieldIs("count", 3),
    )
    expect(Checks.calledOnce(base, "repo/Open", pred).pass).toBe(true)
    expect(Checks.calledOnce(base, "repo/Open").pass).toBe(true)
    expect(Checks.attempted(base, "repo/Open", pred).pass).toBe(true)
    expect(Checks.attempted(base, "repo/Open").pass).toBe(true)
    expect(Checks.notCalled(base, "other/Flow").pass).toBe(true)
    expect(Checks.onlyCalled(base, ["repo/Open"]).pass).toBe(true)
    expect(Checks.atMostLines(base, 2).pass).toBe(true)
    expect(Checks.themeIs(base, "dark").pass).toBe(true)
    expect(Checks.themeUnchanged(makeTrial({ painted: [] })).pass).toBe(true)
    expect(Checks.navigatedTo(base, "/acme/widgets").pass).toBe(true)
    expect(Checks.stayed(makeTrial({ navigated: [] })).pass).toBe(true)

    expect(Checks.hostIs("url", "example.com")({ url: "not a url" })).toBe(false)
    expect(Checks.hostIs("url", "example.com")(null)).toBe(false)
    expect(Checks.fieldSays("title", "hi")(null)).toBe(false)
    expect(Checks.fieldIs("count", 3)(null)).toBe(false)

    expect(Checks.viewShows(base, "generated", "example.com").pass).toBe(true)
    expect(Checks.templateShows(base, "generated", "ACME/WIDGETS").pass).toBe(true)
    expect(Checks.formAsks(makeTrial({
      views: [{ template: "form", url: null, props: { schema: { properties: { email: { title: "Email" } }, required: ["email"] } } }],
    }), ["email"]).pass).toBe(true)
    expect(Checks.formAsks(makeTrial({
      views: [{ template: "form", url: null, props: { schema: { properties: { email: {} }, required: ["email"] } } }],
    })).pass).toBe(true)
    expect(Checks.boardShows(base, 2).pass).toBe(true)
    expect(Checks.inertViews(base).pass).toBe(true)
    expect(Checks.noViews(makeTrial({ views: [] })).pass).toBe(true)
    expect(Checks.askedOnce(base, "choice").pass).toBe(true)
    expect(Checks.askedNothing(makeTrial({ asked: [] })).pass).toBe(true)
    expect(Checks.nothingSaved(base).pass).toBe(true)
    expect(Checks.draftedCalling(base, "repo/Open").pass).toBe(true)
    expect(Checks.usedRole(base, "chat").pass).toBe(true)
    expect(Checks.productWords(base).pass).toBe(true)
    expect(Checks.chargedAsSpent(base).pass).toBe(true)
    expect(Checks.everyAnswer(base).every((c) => c.pass)).toBe(true)
    expect(Checks.safe(base).every((c) => c.pass)).toBe(true)
    const graded = Checks.grade([Checks.everyAnswer(base), [Checks.answered(base), Checks.noCalls(base)]])
    expect(graded.score).toBe(0.5)
    expect(Checks.grade([Checks.everyAnswer(base)]).reason).toBe("every check passed")
    expect(() => Checks.grade([])).toThrow()

    // Fuzz malicious HTML & CSS vectors against inertViews
    const badHtmlArb = Arbitrary.schema(Schema.Literals([
      `<script>alert(1)</script>`,
      `<iframe src="https://evil.com"></iframe>`,
      `<div onclick="x()">hi</div>`,
      `<div style="background: url(https://evil.com/x.png)">hi</div>`,
      `<style>@import "https://evil.com/a.css";</style>`,
      `<style>body { background: \\75rl(https://evil.com/a); }</style>`,
      `<style>/* comment */ a { background: image-set(url(x)); }</style>`,
      `<img src="https://evil.com/x.png" />`,
      `<img src="data:image/svg+xml;base64,PHN2Zz4=" />`,
      `<a href="https://evil.com">link</a>`,
      `<template><script>alert(1)</script></template>`,
      `<img srcset="https://evil.com/a.png 2x" />`,
    ]))
    await holds(badHtmlArb, execs, (html) =>
      Effect.sync(() => {
        const res = Checks.inertViews(makeTrial({ views: [{ template: "generated", url: null, html }] }))
        expect(res.pass).toBe(false)
      }))
  })
})

describe("Wave9 Todos StackWrites, OutboxWrites, Agent AnswerApi, Coedit, PersonalContract, DeviceIdentity & DeviceFixture", () => {
  it("fuzzes StackWrites.layer, todo-op mutation across all outcomes, OutboxWrites.adding, and held()", async () => {
    expect(held().held).toBe(true)

    const outcomes: Array<
      | { readonly ok: true; readonly txid: number | null; readonly number: number }
      | { readonly ok: false; readonly status?: number; readonly code?: string; readonly sessionCheck?: "same_person" }
    > = [
      { ok: true, txid: 101, number: 1 },
      { ok: true, txid: null, number: 1 },
      { ok: false, status: 401, sessionCheck: "same_person" },
      { ok: false, status: 400 },
      { ok: false, status: 401 },
      { ok: false, status: 403 },
      { ok: false, status: 404 },
      { ok: false, status: 409 },
      { ok: false, status: 413 },
      { ok: false, status: 400, code: "stack_full" },
      { ok: false, status: 503 },
      { ok: false },
    ]
    let nextOutcome = outcomes[0]!

    const stackClientLayer = Layer.succeed(
      StackClient,
      StackClient.of({
        change: () =>
          Effect.suspend(() =>
            nextOutcome.ok
              ? Effect.succeed({ txid: nextOutcome.txid, number: nextOutcome.number } as never)
              : Effect.fail(new ChangeNotTaken({
                status: nextOutcome.status,
                code: nextOutcome.code,
                sessionCheck: nextOutcome.sessionCheck,
              })),
          ),
      }),
    )

    const tmpStackDb = `/tmp/wave9a-stack-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`
    const baseOutbox = Layer.succeed(OutboxWrites, OutboxWrites.of({ collections: {}, mutations: {} }))
    const layer = TodoWrites.StackWrites.layer.pipe(
      Layer.provide(stackClientLayer),
      Layer.provide(DeviceFixture.persistenceOn(tmpStackDb)),
      Layer.provide(baseOutbox),
    )

    try { await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const writes = yield* OutboxWrites
          const stackWrites = yield* TodoWrites.StackWrites
          yield* stackWrites.requested.preload
          const mut = writes.mutations[TodoWrites.TODO_OP]!
          const orderFn = writes.orderingKeys![TodoWrites.TODO_OP]!

          const commitRow = {
            v: 4 as const,
            id: crypto.randomUUID(),
            repo: "acme/widgets",
            repoId: "repo-1",
            op: "commit" as const,
            title: "Ship it",
            prompt: "Do the work",
            acceptance: ["tests pass"],
            number: 0,
            issue: 42,
            after: 1,
            queuedAt: Date.now(),
          }
          const attachRow = {
            v: 4 as const,
            id: crypto.randomUUID(),
            repo: "acme/widgets",
            repoId: "repo-1",
            op: "attach" as const,
            title: "",
            prompt: "",
            acceptance: [] as Array<string>,
            number: 1,
            issue: 42,
            queuedAt: Date.now(),
          }
          const dropRow = {
            v: 4 as const,
            id: crypto.randomUUID(),
            repo: "acme/widgets",
            repoId: "repo-1",
            op: "drop" as const,
            title: "",
            prompt: "",
            acceptance: [] as Array<string>,
            number: 1,
            queuedAt: Date.now(),
          }

          expect(orderFn([commitRow])).toEqual(["stack:acme/widgets"])
          expect(TodoWrites.requestOf(commitRow).op).toBe("commit")
          expect(TodoWrites.requestOf(attachRow).op).toBe("attach")
          expect(TodoWrites.requestOf(dropRow).op).toBe("drop")

          for (let i = 0; i < outcomes.length; i++) {
            nextOutcome = outcomes[i]!
            const row = i % 3 === 0 ? commitRow : i % 3 === 1 ? attachRow : dropRow
            const exit = yield* Effect.exit(mut({ rows: [row] } as never))
            if (nextOutcome.ok) expect(Exit.isSuccess(exit)).toBe(true)
            else expect(Exit.isFailure(exit)).toBe(true)
          }

          // Update existing requested row in keep()
          yield* TodoWrites.keep(stackWrites.requested, commitRow, "requested", null, 1)
          yield* TodoWrites.keep(stackWrites.requested, commitRow, "not_sent", "conflict", null)
        }).pipe(Effect.provide(layer), Effect.provide(silent)),
      ),
    ) } finally { rmSync(tmpStackDb, { force: true }) }
  })

  it("fuzzes Coedit saved marks, PersonalContract checkSave/codingChoice/jevOf, DeviceIdentity & DeviceFixture", async () => {
    // 2. Coedit saved marks
    const textArb = Arbitrary.schema(Schema.String.check(Schema.isMaxLength(200)))
    await holds(textArb, execs, (t) =>
      Effect.sync(() => {
        const wellFormed = t.toWellFormed()
        const mark = CoeditSaved.savedMarkOf(wellFormed)
        expect(mark.startsWith(`${wellFormed.length}:`)).toBe(true)
        const n1 = CoeditSaved.savedNameOf(1)
        const n5 = CoeditSaved.savedNameOf(5)
        const marks = new Map([[CoeditSaved.SAVED_MARK, "legacy"], [n1, "m1"], [n5, mark], ["saved:bad", "x"], ["other", "y"]])
        expect(CoeditSaved.savedOf(marks)).toEqual({ name: n5, value: mark })
        expect(CoeditSaved.savedOf(new Map([[CoeditSaved.SAVED_MARK, "legacy"]]))).toEqual({ name: CoeditSaved.SAVED_MARK, value: "legacy" })
        expect(CoeditSaved.savedOf(new Map())).toEqual({ name: CoeditSaved.SAVED_MARK, value: undefined })
      }))

    // 3. PersonalContract: checkSave, codingChoice, jevOf, baseUrlOf, writeExecutionId
    expect(PersonalContract.baseUrlOf(`https://${"a".repeat(255)}.com`)).toBeUndefined()
    expect(PersonalContract.writeExecutionId("put", "id-1")).toBe("model-put:id-1")
    const savedList = [
      { id: "c0", kind: "api_key", active: false, protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", keyLast4: "1111", failureStatus: null, failedAt: null },
      { id: "c1", kind: "claude_subscription", active: true, protocol: null, baseUrl: null, keyLast4: "2222", failureStatus: null, failedAt: null },
      { id: "c2", kind: "jev", active: true, protocol: null, baseUrl: null, keyLast4: "3333", failureStatus: null, failedAt: null },
    ]
    expect(PersonalContract.codingChoice(savedList as never).agent).toBe("claude-code")
    expect(PersonalContract.codingChoice([savedList[0]!, savedList[2]!] as never).agent).toBe("smithers")
    expect(PersonalContract.jevOf(savedList as never)?.id).toBe("c2")

    // checkSave all validation branches
    expect(PersonalContract.checkSave({ connections: [] }, [])).toBe("invalid")
    expect(PersonalContract.checkSave({ connections: [{ kind: "bogus" as never }] }, [])).toBe("invalid")
    expect(PersonalContract.checkSave({
      connections: [
        { id: "dup", kind: "api_key", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", key: "sk-1234567890123456" },
        { id: "dup", kind: "api_key", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", key: "sk-1234567890123456" },
      ],
    }, [])).toBe("invalid")
    expect(PersonalContract.checkSave({ connections: [{ kind: "jev", protocol: "openai-chat", key: "sk-1234567890123456" }] }, [])).toBe("invalid_protocol")
    expect(PersonalContract.checkSave({ connections: [{ kind: "jev", baseUrl: "https://a.com", key: "sk-1234567890123456" }] }, [])).toBe("invalid_base_url")
    expect(PersonalContract.checkSave({ connections: [{ kind: "codex_subscription", baseUrl: "https://a.com" }] }, [])).toBe("invalid")
    expect(PersonalContract.checkSave({ connections: [{ kind: "api_key", protocol: "bad" as never, baseUrl: "https://a.com", key: "sk-1234567890123456" }] }, [])).toBe("invalid_protocol")
    expect(PersonalContract.checkSave({ connections: [{ kind: "api_key", protocol: "openai-chat", baseUrl: "http://bad", key: "sk-1234567890123456" }] }, [])).toBe("invalid_base_url")
    expect(PersonalContract.checkSave({ connections: [{ kind: "claude_subscription", key: "not-oat-1234567890123456" }] }, [])).toBe("invalid_token")
    expect(PersonalContract.checkSave({ connections: [{ kind: "api_key", protocol: "openai-chat", baseUrl: "https://api.openai.com", key: "sk-1234567890123456", models: { badtier: "m" } as never }] }, [])).toBe("invalid")
    expect(PersonalContract.checkSave({ connections: [{ kind: "api_key", protocol: "openai-chat", baseUrl: "https://api.openai.com", key: "sk-1234567890123456", models: { fast: "bad model!" } }] }, [])).toBe("invalid_model")
    const moonOk = PersonalContract.checkSave({
      connections: [{ kind: "moonshot", protocol: "openai-chat", baseUrl: "https://api.moonshot.ai", key: "sk-1234567890123456", models: { fast: "kimi-k3" } }],
    }, [])
    expect(typeof moonOk).toBe("object")

    // 4. DeviceIdentity boundFetch: 401 with CONFIRM_401_HEADER (same_person vs signed_out), 503 credential_stale, sign-out, cross-origin
    let reauthCalls = 0
    let sessionResp: () => Response = () =>
      new Response(JSON.stringify({ signedIn: true, personId: "person-1", login: "p1", role: "member" }), { status: 200 })
    let clockMs = 1_000_000
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (u.includes("/api/auth/session")) return sessionResp()
      if (u.includes("/api/auth/sign-out")) return new Response(null, { status: 204 })
      if (u.includes("/api/need-auth")) return new Response("unauth", { status: 401 })
      if (u.includes("/api/stale-cred")) {
        return new Response("", { status: 503, headers: { "x-smithers-credential": "stale", "retry-after": "2" } })
      }
      return new Response("ok", { status: 200 })
    }
    const bound = DeviceIdentity.boundFetch(fakeFetch, {
      origin: "https://smithers.test",
      principal: () => "person-1",
      reauthorize: async () => { reauthCalls += 1; return false },
      reopensOnSignIn: () => true,
      now: () => clockMs,
    })
    // Cross-origin passes straight through
    expect((await bound("https://other.test/path")).status).toBe(200)
    // 401 with CONFIRM_401_HEADER while same person -> SESSION_CHECK_HEADER = same_person
    const r401 = await bound("https://smithers.test/api/need-auth", {
      headers: { [AuthContract.CONFIRM_401_HEADER]: "1" },
    })
    expect(r401.status).toBe(401)
    expect(r401.headers.get(AuthContract.SESSION_CHECK_HEADER)).toBe("same_person")
    // 503 credential_stale rejects, blocks writes until retry-after elapses, then rereads session
    await expect(bound("https://smithers.test/api/stale-cred", { method: "POST" })).rejects.toThrow()
    await expect(bound("https://smithers.test/api/ok", { method: "POST" })).rejects.toThrow()
    clockMs += 5_000
    expect((await bound("https://smithers.test/api/ok", { method: "POST" })).status).toBe(200)
    // 401 when signed out triggers reauthorize
    sessionResp = () => new Response(JSON.stringify({ signedIn: false, available: true }), { status: 200 })
    await expect(bound("https://smithers.test/api/need-auth", {
      headers: { [AuthContract.CONFIRM_401_HEADER]: "1" },
    })).rejects.toThrow()
    expect(reauthCalls).toBeGreaterThanOrEqual(1)
    // Sign-out path
    expect((await bound("https://smithers.test/api/auth/sign-out", { method: "POST" })).status).toBe(204)

    const boundNoReauth = DeviceIdentity.boundFetch(
      async () => new Response("unauth", { status: 401 }),
      { origin: "https://smithers.test", principal: () => "person-1" },
    )
    expect((await boundNoReauth("https://smithers.test/api/need-auth")).status).toBe(401)

    // 5. DeviceFixture real SQLite file (dropped in finally)
    const tmpSqlite = `/tmp/wave9a-devfix-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sqlite`
    try {
      const db = DeviceFixture.sqlite(tmpSqlite)
      await db.execute("CREATE TABLE t (id TEXT PRIMARY KEY)")
      db.close()
      expect(await DeviceFixture.keptRows(tmpSqlite)).toEqual([])
      const faulty = DeviceFixture.faultyPersistenceOn(tmpSqlite)
      expect(faulty).toBeDefined()
      const plainObj = DeviceFixture.plain({ a: 1, b: undefined })
      expect(plainObj).toEqual({ a: 1 })
    } finally {
      rmSync(tmpSqlite, { force: true })
    }
  }, 60_000)
})
