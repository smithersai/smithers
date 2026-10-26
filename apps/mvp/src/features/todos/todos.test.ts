import { RepoStore } from "../repo/store"
import { RepoClient } from "../repo/api"
import { role as readRepositoryRole } from "../repo/actions"
// TODOs on the tab (decision 0016 slice 1, Track A; docs/features/todos.md), driven as React drives them: the TODOs
// layer's plain actions, its live queries and the view's pure functions, with no React. Each device runs the browser's
// own layer (`appLayer`) on a Node device whose engine leads (src/test/chatApi.ts), against ChatApi's real stack routes
// (worker/stack/Api.ts) and its one writer over the compose Postgres and Electric. Only the model is scripted. Unhappy
// paths give the tab a faulty `StackClient`, the real one behind switches (test.faults-by-injection).
import { Collection, Persistence, Outbox } from "@smthrs/effect-tanstack-db"
import { Context, Deferred, Exit, Effect, Layer, Logger, type ManagedRuntime, Metric, Option } from "effect"
import { ShapeSource } from "@smthrs/effect-electric"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import {
  CHATAPI_ORIGIN,
  failingWorker,
  nodeDevice,
  openTab,
  openTestApp,
  type TabOptions,
  TEST_REPOSITORY,
  TestChatApi,
} from "../../test/chatApi"
import { AuthStore } from "../auth/store"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { repoId } from "../repo/contract"
import { ChangeNotTaken, StackClient } from "./api"
import { stackPath } from "./contract"
import { FlowDispatch } from "../../flows/dispatch"
import { TodoStatusUnavailable, TodoStepRefused } from "./flows"
import { pendingActions, sends } from "./metrics"
import type { Draft, Requested, Sending, Todo, TodoRequest } from "./schema"
import { IssuesStore } from "../issues/store"
import { TodosStore } from "./store"
import { issuesSynced } from "./tab"
import { Todos } from "./todos"
import { accessFor, draftsOfAnswer, draftsOfRepo, notSentRows, stackRows, todoCardOf, todosByIssue } from "./view"
import { keep } from "./writes"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
}, 120_000)

/**
 * How long a flow may take on the device's engine, its first start included, on a loaded machine: a fresh engine's
 * first run took 20 s on 2026-10-20 with ten agents' suites running beside it.
 */
const until = (assertion: () => void | Promise<void>, timeout = 90_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: flows on a fresh device's engine, each with its first start, on a loaded machine. */
const WITHIN = 240_000

const [OWNER, NAME] = TEST_REPOSITORY.split("/") as [string, string]
const REPO_ID = repoId(OWNER, NAME)

const maya: Actor = { subject: { kind: "person", id: "person-maya" }, role: "member", login: "maya" }
const gus: Actor = { subject: { kind: "person", id: "person-gus" }, role: "guest", login: "gus" }

/** A faulty `StackClient`: the real one, behind switches. */
const faultyClient = () => {
  const plan: Array<"network" | "drop" | number> = []
  const state = { down: false, sends: 0 }
  const layer = Layer.effect(
    StackClient,
    Effect.map(StackClient, (real) =>
      StackClient.of({
        change: (owner, name, change) =>
          Effect.suspend(() => {
            state.sends += 1
            if (state.down) return Effect.fail(new ChangeNotTaken({}))
            const next = plan.shift()
            if (next === undefined) return real.change(owner, name, change)
            // ChatApi took it, and its answer never arrived.
            if (next === "drop") return Effect.andThen(real.change(owner, name, change), Effect.fail(new ChangeNotTaken({})))
            return Effect.fail(next === "network" ? new ChangeNotTaken({}) : new ChangeNotTaken({ status: next }))
          }),
      })),
  ).pipe(Layer.provide(StackClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
  return { layer, state, next: (...faults: Array<"network" | "drop" | number>) => void plan.push(...faults) }
}

/** Hold a real outbound operation until its pending UI has been observed. */
const holdClient = (op: "commit" | "drop") => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const settled = Deferred.makeUnsafe<void>()
  const layer = Layer.effect(StackClient, Effect.map(StackClient, (real) => StackClient.of({
    change: (owner, name, change) => change.op !== op
      ? real.change(owner, name, change)
      : Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* real.change(owner, name, change).pipe(Effect.tap(() => Deferred.succeed(settled, undefined)))
      }),
  }))).pipe(Layer.provide(StackClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
  return { layer, entered, release, settled }
}

type App = ManagedRuntime.ManagedRuntime<RepoStore | RepoClient | Todos | TodosStore | ChatStore | Chat | Commands | AuthStore | FlowDispatch | IssuesStore, unknown>

/** A tab on `runtime`, with the TODOs layer's queries started as React starts them. */
const tabOf = async (runtime: App) => {
  await runtime.runPromise(readRepositoryRole(OWNER, NAME))
  const todos = await runtime.runPromise(Effect.service(Todos))
  const store = await runtime.runPromise(Effect.service(TodosStore))
  const { queries } = todos
  for (const query of [queries.view, queries.drafts, queries.sending, queries.requested, queries.access]) {
    query.startSyncImmediate()
  }
  const stack = () => {
    const opened = queries.stack(REPO_ID)
    opened.todos.startSyncImmediate()
    opened.requests.startSyncImmediate()
    return {
      todos: opened.todos.toArray as ReadonlyArray<Todo>,
      requests: opened.requests.toArray as ReadonlyArray<TodoRequest>,
    }
  }
  const sending = () => queries.sending.toArray as ReadonlyArray<Sending>
  const requested = () => queries.requested.toArray as ReadonlyArray<Requested>
  const drafts = () => queries.drafts.toArray as ReadonlyArray<Draft>
  const rows = () => stackRows(REPO_ID, stack().todos, sending(), requested())
  return {
    runtime,
    todos,
    actions: todos.actions,
    store,
    stack,
    drafts,
    /** The stack as the screen shows it. */
    rows,
    /** The TODO the route names, as the screen shows it. */
    card: () => todoCardOf(queries.view.toArray[0]?.number ?? null, rows(), stack().todos, stack().requests),
    notSent: () => notSentRows(REPO_ID, requested()),
    access: () => accessFor(REPO_ID, queries.access.toArray),
    view: () => queries.view.toArray[0],
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes))).count,
  }
}

