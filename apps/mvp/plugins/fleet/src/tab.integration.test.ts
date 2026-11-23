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
    // The shipped manifest's two component renders must resolve through the public lazy loader, and keep the
    // same promise so React's `use` can settle when a repository opens its Fleet tab.
    const components = ui.actions.components("fleet")
    expect(ui.actions.components("fleet")).toBe(components)
    const loaded = await components
    expect(loaded.Fleet).toEqual(expect.any(Function))
    expect(loaded.RepoTab).toEqual(expect.any(Function))
    expect(loaded.GlobalFleet).toEqual(expect.any(Function))
    expect(loaded.NavButton).toEqual(expect.any(Function))
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

test("global fleet shapes sync host_nodes, observed_sessions, and provider_accounts live through ElectricSQL for deployment admin", async ({ signal }) => {
  const app = openTestApp(
    { answers: false },
    { actor: { subject: { kind: "person", id: "p-will" }, role: "admin", login: "roninjin10" } },
  )
  try {
    const api = await app.runPromise(Effect.service(TestChatApi))
    const query = <A>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, body)))
    await query((sql) =>
      Effect.all([
        sql`INSERT INTO host_nodes (node_id, name, kind, labels, online, cpu_cores, mem_used_gb, mem_total_gb, disk_free_gb, disk_total_gb, active_sessions, runner_capacity, version)
          VALUES (${"mac-mini-live"}, ${"Mac mini"}, ${"mac-mini"}, ${["mac-mini", "darwin"]}, true, 12, 18.5, 64, 420.5, 1000, 1, 4, ${"1.0.0"})`,
        sql`INSERT INTO observed_sessions (session_key, node_id, managed, harness, model, account_label, repo, lane, title, status, pid, cpu_seconds, tokens_used)
          VALUES (${"mac-mini-live:claude:s1"}, ${"mac-mini-live"}, false, ${"claude"}, ${"claude-opus-4-7"}, ${"claude-1"}, ${"smithers"}, ${"feat/fleet"}, ${"Verify ElectricSQL sync"}, ${"working"}, 1234, 12.5, 4200)`,
        sql`INSERT INTO provider_accounts (account_key, provider, label, plan, status, five_hour_pct, weekly_pct, grants_json, active_sessions, pools, source_node)
          VALUES (${"claude:claude-1"}, ${"claude"}, ${"claude-1"}, ${"max"}, ${"ready"}, 12.5, 34, ${JSON.stringify({ tier: "max" })}::jsonb, 1, ${["max"]}, ${"mac-mini-live"})`,
      ], { discard: true })
    )
    const ui = await app.runPromise(Effect.service(PluginsUi))
    expect(ui.actions.viewAt("fleet", "")?.id).toBe("fleet/global")
    const tab = await ui.actions.tab("fleet") as FleetTab
    const nodes = tab.queries.globalNodes()
    const sessions = tab.queries.globalSessions()
    const accounts = tab.queries.globalAccounts()
    await Promise.all([
      changed(nodes, (v) => v._tag === "Ready" && v.rows.some((r) => r.nodeId === "mac-mini-live"), signal),
      changed(sessions, (v) => v._tag === "Ready" && v.rows.some((r) => r.sessionKey === "mac-mini-live:claude:s1"), signal),
      changed(accounts, (v) => v._tag === "Ready" && v.rows.some((r) => r.accountKey === "claude:claude-1"), signal),
    ])
    const nodesState = nodes.current()
    const nodeRow = nodesState._tag === "Ready" ? nodesState.rows.find((r) => r.nodeId === "mac-mini-live") : undefined
    expect(nodeRow).toMatchObject({
      nodeId: "mac-mini-live",
      name: "Mac mini",
      kind: "mac-mini",
      labels: ["mac-mini", "darwin"],
      cpuCores: 12,
      memUsedGb: 18.5,
      activeSessions: 1,
    })
    const sessionsState = sessions.current()
    const sessionRow = sessionsState._tag === "Ready"
      ? sessionsState.rows.find((r) => r.sessionKey === "mac-mini-live:claude:s1")
      : undefined
    expect(sessionRow).toMatchObject({
      sessionKey: "mac-mini-live:claude:s1",
      nodeId: "mac-mini-live",
      harness: "claude",
      accountLabel: "claude-1",
      tokensUsed: 4200,
    })
    const accountsState = accounts.current()
    const accountRow = accountsState._tag === "Ready"
      ? accountsState.rows.find((r) => r.accountKey === "claude:claude-1")
      : undefined
    expect(accountRow).toMatchObject({
      accountKey: "claude:claude-1",
      provider: "claude",
      fiveHourPct: 12.5,
      weeklyPct: 34,
      pools: ["max"],
      sourceNode: "mac-mini-live",
    })
  } finally { await app.dispose() }
})
