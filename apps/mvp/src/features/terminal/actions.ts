import { TerminalSocket } from "@smthrs/platform-browser"
import { Cause, Clock, Effect, FiberHandle, Metric, Option, Ref, Stream } from "effect"
import { runners } from "../../boundary"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { AuthStore, SESSION } from "../auth/store"
import { ADMIT_WAIT_SECONDS, DEFAULT_COLS, DEFAULT_ROWS, OPEN_DEADLINE_SECONDS, terminalSocketRoute } from "./contract"
import { bytes, ended, openMs, reconnects } from "./metrics"
import { PANEL, type Panel, type Tab, type TerminalRow } from "./schema"
import { TerminalStore } from "./store"

// What a person does with a branch's terminal (decision 0013 §3, docs/features/branch-workspace.md#the-terminal), and
// what the tab does for them. Opening is the flow `terminal/open`; the terminal's row says when its shell is up. The
// socket is `@smthrs/platform-browser`'s `TerminalSocket`, which reconnects by itself; its bytes go straight to the
// frame. Nothing here counts or logs a byte's content.

/** Where the frame's output goes. */
export interface Sink {
  readonly output: (bytes: Uint8Array) => void
}

const setPanel = (fields: Partial<Omit<Panel, "id">>) =>
  Effect.flatMap(TerminalStore, ({ panel }) =>
    Effect.orDie(panel.update(PANEL, (row) => void Object.assign(row, fields))))

const panelNow = Effect.flatMap(TerminalStore, ({ panel }) => Effect.map(panel.get(PANEL), Option.getOrThrow))

/** Milliseconds from row creation until the panel says opening failed. */
const OPEN_WITHIN = OPEN_DEADLINE_SECONDS * 1000

/** The signed-in person's GitHub login, if any: whose terminals are theirs. */
const loginNow = Effect.gen(function* () {
  const { session } = yield* AuthStore
  return Option.getOrThrow(yield* session.get(SESSION)).login
})

/** The person's live terminal among `rows`, if they have one. */
const mineOf = (rows: ReadonlyArray<TerminalRow>, login: string | null) =>
  login === null
    ? undefined
    : rows.find((row) => row.ownerLogin === login && (row.status === "open" || row.status === "opening"))

/** Makes the panel's tabs the live terminals among `rows`. */
const mirrorTabs = (rows: ReadonlyArray<TerminalRow>) =>
  Effect.gen(function* () {
    const { tabs } = yield* TerminalStore
    const login = yield* loginNow
    const live: ReadonlyArray<Tab> = rows.flatMap((row) =>
      row.status === "open" || row.status === "opening"
        ? [{
          id: row.id,
          ownerId: row.ownerId,
          ownerLogin: row.ownerLogin,
          mine: row.ownerLogin === login,
          status: row.status,
          waiting: row.status === "opening" && row.waiting === true,
          createdAt: row.createdAt,
        }]
        : []
    )
    const keep = new Set(live.map((tab) => tab.id))
    const gone = (yield* tabs.toArray).filter((tab) => !keep.has(tab.id)).map((tab) => tab.id)
    if (gone.length > 0) yield* Effect.orDie(tabs.delete(gone))
    for (const tab of live) {
      if (Option.isSome(yield* tabs.get(tab.id))) {
        yield* Effect.orDie(tabs.update(tab.id, (draft) => void Object.assign(draft, tab)))
      } else {
        yield* Effect.orDie(tabs.insert(tab))
      }
    }
  })

/**
 * Shows branch `branchId`'s terminal panel: `watching`, a terminal to watch (anyone's), or else the person's own open
 * one, or else the first live terminal on the branch, attached once it is open; otherwise Open terminal, until such a
 * terminal turns up. Its tabs follow the branch's live terminals while it shows. `null` shows none, and lets go of the socket. Answers the
 * terminal it shows, if any.
 */