type Tab = Awaited<ReturnType<typeof tabOf>>

/** The app on a fresh ChatApi as `actor` (Maya unless set), its device's engine leading. */
const open = async (options: TabOptions = {}, actor: Actor | null = maya) => {
  const runtime: ManagedRuntime.ManagedRuntime<
    RepoClient | RepoStore | Todos | TodosStore | ChatStore | Chat | Commands | AuthStore | FlowDispatch | IssuesStore | TestChatApi,
    unknown
  > = openTestApp(options, { actor })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  return { ...(await tabOf(runtime)), api }
}

/** Another device on the same ChatApi. */
const another = async (api: TestChatApi["Service"], options: TabOptions = {}) => {
  const runtime: App = openTab(api, options)
  runtimes.push(runtime)
  return tabOf(runtime)
}

/** Runs SQL on the ChatApi's own schema, as only a test does. */
const sql = <A extends object>(api: TestChatApi["Service"], statement: string) =>
  Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement))))

/** A new draft on `tab` with this title and prompt; answers its id. */
const drafted = (tab: Tab, title: string, prompt: string) => {
  const id = tab.actions.newDraft(OWNER, NAME)
  tab.actions.setTitle(id, title)
  tab.actions.setPrompt(id, prompt)
  return id
}

/** Commits a new draft on `tab` and waits until the stack numbered it on that device. */
const committed = async (tab: Tab, title: string, number: number) => {
  tab.actions.commit(drafted(tab, title, `${title}, please.`))
  await until(() => expect(tab.rows()).toContainEqual(expect.objectContaining({ number, title })))
}

describe("a shared TODO status read", () => {
  test("the registered durable flow reads missing and current TODOs from the server without changing them", async () => {
    const tab = await open()
    const flows = await tab.runtime.runPromise(Effect.service(FlowDispatch))
    const inspect = () => tab.runtime.runPromise(
      flows.dispatch("todo/inspect", { repo: TEST_REPOSITORY, number: 1 }, { door: "agent" }),
    )
    expect(await inspect()).toEqual({ _tag: "Done", value: { kind: "not_found", number: 1 } })
    await tab.actions.open(OWNER, NAME)
    tab.actions.commit(drafted(tab, "Private title", "Private prompt"))
    await until(() => expect(tab.rows()).toEqual([
      { id: expect.any(String), number: 1, title: "Private title", state: "queued" },
    ]))
    // The read uses the shared row, including changes this device has not yet synced.
    const runId = `todo:${crypto.randomUUID()}`
    await sql(tab.api, `UPDATE todos SET state = 'failed', failure = 'empty_change', run_id = '${runId}' WHERE number = 1`)
    expect(await inspect()).toEqual({
      _tag: "Done", value: {
        kind: "found", number: 1, state: "failed", step: null, attempt: 0, branch: null,
        prNumber: null, failure: "empty_change", note: null, runId, updatedAt: expect.any(String),
      },
    })
    expect(tab.api.spans.filter((span) => span.name === "stack.status").map((span) => span.attributes.get("outcome")))
      .toEqual(["todo_not_found", "found"])
    expect(await sql(tab.api, "SELECT count(*)::int AS n FROM stack_ops")).toEqual([{ n: 1 }])
  }, WITHIN)

  test("the registered flow preserves a real access refusal without reporting absence", async () => {
    const tab = await open({}, gus)
    const flows = await tab.runtime.runPromise(Effect.service(FlowDispatch))
    expect(await tab.runtime.runPromise(
      flows.dispatch("todo/inspect", { repo: TEST_REPOSITORY, number: 1 }, { door: "agent" }),
    )).toEqual({ _tag: "Failed", error: new TodoStatusUnavailable({ reason: "forbidden" }) })
    expect(tab.api.spans.filter((span) => span.name === "stack.status").map((span) => span.attributes.get("outcome")))
      .toEqual(["forbidden"])
    expect(await sql(tab.api, "SELECT count(*)::int AS n FROM stack_ops")).toEqual([{ n: 0 }])
  }, WITHIN)
})

