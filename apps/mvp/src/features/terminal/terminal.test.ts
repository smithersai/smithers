// The branch terminal in the browser (decision 0013 §3, docs/features/branch-workspace.md#the-terminal): the browser's own
// layer (`appLayer`) on a Node device whose engine leads, against ChatApi's real `POST /api/terminals` and terminals
// shape (worker/branch/Terminals.ts, src/test/chatApi.ts) over the compose Postgres and Electric. The remote
// `terminal/Open` doesn't run here: the test settles a terminal's row with SQL, as that flow does. The socket is
// `@smthrs/platform-browser`'s `TerminalSocket` over Node's own WebSocket, dialing a real WebSocket server on loopback
// at the app's origin that speaks `TerminalProtocol` from `@smthrs/sandbox`: binary frames are bytes, text frames are
// JSON control (`ready`, `ended`, `resize`), and its close codes say whether to come back (1000 ended, 1003
// unsupported, 1008 no access, 1011 failed). `terminal/open`'s client and step are also driven over an injected
// `fetch` for the answers a valid request never gets (test.faults-by-injection).
import { NodeWS } from "@effect/platform-node/NodeSocket"
import { Effect, Layer, Logger, Metric, Scheduler } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import * as Conversations from "../../../worker/branch/Conversations.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { type ChatApiOptions, failingWorker, member, nodeDevice, openTestApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { dispatches } from "../../flows/dispatch"
import { AuthStore, SESSION } from "../auth/store"
import { Branch } from "../branch/branch"
import { OpenRefused, TerminalClient } from "./api"
import { ADMIT_WAIT_SECONDS, DEFAULT_COLS, DEFAULT_ROWS, OPEN_DEADLINE_SECONDS, openExecutionId } from "./contract"
import { TerminalOpenRefused, TerminalOpenUnavailable } from "./flows"
import { bytes, ended, openMs, opens, reconnects } from "./metrics"
import { requestOpen } from "./steps"
import { show, socketUrl } from "./actions"
import { PANEL } from "./schema"
import { TerminalStore } from "./store"
import { Terminal } from "./terminal"
import { panelViewOf } from "./view"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: flows on a fresh device's engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

/** One socket the app attached: the path it dialed, every frame it sent, and the host's side of `TerminalProtocol`. */
interface Peer {
  readonly path: string
  /** Each frame from the app: bytes it typed as text, or its JSON control. */
  readonly frames: Array<{ readonly bytes: string } | { readonly control: unknown }>
  /** The code the connection closed with, once it has. */
  readonly closed: Promise<number>
  readonly ready: (access: "write" | "read") => void
  readonly output: (text: string) => void
  readonly ended: (reason: "closed" | "slept" | "lost" | "revoked") => void
  readonly close: (code: number) => void
}

/**
 * A terminal host on loopback, as a branch's machine answers the page's socket: every socket the app attaches arrives
 * on `peers`. `origin` is the app's origin the test opens the app on, so the app dials it at `/api/terminals/<id>`.
 */
const terminalHost = async () => {
  const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const peers: Array<Peer> = []
  server.on("connection", (socket, request) => {
    const frames: Peer["frames"] = []
    socket.on("message", (data, binary) => {
      const text = Buffer.from(data as Buffer).toString("utf8")
      frames.push(binary ? { bytes: text } : { control: JSON.parse(text) })
    })
    peers.push({
      path: request.url ?? "",
      frames,
      closed: new Promise((resolve) => socket.once("close", (code) => resolve(code))),
      ready: (access) => socket.send(JSON.stringify({ type: "ready", access })),
      output: (text) => socket.send(Buffer.from(text, "utf8"), { binary: true }),
      ended: (reason) => {
        socket.send(JSON.stringify({ type: "ended", reason }))
        socket.close(1000)
      },
      close: (code) => socket.close(code),
    })
  })
  closers.push(() =>
    new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    })
  )
  const { port } = server.address() as { readonly port: number }
  return { origin: `http://127.0.0.1:${port}`, peers }
}

type Row = { readonly id: string; readonly status: string; readonly ownerId: string }

/**
 * The app on a ChatApi on `chatApi.origin` (signed in as a Member unless set), its GitHub with `octo/hello` (`main`, its
 * default, and `feature/one`), and the session row set as sign-in's `load` sets it, so the panel knows whose terminals
 * are the person's.
 */