export const show = (branchId: string | null, watching?: string) =>
  Effect.gen(function* () {
    const store = yield* TerminalStore
    yield* FiberHandle.clear(store.attached)
    yield* FiberHandle.clear(store.follower)
    if (branchId === null) {
      yield* mirrorTabs([])
      yield* setPanel({ branchId: null, terminalId: null, phase: "idle", access: null })
      return null
    }
    yield* mirrorTabs([])
    yield* setPanel({ branchId, terminalId: null, phase: "loading", access: null })
    const terminals = yield* store.terminals(branchId)
    // Rows load behind the screen, so navigation never waits or offers a duplicate terminal while they are unknown.
    const startedAt = yield* Clock.currentTimeMillis
    const loaded = yield* terminals.preload.pipe(
      Effect.onExit((exit) => Effect.gen(function* () {
        const fields = {
          preloadMs: (yield* Clock.currentTimeMillis) - startedAt,
          rowCount: (yield* terminals.toArray).length,
          outcome: exit._tag === "Success" ? "ready" : Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
        }
        yield* Effect.annotateCurrentSpan(fields)
        // Rows that couldn't load leave the panel loading: a failure, with its code.
        yield* exit._tag === "Failure" && fields.outcome === "failed"
          ? Effect.logWarning("terminal.show").pipe(
            Effect.annotateLogs({ ...fields, errorCode: codeOf(Cause.squash(exit.cause)) }),
          )
          : Effect.logInfo("terminal.show").pipe(Effect.annotateLogs(fields))
      })),
      Effect.option,
    )
    if (Option.isNone(loaded)) return null
    const rows = yield* terminals.toArray
    yield* mirrorTabs(rows)
    const pick = (rows: ReadonlyArray<TerminalRow>) =>
      Effect.map(loginNow, (login) => mineOf(rows, login) ?? rows.find((row) => row.status === "open" || row.status === "opening"))
    const showRow = (shown: TerminalRow) =>
      Effect.gen(function* () {
        yield* setPanel({ branchId, terminalId: shown.id, phase: shown.status === "open" ? "connecting" : phaseOf(shown), access: null })
        if (shown.status === "opening") yield* Effect.forkIn(awaitOpen(branchId, shown.id, undefined), store.scope)
      })
    // Tabs follow the live rows. A branch with no live terminal selects the first that turns up after its initial
    // sync, so the screen follows terminals opened later too.
    yield* FiberHandle.run(
      store.follower,
      terminals.changes().pipe(Stream.runForEach(() =>
        Effect.gen(function* () {
          const now = yield* terminals.toArray
          yield* mirrorTabs(now)
          if (watching !== undefined) return
          const panel = yield* panelNow
          if (panel.branchId !== branchId || panel.terminalId !== null || panel.phase !== "idle") return
          const found = yield* pick(now)
          if (found !== undefined) yield* showRow(found)
        })
      )),
    )
    const shown = watching === undefined ? yield* pick(rows) : rows.find((row) => row.id === watching)
    if (shown === undefined) yield* setPanel({ branchId, terminalId: null, phase: "idle", access: null })
    else yield* showRow(shown)
    return shown?.id ?? null
  }).pipe(Effect.withSpan("terminal.show"), Effect.annotateLogs({ feature: "terminal" }))

/** The panel's phase for a row that isn't open. */
const phaseOf = (row: TerminalRow): Panel["phase"] =>
  row.status === "opening" ? "opening" : row.status === "failed" ? "failed" : "ended"

/**
 * Waits for terminal `terminalId`'s row to settle, then shows it open, or why not. A row waiting for a free machine
 * gets the wait's time too (`ADMIT_WAIT_SECONDS`).
 */