describe("a commit", () => {
  test("shows T– Requested at once; the stack numbers it T1, Queued, on every device; its prompt syncs", async () => {
    const held = holdClient("commit")
    const tab = await open({ replace: held.layer })
    const other = await another(tab.api)
    try {
      await tab.actions.open(OWNER, NAME)
      await other.actions.open(OWNER, NAME)
      const draftId = drafted(tab, "  Retry webhook delivery  ", "Retry a failed delivery **three** times.")
      expect(draftsOfRepo(REPO_ID, tab.drafts())).toEqual([
        expect.objectContaining({ id: draftId, title: "  Retry webhook delivery  ", answerId: null }),
      ])
      // Another device has none of this device's drafts.
      expect(other.drafts()).toEqual([])

      expect(tab.actions.commit(draftId)).toBe(stackPath(OWNER, NAME))
      expect(tab.view()?.committing).toEqual([draftId])
      // A second press while the first is on its way runs nothing.
      expect(tab.actions.commit(draftId)).toBeUndefined()

      await Effect.runPromise(Deferred.await(held.entered))
      await until(() =>
        expect(tab.rows()).toEqual([
          { id: expect.any(String), number: null, title: "Retry webhook delivery", state: "queued", pending: "requested" },
        ])
      )
      // The step queued it: the draft goes and the card can press again.
      await until(() => expect(tab.drafts()).toEqual([]))
      await until(() => expect(tab.view()?.committing).toEqual([]))

      await Effect.runPromise(Deferred.succeed(held.release, undefined))
      await Effect.runPromise(Deferred.await(held.settled))
      for (const device of [tab, other]) {
        await until(() =>
          expect(device.rows()).toEqual([{ id: expect.any(String), number: 1, title: "Retry webhook delivery", state: "queued" }])
        )
      }
      // The follower dropped the requested change: the stack's row shows in its place.
      await until(() => expect(tab.store.requested.tanstack.size).toBe(0))
      expect(tab.count(sends, { op: "commit", outcome: "taken" })).toBe(1)
      expect(await sql(tab.api, `SELECT via, outcome FROM stack_ops`)).toEqual([{ via: "person", outcome: "committed" }])

      // The TODO at full size, on the device that didn't commit it.
      await other.actions.open(OWNER, NAME, 1)
      await until(() =>
        expect(other.card()).toEqual({
          id: expect.any(String),
          number: 1,
          title: "Retry webhook delivery",
          state: "queued",
          prompt: "Retry a failed delivery **three** times.",
          acceptance: [],
          createdLogin: expect.any(String),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          settledAt: null,
          branch: null,
          prNumber: null,
          issueNumber: null,
          runId: null,
          failure: null,
        })
      )
    } finally {
      await Effect.runPromise(Deferred.succeed(held.release, undefined))
    }
  }, WITHIN)

  test("a draft with a blank title or prompt, or one the device doesn't have, commits nothing", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    const id = tab.actions.newDraft(OWNER, NAME)
    expect(tab.actions.commit(id)).toBeUndefined()
    tab.actions.setTitle(id, "Title")
    expect(tab.actions.commit(id)).toBeUndefined()
    tab.actions.setPrompt(id, "   ")
    expect(tab.actions.commit(id)).toBeUndefined()
    expect(tab.actions.commit("no-such-draft")).toBeUndefined()
    // Text for a draft that went stays gone.
    tab.actions.setTitle("no-such-draft", "x")
    expect(tab.drafts()).toHaveLength(1)
    expect(tab.view()?.committing).toEqual([])
  }, WITHIN)

  test("Discard on a draft: it goes, counted", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    const id = drafted(tab, "Title", "Prompt")
    tab.actions.discardDraft(id)
    tab.actions.discardDraft(id)
    expect(tab.drafts()).toEqual([])
    expect(tab.count(pendingActions, { action: "discard_draft" })).toBe(1)
  }, WITHIN)

  test("offline, a commit waits in the outbox as T– Requested and is numbered once on reconnect", async () => {
    const client = faultyClient()
    client.state.down = true
    const tab = await open({ replace: client.layer })
    await tab.actions.open(OWNER, NAME)
    tab.actions.commit(drafted(tab, "Offline commit", "Made offline."))
    await until(() => expect(client.state.sends).toBeGreaterThan(0))
    expect(tab.rows()).toEqual([expect.objectContaining({ number: null, pending: "requested" })])

    client.state.down = false
    await tab.runtime.runPromise(Effect.flatMap(ChatStore, (chat) => chat.outbox.retryNow))
    await until(() => expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, title: "Offline commit" })]))
    expect(await sql(tab.api, `SELECT count(*)::int AS n FROM todos`)).toEqual([{ n: 1 }])
  }, WITHIN)

  test("an answer lost after ChatApi took it: the resend answers the same, and the stack keeps one TODO", async () => {
    const client = faultyClient()
    client.next("drop")
    const tab = await open({ replace: client.layer })
    await tab.actions.open(OWNER, NAME)
    tab.actions.commit(drafted(tab, "Once", "Only once."))
    await until(() => expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, title: "Once" })]))
    // The outbox sends it again after its backoff, and ChatApi answers what it answered.
    await until(() => expect(tab.count(sends, { op: "commit", outcome: "existing" })).toBe(1))
    expect(client.state.sends).toBe(2)
    expect(await sql(tab.api, `SELECT count(*)::int AS n FROM todos`)).toEqual([{ n: 1 }])
  }, WITHIN)
})

