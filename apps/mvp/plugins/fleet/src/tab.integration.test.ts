// The shipped fleet tab loaded by the public plugin host, reading live rows over the real API and Electric.
import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { AuthStore, SESSION } from "../../../src/features/auth/store.vibe"
import { FleetStore } from "../../../src/features/fleet/store.vibe"
import { PluginsUi } from "../../../src/plugins/ui.vibe"
import { member, openFaultyApp, openTestApp, TestChatApi } from "../../../src/test/chatApi"
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

/** A deployment that names its one admin, signed in in person: no login is an admin unless the deployment says so. */
const admin = {
  deploymentAdmins: "fleet-admin",
  actor: { subject: { kind: "person", id: "p-fleet-admin" }, role: "admin", login: "fleet-admin" },
} as const

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
    admin,
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
          VALUES (${"claude:claude-1"}, ${"claude"}, ${"claude-1"}, ${"max"}, ${"ready"}, 12.5, 34, ${JSON.stringify({ tier: "max", leak: { token: "sentinel-legacy-grant" } })}::jsonb, 1, ${["max"]}, ${"mac-mini-live"})`,
        // A session that ended, with a transcript: the shape leaves it on the server.
        sql`INSERT INTO observed_sessions (session_key, node_id, managed, harness, title, status, ended_at, transcript_json)
          VALUES (${"mac-mini-live:claude:ended"}, ${"mac-mini-live"}, false, ${"claude"}, ${"Finished yesterday"}, ${"ended"}, now(),
            ${JSON.stringify([{ ts: null, role: "assistant", label: null, text: "sentinel-ended-transcript" }])}::jsonb)`,
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
    // R2-Astra-D4-004: Electric is never asked for `grants_json`, so a legacy row's disallowed fields stay on the server.
    expect(accountRow).not.toHaveProperty("grantsJson")
    expect(accountRow).not.toHaveProperty("grants_json")
    expect(JSON.stringify(accountsState)).not.toContain("sentinel")
    // R2-Astra-D4-015: the snapshot that delivered the live session did not carry the ended one.
    expect(sessionsState._tag === "Ready" ? sessionsState.rows.map((r) => r.sessionKey) : []).toEqual(["mac-mini-live:claude:s1"])
    expect(JSON.stringify(sessionsState)).not.toContain("sentinel")
  } finally { await app.dispose() }
})

// Astra-D4-003: a fleet shape's 401 stopped its requests and asked for a session check, and the tab went on showing
// the last admin-only snapshot for as long as that check took. Here nothing answers the check at all.
test("a 401 hides the synced fleet at once, keeps it hidden for another person, and only a fresh answer shows it again", async ({ signal }) => {
  const app = openFaultyApp({ answers: false, sessionLifecycle: false }, undefined, admin)
  try {
    const api = await app.runPromise(Effect.service(TestChatApi))
    const query = <A>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, body)))
    await query((sql) => sql`INSERT INTO host_nodes (node_id, name, kind, labels, online, active_sessions, runner_capacity)
      VALUES ('host-1', 'Host one', 'bare-metal', ${["bare-metal"]}, true, 0, 1)`)
    const ui = await app.runPromise(Effect.service(PluginsUi))
    const store = await app.runPromise(Effect.service(FleetStore))
    const auth = await app.runPromise(Effect.service(AuthStore))
    const switches = await app.runPromise(Effect.service(ShapeSource.Faults))
    await app.runPromise(auth.session.update(SESSION, (row) => { row.status = "signed_in"; row.login = "fleet-admin"; row.role = "admin" }))
    const tab = await ui.actions.tab("fleet") as FleetTab
    const nodes = tab.queries.globalNodes()
    await changed(nodes, (value) => value._tag === "Ready" && value.rows.some((row) => row.nodeId === "host-1"), signal)
    const cached = await app.runPromise(store.globalNodes)

    // Every request from here is answered 401; the change makes the waiting long poll return and the next one ask.
    await app.runPromise(switches.refuse(401))
    await query((sql) => sql`UPDATE host_nodes SET name = 'Host one renamed' WHERE node_id = 'host-1'`)
    await changed(nodes, (value) => value._tag === "Refused", signal)
    expect(nodes.current()).toEqual({ _tag: "Refused", reason: "unavailable" })
    expect(store.global.visible("nodes")).toBe(false)
    // The gate hides them, not an eviction: the rows are still in memory, and no session check has answered.
    expect(await app.runPromise(cached.toArray)).toHaveLength(1)
    expect(Option.getOrThrow(await app.runPromise(auth.session.get(SESSION))).status).toBe("signed_in")

    // Another person signs in on this tab while requests are still refused: the last person's rows go.
    await app.runPromise(auth.session.update(SESSION, (row) => { row.login = "someone-else"; row.role = "member" }))
    await expect.poll(async () => (await app.runPromise(cached.toArray)).length, { timeout: 20_000 }).toBe(0)
    expect(nodes.current()).toEqual({ _tag: "Refused", reason: "unavailable" })

    // The admin again, confirmed by the server, and the source answers: the rows come back from a fresh sync.
    await app.runPromise(auth.session.update(SESSION, (row) => { row.login = "fleet-admin"; row.role = "admin" }))
    await app.runPromise(switches.heal)
    await app.runPromise(auth.sessionConfirmed)
    await changed(nodes, (value) => value._tag === "Ready" && value.rows.some((row) => row.name === "Host one renamed"), signal)
    expect(store.global.visible("nodes")).toBe(true)
    await app.runPromise(auth.session.update(SESSION, (row) => { row.unverifiable = true }))
    expect(store.global.visible("nodes")).toBe(false)
    await app.runPromise(auth.session.update(SESSION, (row) => { delete row.unverifiable; row.status = "signed_out" }))
    await expect.poll(() => store.global.visible("nodes")).toBe(false)
    await expect.poll(async () => (await app.runPromise(cached.toArray)).length, { timeout: 20_000 }).toBe(0)
  } finally { await app.dispose() }
}, 90_000)

// Astra-D4-031: before its first snapshot the hosts query answered no rows, which the view counted as "hosts 0/0" and
// drew as "No hosts connected". Held, refused and delivered-empty are three different answers.
test("a fleet whose first sync is held is loading, a refused one is unavailable, and only a delivered one is empty", async ({ signal }) => {
  const app = openFaultyApp({ answers: false, sessionLifecycle: false }, (switches) => switches.stall("all"), admin)
  try {
    const ui = await app.runPromise(Effect.service(PluginsUi))
    const store = await app.runPromise(Effect.service(FleetStore))
    const switches = await app.runPromise(Effect.service(ShapeSource.Faults))
    const tab = await ui.actions.tab("fleet") as FleetTab
    const nodes = tab.queries.globalNodes()
    const asked = async () => (await app.runPromise(switches.sent)).some((url) => url.pathname.endsWith("/fleet/nodes"))
    await expect.poll(asked, { timeout: 20_000 }).toBe(true)
    expect(nodes.current()).toEqual({ _tag: "Loading" })
    expect(store.global.availability("nodes")).toBe("loading")
    // The held answers go through, and every request after them is refused.
    await app.runPromise(Effect.andThen(switches.heal, switches.refuse(403)))
    await changed(nodes, (value) => value._tag === "Refused", signal)
    expect(store.global.availability("nodes")).toBe("unavailable")
    // Sessions were never refused here: their own first snapshot arrives, and holds nothing.
    await app.runPromise(switches.heal)
    const sessions = tab.queries.globalSessions()
    await changed(sessions, (value) => value._tag === "Ready", signal)
    expect(sessions.current()).toEqual({ _tag: "Ready", rows: [] })
    expect(store.global.availability("sessions")).toBe("ready")
    expect(nodes.current()).toEqual({ _tag: "Refused", reason: "unavailable" })
  } finally { await app.dispose() }
}, 90_000)