const open = async (options: TabOptions = {}, chatApi: ChatApiOptions = {}) => {
  const runtime = openTestApp(options, chatApi)
  closers.push(() => runtime.dispose())
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  const terminal = await runtime.runPromise(Effect.service(Terminal))
  const branch = await runtime.runPromise(Effect.service(Branch))
  const store = await runtime.runPromise(Effect.service(TerminalStore))
  terminal.queries.panel.startSyncImmediate()
  terminal.queries.tabs.startSyncImmediate()
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one") },
  })
  const actor = chatApi.actor === undefined ? member : chatApi.actor
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(SESSION, (row) =>
      void Object.assign(
        row,
        actor === null
          ? { status: "signed_out", login: null, role: null }
          : { status: "signed_in", login: actor.subject.id, role: actor.role },
      )),
  )
  const sql = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, statement)))
  return {
    runtime,
    api,
    store,
    actions: terminal.actions,
    panel: () => terminal.queries.panel.toArray[0],
    /** The panel's tabs, oldest first: whose, whether the person's own, and open yet. */
    tabs: () => terminal.queries.tabs.toArray.map(({ id, ownerLogin, mine, status }) => ({ id, ownerLogin, mine, status })),
    /** Tracks branch `name` of `octo/hello` as `POST /api/branches` does, with no page open: its id. */
    track: (name: string, mode: "locked" | "open" = "open") =>
      runtime.runPromise(
        api.branches.run(Conversations.track("github/octo/hello", name, mode, shaOf(name))),
      ).then((tracked) => tracked.branch.branchId),
    /** Opens branch `name`'s page, as the route does: its id. */
    openBranch: async (name: string) => (await branch.actions.open("octo", "hello", name))!,
    /** Branch `branchId`'s terminals, as Postgres holds them. */
    rows: (branchId: string) =>
      sql((sql) =>
        sql<Row>`SELECT id, status, owner_id AS "ownerId" FROM terminal_sessions WHERE branch_id = ${branchId}
          ORDER BY created_at`
      ),
    /** Puts terminal `id` of `ownerId` on `branchId` in Postgres as `status`, as an open and `terminal/Open` leave it. */
    insert: async (
      row: {
        readonly id: string
        readonly branchId: string
        readonly ownerId: string
        readonly status: string
        readonly createdAt?: string
        readonly waiting?: boolean
      },
      options: { readonly receive?: boolean } = {},
    ) => {
      await sql((sql) =>
        sql`
          INSERT INTO terminal_sessions (id, branch_id, owner_id, owner_login, status, generation, ended_reason, failure, created_at,
            waiting)
          VALUES (${row.id}, ${row.branchId}, ${row.ownerId}, ${row.ownerId}, ${row.status},
            ${row.status === "open" ? 1 : null}, ${row.status === "ended" ? "closed" : null},
            ${row.status === "failed" ? "unavailable" : null}, COALESCE(${row.createdAt ?? null}::timestamptz, now()),
            ${row.waiting === true})`
      )
      if (options.receive === false) return
      // Socket tests start from a delivered row; the real open flow's delivery timing is tested separately.
      await runtime.runPromise(Effect.flatMap(store.terminals(row.branchId), (terminals) =>
        Effect.andThen(terminals.preload, terminals.awaitRow((terminal) => terminal.id === row.id, "40 seconds")),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, api.fetch), Effect.timeout("40 seconds")))
      await runtime.runPromise(Effect.yieldNow)
    },
    /** Marks terminal `id` waiting for a free machine, as `terminal/Open`'s admission does. */
    wait: (id: string) => sql((sql) => sql`UPDATE terminal_sessions SET waiting = true, updated_at = now() WHERE id = ${id}`),
    /** Settles terminal `id` as `terminal/Open` or its machine does: open, failed to open, or ended. */
    settle: (id: string, status: "open" | "failed" | "ended") =>
      sql((sql) =>
        status === "open"
          ? sql`UPDATE terminal_sessions SET status = 'open', generation = 1, updated_at = now() WHERE id = ${id}`
          : status === "failed"
          ? sql`UPDATE terminal_sessions SET status = 'failed', failure = 'unavailable', ended_at = now(),
              updated_at = now() WHERE id = ${id}`
          : sql`UPDATE terminal_sessions SET status = 'ended', ended_reason = 'slept', ended_at = now(),
              updated_at = now() WHERE id = ${id}`
      ),
    /** Whether the device has terminal `id` of `branchId` as `status`. */
    synced: (branchId: string, id: string) =>
      runtime.runPromise(Effect.flatMap(store.terminals(branchId), (terminals) => terminals.get(id))).then((row) =>
        row._tag === "Some" ? row.value.status : undefined
      ),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes))).count,
    openTimes: () => runtime.runSync(Metric.value(openMs)).count,
    /** `terminal/open` dispatches from Open terminal that ended `outcome`. */
    dispatched: (outcome: string) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(dispatches, { flow: "terminal/open", door: "button", outcome })),
      ).count,
  }
}

type Tab = Awaited<ReturnType<typeof open>>

/** The frame's output seam: every chunk the socket wrote to it, as text. */
const frame = () => {
  const chunks: Array<string> = []
  return { chunks, sink: { output: (chunk: Uint8Array) => void chunks.push(new TextDecoder().decode(chunk)) } }
}

/** Presses Open terminal and waits until ChatApi started the remote `terminal/Open`: the terminal's id. */
const pressOpen = async (tab: Tab) => {
  const before = tab.api.branches.starts.length
  tab.actions.open()
  await until(() => expect(tab.api.branches.starts.length).toBe(before + 1))
  return (tab.api.branches.starts.at(-1)!.payload as { readonly terminalId: string }).terminalId
}