describe("a drop", () => {
  test("shows Requested on its TODO, then Dropped on every device, after the open ones", async () => {
    const tab = await open()
    const held = holdClient("drop")
    const other = await another(tab.api, { replace: held.layer })
    await tab.actions.open(OWNER, NAME)
    await other.actions.open(OWNER, NAME)
    await committed(tab, "First", 1)
    await committed(tab, "Second", 2)
    await until(() => expect(other.rows().map(({ number }) => number)).toEqual([1, 2]))

    try {
      other.actions.drop(OWNER, NAME, 1)
      await Effect.runPromise(Deferred.await(held.entered))
      await until(() =>
        expect(other.rows()[0]).toEqual(expect.objectContaining({ number: 1, state: "queued", pending: "requested" }))
      )
      await Effect.runPromise(Deferred.succeed(held.release, undefined))
      await Effect.runPromise(Deferred.await(held.settled))
      for (const device of [tab, other]) {
        await until(() =>
          expect(device.rows().map(({ number, state, pending }) => [number, state, pending])).toEqual([
            [2, "queued", undefined],
            [1, "dropped", undefined],
          ])
        )
      }
      await until(() => expect(other.store.requested.tanstack.size).toBe(0))
      expect(await sql(tab.api, `SELECT number, position FROM todos ORDER BY number`)).toEqual([
        { number: 1, position: null },
        { number: 2, position: 1 },
      ])
    } finally {
      await Effect.runPromise(Deferred.succeed(held.release, undefined))
    }
  }, WITHIN)

  test("a refused drop stays Not sent on its TODO, with Discard", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    await committed(tab, "Merged one", 1)
    await sql(tab.api, `UPDATE todos SET state = 'merged', position = NULL, settled_at = now() WHERE number = 1`)
    await until(() => expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, state: "merged" })]))

    tab.actions.drop(OWNER, NAME, 1)
    await until(() => expect(tab.notSent()).toEqual([{ id: expect.any(String), op: "drop", label: "Drop T1", reason: "Merged" }]))
    expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, state: "merged", pending: "not_sent" })])
    tab.actions.discard(tab.notSent()[0]!.id)
    expect(tab.notSent()).toEqual([])
    expect(tab.count(pendingActions, { action: "discard" })).toBe(1)
  }, WITHIN)
})

describe("refusals", () => {
  test("a full stack: the commit stays Not sent, Stack full; Edit brings its text back as a draft, Discard drops it", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    await committed(tab, "Fills it", 1)
    await sql(tab.api, `UPDATE stacks SET max_open = 1`)

    tab.actions.commit(drafted(tab, "One too many", "Over the limit."))
    await until(() =>
      expect(tab.notSent()).toEqual([{ id: expect.any(String), op: "commit", label: "One too many", reason: "Stack full" }])
    )
    expect(tab.rows()).toEqual([
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({ number: null, title: "One too many", pending: "not_sent" }),
    ])
    expect(tab.count(sends, { op: "commit", outcome: "refused" })).toBe(1)
    // The step queued it, so its draft went; the stack's refusal can arrive first.
    await until(() => expect(tab.view()?.committing).toEqual([]))
    expect(tab.drafts()).toEqual([])

    expect(tab.actions.edit(tab.notSent()[0]!.id)).toBe(stackPath(OWNER, NAME))
    expect(tab.notSent()).toEqual([])
    expect(tab.drafts()).toEqual([expect.objectContaining({ title: "One too many", prompt: "Over the limit." })])
    expect(tab.actions.edit("no-such-change")).toBeUndefined()
    expect(tab.count(pendingActions, { action: "edit" })).toBe(1)
  }, WITHIN)

  test("a Guest can't change a stack, or read one: Not found; signed out, sign in", async () => {
    const guest = await open({}, gus)
    await guest.actions.open(OWNER, NAME)
    await until(() => expect(guest.access()).toBe("forbidden"))
    guest.actions.commit(drafted(guest, "As a Guest", "Not allowed."))
    await until(() => expect(guest.notSent()).toEqual([expect.objectContaining({ reason: "Not allowed" })]))

    const visitor = await open({}, null)
    await visitor.actions.open(OWNER, NAME)
    await until(() => expect(visitor.access()).toBe("sign_in"))
  }, WITHIN)
})

