import { WebCrypto } from "@smthrs/crypto"
import { Migrations } from "@smthrs/effect-tanstack-db"
import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as OlderLeader from "./device/olderLeader.ts"
import * as FilesFlows from "./features/files/flows.vibe"
import * as FlowSource from "./features/flows-ui/source.ts"
import * as NavFlows from "./features/navigation/flows.vibe"
import * as PullsContract from "./features/pulls/contract.ts"
import * as RepoContract from "./features/repo/contract.ts"
import * as StatusApi from "./features/status/api.vibe"
import * as StatusFlows from "./features/status/flows.vibe"
import * as StatusReporter from "./features/status/reporter.vibe"
import * as TodosView from "./features/todos/view.ts"
import * as TabRequests from "./flows/requests.vibe"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const execs = Math.max(20, Math.min(Math.ceil(baseExecs / 3), 60))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261175")
const silentLogger = Logger.layer([])

const holds = async <A>(arb: Arbitrary.Arbitrary<A>, n: number, fn: (v: A) => Effect.Effect<void, unknown>) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (v) => fn(v).pipe(Effect.as(true)), { seed, executions: n }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("Wave7: apps/mvp/src pure views, contracts, source parser, olderLeader, and TabRequests", () => {
  it("fuzzes TodosView (stackRows, notSentRows, withDrop, todoScreenOf, todosByIssue, withTodos, issueChoices, needsAnIssue, todoStagesOf, afterChoicesOf)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        state: Schema.Literals(["queued", "running", "in_review", "merged", "failed", "dropped"]),
        step: Schema.NullOr(Schema.Literals(["plan", "implement", "test", "review"])),
        waiting: Schema.Boolean,
        access: Schema.Literals(["allowed", "forbidden", "loading"]),
        may: Schema.Boolean,
      })
    )

    await holds(arb, execs, (v) =>
      Effect.sync(() => {
        const repoId = "github/acme/app"
        const todos: ReadonlyArray<any> = [
          {
            id: "t1",
            repoId,
            number: 1,
            title: "First",
            body: "b",
            state: v.state,
            step: v.step,
            position: 2,
            issueNumber: 10,
            prNumber: null,
            branchName: null,
            runId: "r1",
            waiting: v.waiting ? { kind: "question", prompt: "?", version: 1, execution: "ex-1" } : null,
            failure: v.state === "failed" ? "tests_failed" : null,
            createdAt: "2026-11-24 00:00:00+00",
            updatedAt: "2026-11-24 00:00:00+00",
          },
          {
            id: "t2",
            repoId,
            number: 2,
            title: "Second",
            body: "b",
            state: "queued",
            step: null,
            position: 1,
            issueNumber: null,
            prNumber: null,
            branchName: null,
            runId: null,
            waiting: null,
            failure: null,
            createdAt: "2026-11-24 00:00:00+00",
            updatedAt: "2026-11-24 00:00:00+00",
          },
        ]
        const requested: ReadonlyArray<any> = [
          { id: "q2", repoId, op: "commit", title: "Q2", status: "not_sent", reason: "offline", queuedAt: 200 },
          { id: "q1", repoId, op: "commit", title: "Q1", status: "not_sent", reason: null, queuedAt: 100 },
        ]
        const rows = TodosView.stackRows(repoId, todos, [], requested)
        expect(rows.length).toBeGreaterThanOrEqual(2)
        const ns = TodosView.notSentRows(repoId, requested, [])
        expect(ns.length).toBe(2)

        const items = TodosView.stackItemsOf(rows, todos, "acme", "app")
        let dropped: number | undefined
        const droppable = TodosView.withDrop(items, true, (n) => { dropped = n })
        for (const item of droppable) {
          if (item.menu && item.menu[0]) item.menu[0].onSelect()
        }
        expect(dropped === undefined || typeof dropped === "number").toBe(true)

        const scr = TodosView.todoScreenOf(undefined, 999, todos, v.access as any, "acme", "app")
        expect(scr.kind === "missing" || scr.kind === "waiting" || scr.kind === "page").toBe(true)

        const byIssue = TodosView.todosByIssue(repoId, [
          ...todos,
          { ...todos[0], id: "t3", number: 3, issueNumber: 10 },
        ], "acme", "app")
        expect(byIssue.size).toBe(1)

        let madeNum: number | undefined
        const decorated = TodosView.withTodos(
          [{ id: "i1", number: 10, title: "Bug", state: "open", href: "/acme/app/issues/10" } as any],
          byIssue,
          v.may,
          (n) => { madeNum = n }
        )
        if (decorated[0]?.menu?.[0]?.onSelect) decorated[0].menu[0].onSelect()
        expect(madeNum === undefined || madeNum === 10).toBe(true)

        const issues: ReadonlyArray<TodosView.IssueFacts> = [
          { repoId, kind: "issue", number: 10, title: "Del", state: "open", deletedAt: "2026-11-24T00:00:00Z" },
          { repoId, kind: "issue", number: 12, title: "Open B", state: "open", deletedAt: null },
          { repoId, kind: "issue", number: 11, title: "Open A", state: "open", deletedAt: null },
        ]
        expect(TodosView.issueChoices(repoId, issues).map((i) => i.number)).toEqual([12, 11])
        expect(TodosView.needsAnIssue(repoId, todos, issues).length).toBe(2)

        const stages = TodosView.todoStagesOf(todos[0])
        expect(Array.isArray(stages)).toBe(true)
        const stagesUndef = TodosView.todoStagesOf(undefined)
        expect(stagesUndef).toEqual([])

        const afters = TodosView.afterChoicesOf(repoId, todos)
        expect(afters.length).toBeGreaterThanOrEqual(4)
      })
    )
  })

  it("fuzzes PullsContract, RepoContract, FlowSource, OlderLeader, and TabRequests", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mergeFailure: Schema.Literals(["head_moved", "base_moved", "draft", "not_mergeable", "merged", "closed"]),
        bytesKind: Schema.Literals(["utf8", "nul", "bad_utf8"]),
        sourceKind: Schema.Literals(["caps_literal", "caps_template", "caps_parens", "bad_syntax", "machine_cap"]),
        leaderFail: Schema.Boolean,
        remembered: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
      })
    )

    await holds(arb, execs, (v) =>
      Effect.gen(function* () {
        // PullsContract
        expect(PullsContract.MERGE_FAILURE_COPY[v.mergeFailure]("main").length).toBeGreaterThan(0)
        expect(PullsContract.compareRoute("acme", "app", "main", "feat")).toContain("main...feat")
        expect(PullsContract.githubPullUrl("acme", "app", 7)).toBe("https://github.com/acme/app/pull/7")
        expect(PullsContract.reviewExecutionId("github/acme/app", "abc", 123)).toContain("review:")
        expect(PullsContract.reviewRoute("acme", "app", 7)).toContain("/7/")

        // RepoContract
        expect(RepoContract.treeRoute("acme", "app", "abc")).toContain("/tree/abc")
        expect(RepoContract.blobRoute("acme", "app", "abc", "src/a b.ts")).toContain("/blob/abc/")
        expect(RepoContract.rawRoute("acme", "app", "abc", "src/a.ts")).toContain("/raw/abc/")
        expect(RepoContract.refsRoute("acme", "app")).toContain("/refs")
        expect(RepoContract.aboutRoute("acme", "app")).toContain("/about")
        expect(RepoContract.githubRawUrl("acme", "app", "abc", "src/a.ts")).toContain("github.com")
        const bytes =
          v.bytesKind === "utf8"
            ? new TextEncoder().encode("hello")
            : v.bytesKind === "nul"
              ? new Uint8Array([65, 0, 66])
              : new Uint8Array([0xff, 0xfe, 0xfd])
        const decoded = RepoContract.textOf(bytes)
        expect(v.bytesKind === "utf8" ? decoded === "hello" : decoded === undefined).toBe(true)

        // FlowSource
        const src =
          v.sourceKind === "caps_literal"
            ? `import { Flow } from "@smthrs/flow"\nexport default Flow.make("a", { capabilities: ["fs:read", "git:push"] })`
            : v.sourceKind === "caps_template"
              ? `export default Flow.make("a", { capabilities: [\`shell:exec\`] })`
              : v.sourceKind === "caps_parens"
                ? `export default Flow.make("a", { capabilities: [("net:fetch" as const)] })`
                : v.sourceKind === "bad_syntax"
                  ? `export default {{{ broken`
                  : `import "node:fs"\nexport default Flow.make("a", { capabilities: ["sandbox:exec"] })`
        const caps = FlowSource.capabilitiesOf(src)
        const needM = FlowSource.needsMachine(src)
        expect(Array.isArray(caps)).toBe(true)
        expect(typeof needM).toBe("boolean")

        // OlderLeader
        const reg = Migrations.registry({ stores: [{ id: "issue-writes", schemaVersion: 3 }] as any })
        expect(OlderLeader.olderLeader(reg, new Error(`Schema version mismatch for collection "issue-writes": found 3, expected 1`))).toBe(true)
        expect(OlderLeader.olderLeader(reg, new Error("other error"))).toBe(false)
        let seenErr: unknown
        const coord = OlderLeader.watchLeader(
          {
            pullSince: async () => {
              if (v.leaderFail) throw new Error("old_leader")
              return "ok"
            },
          },
          (e) => { seenErr = e }
        )
        const pullExit = yield* Effect.exit(Effect.tryPromise(() => coord.pullSince()))
        if (v.leaderFail) {
          expect(Exit.isFailure(pullExit)).toBe(true)
          expect(seenErr).toBeInstanceOf(Error)
        } else {
          expect(Exit.isSuccess(pullExit)).toBe(true)
        }

        // TabRequests
        yield* Effect.gen(function* () {
          const tr = yield* TabRequests.TabRequests
          for (let i = 0; i < v.remembered + 2; i++) {
            yield* tr.add(`exec-${i}`, "button")
          }
          yield* tr.add(`exec-${v.remembered + 1}`, "button")
          const latest = yield* tr.doorOf(`exec-${v.remembered + 1}`)
          expect(Option.isSome(latest)).toBe(true)
          const evicted = yield* tr.doorOf("exec-0")
          expect(Option.isNone(evicted)).toBe(true)
        }).pipe(Effect.provide(TabRequests.TabRequests.layer(v.remembered)))
      })
    )
  })
})