const awaitOpen = (branchId: string, terminalId: string, startedAt: number | undefined) =>
  Effect.gen(function* () {
    const terminals = yield* (yield* TerminalStore).terminals(branchId)
    const settled = (row: TerminalRow | undefined) => row !== undefined && row.status !== "opening"
    const now = Option.getOrUndefined(yield* terminals.get(terminalId))
    const from = now === undefined ? yield* Clock.currentTimeMillis : Date.parse(now.createdAt)
    /** The row once `match` holds for it, or as it is at `until`. */
    const awaitRow = (match: (row: Partial<TerminalRow>) => boolean, until: number) =>
      Effect.gen(function* () {
        const remaining = Math.max(0, until - (yield* Clock.currentTimeMillis))
        return yield* terminals.awaitMatch((change) => change.value.id === terminalId && match(change.value), remaining).pipe(
          Effect.timeoutOption(remaining),
          Effect.ignore,
          Effect.andThen(terminals.get(terminalId)),
          Effect.map(Option.getOrUndefined),
        )
      })
    // An update carries only the columns it changed: a change settles the row only when it says its status.
    const settles = (value: Partial<TerminalRow>) => value.status !== undefined && value.status !== "opening"
    let row = now
    if (!settled(row) && row?.waiting !== true) {
      row = yield* awaitRow((value) => settles(value) || value.waiting === true, from + OPEN_WITHIN)
    }
    if (!settled(row) && row?.waiting === true) {
      row = yield* awaitRow(settles, from + ADMIT_WAIT_SECONDS * 1000 + OPEN_WITHIN)
    }
    const panel = yield* panelNow
    if (panel.terminalId !== terminalId) return
    if (row === undefined || row.status === "opening") {
      // The row never settled within its wait, or it went: the panel shows the terminal failed.
      yield* Effect.logWarning("terminal.open.unsettled").pipe(
        Effect.annotateLogs({ feature: "terminal", outcome: row === undefined ? "missing" : "timeout" }),
      )
      return yield* setPanel({ phase: "failed" })
    }
    yield* setPanel({ phase: row.status === "open" ? "connecting" : phaseOf(row) })
    if (row.status === "open" && startedAt !== undefined) yield* Ref.set((yield* TerminalStore).openedAt, startedAt)
  })

/**
 * Open terminal: opens the person's terminal on the panel's branch through `terminal/open`, and shows it once its
 * shell is up. A person has one terminal per branch, so this shows theirs if it is already open.
 */