describe("the agent", () => {
  test("drafts a TODO, privately, under its answer; only the person's device has it", async () => {
    const tab = await open()
    const other = await another(tab.api)
    const chat = await tab.runtime.runPromise(Effect.service(Chat))
    const asked = chat.actions.ask("Make a TODO to retry webhooks")
    if (!asked.asked) throw new Error("not asked")
    const first = await Effect.runPromise(tab.api.answerTo("Make a TODO to retry webhooks"))
    first.cell(
      `const drafted = await ctx.call("todo/draft", { repo: "${TEST_REPOSITORY}", ` +
        `prompt: "# Retry webhook delivery\\n\\nThree tries.", acceptance: ["three tries"] })\n` +
        `console.log(JSON.stringify(drafted))`,
    )
    await until(() =>
      expect(draftsOfAnswer(asked.answerId, tab.drafts())).toEqual([
        expect.objectContaining({
          id: expect.any(String),
          repo: TEST_REPOSITORY,
          repoId: REPO_ID,
          title: "Retry webhook delivery",
          prompt: "# Retry webhook delivery\n\nThree tries.",
          acceptance: ["three tries"],
          answerId: asked.answerId,
          createdAt: expect.any(Number),
        }),
      ])
    )
    ;(await Effect.runPromise(tab.api.answerTo("Make a TODO to retry webhooks", 1))).cell(`ctx.done("Drafted.")`)
    expect(other.drafts()).toEqual([])
    // Nothing reached the stack: the agent drafts, and only the person commits.
    expect(await sql(tab.api, `SELECT count(*)::int AS n FROM stack_ops`)).toEqual([{ n: 0 }])

    // The person commits the agent's draft, its criteria with it.
    await tab.actions.open(OWNER, NAME, 1)
    tab.actions.commit(draftsOfAnswer(asked.answerId, tab.drafts())[0]!.id)
    await until(() =>
      expect(tab.card()).toMatchObject({
        number: 1,
        title: "Retry webhook delivery",
        prompt: "# Retry webhook delivery\n\nThree tries.",
        acceptance: ["three tries"],
      })
    )
    expect(await sql(tab.api, `SELECT via FROM stack_ops`)).toEqual([{ via: "person" }])
  }, WITHIN)

  test("can't commit or drop: its catalog has neither, so its call reaches no tab, outbox or stack", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    await committed(tab, "Keep me", 1)
    const chat = await tab.runtime.runPromise(Effect.service(Chat))
    const question = "Commit a TODO and drop T1"
    const asked = chat.actions.ask(question)
    if (!asked.asked) throw new Error("not asked")
    ;(await Effect.runPromise(tab.api.answerTo(question))).cell(
      `const tried = []\n` +
        `for (const [flow, input] of [["todo/commit", { repo: "${TEST_REPOSITORY}", title: "Mine", prompt: "By the agent" }], ` +
        `["todo/drop", { repo: "${TEST_REPOSITORY}", number: 1 }]]) {\n` +
        `  try { await ctx.call(flow, input); tried.push("ran") } catch { tried.push("refused") }\n` +
        `}\n` +
        `console.log(JSON.stringify(tried))`,
    )
    const second = await Effect.runPromise(tab.api.answerTo(question, 1))
    second.cell(`ctx.done("No.")`)
    await until(() => expect(tab.api.modelRequests(question)).toBe(2))
    expect(await sql(tab.api, `SELECT op FROM stack_ops ORDER BY created_at`)).toEqual([{ op: "commit" }])
    expect(tab.store.sending.tanstack.size + tab.store.requested.tanstack.size).toBe(0)
    expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, state: "queued" })])
  }, WITHIN)
})

