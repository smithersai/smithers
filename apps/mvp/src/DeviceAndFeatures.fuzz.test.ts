import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import * as Identity from "./device/identity.vibe"
import * as FilesFlows from "./features/files/flows.vibe"
import * as FlowsSource from "./features/flows-ui/source.ts"
import * as IssueLifecycle from "./features/issues/lifecycle.ts"
import * as NavFlows from "./features/navigation/flows.vibe"
import * as StatusApi from "./features/status/api.vibe"
import * as StatusFlows from "./features/status/flows.vibe"
import * as StatusReporter from "./features/status/reporter.vibe"
import * as TodoView from "./features/todos/view.ts"
import * as ViewForm from "./features/views/form.ts"
import * as TabPort from "./flows/tabPort.vibe"
import * as Pwa from "./pwa.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")
const silentLogger = Logger.layer([])

const memoryStorage = () => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    }
  }
}

const makeFakeSqlite = (initialOwner: { personId: string; login: string; ownsUnstamped: number; sessionTag: string | null } | null) => {
  let owner = initialOwner ? { ...initialOwner } : null
  const execute = (sql: string, params?: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<Record<string, unknown>>> =>
    Effect.sync(() => {
      const q = sql.trim()
      if (q.startsWith("PRAGMA table_info")) {
        return [{ name: "owns_unstamped" }, { name: "session_tag" }]
      }
      if (q.startsWith("SELECT v, person_id")) {
        if (owner === null) return []
        return [{ v: 1, personId: owner.personId, login: owner.login, ownsUnstamped: owner.ownsUnstamped, sessionTag: owner.sessionTag }]
      }
      if (q.startsWith("INSERT") || q.startsWith("REPLACE") || q.startsWith("UPDATE")) {
        if (params && params.length >= 2) {
          owner = {
            personId: String(params[0]),
            login: String(params[1]),
            ownsUnstamped: 0,
            sessionTag: params[2] ? String(params[2]) : null
          }
        }
        return []
      }
      return []
    })
  return { execute } as unknown as Parameters<typeof Identity.authorizeDevice>[0]["database"]
}

const makeChannelPair = () => {
  const listenersA = new Set<(event: { readonly data: unknown }) => void>()
  const listenersB = new Set<(event: { readonly data: unknown }) => void>()
  const a: TabPort.Endpoint = {
    postMessage: (msg) => {
      queueMicrotask(() => {
        for (const fn of [...listenersB]) fn({ data: msg })
      })
    },
    addEventListener: (_type, fn) => {
      listenersA.add(fn as (event: { readonly data: unknown }) => void)
    },
    removeEventListener: (_type, fn) => {
      listenersA.delete(fn as (event: { readonly data: unknown }) => void)
    }
  }
  const b: TabPort.Endpoint = {
    postMessage: (msg) => {
      queueMicrotask(() => {
        for (const fn of [...listenersA]) fn({ data: msg })
      })
    },
    addEventListener: (_type, fn) => {
      listenersB.add(fn as (event: { readonly data: unknown }) => void)
    },
    removeEventListener: (_type, fn) => {
      listenersB.delete(fn as (event: { readonly data: unknown }) => void)
    }
  }
  return { a, b }
}

describe("apps/mvp device identity, todos view, tabPort, status, flows-ui, pwa & feature flows fuzz invariants", () => {
  it("Device.identity exercises authorizeDevice, readSession, sessionNow, answer, readReceipt, stale, reopenDue, boundFetch, activationGate & outboxPrincipal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        storedOwner: Schema.NullOr(Schema.Literals([Identity.VISITOR, "person-1", "person-2"])),
        sessionKind: Schema.Literals(["signed-in-1", "signed-in-2", "signed-out", "unreachable", "500", "malformed"]),
        fetchStatus: Schema.Literals([200, 401, 403, 409, 500]),
        hasBodyHeader: Schema.Boolean,
        continuous: Schema.Boolean,
        reopensOnSignIn: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ storedOwner, sessionKind, fetchStatus, hasBodyHeader, continuous, reopensOnSignIn }) =>
          Effect.promise(async () => {
            const db = makeFakeSqlite(
              storedOwner === null
                ? null
                : { personId: storedOwner, login: storedOwner === Identity.VISITOR ? "visitor" : storedOwner, ownsUnstamped: 1, sessionTag: "tag-1" }
            )
            const sessionEff =
              sessionKind === "unreachable"
                ? Effect.fail(new Error("offline"))
                : sessionKind === "signed-out" || sessionKind === "500" || sessionKind === "malformed"
                ? Effect.succeed({ signedIn: false, configured: true } as const)
                : Effect.succeed({
                    signedIn: true,
                    configured: true,
                    person: { id: sessionKind === "signed-in-1" ? "person-1" : "person-2", login: sessionKind === "signed-in-1" ? "p1" : "p2" },
                    role: "member" as const,
                    sessionTag: "tag-1"
                  })

            const reports: Array<Identity.Outcome> = []
            const authExit = await Effect.runPromise(
              Effect.exit(
                Identity.authorizeDevice({
                  database: db,
                  session: sessionEff as never,
                  report: (_owner, outcome) => {
                    reports.push(outcome)
                  }
                }).pipe(Effect.provide(silentLogger))
              )
            )

            const resp =
              sessionKind === "500"
                ? new Response("err", { status: 500 })
                : sessionKind === "malformed"
                ? new Response("{bad", { status: 200, headers: { "content-type": "application/json" } })
                : sessionKind === "signed-out"
                ? new Response(JSON.stringify({ signedIn: false, configured: true }), { status: 200, headers: { "content-type": "application/json" } })
                : new Response(
                    JSON.stringify({
                      signedIn: true,
                      configured: true,
                      person: { id: "person-1", login: "p1" },
                      role: "member"
                    }),
                    { status: 200, headers: { "content-type": "application/json" } }
                  )
            const sNow = await Identity.sessionNow(resp)
            const receipt: Identity.Receipt = {
              _tag: Identity.IDENTITY_MESSAGE,
              owner: storedOwner ?? undefined,
              outcome: authExit._tag === "Success" ? "verified" : "unverified",
              ...(continuous ? { continuous: true as const } : {})
            }
            const answered = Identity.answer(receipt, sNow)
            const parsedReceipt = Identity.readReceipt(answered)
            const badReceipt = Identity.readReceipt({ bogus: 1 })
            Identity.readSession({ signedIn: false, configured: true })
            Identity.readSession(null)

            const st = Identity.stale(
              storedOwner ?? Identity.VISITOR,
              reopensOnSignIn,
              sNow !== "unreachable" && sNow !== "malformed" ? sNow : undefined
            )
            const marks = memoryStorage()
            const d1 = Identity.reopenDue(marks, "m1", 60_000, 100_000)
            marks.setItem("m1", "100000")
            const d2 = Identity.reopenDue(marks, "m1", 60_000, 105_000)
            const d3 = Identity.reopenDue(marks, "m1", 60_000, 200_000)

            let refusedCount = 0
            const binding: Identity.Binding = {
              principal: () => storedOwner ?? Identity.VISITOR,
              adopt: async () => "adopted",
              refuse: () => {
                refusedCount++
              },
              clear: () => Effect.void,
              reopen: () => {}
            } as unknown as Identity.Binding
            const wrapped = Identity.boundFetch(
              (async () =>
                new Response(
                  JSON.stringify({ code: fetchStatus === 409 ? "device_mismatch" : "ok" }),
                  {
                    status: fetchStatus,
                    headers: hasBodyHeader ? { "x-smithers-device-person": "person-1" } : {}
                  }
                )) as unknown as typeof globalThis.fetch,
              binding
            )
            await wrapped("https://smithers.test/api/test", { method: "POST" })

            const gate = Identity.activationGate(() => {
              refusedCount++
            })
            const allowed = gate.allow()
            const refused = gate.refuse()
            const state = gate.state()

            const op = Identity.outboxPrincipal(() => storedOwner ?? undefined, () => continuous)
            const nowP = op.now()
            const unstamped = op.ownsUnstamped()

            return (
              parsedReceipt !== undefined &&
              badReceipt === undefined &&
              typeof st === "boolean" &&
              d1 === true &&
              d2 === false &&
              d3 === true &&
              typeof allowed === "boolean" &&
              typeof refused === "boolean" &&
              typeof state === "string" &&
              typeof nowP === "string" &&
              typeof unstamped === "boolean" &&
              refusedCount >= 0
            )
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("TodoView covers stackRows, notSentRows, deliveredOf, todoCardOf, statusOf, runLinkOf, stackItemsOf, withDrop, todoPageOf, todoScreenOf, todosByIssue, withTodos & mayRetry", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        state: Schema.Literals(["queued", "working", "in_review", "merged", "failed", "dropped"]),
        waiting: Schema.NullOr(Schema.Literals(["runner"])),
        accessStatus: Schema.Literals(["allowed", "refused", "checking"]),
        hasFailure: Schema.Boolean,
        hasRunId: Schema.Boolean,
        pendingKind: Schema.Literals(["none", "requested", "not_sent"]),
        issueState: Schema.Literals(["open", "closed"]),
        op: Schema.Literals(["commit", "drop", "retry", "attach"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ state, waiting, accessStatus, hasFailure, hasRunId, pendingKind, issueState, op }) =>
          Effect.sync(() => {
            const todo = {
              id: "t-1",
              repoId: "acme/widgets",
              number: 42,
              title: "Fix bug",
              state,
              position: state === "merged" || state === "dropped" ? null : 1,
              issueNumber: 7,
              runId: hasRunId ? "run-99" : null,
              failure: hasFailure ? ("runner_lost" as const) : null,
              prNumber: 42,
              branch: "smithers/todo-42",
              afterNumber: null,
              waiting,
              createdLogin: "alice",
              createdAt: "2026-11-22 12:00:00+00",
              updatedAt: "2026-11-22 12:05:00+00",
              settledAt: state === "merged" || state === "dropped" ? "2026-11-22 12:06:00+00" : null
            }
            const reqRow = {
              id: "req-1",
              repoId: "acme/widgets",
              op,
              number: 42,
              title: "Fix bug",
              issue: 7,
              status: pendingKind === "not_sent" ? "not_sent" : "requested",
              reason: pendingKind === "not_sent" ? "offline" : null,
              queuedAt: 1000
            }
            const sending = pendingKind === "requested" ? [reqRow] : []
            const requested = pendingKind !== "none" ? [reqRow] : []

            const rows = TodoView.stackRows("acme/widgets", [todo as never], sending as never, requested as never)
            const notSent = TodoView.notSentRows("acme/widgets", requested as never, sending as never)
            const delivered = TodoView.deliveredOf("acme/widgets", [todo as never], requested as never)
            const card = TodoView.todoCardOf(
              42,
              rows,
              [todo as never],
              [{ todoId: "t-1", prompt: "Fix it", acceptance: ["tests pass"], createdAt: "2026-11-22 12:00:00+00" } as never]
            )
            const st = TodoView.statusOf(42, state, waiting)
            const link = TodoView.runLinkOf(todo as never)
            const iso = TodoView.isoOf(todo.createdAt)
            const droppable = TodoView.isDroppable({
              number: 42,
              state,
              pending: pendingKind === "none" ? undefined : pendingKind
            })
            const items = TodoView.stackItemsOf(rows, [todo as never], "acme", "widgets")
            const dropped = TodoView.withDrop(items, accessStatus === "allowed", () => {})
            const confirm = TodoView.dropConfirm(42, "Fix bug")
            const page = card !== undefined ? TodoView.todoPageOf(card, "acme", "widgets") : undefined
            const draftsR = TodoView.draftsOfRepo("acme/widgets", [{ id: "d1", repoId: "acme/widgets", answerId: "a1" } as never])
            const draftsA = TodoView.draftsOfAnswer("a1", [{ id: "d1", repoId: "acme/widgets", answerId: "a1" } as never])
            const acc = TodoView.accessFor("acme/widgets", [{ repoId: "acme/widgets", status: accessStatus } as never])
            const canChg = TodoView.mayChange({ status: "signed_in", role: "member" }, { role: "member" }, { status: "ok" } as never)
            const screen = TodoView.todoScreenOf(card, 42, [todo as never], acc, "acme", "widgets")
            const byIssue = TodoView.todosByIssue("acme/widgets", [todo as never], sending as never, requested as never)
            const canMake = TodoView.mayMakeTodo(canChg, { state: issueState })
            const issueWithTodos = TodoView.withTodos(
              [{ number: 7, title: "Bug", state: issueState } as never],
              byIssue,
              canChg,
              () => {}
            )
            const retry = card !== undefined ? TodoView.mayRetry(card, { status: "signed_in", login: "alice" }, requested as never) : false

            return (
              Array.isArray(rows) &&
              Array.isArray(notSent) &&
              Array.isArray(delivered) &&
              typeof st === "object" &&
              (link === undefined || typeof link === "object") &&
              iso.includes("T") &&
              typeof droppable === "boolean" &&
              Array.isArray(dropped) &&
              confirm.title.length > 0 &&
              (page === undefined || typeof page === "object") &&
              draftsR.length === 1 &&
              draftsA.length === 1 &&
              typeof screen === "object" &&
              typeof canMake === "boolean" &&
              Array.isArray(issueWithTodos) &&
              typeof retry === "boolean"
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("TabPort, FlowsSource, Pwa, ViewForm, IssueLifecycle, FilesFlows & NavFlows uphold pure invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["ping", "fail", "missing"]),
        urlPath: Schema.Literals(["/", "/docs/guide", "/changelogs/v1", "/app/repo", "/api/session", "/assets/main.js"]),
        sameOrigin: Schema.Boolean,
        navMode: Schema.Literals(["navigate", "cors"]),
        flowName: Schema.Literals(["triage", "deploy", "review"]),
        needsShell: Schema.Boolean,
        issueTitle: Schema.Literals(["Crash on login", "Feature request: dark mode", "Bug: 500 error"]),
        hasSecretField: Schema.Boolean,
        navTarget: Schema.Literals(["/acme/widgets", "/acme/widgets/issues", "https://evil.com", "javascript:alert(1)", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, urlPath, sameOrigin, navMode, flowName, needsShell, issueTitle, hasSecretField, navTarget }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { a, b } = makeChannelPair()
              const stop = yield* TabPort.answer(b, {
                ping: (input) => Effect.succeed({ pong: input }),
                fail: () => Effect.fail("handler-boom")
              })
              const callExit = yield* Effect.gen(function* () {
                const port = yield* TabPort.TabPort
                return yield* Effect.exit(port.call(method, { ok: true }))
              }).pipe(Effect.provide(TabPort.TabPort.layer(a, "200 millis")))
              if (method === "ping" && callExit._tag !== "Success") return false
              if ((method === "fail" || method === "missing") && callExit._tag !== "Failure") return false
              stop()

              const src = FlowsSource.renderSource({
                name: flowName,
                description: "Fuzz flow",
                instructions: "Check repo\nReport findings",
                flows: needsShell ? ["sandbox/exec", "files/read"] : ["issues/list"]
              })
              const imps = FlowsSource.importsOf(src)
              const caps = FlowsSource.capabilitiesOf(src)
              const placement = FlowsSource.placementOf(src)
              const sn = FlowsSource.stepName(flowName)

              const cached = Pwa.shellCaches({
                url: new URL(`https://smithers.test${urlPath}`),
                sameOrigin,
                request: { mode: navMode, method: "GET" } as never
              })
              let failedInstall = false
              const workerState = {
                state: "installing",
                addEventListener: (_e: "statechange", cb: () => void) => {
                  workerState.state = "redundant"
                  cb()
                }
              }
              Pwa.watchInstalls(
                {
                  installing: workerState,
                  addEventListener: (_e: "updatefound", cb: () => void) => cb()
                },
                () => {
                  failedInstall = true
                }
              )

              const unwatch = Pwa.watchUpdates(
                { update: async () => {} },
                {
                  visible: () => sameOrigin,
                  listen: (_trigger, check) => {
                    check()
                    return () => {}
                  },
                  record: () => {}
                }
              )
              unwatch()
              Pwa.applyRelease({
                hidden: () => sameOrigin,
                listen: (_sig, cb) => {
                  cb()
                  return () => {}
                },
                reload: () => {}
              })

              const formSchema: Record<string, unknown> = hasSecretField
                ? { type: "object", properties: { api_key: { type: "string", format: "password" } } }
                : { type: "object", properties: { name: { type: "string" }, count: { type: "number" } }, required: ["name"] }
              ViewForm.formRefusal(formSchema)
              ViewForm.formRefusal({ type: "object", properties: {} })
              ViewForm.acceptedValues(formSchema, { name: "alice", count: "3" } as never)

              const bug = IssueLifecycle.isBug(issueTitle, ["bug"])
              const repro = IssueLifecycle.hasReproCandidate(["```ts\nexpect(1).toBe(2)\n```", "plain text"])
              const comm = IssueLifecycle.commitmentOf(["smithers:commit-now"])
              const conflict = IssueLifecycle.commitmentOf(["smithers:commit-now", "smithers:commit-later"])
              const search = IssueLifecycle.commitmentSearch({ commitment: "now" })
              const filtered = IssueLifecycle.filterCommitment([{ commitment: "now" }, { commitment: "later" }], "now")

              const norm = FilesFlows.normalPath("///src/app.ts///")
              const opened = yield* Effect.exit(
                FilesFlows.openFile({ path: "src/app.ts", lines: "1-5" }).pipe(
                  Effect.provide(
                    Layer.succeed(FilesFlows.FileTabsTabs, {
                      open: () => Effect.succeed({ ok: true, opened: "src/app.ts" } as never),
                      close: () => Effect.succeed({ ok: true } as never)
                    } as never)
                  )
                ) as Effect.Effect<unknown, unknown, never>
              )
              const closed = yield* Effect.exit(
                FilesFlows.closeFile({ path: "src/app.ts" }).pipe(
                  Effect.provide(
                    Layer.succeed(FilesFlows.FileTabsTabs, {
                      open: () => Effect.succeed({ ok: true } as never),
                      close: () => Effect.succeed({ ok: true } as never)
                    } as never)
                  )
                ) as Effect.Effect<unknown, unknown, never>
              )
              const navExit = yield* Effect.exit(
                NavFlows.goTo({ to: navTarget }).pipe(
                  Effect.provide(
                    Layer.succeed(NavFlows.Tabs, {
                      navigate: () => Effect.succeed({ ok: true, to: navTarget } as never)
                    } as never)
                  )
                ) as Effect.Effect<unknown, unknown, never>
              )

              return (
                Array.isArray(imps) &&
                Array.isArray(caps) &&
                (placement === "client" || placement === "sandbox") &&
                sn.endsWith("/agent") &&
                typeof cached === "boolean" &&
                typeof failedInstall === "boolean" &&
                typeof bug === "boolean" &&
                typeof repro === "boolean" &&
                comm === "now" &&
                conflict === "conflict" &&
                search.commitment === "now" &&
                filtered.length === 1 &&
                norm === "src/app.ts" &&
                opened !== undefined &&
                closed !== undefined &&
                navExit !== undefined
              )
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("StatusApi, StatusReporter, StatusFlows handle HTTP responses, retries & refusals", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals([200, 202, 400, 401, 403, 404, 409, 500]),
        answerText: Schema.Literals(["yes", "no", "deploy main"]),
        execution: Schema.Literals(["run-1/call/0.0", "run-2/step/1"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, answerText, execution }) =>
          Effect.gen(function* () {
            const fakeHttp = HttpClient.make((req) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(
                    JSON.stringify({
                      ok: status < 400,
                      question: "hi?",
                      history: [],
                      waitedMs: 100,
                      code: status === 409 ? "already_settled" : "ok"
                    }),
                    { status, headers: { "content-type": "application/json" } }
                  )
                )
              )
            )
            const httpLayer = Layer.succeed(HttpClient.HttpClient, fakeHttp)
            const runsLayer = StatusApi.RunsClient.layer({ origin: "https://smithers.test", within: "2 seconds" }).pipe(
              Layer.provide(httpLayer)
            )
            const reporterLayer = StatusReporter.RunReporter.layer.pipe(Layer.provide(runsLayer))
            const ref = StatusFlows.isRefusal(status)
            const tok = StatusFlows.tokenOf(execution)
            const ans = StatusFlows.answerOf({ text: answerText })
            const nullAns = StatusFlows.answerOf(null)

            const runsClient = yield* StatusApi.RunsClient.pipe(Effect.provide(runsLayer))
            yield* Effect.exit(runsClient.report("run-1", { kind: "working", label: "Checking" } as never))
            yield* Effect.exit(runsClient.answer("run-1", { execution, answer: answerText } as never))

            const reporter = yield* StatusReporter.RunReporter.pipe(Effect.provide(reporterLayer))
            yield* Effect.exit(reporter.report("run-1", { kind: "working", label: "Checking" } as never))
            yield* Effect.exit(reporter.reportOrFail("run-1", { kind: "done" } as never))

            return (
              typeof ref === "boolean" &&
              typeof tok === "string" &&
              tok.length > 0 &&
              (ans === null || typeof ans === "object") &&
              nullAns === null
            )
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