const other = "person-other"

describe("Open terminal", () => {
  test("opening while the machine wakes, connecting once the row is open; the socket drives the panel", async () => {
    const host = await terminalHost()
    const tab = await open({}, { origin: host.origin })
    const branchId = await tab.openBranch("feature/one")
    await tab.actions.show(branchId)
    expect(tab.panel()).toMatchObject({ branchId, terminalId: null, phase: "idle", access: null })

    tab.actions.open()
    // The panel says so before anything waits.
    expect(tab.panel()).toMatchObject({ branchId, phase: "opening", terminalId: expect.any(String) })
    await until(() => expect(tab.api.branches.starts).toHaveLength(1))
    const terminalId = tab.panel()!.terminalId!
    // One remote `terminal/Open` per terminal, as the person's own user, on the branch's machine.
    expect(tab.api.branches.starts).toEqual([{
      flow: "terminal/Open",
      executionId: openExecutionId(terminalId),
      payload: {
        terminalId,
        ownerId: member.subject.id,
        branch: { branchId, owner: "octo", name: "hello", branch: "feature/one" },
      },
    }])
    expect(await tab.rows(branchId)).toEqual([{ id: terminalId, status: "opening", ownerId: member.subject.id }])
    // Pressing it again while it opens asks nothing more.
    tab.actions.open()

    await tab.settle(terminalId, "open")
    await until(() => expect(tab.panel()).toMatchObject({ terminalId, phase: "connecting" }))
    expect(tab.api.branches.starts).toHaveLength(1)

    const { chunks, sink } = frame()
    const detach = tab.actions.attach(terminalId, sink)
    await until(() => expect(host.peers).toHaveLength(1))
    const peer = host.peers[0]!
    expect(peer.path).toBe(`/api/terminals/${terminalId}`)
    expect(tab.panel()?.phase).toBe("connecting")

    peer.ready("write")
    await until(() => expect(tab.panel()).toMatchObject({ phase: "open", access: "write" }))
    peer.output("hello ")
    peer.output("world")
    await until(() => expect(chunks.join("")).toBe("hello world"))
    // Bytes are counted by direction; Open terminal to the first byte is timed once.
    expect(tab.count(bytes, { direction: "out" })).toBe(11)
    expect(tab.openTimes()).toBe(1)

    tab.actions.input("ls\r")
    tab.actions.resize(120, 40)
    await until(() =>
      expect(peer.frames).toEqual([
        { bytes: "ls\r" },
        { control: { type: "resize", cols: 120, rows: 40 } },
      ])
    )
    expect(tab.count(bytes, { direction: "in" })).toBe(3)

    // The host failed: the socket redials by itself, and the panel says it's offline until it's back.
    peer.close(1011)
    await until(() => expect(tab.panel()?.phase).toBe("offline"))
    expect(tab.count(reconnects, { code: "1011" })).toBe(1)
    await until(() => expect(host.peers).toHaveLength(2))
    host.peers[1]!.ready("write")
    await until(() => expect(tab.panel()).toMatchObject({ phase: "open", access: "write" }))

    // Detaching lets go of the socket: what the person types after it goes nowhere.
    detach()
    expect(await host.peers[1]!.closed).toBe(1000)
    tab.actions.input("exit\r")
    tab.actions.resize(80, 24)
    expect(tab.count(bytes, { direction: "in" })).toBe(3)
    expect(chunks.join("")).toBe("hello world")
  }, WITHIN)

  test("the session ending ends the panel, counted by why; a watcher who may only read is open to read", async () => {
    const host = await terminalHost()
    const tab = await open({}, { origin: host.origin })
    const branchId = await tab.track("feature/one")
    const theirs = crypto.randomUUID()
    await tab.insert({ id: theirs, branchId, ownerId: other, status: "open" })
    await tab.actions.show(branchId, theirs)
    expect(tab.panel()).toMatchObject({ branchId, terminalId: theirs, phase: "connecting" })

    tab.actions.attach(theirs, frame().sink)
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.ready("read")
    await until(() => expect(tab.panel()).toMatchObject({ phase: "open", access: "read" }))
    host.peers[0]!.ended("slept")

    await until(() => expect(tab.panel()?.phase).toBe("ended"))
    expect(tab.count(ended, { reason: "slept" })).toBe(1)
    // An ended session never redials.
    expect(await host.peers[0]!.closed).toBe(1000)
    expect(host.peers).toHaveLength(1)
  }, WITHIN)

  test("a close for no access shows no access; any other final close ends the panel", async () => {
    const host = await terminalHost()
    const tab = await open({}, { origin: host.origin })
    const branchId = await tab.track("feature/one")
    const terminalId = crypto.randomUUID()
    await tab.insert({ id: terminalId, branchId, ownerId: member.subject.id, status: "open" })
    await tab.actions.show(branchId)
    expect(tab.panel()).toMatchObject({ terminalId, phase: "connecting" })

    tab.actions.attach(terminalId, frame().sink)
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.close(1008)
    await until(() => expect(tab.panel()?.phase).toBe("no_access"))

    tab.actions.attach(terminalId, frame().sink)
    await until(() => expect(host.peers).toHaveLength(2))
    host.peers[1]!.close(1003)
    await until(() => expect(tab.panel()?.phase).toBe("ended"))
    expect(host.peers).toHaveLength(2)
  }, WITHIN)

  test("the row ending ends the panel, even while the socket waits for its host", async () => {
    const host = await terminalHost()
    const tab = await open({}, { origin: host.origin })
    const branchId = await tab.track("feature/one")
    const terminalId = crypto.randomUUID()
    await tab.insert({ id: terminalId, branchId, ownerId: member.subject.id, status: "open" })
    await tab.actions.show(branchId)
    tab.actions.attach(terminalId, frame().sink)
    await until(() => expect(host.peers).toHaveLength(1))
    expect(tab.panel()?.phase).toBe("connecting")

    // The machine slept: `terminal/Open`'s host records the row ended, and the socket never hears `ready`.
    await tab.settle(terminalId, "ended")

    await until(() => expect(tab.panel()?.phase).toBe("ended"))
    // The panel let go of the socket.
    expect(await host.peers[0]!.closed).toBe(1000)
  }, WITHIN)

  test("a socket with no branch shown follows only its own status; showing a branch lets go of it", async () => {
    const host = await terminalHost()
    const tab = await open({}, { origin: host.origin })
    const branchId = await tab.track("feature/one")
    const terminalId = crypto.randomUUID()
    await tab.insert({ id: terminalId, branchId, ownerId: other, status: "open" })

    tab.actions.attach(terminalId, frame().sink)
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.ready("read")
    await until(() => expect(tab.panel()).toMatchObject({ branchId: null, phase: "open", access: "read" }))

    // Showing the branch lets go of the socket; the branch's live terminal is shown afresh, to attach again.
    await tab.actions.show(branchId)
    expect(await host.peers[0]!.closed).toBe(1000)
    expect(tab.panel()).toMatchObject({ branchId, terminalId, phase: "connecting", access: null })
  }, WITHIN)

  test("the person's terminal already open is shown, not a second one: Open terminal answers theirs", async () => {
    const host = await terminalHost()
    const tab = await open({}, { origin: host.origin })
    const branchId = await tab.track("feature/one")
    const mine = crypto.randomUUID()
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "open" })
    await tab.actions.show(branchId)
    expect(tab.panel()).toMatchObject({ terminalId: mine, phase: "connecting" })

    tab.actions.open()

    // ChatApi answers with theirs, so no remote flow starts and the panel shows it again.
    await until(() => expect(tab.panel()).toMatchObject({ terminalId: mine, phase: "connecting" }))
    expect(tab.api.branches.starts).toEqual([])
    expect((await tab.rows(branchId)).map(({ id }) => id)).toEqual([mine])
    // Open terminal to the first byte is timed from the press.
    tab.actions.attach(mine, frame().sink)
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.ready("write")
    host.peers[0]!.output("$ ")
    await until(() => expect(tab.openTimes()).toBe(1))
  }, WITHIN)
})