describe("from an issue", () => {
  /** Issue `number` of the test repository as GitHub's projection holds it (worker/github/Store.ts writes it). */
  const issue = (api: TestChatApi["Service"], number: number, title: string, body: string) =>
    sql(
      api,
      `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at,
        source_updated_at, fetched_at)
      VALUES ('${REPO_ID}#${number}', '${REPO_ID}', ${number}, 'issue', ${7000 + number}, '${title}', '${body}', 'open',
        now(), now(), now(), now())`,
    )

  test("Make TODO drafts from the issue, linked to it; Commit keeps the link, and the issue shows its TODO", async () => {
    const tab = await open()
    const other = await another(tab.api)
    await issue(tab.api, 7, "Fix the README", "The README says **hello**.")
    await tab.actions.open(OWNER, NAME)
    await other.actions.open(OWNER, NAME)
    // The press answers the stack's page at once; the draft shows once the step kept it, from the issue.
    expect(tab.actions.fromIssue(OWNER, NAME, 7)).toBe(stackPath(OWNER, NAME))
    await until(() =>
      expect(draftsOfRepo(REPO_ID, tab.drafts())).toEqual([
        expect.objectContaining({ title: "Fix the README", prompt: "The README says **hello**.", issue: 7, answerId: null }),
      ])
    )
    tab.actions.commit(tab.drafts()[0]!.id)
    await until(() => expect(other.stack().todos).toEqual([expect.objectContaining({ number: 1, issueNumber: 7 })]))
    expect(await sql(tab.api, `SELECT number, issue_number AS "issue" FROM todos`)).toEqual([{ number: 1, issue: 7 }])
    // On the other device, the issue lists its TODO.
    expect(todosByIssue(REPO_ID, other.stack().todos, OWNER, NAME).get(7)).toEqual({
      links: [{ label: "T1", href: `/${OWNER}/${NAME}/stack/1` }],
    })
    // Remote arrival can precede local cleanup; the next wait must observe a new draft.
    await until(() => expect(tab.drafts()).toEqual([]))
    // T1 still open, Make TODO makes a second TODO from the same issue: one issue, a stack of TODOs, newest first.
    tab.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(draftsOfRepo(REPO_ID, tab.drafts())).toEqual([expect.objectContaining({ issue: 7 })]))
    tab.actions.commit(tab.drafts()[0]!.id)
    await until(() =>
      expect([...other.stack().todos].sort((a, b) => a.number - b.number)).toEqual([
        expect.objectContaining({ number: 1, issueNumber: 7, state: "queued" }),
        expect.objectContaining({ number: 2, issueNumber: 7, state: "queued" }),
      ])
    )
    expect(todosByIssue(REPO_ID, other.stack().todos, OWNER, NAME).get(7)).toEqual({
      links: [{ label: "T2", href: `/${OWNER}/${NAME}/stack/2` }, { label: "T1", href: `/${OWNER}/${NAME}/stack/1` }],
    })
  }, WITHIN)

  test("a TODO from an issue that a full stack refuses keeps its link when Edit brings it back as a draft", async () => {
    const tab = await open()
    await issue(tab.api, 9, "Fix the footer", "The footer is wrong.")
    await tab.actions.open(OWNER, NAME)
    await committed(tab, "Fills it", 1)
    await sql(tab.api, `UPDATE stacks SET max_open = 1`)

    tab.actions.fromIssue(OWNER, NAME, 9)
    await until(() => expect(draftsOfRepo(REPO_ID, tab.drafts())).toEqual([expect.objectContaining({ issue: 9 })]))
    tab.actions.commit(tab.drafts()[0]!.id)
    await until(() => expect(tab.notSent()).toEqual([expect.objectContaining({ op: "commit", reason: "Stack full" })]))
    await until(() => expect(tab.view()?.committing).toEqual([]))

    tab.actions.edit(tab.notSent()[0]!.id)
    expect(tab.drafts()).toEqual([
      expect.objectContaining({ title: "Fix the footer", prompt: "The footer is wrong.", issue: 9 }),
    ])
  }, WITHIN)

  test("the agent makes one from an issue with its own title and prompt, under its answer; the issue stays linked", async () => {
    const tab = await open()
    await issue(tab.api, 8, "Webhooks fail", "They fail.")
    await tab.actions.open(OWNER, NAME)
    const chat = await tab.runtime.runPromise(Effect.service(Chat))
    const question = "Make a TODO from issue 8"
    const asked = chat.actions.ask(question)
    if (!asked.asked) throw new Error("not asked")
    ;(await Effect.runPromise(tab.api.answerTo(question))).cell(
      `console.log(JSON.stringify(await ctx.call("todo/issue", { repo: "${TEST_REPOSITORY}", issue: 8, ` +
        `prompt: "# Retry webhook delivery\\n\\nThree tries." })))`,
    )
    await until(() =>
      expect(draftsOfAnswer(asked.answerId, tab.drafts())).toEqual([
        expect.objectContaining({ title: "Retry webhook delivery", prompt: "# Retry webhook delivery\n\nThree tries.", issue: 8 }),
      ])
    )
    ;(await Effect.runPromise(tab.api.answerTo(question, 1))).cell(`ctx.done("Drafted.")`)
    expect(await sql(tab.api, `SELECT count(*)::int AS n FROM stack_ops`)).toEqual([{ n: 0 }])
  }, WITHIN)

  test("an issue the device doesn't have drafts nothing: todo/issue fails issue_not_found", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    const flows = await tab.runtime.runPromise(Effect.service(FlowDispatch))
    const dispatched = await tab.runtime.runPromise(
      flows.dispatch("todo/issue", { repo: TEST_REPOSITORY, issue: 99 }, { door: "button" }),
    )
    expect(dispatched).toEqual({ _tag: "Failed", error: new TodoStepRefused({ reason: "issue_not_found" }) })
    expect(tab.drafts()).toEqual([])
  }, WITHIN)

  // Electric waits out a stopped shape, so `preload` fails only when the collection itself fails; it is injected failing
  // here (test.faults-by-injection).
  test("issues whose first sync fails are logged as todos.issue.load, which issue_not_found would otherwise hide", async () => {
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    await Effect.runPromise(issuesSynced(Effect.fail(new Collection.LoadFailed({ cause: new Error("private") }))).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
    ))
    expect(logs).toEqual([expect.objectContaining({
      message: "todos.issue.load",
      level: "WARN",
      annotations: expect.objectContaining({ feature: "todos", outcome: "failed", errorCode: "LoadFailed" }),
    })])
    expect(JSON.stringify(logs)).not.toContain("private")
  })
})

