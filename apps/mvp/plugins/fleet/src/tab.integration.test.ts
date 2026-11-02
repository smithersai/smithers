// The shipped fleet tab loaded by the public plugin host, reading live rows over the real API and Electric.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { PluginsUi } from "../../../src/plugins/ui"
import { member, openTestApp, TestChatApi } from "../../../src/test/chatApi"
import type { FleetTab, Watched } from "./tab"

const changed = <A>(live: Watched<A>, ready: (value: A) => boolean, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  let stop = () => {}
  const done = () => { stop(); signal.removeEventListener("abort", aborted) }
  const aborted = () => { done(); reject(signal.reason) }
  const check = () => { if (ready(live.current())) { done(); resolve() } }
  stop = live.subscribe(check)
  signal.addEventListener("abort", aborted, { once: true })
  check()
})

test("the shipped plugin subscribes to run and machine changes, and unsubscribe stops notifications", async ({ signal }) => {
  const app = openTestApp({ answers: false }, { actor: { ...member, role: "maintainer" } })
  try {
    const api = await app.runPromise(Effect.service(TestChatApi))
    const query = <A>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) => Effect.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, body)))
    await query((sql) => sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at)
      VALUES ('live', 'github/octo/hello', 'coder', 1, now())`)
    const ui = await app.runPromise(Effect.service(PluginsUi))
    const tab = await ui.actions.tab("fleet") as FleetTab
    const repo = { owner: "octo", name: "hello" }
    const runs = tab.queries.runs(repo)
    const machines = tab.queries.machines(repo)
    const notifications: Array<string> = []
    const stop = runs.subscribe(() => notifications.push(runs.current()._tag))
    const stopped: Array<string> = []
    const stopMachine = machines.subscribe(() => stopped.push(machines.current()._tag))
    await Promise.all([
      changed(runs, (value) => value._tag === "Ready" && value.rows[0]?.key === "live", signal),
      changed(machines, (value) => value._tag === "Ready", signal),
    ])
    expect(runs.current()).toMatchObject({ _tag: "Ready", rows: [{ key: "live", state: "queued" }] })
    expect(machines.current()).toEqual({ _tag: "Ready", rows: [] })
    expect(tab.queries.runs({ owner: "Octo", name: "Hello" })).toBe(runs)
    expect(notifications).toContain("Ready")
    expect(stopped).toContain("Ready")
    stop(); stopMachine()
    const count = notifications.length
    await query((sql) => sql`UPDATE agent_runs SET state = 'done' WHERE key = 'live'`)
    await changed(runs, (value) => value._tag === "Ready" && value.rows[0]?.state === "done", signal)
    expect(runs.current()).toMatchObject({ _tag: "Ready", rows: [{ key: "live", state: "done" }] })
    expect(notifications).toHaveLength(count)
  } finally { await app.dispose() }
})