describe("Open terminal settles", () => {
  test("failed when its machine couldn't start; the next press opens a new one; no branch shown asks nothing", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    await tab.actions.show(branchId)

    const first = await pressOpen(tab)
    await tab.settle(first, "failed")
    await until(() => expect(tab.panel()).toMatchObject({ terminalId: first, phase: "failed" }))

    // The person's next press opens a new one, and their failed one goes.
    const second = await pressOpen(tab)
    expect(second).not.toBe(first)
    expect((await tab.rows(branchId)).map(({ id }) => id)).toEqual([second])

    await until(() => expect(tab.dispatched("done")).toBe(2))
    await tab.actions.show(null)
    tab.actions.open()
    expect(tab.panel()).toMatchObject({ branchId: null, terminalId: null, phase: "idle" })
    expect(tab.api.branches.starts).toHaveLength(2)
  }, WITHIN)

  test("an answer that comes after the person left the branch isn't shown", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    await tab.actions.show(branchId)

    tab.actions.open()
    await tab.actions.show(null)

    await until(() => expect(tab.dispatched("done")).toBe(1))
    expect(tab.panel()).toMatchObject({ branchId: null, terminalId: null, phase: "idle" })
    // The terminal was opened, and is theirs to come back to.
    expect((await tab.rows(branchId)).map(({ status }) => status)).toEqual(["opening"])
  }, WITHIN)

  test("failed when its row is gone before it opened", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    await tab.actions.show(branchId)

    const terminalId = await pressOpen(tab)
    // Its run settled it failed and another open dropped it, in one transaction.
    await tab.runtime.runPromise(tab.api.branches.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.andThen(
        sql`UPDATE terminal_sessions SET status = 'failed', failure = 'unavailable', ended_at = now() WHERE id = ${terminalId}`,
        sql`DELETE FROM terminal_sessions WHERE id = ${terminalId}`,
      )))))

    await until(() => expect(tab.panel()).toMatchObject({ terminalId, phase: "failed" }))
  }, WITHIN)

  test("ChatApi unable to start the machine is tried again by the step, and the terminal opens once", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    await tab.actions.show(branchId)
    tab.api.branches.refuseStarts(1)

    const terminalId = await pressOpen(tab)

    expect(tab.api.branches.starts).toEqual([expect.objectContaining({ executionId: openExecutionId(terminalId) })])
    expect((await tab.rows(branchId)).map(({ id, status }) => [id, status])).toEqual([[terminalId, "opening"]])
    await tab.settle(terminalId, "open")
    await until(() => expect(tab.panel()).toMatchObject({ terminalId, phase: "connecting" }))
  }, WITHIN)

  test("a locked branch fails; a tab whose engine can't run fails", async () => {
    const tab = await open()
    const main = await tab.track("main", "locked")
    await tab.actions.show(main)
    tab.actions.open()
    await until(() => expect(tab.panel()?.phase).toBe("failed"))
    expect(await tab.rows(main)).toEqual([])

    const stopped = await open({ host: nodeDevice({ engineWorker: failingWorker }) })
    const branchId = await stopped.track("feature/one")
    await stopped.actions.show(branchId)
    stopped.actions.open()
    await until(() => expect(stopped.panel()?.phase).toBe("failed"))
    expect(await stopped.rows(branchId)).toEqual([])
  }, WITHIN)

  test.each<[string, Actor | null]>([
    ["signed out", null],
    ["a Guest", { subject: { kind: "person", id: "person-guest" }, role: "guest" }],
  ])("%s has no access, and no terminal is recorded", async (_who, actor) => {
    const tab = await open({}, { actor })
    const branchId = await tab.track("feature/one")
    await tab.actions.show(branchId)

    tab.actions.open()

    await until(() => expect(tab.panel()?.phase).toBe("no_access"))
    expect(await tab.rows(branchId)).toEqual([])
    expect(tab.api.branches.starts).toEqual([])
  }, WITHIN)
})