describe("slash commands", () => {
  test("/todo.new owner/repo <prompt> drafts one; /todo.drop owner/repo <n> drops one", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    const commands = await tab.runtime.runPromise(Effect.service(Commands))
    const auth = await tab.runtime.runPromise(Effect.service(AuthStore))
    await until(() => expect(auth.session.tanstack.get("session")?.status).not.toBe("loading"))
    await tab.runtime.runPromise(
      auth.session.update("session", (row) => void Object.assign(row, { status: "signed_in", login: "maya", role: "member" })),
    )
    const send = (line: string) => {
      commands.actions.type(line)
      commands.actions.submit(line)
    }
    send(`/todo.new ${TEST_REPOSITORY} Add rate limit headers to every response`)
    await until(() =>
      expect(tab.drafts()).toEqual([
        expect.objectContaining({
          title: "Add rate limit headers to every response",
          prompt: "Add rate limit headers to every response",
          answerId: null,
        }),
      ])
    )
    tab.actions.commit(tab.drafts()[0]!.id)
    await until(() => expect(tab.rows()).toEqual([expect.objectContaining({ number: 1 })]))
    send(`/todo.drop ${TEST_REPOSITORY} 1`)
    await until(() => expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, state: "dropped" })]))
  }, WITHIN)

  test("/todo.issue owner/repo <n> drafts one from issue n, linked to it", async () => {
    const tab = await open()
    await tab.actions.open(OWNER, NAME)
    const commands = await tab.runtime.runPromise(Effect.service(Commands))
    const auth = await tab.runtime.runPromise(Effect.service(AuthStore))
    await until(() => expect(auth.session.tanstack.get("session")?.status).not.toBe("loading"))
    await tab.runtime.runPromise(
      auth.session.update("session", (row) => void Object.assign(row, { status: "signed_in", login: "maya", role: "member" })),
    )
    await sql(
      tab.api,
      `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at,
        source_updated_at, fetched_at)
      VALUES ('${REPO_ID}#5', '${REPO_ID}', 5, 'issue', 7005, 'Slow page', 'The home page is slow.', 'open', now(), now(),
        now(), now())`,
    )
    // This command drafts from the issue this device holds, not an SQL write still in Electric's WAL.
    const issues = await tab.runtime.runPromise(Effect.service(IssuesStore))
    await tab.runtime.runPromise(issues.activate)
    await tab.runtime.runPromise(issues.items.preload)
    await until(() => expect(issues.items.tanstack.get(`${REPO_ID}#5`)).toMatchObject({ number: 5, title: "Slow page" }))
    const line = `/todo.issue ${TEST_REPOSITORY} 5`
    commands.actions.type(line)
    commands.actions.submit(line)
    await until(() =>
      expect(tab.drafts()).toEqual([expect.objectContaining({ title: "Slow page", prompt: "The home page is slow.", issue: 5 })])
    )
  }, WITHIN)
})

describe("the device", () => {
  test("a stack opened twice at once opens once; a stack no route opened has no rows", async () => {
    const tab = await open({ answers: false })
    await Promise.all([tab.actions.open(OWNER, NAME), tab.actions.open(OWNER, NAME, 2)])
    expect(tab.store.opened(REPO_ID)).toBeDefined()
    expect(tab.view()).toMatchObject({ owner: OWNER, name: NAME, repoId: REPO_ID })
    const unopened = tab.todos.queries.stack("github/octo/never")
    unopened.todos.startSyncImmediate()
    expect(unopened.todos.toArray).toEqual([])
    expect(tab.store.opened("github/octo/never")).toBeUndefined()
  }, WITHIN)

  test("a link's warm opens the stack's sync without moving the page shown", async () => {
    const tab = await open({ answers: false })
    await tab.actions.warm(OWNER, NAME)
    expect(tab.store.opened(REPO_ID)).toBeDefined()
    expect(tab.view()).toMatchObject({ owner: "", repoId: "" })
  }, WITHIN)

  test("keeps a draft once and queues a change once; a draft it can't store isn't kept", async () => {
    const tab = await open({ answers: false })
    const draft: Draft = {
      id: "draft-1",
      repo: TEST_REPOSITORY,
      repoId: REPO_ID,
      title: "T",
      prompt: "P",
      acceptance: [],
      answerId: null,
      createdAt: 1,
    }
    expect(await tab.runtime.runPromise(tab.store.keepDraft(draft))).toEqual({ kept: true })
    expect(await tab.runtime.runPromise(tab.store.keepDraft(draft))).toEqual({ kept: true })
    expect(await tab.runtime.runPromise(tab.store.keepDraft({ ...draft, id: "draft-2", answerId: 7 } as never))).toEqual({
      kept: false,
    })
    expect(tab.drafts().map(({ id }) => id)).toEqual(["draft-1"])
    const op = { id: crypto.randomUUID(), repo: TEST_REPOSITORY, op: "drop" as const, title: "", prompt: "", acceptance: [], number: 9 }
    expect(await tab.runtime.runPromise(tab.store.queue(op))).toEqual({ kept: true })
    expect(await tab.runtime.runPromise(tab.store.queue(op))).toEqual({ kept: true })
    expect(tab.store.sending.tanstack.size + tab.store.requested.tanstack.size).toBe(1)
  }, WITHIN)

  test("a send replayed after a crash finds its change kept, and settles it again", async () => {
    const tab = await open({ answers: false })
    const row: Sending = {
      id: "op-1",
      repo: TEST_REPOSITORY,
      op: "commit",
      title: "T",
      prompt: "P",
      acceptance: [],
      number: 0,
      repoId: REPO_ID,
      queuedAt: 1,
      v: 2,
    }
    await tab.runtime.runPromise(keep(tab.store.requested, row, "requested", null, 4))
    await tab.runtime.runPromise(keep(tab.store.requested, row, "not_sent", "stack_full", null))
    expect(tab.store.requested.tanstack.get("op-1")).toMatchObject({ status: "not_sent", reason: "stack_full", taken: null })
  }, WITHIN)

  test("a send the route answers 503 is sent again, with its status", async () => {
    const client = faultyClient()
    client.next(503)
    const tab = await open({ replace: client.layer })
    await tab.actions.open(OWNER, NAME)
    tab.actions.commit(drafted(tab, "After a 503", "Sent twice."))
    await until(() => expect(tab.count(sends, { op: "commit", outcome: "retry" })).toBe(1))
    await tab.runtime.runPromise(Effect.flatMap(ChatStore, (chat) => chat.outbox.retryNow))
    await until(() => expect(tab.rows()).toEqual([expect.objectContaining({ number: 1, title: "After a 503" })]))
  }, WITHIN)

  // The step asks its tab again for 30 s (`ASK_RETRY`), then fails `not_kept`.
  test("an outbox that can't store the change: the flow fails, nothing is queued, and the draft stays", async () => {
    const opened = await open({ answers: false })
    const device = nodeDevice({ agent: opened.api })
    const real = device.outbox.storage
    const storage: Outbox.Options<never>["storage"] = {
      get: (key) => real.get(key),
      keys: () => real.keys(),
      delete: (key) => real.delete(key),
      clear: () => real.clear(),
      set: () => Promise.reject(new Error("quota")),
    }
    const tab = await another(opened.api, { host: { ...device, outbox: { ...device.outbox, storage } } })
    await tab.actions.open(OWNER, NAME)
    const id = drafted(tab, "Not stored", "Never queued.")
    tab.actions.commit(id)
    await until(() => expect(tab.view()?.committing).toEqual([]), 150_000)
    expect(tab.drafts().map((draft) => draft.id)).toEqual([id])
    expect(tab.rows()).toEqual([])
  }, WITHIN)

  test("a tab with no engine: the commit never runs, and the draft stays", async () => {
    const opened = await open({ answers: false })
    const tab = await another(opened.api, { host: nodeDevice({ engineWorker: failingWorker }) })
    await tab.actions.open(OWNER, NAME)
    const id = drafted(tab, "No engine", "Never runs.")
    expect(tab.actions.commit(id)).toBe(stackPath(OWNER, NAME))
    await until(() => expect(tab.view()?.committing).toEqual([]))
    expect(Option.isSome(await tab.runtime.runPromise(tab.store.drafts.get(id)))).toBe(true)
  }, WITHIN)
})