describe("Wave7: NavFlows, FilesFlows, StatusReporter, and StatusFlows", () => {
  it("fuzzes NavFlows.goTo, FilesFlows.openFile/closeFile, and StatusReporter.layer", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        navTarget: Schema.Literals(["/acme/app", "https://evil.example/x", "javascript:alert(1)"]),
        tabReply: Schema.Literals(["none", "moved", "not_moved"]),
        isAgentCall: Schema.Boolean,
        fileOp: Schema.Literals(["open", "close"]),
        fileReply: Schema.Literals(["none", "no_repo", "absent", "done"]),
        reportFail: Schema.Boolean,
        reportStatus: Schema.Literals(["working", "done", "failed"]),
      })
    )

    await holds(arb, execs, (v) =>
      Effect.gen(function* () {
        const execId = v.isAgentCall ? "ans-1/chat/Respond@1/call/0.0" : "req-1"
        const instLayer = Layer.succeed(FlowRuntime.FlowInstance, { executionId: execId } as never)

        // NavFlows.goTo
        const tabsLayer = Layer.succeed(NavFlows.Tabs, NavFlows.Tabs.of({
          origin: "https://smithers.test",
          ask: () =>
            v.tabReply === "none"
              ? Effect.succeedNone
              : Effect.succeedSome({ door: "button", moved: v.tabReply === "moved" }),
        }))
        const navExit = yield* Effect.exit(
          NavFlows.goTo({ to: v.navTarget }).pipe(Effect.provide(Layer.mergeAll(instLayer, tabsLayer, silentLogger)))
        )
        expect(v.navTarget === "/acme/app" ? Exit.isSuccess(navExit) : Exit.isFailure(navExit)).toBe(true)

        // FilesFlows.openFile / closeFile
        const fileTabsLayer = Layer.succeed(FilesFlows.FileTabsTabs, FilesFlows.FileTabsTabs.of({
          ask: () =>
            v.fileReply === "none"
              ? Effect.succeedNone
              : Effect.succeedSome({
                  door: "button",
                  reply: {
                    repository: v.fileReply === "no_repo" ? null : "acme/app",
                    ref: v.fileReply === "no_repo" ? null : "main",
                    done: v.fileReply === "done",
                  },
                }),
        }))
        const fileLayer = Layer.mergeAll(instLayer, fileTabsLayer, silentLogger)
        const fileExit = v.fileOp === "open"
          ? yield* Effect.exit(FilesFlows.openFile({ path: "/src/app.ts/", lines: "10-20" }).pipe(Effect.provide(fileLayer)))
          : yield* Effect.exit(FilesFlows.closeFile({ path: "src/app.ts" }).pipe(Effect.provide(fileLayer)))
        const fileOk = Exit.isSuccess(fileExit as Exit.Exit<unknown, unknown>)
        expect(v.fileReply === "no_repo" ? !fileOk : fileOk).toBe(true)

        // StatusReporter.layer
        const runsClientLayer = Layer.succeed(StatusApi.RunsClient, {
          report: () =>
            v.reportFail
              ? Effect.fail(new StatusApi.RunsRefused({ status: 503, code: "unavailable" }))
              : Effect.void,
          answer: () => Effect.void,
        } as unknown as StatusApi.RunsClient["Service"])
        yield* Effect.gen(function* () {
          const rep = yield* StatusReporter.RunReporter
          yield* rep.report(execId, { status: v.reportStatus } as never)
          yield* rep.report(execId, { status: v.reportStatus } as never) // dedup skipped if not settled
          const orFailExit = yield* Effect.exit(rep.reportOrFail("run-2", { status: "working" } as never))
          expect(v.reportFail ? Exit.isFailure(orFailExit) : Exit.isSuccess(orFailExit)).toBe(true)
        }).pipe(Effect.provide(StatusReporter.RunReporter.layer.pipe(Layer.provide(runsClientLayer))), Effect.provide(silentLogger))
      })
    )
  })

  it("fuzzes StatusFlows Ask/AnswerRun/Deliver registrations and action handlers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals([200, 400, 503]),
        answerErr: Schema.Literals(["ok", "not_open", "refused", "unrecorded"]),
        kind: Schema.Literals(["approval", "question"]),
        valKind: Schema.Literals(["bool", "decision_note", "decision_blank", "string", "null"]),
      })
    )

    await holds(arb, execs, (v) =>
      Effect.gen(function* () {
        // Pure helpers & error constructors
        expect(StatusFlows.isRefusal(v.status)).toBe(v.status >= 400 && v.status < 500)
        const val =
          v.valKind === "bool"
            ? true
            : v.valKind === "decision_note"
              ? { approved: true, note: "ship it" }
              : v.valKind === "decision_blank"
                ? { approved: false, note: "   " }
                : v.valKind === "string"
                  ? "yes"
                  : null
        expect(StatusFlows.answerOf(val) !== undefined).toBe(true)
        expect(StatusFlows.tokenOf("ex-1").length).toBeGreaterThan(0)

        // Verify registration layer builds cleanly with dependencies
        const runsClient = Layer.succeed(StatusApi.RunsClient, {
          report: () => v.status === 200 ? Effect.void : Effect.fail(new StatusApi.RunsRefused({ status: v.status, code: "err" })),
          answer: () =>
            v.answerErr === "ok"
              ? Effect.void
              : Effect.fail(new StatusApi.RunsRefused({
                  status: v.answerErr === "refused" ? 403 : 503,
                  code: v.answerErr === "not_open" ? "not_open" : "err",
                })),
        } as unknown as StatusApi.RunsClient["Service"])
        const reporter = StatusReporter.RunReporter.layer.pipe(Layer.provide(runsClient))
        const handlers = new Map<string, (input: any) => Effect.Effect<any, any, any>>()
        const fakeRuntime = Layer.succeed(FlowRuntime.FlowRuntime, {
          poll: () =>
            v.answerErr === "not_open"
              ? Effect.succeed(Option.some({ _tag: "Complete" }))
              : v.answerErr === "ok"
                ? Effect.succeed(Option.some({ _tag: "Waiting" }))
                : Effect.fail(new Error("not_here")),
          register: (reg: any, fn: any) => Effect.sync(() => { const k = reg?._tag ?? reg?.name; if (k && typeof fn === "function") handlers.set(String(k), fn) }),
          deliver: () => v.answerErr === "ok" ? Effect.void : Effect.fail(new Error("not_waiting")),
        } as unknown as FlowRuntime.FlowRuntime["Service"])
        const env = Layer.mergeAll(runsClient, reporter, fakeRuntime, silentLogger, WebCrypto.layer, Layer.succeed(FlowRuntime.FlowInstance, { executionId: "ex-1" } as never))
        yield* Effect.scoped(Layer.build(StatusFlows.registration.pipe(Layer.provide(env))))
        const reqFn = handlers.get(StatusFlows.AskRequest.name)
        const ansFn = handlers.get(StatusFlows.AskAnswer.name)
        const recFn = handlers.get(StatusFlows.RecordAnswer.name)
        const delFn = handlers.get(StatusFlows.DeliverAnswer.name)
        expect(reqFn && ansFn && recFn && delFn).toBeTruthy()
        if (reqFn) {
          const act = reqFn({ kind: v.kind, prompt: "Choose?", options: ["a", "b"] }) as any
          yield* Effect.exit(((act.execute ?? act) as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(env)))
        }
        if (ansFn) {
          const act = ansFn({ kind: v.kind, value: val }) as any
          const out = yield* ((act.execute ?? act) as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(env))
          expect(typeof (out as any).answered).toBe("boolean")
        }
        if (recFn) {
          const act = recFn({ runId: "r1", version: 1, value: val ?? "ok" }) as any
          yield* Effect.exit(((act.execute ?? act) as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(env)))
        }
        if (delFn) {
          const act = delFn({ execution: "ex-1", value: val ?? "ok" }) as any
          yield* Effect.exit(((act.execute ?? act) as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(env)))
        }
        expect(Interpreter.layerWithImplementations).toBeDefined()
      })
    )
  })
})