describe("the panel", () => {
  test.each([OPEN_DEADLINE_SECONDS * 1000, (OPEN_DEADLINE_SECONDS + 1) * 1000])(
    "page load fails an opening row aged %i ms immediately and offers Open terminal",
    async (age) => {
      const tab = await open()
      const branchId = await tab.track("feature/one")
      const mine = crypto.randomUUID()
      const createdAt = "2026-10-21T12:00:00.000Z"
      await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening", createdAt })
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
      await tab.runtime.runPromise(Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(createdAt) + age)
        expect(yield* show(branchId)).toBe(mine)
        yield* TestClock.adjust(0)
        const panel = yield* tab.store.panel.get(PANEL)
        expect(panel).toMatchObject({ _tag: "Some", value: { terminalId: mine, phase: "failed" } })
        const tabs = yield* tab.store.tabs.toArray
        expect(tabs).toMatchObject([{ id: mine, mine: true, status: "opening" }])
        expect(panelViewOf(panel._tag === "Some" ? panel.value : undefined, tabs, true)).toEqual({
          badge: undefined, open: "button", screen: { kind: "open" },
        })
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
      ))
      expect(await tab.synced(branchId, mine)).toBe("opening")
      // A row that never settled is logged once as it fails the panel.
      expect(logs.filter((log) => log.message === "terminal.open.unsettled")).toEqual([
        expect.objectContaining({ level: "WARN", annotations: expect.objectContaining({ feature: "terminal", outcome: "timeout" }) }),
      ])
    }, WITHIN,
  )

  test("a row waiting for a free machine stays opening past the open's deadline, says so, and fails only past the wait", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    const mine = crypto.randomUUID()
    const createdAt = "2026-10-21T12:00:00.000Z"
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening", createdAt, waiting: true })
    await tab.runtime.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(createdAt))
      expect(yield* show(branchId)).toBe(mine)
      yield* TestClock.adjust(OPEN_DEADLINE_SECONDS * 1000 + 60_000)
      const panel = yield* tab.store.panel.get(PANEL)
      expect(panel).toMatchObject({ _tag: "Some", value: { terminalId: mine, phase: "opening" } })
      const tabs = yield* tab.store.tabs.toArray
      expect(tabs).toMatchObject([{ id: mine, mine: true, status: "opening", waiting: true }])
      expect(panelViewOf(panel._tag === "Some" ? panel.value : undefined, tabs, true)).toEqual({
        badge: undefined, open: "waiting", screen: { kind: "open" },
      })
      yield* TestClock.adjust(ADMIT_WAIT_SECONDS * 1000)
      expect(yield* tab.store.panel.get(PANEL)).toMatchObject({ _tag: "Some", value: { phase: "failed" } })
    }).pipe(Effect.provide(TestClock.layer())))
  }, WITHIN)

  test("a row that starts waiting while the panel waits on it gets the wait's time too", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    const mine = crypto.randomUUID()
    const createdAt = "2026-10-21T12:00:00.000Z"
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening", createdAt })
    await tab.runtime.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(createdAt))
      expect(yield* show(branchId)).toBe(mine)
      yield* Effect.promise(() => tab.wait(mine))
      yield* Effect.promise(() =>
        until(async () => expect(await tab.runtime.runPromise(tab.store.tabs.toArray)).toMatchObject([{ id: mine, waiting: true }]))
      )
      // Past the open's own deadline from its creation: still opening, waiting.
      yield* TestClock.adjust(OPEN_DEADLINE_SECONDS * 1000 + 1_000)
      expect(yield* tab.store.panel.get(PANEL)).toMatchObject({ _tag: "Some", value: { phase: "opening" } })
    }).pipe(Effect.provide(TestClock.layer())))
  }, WITHIN)

  test.each([0, 90_000])("page load keeps an opening row aged %i ms opening until its original deadline", async (age) => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    const mine = crypto.randomUUID()
    const createdAt = "2026-10-21T12:00:00.000Z"
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening", createdAt })
    await tab.runtime.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(createdAt) + age)
      expect(yield* show(branchId)).toBe(mine)
      yield* TestClock.adjust(OPEN_DEADLINE_SECONDS * 1000 - age - 1)
      const panel = yield* tab.store.panel.get(PANEL)
      expect(panel).toMatchObject({ _tag: "Some", value: { terminalId: mine, phase: "opening" } })
      const tabs = yield* tab.store.tabs.toArray
      expect(panelViewOf(panel._tag === "Some" ? panel.value : undefined, tabs, true)).toEqual({
        badge: undefined, open: "opening", screen: { kind: "open" },
      })
      yield* TestClock.adjust(1)
      expect(yield* tab.store.panel.get(PANEL)).toMatchObject({ _tag: "Some", value: { phase: "failed" } })
    }).pipe(Effect.provide(TestClock.layer())))
  }, WITHIN)

  test("shows the person's own live terminal, or the one they watch, by its row; else the branch's first live one, else Open terminal", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    const [ended, failed, theirs] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    await tab.insert({ id: ended, branchId, ownerId: member.subject.id, status: "ended" })
    await tab.insert({ id: failed, branchId, ownerId: other, status: "failed" })
    await tab.insert({ id: theirs, branchId, ownerId: other, status: "opening" })

    // The person's own ended terminal isn't theirs to show: wait for the branch's live one, even if it isn't theirs.
    expect(await tab.actions.show(branchId)).toBe(theirs)
    expect(tab.panel()).toMatchObject({ branchId, terminalId: theirs, phase: "opening" })
    await tab.settle(theirs, "open")
    await until(() => expect(tab.panel()?.phase).toBe("connecting"))
    expect(tab.panel()).toMatchObject({ branchId, terminalId: theirs, phase: "connecting" })
    expect(tab.tabs()).toEqual([{ id: theirs, ownerLogin: other, mine: false, status: "open" }])
    await tab.actions.show(branchId, ended)
    expect(tab.panel()).toMatchObject({ terminalId: ended, phase: "ended" })
    await tab.actions.show(branchId, failed)
    expect(tab.panel()).toMatchObject({ terminalId: failed, phase: "failed" })
    await tab.actions.show(branchId, theirs)
    expect(tab.panel()).toMatchObject({ terminalId: theirs, phase: "connecting" })
    expect(await tab.actions.show(branchId, crypto.randomUUID())).toBeNull()
    expect(tab.panel()).toMatchObject({ terminalId: null, phase: "idle" })

    // Their own terminal opening: the panel waits for its row, then shows it, and the tabs follow the rows.
    const mine = crypto.randomUUID()
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening" })
    await until(async () => expect(await tab.synced(branchId, mine)).toBe("opening"))
    await tab.actions.show(branchId)
    expect(tab.panel()).toMatchObject({ terminalId: mine, phase: "opening" })
    await until(() =>
      expect(tab.tabs()).toEqual([
        { id: theirs, ownerLogin: other, mine: false, status: "open" },
        { id: mine, ownerLogin: member.subject.id, mine: true, status: "opening" },
      ])
    )
    await tab.settle(mine, "open")
    await until(() => expect(tab.panel()).toMatchObject({ terminalId: mine, phase: "connecting" }))
    // Shown from its row, not pressed: nothing to time.
    expect(tab.openTimes()).toBe(0)

    await tab.actions.show(null)
    expect(tab.panel()).toMatchObject({ branchId: null, terminalId: null, phase: "idle", access: null })
    expect(tab.tabs()).toEqual([])
  }, WITHIN)

  test("with no live terminal on the branch, the panel offers Open terminal", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    expect(await tab.actions.show(branchId)).toBeNull()
    expect(tab.panel()).toMatchObject({ branchId, terminalId: null, phase: "idle" })
    expect(tab.tabs()).toEqual([])
    await tab.insert({ id: crypto.randomUUID(), branchId, ownerId: member.subject.id, status: "ended" })
    expect(tab.panel()).toMatchObject({ terminalId: null, phase: "idle" })
    expect(tab.tabs()).toEqual([])
  }, WITHIN)

  test("ended rows leave the empty panel alone; someone else's opening terminal is selected and followed until open", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    await tab.actions.show(branchId)
    const closed = crypto.randomUUID()
    await tab.insert({ id: closed, branchId, ownerId: other, status: "ended" })
    await until(async () => expect(await tab.synced(branchId, closed)).toBe("ended"))
    expect(tab.panel()).toMatchObject({ terminalId: null, phase: "idle" })
    expect(tab.tabs()).toEqual([])
    const theirs = crypto.randomUUID()
    await tab.insert({ id: theirs, branchId, ownerId: other, status: "opening" })
    await until(() => expect(tab.panel()).toMatchObject({ terminalId: theirs, phase: "opening" }))
    await tab.settle(theirs, "open")
    await until(() => expect(tab.panel()).toMatchObject({ terminalId: theirs, phase: "connecting" }))
  }, WITHIN)

  // The branch terminal's reload on a loaded machine (2026-10-20): the branch's rows came after the preload's deadline,
  // so the panel showed nothing, and the Terminal view stayed blank beside the person's live terminal.
  test("a panel that found no terminal shows the first that turns up: the person's own, waiting while it opens", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    expect(await tab.actions.show(branchId)).toBeNull()
    expect(tab.panel()).toMatchObject({ branchId, terminalId: null, phase: "idle" })

    const mine = crypto.randomUUID()
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening" })
    await until(() => expect(tab.panel()).toMatchObject({ branchId, terminalId: mine, phase: "opening" }))
    await tab.settle(mine, "open")
    await until(() => expect(tab.panel()).toMatchObject({ terminalId: mine, phase: "connecting" }))

    // Once it shows one, another terminal turning up doesn't take the panel over.
    const theirs = crypto.randomUUID()
    await tab.insert({ id: theirs, branchId, ownerId: other, status: "open" })
    await until(async () => expect(await tab.synced(branchId, theirs)).toBe("open"))
    expect(tab.panel()).toMatchObject({ terminalId: mine })
  }, WITHIN)

  test("watching a terminal that isn't there waits for nothing else; another branch's panel ignores this one's rows", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    expect(await tab.actions.show(branchId, crypto.randomUUID())).toBeNull()
    const theirs = crypto.randomUUID()
    await tab.insert({ id: theirs, branchId, ownerId: other, status: "open" })
    await until(async () => expect(await tab.synced(branchId, theirs)).toBe("open"))
    await until(() => expect(tab.tabs()).toEqual([{ id: theirs, ownerLogin: other, mine: false, status: "open" }]))
    expect(tab.panel()).toMatchObject({ branchId, terminalId: null, phase: "idle" })
  }, WITHIN)

  test("a terminal that opens after the person left the branch doesn't take the panel over", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")
    const mine = crypto.randomUUID()
    await tab.insert({ id: mine, branchId, ownerId: member.subject.id, status: "opening" })
    await tab.actions.show(branchId)
    expect(tab.panel()).toMatchObject({ terminalId: mine, phase: "opening" })

    await tab.actions.show(null)
    await tab.settle(mine, "open")

    await until(async () => expect(await tab.synced(branchId, mine)).toBe("open"))
    expect(tab.panel()).toMatchObject({ branchId: null, terminalId: null, phase: "idle" })
  }, WITHIN)

  test("signed out, no terminal is the person's", async () => {
    const tab = await open({}, { actor: null })
    const branchId = await tab.track("feature/one")
    // A signed-out shape intentionally delivers no terminal rows.
    await tab.insert({ id: crypto.randomUUID(), branchId, ownerId: member.subject.id, status: "open" }, { receive: false })

    await tab.actions.show(branchId)

    expect(tab.panel()).toMatchObject({ branchId, terminalId: null, phase: "idle" })
  }, WITHIN)

  test("a branch's terminals are synced once per tab, however many ask at once", async () => {
    const tab = await open()
    const branchId = await tab.track("feature/one")

    // Each fiber yields every 16 operations, so the two interleave: the second asks while the first opens it.
    const [first, second] = await tab.runtime.runPromise(
      Effect.all([tab.store.terminals(branchId), tab.store.terminals(branchId)], { concurrency: 2 }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
      ),
    )

    expect(second).toBe(first)
    expect(await tab.runtime.runPromise(tab.store.terminals(branchId))).toBe(first)
  }, WITHIN)

  test("the socket's URL is the app's origin, ws: for http: and wss: for https:", () => {
    expect(socketUrl("http://localhost:1337", "t-1")).toBe("ws://localhost:1337/api/terminals/t-1")
    expect(socketUrl("https://smithers.sh", "t-2")).toBe("wss://smithers.sh/api/terminals/t-2")
  })
})