describe("stack initialization regressions", () => {
  test.each([[401, "allowed"], [403, "allowed"]] as const)("a prompt shape refused %s cannot change session authority (%s)", async (status, expected) => {
    const runtime = openTestApp()
    runtimes.push(runtime)
    const api = await runtime.runPromise(Effect.service(TestChatApi))
    await runtime.runPromise(readRepositoryRole(OWNER, NAME))
    await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const built = yield* Layer.build(TodosStore.layer({ origin: api.origin }).pipe(
        Layer.provide(Layer.succeed(ShapeSource.ShapeSource, {
          request: (url, init) => url.includes("/api/shapes/todo-requests")
            ? Effect.succeed(new Response(null, { status }))
            : ShapeSource.fetchSource.request(url, init),
        })),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, api.fetch)),
      ))
      const store = Context.get(built, TodosStore)
      yield* store.stackOf(REPO_ID)
      yield* Effect.promise(() => until(async () => {
        const row = await runtime.runPromise(store.access.get(REPO_ID))
        expect(Option.isSome(row) && row.value.status).toBe(expected)
      }, 5000))
    })))
  }, WITHIN)

  test("a failed initialization can be opened again after persistence recovers", async () => {
    const runtime = openTestApp()
    runtimes.push(runtime)
    const api = await runtime.runPromise(Effect.service(TestChatApi))
    await runtime.runPromise(readRepositoryRole(OWNER, NAME))
    await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const real = yield* Persistence.Persistence
      let fail = false
      // A device whose persistence metadata becomes temporarily unreadable, then recovers.
      const faulty: Persistence.Service = {
        persistence: real.persistence,
        get registry() {
          if (fail) { fail = false; throw new Error("persistence metadata unavailable") }
          return real.registry
        },
      }
      const built = yield* Layer.build(TodosStore.layer({ origin: api.origin }).pipe(
        Layer.provide(Layer.succeed(Persistence.Persistence, faulty)),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, api.fetch)),
      ))
      const store = Context.get(built, TodosStore)
      fail = true
      expect(Exit.isFailure(yield* Effect.exit(store.stackOf(REPO_ID)))).toBe(true)
      expect(store.opened(REPO_ID)).toBeUndefined()
      const reopened = yield* Effect.exit(store.stackOf(REPO_ID))
      expect(Exit.isSuccess(reopened)).toBe(true)
      if (Exit.isSuccess(reopened)) {
        expect(store.opened(REPO_ID)).toBe(reopened.value)
        expect(yield* store.stackOf(REPO_ID)).toBe(reopened.value)
      }
    })))
  }, WITHIN)
})

test("Retry on a failed TODO sends the same identity through the public action and durable outbox", async () => {
  const tab = await open()
  await tab.actions.open(OWNER, NAME)
  await committed(tab, "Retry this", 1)
  await sql(tab.api, "UPDATE todos SET state = 'failed', failure = 'implement' WHERE number = 1")
  await until(() => expect(tab.stack().todos[0]?.state).toBe("failed"))
  tab.actions.retry(OWNER, NAME, 1)
  await until(() => expect(tab.count(sends, { op: "retry", outcome: "taken" })).toBe(1))
  await until(() => expect(tab.stack().todos[0]?.state).toBe("queued"))
  expect(tab.stack().todos[0]).toMatchObject({ number: 1, title: "Retry this" })
}, WITHIN)
