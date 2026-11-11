// An agent's question to one person, on that person's device (decision 0031 §6,
// docs/features/agent-status.md#addressed-waits). The agent asks through the real asks route with a real machine token;
// `queue/ask` parks on its execution's Durable Object handlers (worker/test/executions.ts); the question reaches the
// person's Node device (src/test/chatApi.ts) through Electric, into `core/waits`, the title and the queue; the host's
// strip answers it with `run/answer`; the parked run takes the answer and settles; the agent reads `answered`; and the
// question leaves the queue. ChatApi's real handler over the compose Postgres and Electric; nothing is scripted.
import { digestSync } from "@smthrs/crypto"
import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { QueueTab } from "../../../plugins/queue/src/tab"
import { askExecutionId } from "../../../worker/flows/Ask.ts"
import { dispatches } from "../../flows/dispatch"
import { presses, viewById } from "../../plugins/plugins"
import { PluginsUi } from "../../plugins/ui"
import { CHATAPI_ORIGIN, nodeDevice, openTab, openTestApp, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { plain } from "../../test/deviceFixture"
import { CoeditStore } from "../coedit/store"
import { AuthStore } from "../auth/store"
import { StatusStore } from "./store"

const ENGINE_WITHIN = 90_000
const VIEW = "queue/queue"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 60_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

/** The person the agent asks: a Maintainer of the test repository, with a login the asks route finds them by. */
const maya = { subject: { kind: "person" as const, id: crypto.randomUUID() }, role: "maintainer" as const, login: "maya-asked" }

describe("an agent's question to the person", { timeout: ENGINE_WITHIN }, () => {
  test("reaches their queue and title; the strip's answer resumes the run, the agent reads it, and the queue empties", async () => {
    const app = openTestApp({ answers: false }, { actor: maya })
    runtimes.push(app)
    const api = await app.runPromise(Effect.service(TestChatApi))
    const titles: Array<string> = []
    const tab = openTab(api, {
      host: nodeDevice({ agent: api, title: { read: () => "Smithers", write: (title) => void titles.push(title) } }),
    })
    runtimes.push(tab)
    const store = await tab.runPromise(Effect.service(StatusStore))
    const plugins = await tab.runPromise(Effect.service(PluginsUi))
    const coedit = await tab.runPromise(Effect.service(CoeditStore))
    store.waits.tanstack.startSyncImmediate()
    store.shownRuns.tanstack.startSyncImmediate()
    plugins.queries.views.startSyncImmediate()
    const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) => tab.runSync(Metric.value(metric)).count

    // The agent's machine token, holding `ask/create` on the test repository.
    const token = `smm_${crypto.randomUUID()}`
    const repoId = `github/${TEST_REPOSITORY}`
    await Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at)
      VALUES (${digestSync(token)}, ${repoId}, 'builder', 'lane-1', ARRAY['ask/create']::text[], 'test', now() + interval '1 day')`)))
    const asks = `${CHATAPI_ORIGIN}/api/repos/${TEST_REPOSITORY}/asks`
    const bearer = { authorization: `Bearer ${token}` }
    const id = `ask-${crypto.randomUUID().slice(0, 8)}`
    const asked = await api.fetch(asks, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ id, to: maya.login, prompt: "Merge the docs preview?", options: ["yes", "not yet"] }),
    })
    expect(asked.status).toBe(202)
    const { runId } = (await asked.json()) as { readonly runId: string }
    const executionId = askExecutionId(TEST_REPOSITORY, id)
    expect((await Effect.runPromise(api.asks.alarm(executionId)))._tag).toBe("Parked")

    // On the person's device: in `core/waits`, with its repository, and counted in the title. It is no run a page lists,
    // and it opens no answer box of its own (the coedit room is a launcher's).
    await until(() =>
      expect(store.waits.tanstack.toArray.map(plain)).toEqual([{
        runId,
        version: 1,
        execution: executionId,
        kind: "question",
        prompt: "Merge the docs preview?",
        options: ["yes", "not yet"],
        question: true,
        approval: false,
        createdAt: expect.any(String),
        repoId,
      }])
    )
    await until(() => expect(titles.at(-1)).toBe("(1) Smithers"))
    expect(store.shownRuns.tanstack.toArray).toEqual([])
    expect(coedit.texts.tanstack.toArray.filter((text) => text.kind === "answer")).toEqual([])

    // A reached server cannot verify this session: hide cached repository content without deleting the durable ask.
    const auth = await tab.runPromise(Effect.service(AuthStore))
    await tab.runPromise(auth.session.update("session", (draft) => {
      draft.status = "unreachable"
      draft.unverifiable = true
    }))
    expect(store.waits.tanstack.toArray).toEqual([])
    expect(store.runs.tanstack.toArray.some((run) => run.id === runId)).toBe(true)
    await until(() => expect(titles.at(-1)).toBe("Smithers"))
    await tab.runPromise(auth.session.update("session", (draft) => {
      draft.status = "signed_in"
      draft.unverifiable = false
    }))
    await until(() => expect(store.waits.tanstack.toArray.map((wait) => wait.runId)).toEqual([runId]))

    // The queue shows it, with its repository; the strip draws its options and answers with the first.
    const queue = (await plugins.actions.tab("queue")) as QueueTab
    await until(() =>
      expect(queue.queries.current.current()).toMatchObject({ index: 0, total: 1, repository: TEST_REPOSITORY, item: { runId } })
    )
    await until(() => expect(plugins.queries.views.toArray.find((row) => row.id === VIEW)).toMatchObject({ item: runId }))
    const strip = plugins.actions.strip(viewById(plugins.contributions, VIEW)!, queue.queries.current.current().item as never)
    expect(strip.buttons.map((button) => [button.label, button.key])).toEqual([["yes", "1"], ["not yet", "2"], ["Reply", "⌘↵"]])
    plugins.actions.press(VIEW, strip.buttons[0]!)

    // `run/answer` recorded it; no engine on this device holds the run, so delivering found nothing, and the press is
    // done, never Not sent. The sync follower's `run/deliver` finds nothing either.
    const done = Metric.withAttributes(presses, { plugin: "queue", event: "option", door: "button", outcome: "done" })
    await until(() => expect(count(done)).toBe(1))
    expect(plugins.queries.views.toArray.find((row) => row.id === VIEW)).toMatchObject({ sending: false, failed: false })
    expect(count(Metric.withAttributes(dispatches, { flow: "run/answer", door: "button", outcome: "done" }))).toBe(1)
    await until(() => expect(store.runs.tanstack.toArray.find((run) => run.id === runId)?.answer).toEqual({ value: "yes" }))
    await until(() => expect(store.waits.tanstack.toArray).toEqual([]))
    await until(() =>
      expect(count(Metric.withAttributes(dispatches, { flow: "run/deliver", door: "sync", outcome: "done" }))).toBe(1)
    )

    // The parked run took the answer: its object's next alarm settles it, and the agent reads it.
    expect((await Effect.runPromise(api.asks.alarm(executionId)))._tag).toBe("Settled")
    await until(() => expect(store.runs.tanstack.toArray.find((run) => run.id === runId)?.status).toBe("done"))
    const read = await api.fetch(`${asks}/${id}`, { headers: bearer })
    expect(await read.json()).toEqual({ status: "answered", answer: "yes", answeredAt: expect.any(String) })
    await until(() => expect(queue.queries.current.current()).toEqual({ item: undefined, index: 0, total: 0 }))
    await until(() => expect(titles.at(-1)).toBe("Smithers"))
  })
})