/** `TerminalClient` over `fetch`, as the engine's host builds it: what one open answers, or its refusal. */
const client = (fetch: typeof globalThis.fetch, within?: "50 millis") =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(TerminalClient), (terminals) =>
      terminals.open({ terminalId: "t-1", branchId: "b-1", cols: DEFAULT_COLS, rows: DEFAULT_ROWS })).pipe(
        Effect.match({ onSuccess: (opened) => opened, onFailure: (refused) => refused }),
        Effect.provide(
          TerminalClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
  )

describe("the terminal client", () => {
  test("posts the open; 202 or 200 with the terminal is opened, and anything else is an OpenRefused", async () => {
    const posted: Array<{ readonly url: string; readonly body: unknown }> = []
    const recording: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      posted.push({ url: request.url, body: await request.json() })
      return Response.json({ terminalId: "t-1" }, { status: 202 })
    }
    expect(await client(recording)).toEqual({ terminalId: "t-1" })
    expect(posted).toEqual([{
      url: "http://chat.test/api/terminals",
      body: { terminalId: "t-1", branchId: "b-1", cols: 80, rows: 24 },
    }])
    expect(await client(async () => Response.json({ terminalId: "t-0" }))).toEqual({ terminalId: "t-0" })

    expect(await client(() => Promise.reject(new TypeError("offline")))).toEqual(new OpenRefused({}))
    expect(await client(() => new Promise(() => {}), "50 millis")).toEqual(new OpenRefused({}))
    expect(await client(async () => Response.json({ code: "locked" }, { status: 409 }))).toEqual(
      new OpenRefused({ status: 409, code: "locked" }),
    )
    expect(await client(async () => new Response("busy", { status: 503 }))).toEqual(new OpenRefused({ status: 503 }))
    const cut = new ReadableStream({ start: (controller) => controller.error(new TypeError("cut")) })
    expect(await client(async () => new Response(cut, { status: 502 }))).toEqual(new OpenRefused({ status: 502 }))
    expect(await client(async () => Response.json({ opened: true }, { status: 202 }))).toEqual(
      new OpenRefused({ status: 202 }),
    )
  })
})