export const open = Effect.gen(function* () {
  const store = yield* TerminalStore
  const panel = yield* panelNow
  if (panel.branchId === null || panel.phase === "opening") return
  const branchId = panel.branchId
  const terminalId = crypto.randomUUID()
  const startedAt = yield* Clock.currentTimeMillis
  yield* setPanel({ terminalId, phase: "opening", access: null })
  const dispatched = yield* Effect.result(
    (yield* FlowDispatch).dispatch(
      "terminal/open",
      { branchId, terminalId, cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
      { door: "button" },
    ),
  )
  // The person moved on while it was asked (another branch, or none): the answer isn't this panel's.
  if ((yield* panelNow).terminalId !== terminalId) return
  if (dispatched._tag === "Failure" || dispatched.success._tag === "Failed") {
    const error = dispatched._tag === "Success" && dispatched.success._tag === "Failed"
      ? dispatched.success.error
      : undefined
    const refused = error?._tag === "@smthrs/mvp/terminal/TerminalOpenRefused" ? error.reason : undefined
    return yield* setPanel({ phase: refused === "sign_in" || refused === "forbidden" ? "no_access" : "failed" })
  }
  const answered = dispatched.success.value.terminalId
  yield* setPanel({ terminalId: answered })
  yield* Effect.forkIn(awaitOpen(branchId, answered, startedAt), store.scope)
}).pipe(Effect.withSpan("terminal.open.press"), Effect.annotateLogs({ feature: "terminal" }))

/** The socket's status, as the panel shows it, with its records. */
const onStatus = (status: TerminalSocket.Status) => {
  switch (status._tag) {
    case "Connecting":
      return setPanel({ phase: "connecting" })
    case "Open":
      return setPanel({ phase: "open", access: status.access })
    case "Offline":
      return Effect.andThen(
        Metric.update(Metric.withAttributes(reconnects, { code: String(status.code) }), 1),
        setPanel({ phase: "offline" }),
      )
    case "Ended":
      return Effect.andThen(
        Metric.update(Metric.withAttributes(ended, { reason: status.reason }), 1),
        setPanel({ phase: "ended" }),
      )
    case "Closed":
      return setPanel({ phase: status.code === 1008 ? "no_access" : "ended" })
  }
}

/**
 * How long an attached panel watches its terminal's row. The wait is a timer, and a timer holds at most 2^31 - 1 ms
 * (about 24.8 days): a longer one fires at once, in browsers and Node alike, which would end the panel as it attaches.
 */
const ROW_WATCH = "24 days"

/** The socket URL of terminal `terminalId` on the app's `origin`: `ws:` for `http:`, `wss:` for `https:`. */
export const socketUrl = (origin: string, terminalId: string) =>
  `${origin.replace(/^http/, "ws")}${terminalSocketRoute(terminalId)}`

/**
 * Attaches this tab to terminal `terminalId`, writing its output to `sink`, until `detach` or another attach. The
 * socket reconnects by itself; the panel follows its status and the terminal's row: a row that ends stops it.
 */
export const attach = (terminalId: string, sink: Sink) =>
  Effect.gen(function* () {
    const store = yield* TerminalStore
    // The socket calls back with each frame outside any fiber: its records run with this attach's services.
    const { runSync: record } = runners(yield* Effect.context<TerminalStore>(), "terminal")
    const run = Effect.scoped(Effect.gen(function* () {
      const connection = yield* TerminalSocket.connect(socketUrl(store.origin, terminalId), {
        onOutput: (chunk) => {
          sink.output(chunk)
          record(Effect.andThen(
            recordFirstByte,
            Metric.update(Metric.withAttributes(bytes, { direction: "out" }), chunk.length),
          ))
        },
      })
      yield* Ref.set(store.connection, connection)
      const panel = yield* panelNow
      const terminals = panel.branchId === null ? undefined : yield* store.terminals(panel.branchId)
      // The row ending (the machine slept or was lost) ends the panel, even while the socket redials.
      const rowEnds = terminals === undefined ? Effect.never : terminals.awaitMatch(
        (change) => change.value.id === terminalId && (change.value.status === "ended" || change.value.status === "failed"),
        ROW_WATCH,
      ).pipe(Effect.ignore, Effect.andThen(setPanel({ phase: "ended" })))
      yield* Effect.raceFirst(connection.status.pipe(Stream.runForEach(onStatus)), rowEnds)
    })).pipe(
      Effect.provide(TerminalSocket.layerWebSocket),
      Effect.ensuring(Effect.flatMap(TerminalStore, (s) => Ref.set(s.connection, undefined))),
      Effect.withSpan("terminal.connect"),
    )
    yield* FiberHandle.run(store.attached, run)
  }).pipe(Effect.annotateLogs({ feature: "terminal" }))

/** Records `terminal_open_ms` once, at the first byte after Open terminal. */
const recordFirstByte = Effect.gen(function* () {
  const startedAt = yield* Ref.getAndSet((yield* TerminalStore).openedAt, undefined)
  if (startedAt !== undefined) yield* Metric.update(openMs, (yield* Clock.currentTimeMillis) - startedAt)
})

/** Lets go of the socket this tab holds. */
export const detach = Effect.flatMap(TerminalStore, (store) => FiberHandle.clear(store.attached))

/** What the person typed: sent while the terminal is open to them for writing, dropped otherwise. */
export const input = (data: string) =>
  Effect.gen(function* () {
    const connection = yield* Ref.get((yield* TerminalStore).connection)
    if (connection === undefined) return
    yield* connection.send(data)
    yield* Metric.update(Metric.withAttributes(bytes, { direction: "in" }), data.length)
  })

/** The frame's size: the shell follows the owner's. */
export const resize = (cols: number, rows: number) =>
  Effect.gen(function* () {
    const connection = yield* Ref.get((yield* TerminalStore).connection)
    if (connection !== undefined) yield* connection.resize(cols, rows)
  })