describe("the step", () => {
  /** `terminal/open/request` over a client that answers `answer`: how it ended, and every record it left. */
  const step = async (answer: () => Promise<Response>) => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
    const ended = await Effect.runPromise(
      requestOpen({ terminalId: "t-1", branchId: "b-1", cols: 80, rows: 24 }).pipe(
        Effect.match({ onSuccess: (opened) => ({ opened }), onFailure: (failed) => ({ failed }) }),
        Effect.provide(
          TerminalClient.layer({ origin: "http://chat.test", within: "50 millis" }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, () => answer())),
          ),
        ),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    const count = (outcome: string) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(opens, { outcome })).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count
    return { ended, logs, count }
  }

  test.each<[number, string | undefined, TerminalOpenRefused | TerminalOpenUnavailable, string]>([
    [401, undefined, new TerminalOpenRefused({ reason: "sign_in" }), "sign_in"],
    [403, undefined, new TerminalOpenRefused({ reason: "forbidden" }), "forbidden"],
    [409, "locked", new TerminalOpenRefused({ reason: "locked" }), "locked"],
    [409, "id_taken", new TerminalOpenUnavailable(), "unavailable"],
    [404, undefined, new TerminalOpenRefused({ reason: "not_found" }), "not_found"],
    [400, undefined, new TerminalOpenRefused({ reason: "invalid" }), "invalid"],
    [413, undefined, new TerminalOpenRefused({ reason: "invalid" }), "invalid"],
    [503, undefined, new TerminalOpenUnavailable(), "unavailable"],
  ])("ChatApi's %s (%s) fails the step, counted and logged by its outcome and status", async (status, code, failure, outcome) => {
    const { ended, logs, count } = await step(async () => Response.json({ code: code ?? "x" }, { status }))

    expect(ended).toEqual({ failed: failure })
    expect(count(outcome)).toBe(1)
    expect(logs).toEqual([
      expect.objectContaining({
        level: "WARN",
        message: "terminal.open",
        annotations: expect.objectContaining({ outcome, status, terminalId: "t-1", branchId: "b-1", feature: "terminal" }),
      }),
    ])
  })

  test("opening is counted and logged as Info; no answer at all is unavailable, with no status", async () => {
    const opened = await step(async () => Response.json({ terminalId: "t-1" }, { status: 202 }))
    expect(opened.ended).toEqual({ opened: { terminalId: "t-1" } })
    expect(opened.count("opening")).toBe(1)
    expect(opened.logs).toEqual([
      expect.objectContaining({ level: "INFO", message: "terminal.open", annotations: expect.objectContaining({ outcome: "opening" }) }),
    ])
    expect(opened.logs[0]!.annotations).not.toHaveProperty("status")

    const stalled = await step(() => new Promise(() => {}))
    expect(stalled.ended).toEqual({ failed: new TerminalOpenUnavailable() })
    expect(stalled.count("unavailable")).toBe(1)
    expect(stalled.logs[0]).toMatchObject({ level: "WARN", annotations: { outcome: "unavailable" } })
    expect(stalled.logs[0]!.annotations).not.toHaveProperty("status")
  })
})
