/**
 * The gateway read path: served projections computed from the control plane.
 *
 * Every projection here is a fold over facts `@smthrs/control` already
 * publishes: `Control.list` for run and flow listings, `Control.watch` for a
 * run's ordered events. The gateway never opens the engine database, so a
 * projection served to a browser through a relay is the same projection a
 * local reader computes, and a projection cannot drift from the control plane
 * by reading a column the control plane does not expose.
 *
 * A snapshot brackets its journal read with run-summary reads and retries
 * when the summary changes. Rows and cursor share the resulting event buffer,
 * so a completion cannot be acknowledged with the preceding run status.
 *
 * A subscription is a snapshot followed by deltas. A delta recomputes the
 * selector's rows from the accumulated events rather than patching them: a
 * projection is a reproducible fold (`@smthrs/journal` `Projection`), and
 * recomputation is the only delta that cannot disagree with a fresh snapshot.
 * The two append-only projections, `run-events` and `transcript`, are the
 * exception: their rows never change once folded, so a delta carries only the
 * rows one event appended. The events are accumulated in the stream rather
 * than re-read, so following a run never re-reads history after reconciling
 * the initial cutoff.
 *
 * A workspace subscription follows every journal partition without a cursor.
 * The follower stores each retained run's last position and drops replay
 * through that cutoff. Sources and exclusion verdicts share the snapshot's
 * run ceiling; eviction discards a verdict together with its cursor state.
 * Events are gathered for a short window and folded into one frame, and each
 * run's rows are cached so a burst refolds only the runs whose journals grew.
 *
 * @since 1.0.0
 */
import type { Service as ControlService } from "@smthrs/control/Control"
import { Control } from "@smthrs/control/Control"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { GatewayError, settingRefusal } from "./GatewayError.ts"
import * as GatewayProjection from "./GatewayProjection.ts"
import * as GatewaySchema from "./GatewaySchema.ts"

/**
 * How often an idle subscription emits a keepalive frame.
 *
 * Plue's relay cuts an idle tunnel at 600 s (the deployed relay behavior), so a
 * quiet run must produce a frame well inside that window or the connection is
 * dropped and every follower reconnects. Thirty seconds leaves twenty
 * heartbeats of margin.
 *
 * @since 1.0.0
 * @category models
 */
export const heartbeatIntervalMillis = 30_000

/**
 * The most runs one workspace projection folds.
 *
 * A workspace projection reads one full journal per run, so the number of
 * runs it folds is bounded on purpose. This is the gateway's own ceiling, not
 * the control plane's default page size. It is 500 because that equals
 * `ControlSchema.maxPageSize`, letting the control plane satisfy the whole
 * gateway allowance in one page when it can.
 *
 * @since 1.0.0
 * @category models
 */
export const maxWorkspaceRuns = 500

/**
 * The most journal events one run projection admits.
 *
 * @since 1.0.0
 * @category models
 */
export const maxEventsPerRun = 10_000

/**
 * The largest encoded event history or projected row set one run admits.
 *
 * @since 1.0.0
 * @category models
 */
export const maxProjectionBytes = 4 * 1024 * 1024

/**
 * How long a workspace follower gathers events before folding one delta.
 *
 * A workspace delta replaces every row, so its cost is the whole workspace,
 * not the one event that arrived. Gathering a burst into one frame bounds the
 * frame rate at twenty per second however many runs journal at once, and
 * fifty milliseconds is below what a dashboard reader can notice.
 */
const workspaceDeltaCoalesceMillis = 50

/** The most events one workspace batch gathers before folding inside the window. */
const workspaceDeltaBatchSize = 1_024

/**
 * Read-path operations served by the gateway.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  /**
   * Current rows, or only run-events rows after an issued cursor.
   *
   * A literal selector keeps its own row type, so an approvals reader reads
   * `requestId` and a run-tree reader reads `nodeId` without an assertion. A
   * selector chosen at runtime still answers with the snapshot union.
   */
  readonly snapshot: <S extends GatewaySchema.ProjectionSelector>(
    selector: S,
    after?: GatewaySchema.ProjectionCursor | undefined
  ) => Effect.Effect<GatewaySchema.SnapshotOf<S>, GatewayError>
  /**
   * A snapshot followed by recomputed deltas and keepalive frames, or, when
   * `after` names a cursor this selector issued, the deltas after it alone.
   *
   * The row and delta frames are the selector's own, on the same rule as
   * `snapshot`.
   */
  readonly subscribe: <S extends GatewaySchema.ProjectionSelector>(
    selector: S,
    after?: GatewaySchema.ProjectionCursor | undefined
  ) => Stream.Stream<GatewaySchema.FrameOf<S>, GatewayError>
}

/**
 * The gateway read path.
 *
 * @since 1.0.0
 * @category services
 */
export class Projections extends Context.Service<Projections, Service>()("@smthrs/gateway/Projections") {}

/**
 * The part of a control-plane failure a client is allowed to see: the failure's
 * tag and its stable code, never its message, its nested cause, or the SQL and
 * file paths a `PersistenceError` carries.
 *
 * Server logs carry only an operation identifier and an allowlisted summary.
 * `GatewayError` is the RPC error schema, so anything left on it is serialized
 * to every bearer holder and
 * forwarded to the browser by the product relay, and a cause JSON cannot encode
 * would make the error frame itself fail to encode.
 */
const summarize = (cause: unknown): { readonly _tag: string; readonly code?: string } | undefined => {
  const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : undefined
  if (record === undefined || typeof record._tag !== "string") return undefined
  return typeof record.code === "string" ? { _tag: record._tag, code: record.code } : { _tag: record._tag }
}

/** Log only known control-plane identifiers, never arbitrary backend text. */
const logReadFailure = (
  operation: "list-runs" | "read-events" | "follow-run" | "follow-workspace",
  cause: unknown
) => {
  const summary = summarize(cause)
  const known = summary?._tag === "/control/PersistenceError" && summary.code === "persistence_failed" ||
    summary?._tag === "/control/Unavailable" && summary.code === "unavailable"
  return Effect.logWarning({ operation, ...(known ? summary : {}) })
}

/** The read failed, with only a public error summary. */
const unavailable = (message: string, cause: unknown): GatewayError => {
  const summary = summarize(cause)
  return new GatewayError({
    code: "run_unavailable",
    message,
    ...(summary === undefined ? {} : { cause: summary })
  })
}

/** The request named something the control plane cannot serve. */
const malformed = (message: string): GatewayError => new GatewayError({ code: "malformed_request", message })

/** A projection exceeded the bounded read or wire budget. */
const resourceLimit = (message: string): GatewayError => new GatewayError({ code: "resource_limit", message })

/** The run a selector is scoped to, or undefined for a workspace selector. */
const scopeOf = (selector: GatewaySchema.ProjectionSelector): string | undefined =>
  "runId" in selector ? selector.runId : undefined

interface CursorPosition {
  readonly value: number
  readonly offset: number
}

interface EventBuffer {
  readonly events: Array<ControlSchema.ControlEvent>
  readonly encodedBytes: number
  readonly lastPosition: CursorPosition
}

const emptyEventBuffer = (): EventBuffer => ({ events: [], encodedBytes: 2, lastPosition: { value: 0, offset: 0 } })

const textEncoder = new TextEncoder()

const decodeEvent = Schema.decodeUnknownSync(ControlSchema.ControlEvent)
const decodeFrame = Schema.decodeUnknownSync(GatewaySchema.GatewayFrame)
const decodeSnapshot = Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)

const decodedEvent = (
  candidate: unknown,
  message: string
): Effect.Effect<ControlSchema.ControlEvent, GatewayError> =>
  Effect.suspend(() => {
    try {
      const event = decodeEvent(candidate)
      return Number.isSafeInteger(event.sequence) && event.sequence >= 0
        ? Effect.succeed(event)
        : Effect.fail(unavailable(message, undefined))
    } catch (cause) {
      return Effect.fail(unavailable(message, cause))
    }
  })

const appendEvent = (
  state: EventBuffer,
  candidate: unknown,
  message: string
): Effect.Effect<EventBuffer, GatewayError> =>
  Effect.flatMap(decodedEvent(candidate, message), (event) => {
    if (state.events.length > 0 && event.sequence < state.lastPosition.value) {
      return Effect.fail(unavailable(message, undefined))
    }
    // `decodedEvent` has already rebuilt payload through `Schema.Json`, so it
    // contains neither accessors nor `toJSON` hooks and JSON encoding cannot
    // execute caller code here.
    const bytes = textEncoder.encode(JSON.stringify(event)).byteLength
    const count = state.events.length + 1
    const encodedBytes = state.encodedBytes + bytes + (state.events.length === 0 ? 0 : 1)
    if (count > maxEventsPerRun) {
      return Effect.fail(resourceLimit(`Run event history exceeds ${maxEventsPerRun} events`))
    }
    if (!Number.isSafeInteger(encodedBytes) || encodedBytes > maxProjectionBytes) {
      return Effect.fail(resourceLimit(`Run event history exceeds ${maxProjectionBytes} encoded bytes`))
    }
    const offset = state.events.length > 0 && event.sequence === state.lastPosition.value
      ? state.lastPosition.offset + 1
      : 0
    state.events.push(event)
    return Effect.succeed({
      events: state.events,
      encodedBytes,
      lastPosition: { value: event.sequence, offset }
    })
  })

const bufferOf = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  message: string
): Effect.Effect<EventBuffer, GatewayError> =>
  events.reduce(
    (state, event) => Effect.flatMap(state, (buffer) => appendEvent(buffer, event, message)),
    Effect.succeed(emptyEventBuffer()) as Effect.Effect<EventBuffer, GatewayError>
  )

const cursorOf = (
  selector: GatewaySchema.ProjectionSelector,
  position: CursorPosition
): GatewaySchema.ProjectionCursor => ({
  selector,
  projection: selector._tag,
  runId: scopeOf(selector) ?? null,
  value: position.value,
  offset: position.offset
})

const comparePosition = (left: CursorPosition, right: CursorPosition): number =>
  left.value === right.value ? left.offset - right.offset : left.value - right.value

const positionedEvents = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<{ readonly event: ControlSchema.ControlEvent; readonly position: CursorPosition }> => {
  let sequence = -1
  let offset = 0
  return events.map((event) => {
    offset = event.sequence === sequence ? offset + 1 : 0
    sequence = event.sequence
    return { event, position: { value: sequence, offset } }
  })
}

const sameSelector = (
  left: GatewaySchema.ProjectionSelector,
  right: GatewaySchema.ProjectionSelector
): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case "workspace-runs":
      return true
    case "approvals":
      return left.runId === (right as GatewaySchema.ApprovalsSelector).runId
    case "node-output": {
      const candidate = right as GatewaySchema.NodeOutputSelector
      return left.runId === candidate.runId && left.nodeId === candidate.nodeId
    }
    default:
      return left.runId === (right as GatewaySchema.RunSummarySelector).runId
  }
}

/** One run and the journal it has committed, read together and read once. */
interface RunSource extends EventBuffer {
  readonly run: ControlSchema.RunSummary
}

/** Everything a selector folds, read once per snapshot. */
type Source =
  | { readonly _tag: "run"; readonly run: RunSource }
  | { readonly _tag: "workspace"; readonly runs: ReadonlyArray<RunSource> }

/**
 * The rows one run contributes to a selector.
 *
 * Pure and total over facts already read: it never reads the control plane, so
 * a delta folded from accumulated events and a fresh snapshot compute the same
 * rows from the same events. `workspace-runs` appears here because a workspace
 * listing is one summary row per run, folded by this same function.
 */
const rowsOfRun = (
  selector: GatewaySchema.ProjectionSelector,
  source: {
    readonly run: ControlSchema.RunSummary
    readonly events: ReadonlyArray<ControlSchema.ControlEvent>
  }
): ReadonlyArray<unknown> => {
  switch (selector._tag) {
    case "workspace-runs":
    case "run-summary":
      return [GatewayProjection.runSummary(source.run, source.events)]
    case "run-tree":
      return GatewayProjection.runTree(source.run, source.events)
    case "run-events":
      return source.events
    case "transcript":
      return GatewayProjection.transcript(source.events)
    case "approvals":
      return GatewayProjection.approvals(source.events)
    case "node-output":
      return GatewayProjection.nodeOutput(source.events).filter((row) => row.nodeId === selector.nodeId)
  }
}

/** Turns opened so far, for numbering appended transcript rows without a refold. */
const turnsOpened = (events: ReadonlyArray<ControlSchema.ControlEvent>): number =>
  GatewayProjection.transcript(events).at(-1)?.turn ?? 0

/**
 * The transcript rows one appended event contributes.
 *
 * A transcript row is immutable once folded and only the turn counter carries
 * across events, so folding the one event and offsetting its turn produces
 * exactly the rows a full refold would append.
 */
const transcriptAppend = (
  event: ControlSchema.ControlEvent,
  turnsBefore: number
): ReadonlyArray<GatewayProjection.TranscriptRow> =>
  GatewayProjection.transcript([event]).map((row) => ({ ...row, turn: row.turn + turnsBefore }))

/** Snapshot and follow admit exactly the same runs to the workspace inbox. */
const eligibleForWorkspace = (selector: GatewaySchema.ProjectionSelector, source: RunSource): boolean =>
  selector._tag !== "approvals" ||
  source.run.status === "waiting-approval" &&
    GatewayProjection.approvals(source.events).some((row) => row.status === "pending")

/**
 * The rows a workspace selector projects across every run it read.
 *
 * The approvals inbox is the exception: a run card wants a run's decided gates
 * too, but an inbox wants only what a human still owes an answer to.
 */
const rowsOfWorkspace = (
  selector: GatewaySchema.ProjectionSelector,
  runs: ReadonlyArray<RunSource>
): ReadonlyArray<unknown> =>
  selector._tag === "approvals"
    ? runs.flatMap((source) => GatewayProjection.approvals(source.events).filter((row) => row.status === "pending"))
    : runs.flatMap((source) => rowsOfRun(selector, source))

/** The rows a selector projects from the facts one read produced. */
const rowsOf = (
  selector: GatewaySchema.ProjectionSelector,
  source: Source
): ReadonlyArray<unknown> =>
  source._tag === "run" ? rowsOfRun(selector, source.run) : rowsOfWorkspace(selector, source.runs)

const boundedRows = (
  selector: GatewaySchema.ProjectionSelector,
  candidate: unknown
): Effect.Effect<ReadonlyArray<unknown>, GatewayError> =>
  Effect.suspend(() => {
    try {
      const schema = Schema.Array(GatewaySchema.rowSchemaFor(selector))
      const rows = Schema.decodeUnknownSync(schema)(candidate) as ReadonlyArray<unknown>
      const encoded = Schema.encodeUnknownSync(schema)(rows)
      const bytes = textEncoder.encode(JSON.stringify(encoded)).byteLength
      return bytes <= maxProjectionBytes
        ? Effect.succeed(rows)
        : Effect.fail(resourceLimit(`Projection rows exceed ${maxProjectionBytes} encoded bytes`))
    } catch (cause) {
      return Effect.fail(unavailable("Projection produced invalid rows", cause))
    }
  })

const frameOf = (candidate: unknown): Effect.Effect<GatewaySchema.GatewayFrame, GatewayError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decodeFrame(candidate))
      /* v8 ignore next -- rows, selectors, cursors, and tags were admitted before this internal assembly step. */
    } catch (cause) {
      /* v8 ignore next -- the assembled frame consists only of already-admitted fields. */
      return Effect.fail(unavailable("Projection produced an invalid frame", cause))
    }
  })

const snapshotOf = (candidate: unknown): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decodeSnapshot(candidate))
      /* v8 ignore next -- boundedRows and cursorOf admit every field before this internal assembly step. */
    } catch (cause) {
      /* v8 ignore next -- the assembled snapshot consists only of already-admitted fields. */
      return Effect.fail(unavailable("Projection produced an invalid snapshot", cause))
    }
  })

/**
 * The cursor the read reached.
 *
 * A run's cursor is the last sequence its journal committed, taken from the
 * same array the rows were folded from. A workspace cursor is `0`: control
 * journal sequences belong to per-run partitions (`@smthrs/control`
 * `ControlLive.streamForRun` and `snapshotHighWater` are keyed by `runId`), so
 * there is no workspace-wide sequence to advertise and no workspace resume.
 */
const cursorPositionOf = (source: Source): CursorPosition =>
  source._tag === "run" ? source.run.lastPosition : { value: 0, offset: 0 }

/** Implements a read path after its construction settings have been admitted. */
const makeService = (control: ControlService, heartbeatMillis: number): Service => {
  /** Every committed event of one run, oldest first. */
  const eventsOf = (runId: string): Effect.Effect<EventBuffer, GatewayError> => {
    const message = `Reading the events of ${runId} failed`
    return Stream.runFoldEffect(
      control.watch({ runId, follow: false }).pipe(
        Stream.tapError((cause) => logReadFailure("read-events", cause)),
        Stream.mapError((cause) => unavailable(message, cause))
      ),
      emptyEventBuffer,
      (buffer, event) => appendEvent(buffer, event, `${message}: the control plane returned an invalid event`)
    )
  }

  const runsMatching = (
    filters: { readonly runId?: string; readonly status?: ControlSchema.RunStatus }
  ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> => {
    const singleRun = filters.runId !== undefined
    const ceiling = singleRun ? 1 : maxWorkspaceRuns
    const page = (
      accumulated: ReadonlyArray<ControlSchema.RunSummary>,
      seen: Set<string>,
      cursor?: string | undefined
    ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> => {
      const remaining = ceiling - accumulated.length
      return control.list({
        _tag: "runs",
        filters,
        limit: remaining,
        ...(cursor === undefined ? {} : { cursor })
      }).pipe(
        Effect.tapError((cause) => logReadFailure("list-runs", cause)),
        Effect.mapError((cause) => unavailable("Listing runs failed", cause)),
        Effect.flatMap((response) => {
          if (response._tag !== "runs") return Effect.succeed(accumulated)
          const ids = new Set(accumulated.map((run) => run.runId))
          const added = response.items.filter((run) => {
            if (ids.has(run.runId)) return false
            ids.add(run.runId)
            return true
          }).slice(0, remaining)
          const runs = [...accumulated, ...added]
          if (
            singleRun || added.length === 0 || response.nextCursor === undefined ||
            runs.length >= ceiling || seen.has(response.nextCursor)
          ) return Effect.succeed(runs)
          seen.add(response.nextCursor)
          // Each continued page adds at least one run, so the run ceiling
          // also caps the number of pages at maxWorkspaceRuns.
          return page(runs, seen, response.nextCursor)
        })
      )
    }
    return Effect.suspend(() => page([], new Set()))
  }

  /**
   * The one run a run-scoped selector names, or a typed refusal.
   *
   * Every run-scoped selector goes through here, so an unknown run id is
   * refused the same way for all of them. Reading a run's events alone cannot
   * tell an unknown run from a run with no events: `@smthrs/control`
   * `ControlLive.snapshotForRun` answers an empty stream for both.
   */
  const runOf = (runId: string): Effect.Effect<ControlSchema.RunSummary, GatewayError> =>
    runsMatching({ runId }).pipe(
      Effect.flatMap((runs) => {
        const run = runs.find((candidate) => candidate.runId === runId)
        return run === undefined
          ? Effect.fail(new GatewayError({ code: "run_not_found", message: `No run ${runId}` }))
          : Effect.succeed(run)
      })
    )

  /** Pin the journal between equal summaries; refuse a continuously moving row. */
  const consistentRunSource = (
    before: ControlSchema.RunSummary,
    attempts = 8
  ): Effect.Effect<RunSource, GatewayError> =>
    Effect.gen(function*() {
      const buffer = yield* eventsOf(before.runId)
      const run = yield* runOf(before.runId)
      if (JSON.stringify(before) === JSON.stringify(run)) return { run, ...buffer }
      if (attempts === 1) return yield* Effect.fail(unavailable("Run changed throughout the snapshot read", undefined))
      return yield* consistentRunSource(run, attempts - 1)
    })

  /** One run and its journal at a reconciled cutoff. */
  const runSourceOf = (runId: string): Effect.Effect<RunSource, GatewayError> =>
    Effect.flatMap(runOf(runId), (run) => consistentRunSource(run))

  /** Every run a workspace selector folds, and each one's journal. */
  const workspaceSourceOf = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<ReadonlyArray<RunSource>, GatewayError> =>
    Effect.flatMap(
      // The inbox asks the control plane which runs are parked rather than
      // reading every run's journal to find out.
      runsMatching(selector._tag === "approvals" ? { status: "waiting-approval" } : {}),
      (runs) =>
        Effect.map(
          Effect.forEach(runs, (run) => consistentRunSource(run), { concurrency: 8 }),
          (sources) => sources.filter((source) => eligibleForWorkspace(selector, source))
        )
    )

  /** The reconciled source a snapshot folds. */
  const sourceOf = (selector: GatewaySchema.ProjectionSelector): Effect.Effect<Source, GatewayError> => {
    const runId = scopeOf(selector)
    return runId === undefined
      ? Effect.map(workspaceSourceOf(selector), (runs) => ({ _tag: "workspace" as const, runs }))
      : Effect.map(runSourceOf(runId), (run) => ({ _tag: "run" as const, run }))
  }

  const snapshot = (
    selector: GatewaySchema.ProjectionSelector,
    after?: GatewaySchema.ProjectionCursor | undefined
  ): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
    Effect.gen(function*() {
      if (after !== undefined) {
        if (selector._tag !== "run-events") {
          return yield* malformed("Only run-events snapshots accept an after cursor")
        }
        const scope = resumeScope(selector, after)
        if (typeof scope !== "string") return yield* scope
      }
      const source = yield* sourceOf(selector)
      const position = cursorPositionOf(source)
      if (after !== undefined && comparePosition(after, position) > 0) {
        return yield* malformed("A snapshot cursor cannot be ahead of the run's journal")
      }
      const projected = after !== undefined && source._tag === "run"
        ? positionedEvents(source.run.events)
          .filter((entry) => comparePosition(entry.position, after) > 0)
          .map((entry) => entry.event)
        : rowsOf(selector, source)
      const rows = yield* boundedRows(selector, projected)
      return yield* snapshotOf({ selector, cursor: cursorOf(selector, position), rows })
    })

  const snapshotFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    rows: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<GatewaySchema.GatewayFrame>, GatewayError> => {
    const cursor = cursorOf(selector, cursorPositionOf(source))
    return Effect.forEach([
      { _tag: "snapshot-start", selector, cursor },
      ...rows.map((row) => ({ _tag: "row", selector, cursor, row })),
      { _tag: "snapshot-end", selector, cursor }
    ], frameOf)
  }

  /**
   * The rows one delta carries.
   *
   * `run-events`' rows are the ordered events themselves, so its delta is the
   * one event that arrived. `transcript` rows are immutable once folded, so
   * its delta is the rows that event appended, numbered after the turns the
   * follower has already counted. Every other selector answers a full
   * replacement folded from the accumulated events, because recomputation is
   * the only delta that cannot disagree with a fresh snapshot. Only the two
   * selectors whose rows read the run row re-read it: a fenced status write
   * does not always journal an event, so their status would otherwise lag.
   */
  const deltaRows = (
    selector: GatewaySchema.ProjectionSelector,
    run: ControlSchema.RunSummary,
    event: ControlSchema.ControlEvent,
    events: ReadonlyArray<ControlSchema.ControlEvent>,
    turnsBefore: number
  ): Effect.Effect<ReadonlyArray<unknown>, GatewayError> => {
    if (selector._tag === "run-events") return Effect.succeed([event])
    if (selector._tag === "transcript") return Effect.succeed(transcriptAppend(event, turnsBefore))
    if (selector._tag === "run-summary" || selector._tag === "run-tree") {
      return Effect.map(runOf(run.runId), (fresh) => rowsOfRun(selector, { run: fresh, events }))
    }
    return Effect.succeed(rowsOfRun(selector, { run, events }))
  }

  interface RunFollowState {
    readonly buffer: EventBuffer
    readonly observed: CursorPosition | undefined
    /** Turns the transcript has opened so far; zero for every other selector. */
    readonly turns: number
  }

  interface RunDelta {
    readonly event: ControlSchema.ControlEvent
    readonly events: ReadonlyArray<ControlSchema.ControlEvent>
    readonly position: CursorPosition
    readonly turnsBefore: number
  }

  /**
   * Deltas for one run, following from `from` and folding over the events the
   * caller already read plus each event that arrives.
   *
   * Nothing here re-reads the journal. Re-reading the history for every event
   * made a subscription quadratic in run length and re-sent the whole log on
   * each frame, which is the opposite of what a follower asked for.
   */
  const runDeltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: RunSource,
    from: CursorPosition
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    const runId = source.run.runId
    const message = `Following ${runId} failed`
    const seedEvents = positionedEvents(source.events)
      .filter(({ position }) => comparePosition(position, from) <= 0)
      .map(({ event }) => event)
    const seed = comparePosition(from, source.lastPosition) === 0
      ? Effect.succeed<EventBuffer>({
        events: source.events,
        encodedBytes: source.encodedBytes,
        lastPosition: source.lastPosition
      })
      : bufferOf(seedEvents, `${message}: the cursor seed is invalid`)
    return Stream.unwrap(Effect.map(seed, (initial) =>
      control.watch({
        runId,
        // Sequence zero also needs replay for empty seeds and derived offsets.
        ...(from.value === 0 ? {} : { afterSequence: from.value - 1 }),
        follow: true
      }).pipe(
        Stream.tapError((cause) => logReadFailure("follow-run", cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.mapAccumEffect(
          (): RunFollowState => ({
            buffer: initial,
            observed: undefined,
            turns: selector._tag === "transcript" ? turnsOpened(initial.events) : 0
          }),
          (state, candidate): Effect.Effect<
            readonly [RunFollowState, ReadonlyArray<RunDelta>],
            GatewayError
          > =>
            Effect.flatMap(
              decodedEvent(candidate, `${message}: the control plane returned an invalid event`),
              (event) => {
                if (state.observed !== undefined && event.sequence < state.observed.value) {
                  return Effect.fail(unavailable(`${message}: event sequences moved backward`, undefined))
                }
                const position: CursorPosition = {
                  value: event.sequence,
                  offset: state.observed?.value === event.sequence ? state.observed.offset + 1 : 0
                }
                const nextState: RunFollowState = { ...state, observed: position }
                if (seedEvents.length > 0 && comparePosition(position, from) <= 0) {
                  return Effect.succeed([nextState, [] as ReadonlyArray<RunDelta>] as const)
                }
                const turnsBefore = state.turns
                const turns = selector._tag === "transcript"
                  ? transcriptAppend(event, turnsBefore).at(-1)?.turn ?? turnsBefore
                  : 0
                return Effect.map(
                  appendEvent(state.buffer, event, `${message}: event history is invalid`),
                  (buffer) =>
                    [
                      { buffer, observed: position, turns } satisfies RunFollowState,
                      [{ event, events: buffer.events, position, turnsBefore }] satisfies ReadonlyArray<RunDelta>
                    ] as const
                )
              }
            )
        ),
        Stream.mapEffect(({ event, events, position, turnsBefore }) =>
          Effect.flatMap(deltaRows(selector, source.run, event, events, turnsBefore), (rows) =>
            Effect.flatMap(boundedRows(selector, rows), (delta) =>
              frameOf({
                _tag: "delta",
                selector,
                cursor: cursorOf(selector, position),
                delta
              })))
        )
      )))
  }

  /**
   * Workspace deltas from the unscoped control follow.
   *
   * Control sequences belong to run partitions, so this stream cannot start
   * after one workspace cursor. It follows without a cursor instead. That
   * replays partition history, and the sources seeded from the snapshot drop
   * events through each run's last folded position. Excluded runs retain only
   * a verdict and replay positions, sharing the source ceiling. Their replay
   * costs no further journal reads until the verdict is evicted.
   *
   * Events are gathered for `workspaceDeltaCoalesceMillis` and admitted as one
   * batch. A batch re-reads each changed run's row once, refolds only those
   * runs' cached rows, and answers one frame, so a burst across many runs
   * costs one frame and one row read per run that changed.
   */
  const workspaceDeltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    runs: ReadonlyArray<RunSource>
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.unwrap(Effect.sync(() => {
      interface FollowedSource {
        source: RunSource
        observed: CursorPosition | undefined
        /** This run's rows, folded when its journal grows rather than on every frame. */
        rows: ReadonlyArray<unknown>
      }
      interface JudgedRun {
        readonly lastPosition: CursorPosition | undefined
        observed: CursorPosition
      }
      const rowsOfSource = (source: RunSource): ReadonlyArray<unknown> => rowsOfWorkspace(selector, [source])
      const sources = new Map<string, FollowedSource>(runs.map((source) => [
        source.run.runId,
        { source, observed: undefined, rows: rowsOfSource(source) }
      ]))
      // A verdict retains no journal. Undefined lastPosition means run_not_found.
      // Sources and verdicts share one ceiling; only verdicts may be evicted.
      const judged = new Map<string, JudgedRun>()
      const makeRoom = () => {
        if (sources.size + judged.size >= maxWorkspaceRuns) {
          // Callers have room for a source, so a full cache has a verdict.
          judged.delete(judged.keys().next().value!)
        }
      }
      const remember = (runId: string, lastPosition: CursorPosition | undefined, observed: CursorPosition) => {
        judged.delete(runId)
        makeRoom()
        judged.set(runId, { lastPosition, observed })
      }
      const noFrames: ReadonlyArray<GatewaySchema.GatewayFrame> = []
      const delta = (): Effect.Effect<ReadonlyArray<GatewaySchema.GatewayFrame>, GatewayError> =>
        Effect.flatMap(
          boundedRows(selector, [...sources.values()].flatMap(({ rows }) => rows)),
          (rows) =>
            Effect.map(
              frameOf({
                _tag: "delta",
                selector,
                cursor: cursorOf(selector, { value: 0, offset: 0 }),
                delta: rows
              }),
              (frame) => [frame]
            )
        )
      const message = "Following the workspace failed"
      /**
       * What one admitted event did to the retained state: nothing a frame
       * must report, a change already folded, or a change to a followed run
       * whose row must be re-read before its rows are refolded.
       */
      type Admission = "unchanged" | "fresh" | "stale"
      const admit = (event: ControlSchema.ControlEvent): Effect.Effect<Admission, GatewayError> =>
        Effect.gen(function*() {
          const runId = event.runId
          if (runId === undefined) return "unchanged"
          const current = sources.get(runId)
          const verdict = judged.get(runId)
          const previous = current?.observed ?? verdict?.observed
          if (previous !== undefined && event.sequence < previous.value) {
            return yield* Effect.fail(unavailable(`${message}: event sequences moved backward`, undefined))
          }
          const position: CursorPosition = {
            value: event.sequence,
            offset: previous?.value === event.sequence ? previous.offset + 1 : 0
          }
          if (current !== undefined) {
            current.observed = position
            if (
              current.source.events.length > 0 && comparePosition(position, current.source.lastPosition) <= 0
            ) return "unchanged"
            const buffer = yield* appendEvent(current.source, event, `${message}: event history is invalid`)
            current.source = { run: current.source.run, ...buffer }
            return "stale"
          }
          if (verdict !== undefined) {
            verdict.observed = position
            if (verdict.lastPosition === undefined || comparePosition(position, verdict.lastPosition) <= 0) {
              return "unchanged"
            }
          }
          if (sources.size >= maxWorkspaceRuns) return "unchanged"
          return yield* runSourceOf(runId).pipe(
            Effect.flatMap((source) => {
              const admitted = source.events.length > 0 && comparePosition(position, source.lastPosition) <= 0
                ? Effect.succeed(source)
                : Effect.map(
                  appendEvent(source, event, `${message}: event history is invalid`),
                  (buffer): RunSource => ({ run: source.run, ...buffer })
                )
              return Effect.map(admitted, (complete): Admission => {
                if (!eligibleForWorkspace(selector, complete)) {
                  remember(runId, complete.lastPosition, position)
                  return "unchanged"
                }
                judged.delete(runId)
                makeRoom()
                sources.set(runId, { source: complete, observed: position, rows: rowsOfSource(complete) })
                return "fresh"
              })
            }),
            Effect.catchIf(
              (failure) => failure.code === "run_not_found",
              () => {
                remember(runId, undefined, position)
                return Effect.succeed<Admission>("unchanged")
              }
            )
          )
        })
      /** Re-read one grown run's row, then refold its rows or exclude it. */
      const refresh = (runId: string): Effect.Effect<void, GatewayError> =>
        Effect.gen(function*() {
          const current = sources.get(runId)
          /* v8 ignore next -- only runs still followed after the batch are refreshed. */
          if (current === undefined || current.observed === undefined) return
          const fresh = yield* runOf(runId)
          const source: RunSource = { ...current.source, run: fresh }
          if (eligibleForWorkspace(selector, source)) {
            current.source = source
            current.rows = rowsOfSource(source)
          } else {
            sources.delete(runId)
            remember(runId, source.lastPosition, current.observed)
          }
        })
      return control.watch({ follow: true }).pipe(
        Stream.tapError((cause) => logReadFailure("follow-workspace", cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.groupedWithin(workspaceDeltaBatchSize, workspaceDeltaCoalesceMillis),
        Stream.mapEffect((batch) =>
          Effect.gen(function*() {
            const stale = new Set<string>()
            let changed = false
            for (const candidate of batch) {
              const event = yield* decodedEvent(candidate, `${message}: the control plane returned an invalid event`)
              const admission = yield* admit(event)
              if (admission === "unchanged") continue
              changed = true
              if (admission === "stale" && event.runId !== undefined) stale.add(event.runId)
            }
            yield* Effect.forEach(stale, refresh, { discard: true })
            return changed ? yield* delta() : noFrames
          })
        ),
        Stream.flattenIterable
      )
    }))

  /**
   * Deltas for a selector.
   *
   * A run selector follows after its sequence cursor. A workspace selector has
   * no resume cursor because control journal sequences belong to per-run
   * partitions, but it can follow every partition without one.
   */
  const deltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    from: CursorPosition
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    source._tag === "workspace"
      ? workspaceDeltaFrames(selector, source.runs)
      : runDeltaFrames(selector, source.run, from)

  /**
   * The keepalive channel. `Stream.tick` emits immediately and then on the
   * interval, and an immediate keepalive would arrive before the snapshot it
   * is supposed to keep alive; dropping the first tick makes the cadence what
   * it says it is.
   */
  const heartbeats: Stream.Stream<GatewaySchema.GatewayFrame> = Stream.tick(heartbeatMillis).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(Effect.clockWith((clock) => clock.currentTimeMillis), (atMs) => ({
        _tag: "heartbeat" as const,
        atMs
      }))
    )
  )

  /** The run a cursor resumes, or the refusal explaining why it resumes none. */
  const resumeScope = (
    selector: GatewaySchema.ProjectionSelector,
    after: GatewaySchema.ProjectionCursor
  ): string | GatewayError => {
    const candidate = after as unknown as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.value) || (candidate.value as number) < 0) {
      return malformed(
        `Cursor value ${String(candidate.value)} must be a non-negative safe integer`
      )
    }
    if (!Number.isSafeInteger(candidate.offset) || (candidate.offset as number) < 0) {
      return malformed(
        `Cursor offset ${String(candidate.offset)} must be a non-negative safe integer`
      )
    }
    if (!Schema.is(GatewaySchema.ProjectionCursor)(after)) {
      return malformed("The projection cursor is not a valid gateway cursor")
    }
    const runId = scopeOf(selector)
    if (after.projection !== selector._tag) {
      return malformed(
        `A cursor for the ${after.projection} projection cannot resume a ${selector._tag} subscription`
      )
    }
    if (!sameSelector(after.selector, selector)) {
      return malformed("A cursor can resume only the exact selector that issued it")
    }
    if (runId === undefined) {
      return malformed(
        `A ${selector._tag} subscription has no resumable cursor, because control journal sequences belong to per-run partitions`
      )
    }
    if (after.runId !== runId) {
      return malformed(`A cursor for run ${after.runId ?? "none"} cannot resume a subscription to run ${runId}`)
    }
    return runId
  }

  /** Snapshot and follow share the reconciled event buffer. */
  const fromSnapshot = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>, GatewayError> =>
    Effect.flatMap(
      sourceOf(selector),
      (source) =>
        Effect.flatMap(boundedRows(selector, rowsOf(selector, source)), (rows) =>
          Effect.map(snapshotFrames(selector, source, rows), (frames) =>
            Stream.concat(
              Stream.fromIterable(frames),
              deltaFrames(selector, source, cursorPositionOf(source))
            )))
    )

  /**
   * The deltas after a cursor the client already holds, with no snapshot.
   *
   * The read still happens: a folded projection cannot be recomputed from the
   * events after the cursor alone. What the client skips is receiving rows it
   * already has.
   */
  const fromCursor = (
    selector: GatewaySchema.ProjectionSelector,
    after: GatewaySchema.ProjectionCursor
  ): Effect.Effect<Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>, GatewayError> => {
    const scope = resumeScope(selector, after)
    return typeof scope === "string"
      ? Effect.flatMap(runSourceOf(scope), (source) => {
        const position = { value: after.value, offset: after.offset }
        const last = source.lastPosition
        if (comparePosition(position, last) > 0) {
          return Effect.fail(malformed(
            `Cursor ${after.value}:${after.offset} cannot resume run ${scope} past its last position ${last.value}:${last.offset}`
          ))
        }
        const issued = position.value === 0 && position.offset === 0 ||
          positionedEvents(source.events).some((candidate) => comparePosition(candidate.position, position) === 0)
        return !issued
          ? Effect.fail(malformed(
            `Cursor ${after.value}:${after.offset} was not issued by run ${scope}`
          ))
          : Effect.succeed(runDeltaFrames(selector, source, position))
      })
      : Effect.fail(scope)
  }

  const subscribe = (
    selector: GatewaySchema.ProjectionSelector,
    after?: GatewaySchema.ProjectionCursor | undefined
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.merge(
      Stream.unwrap(after === undefined ? fromSnapshot(selector) : fromCursor(selector, after)),
      heartbeats,
      { haltStrategy: "left" }
    )

  /*
   * The service is generic in its selector; the implementation folds every
   * selector through one code path and is not. The correlation the signature
   * promises is enforced at runtime rather than assumed: `boundedRows`
   * decodes each fold against `GatewaySchema.rowSchemaFor(selector)` and
   * fails the read when a row does not belong to the selector that asked.
   */
  return { snapshot, subscribe } as Service
}

/**
 * Builds the read path over a control plane.
 *
 * Invalid keepalive settings are returned as typed `bind_failed` failures;
 * construction never throws synchronously.
 *
 * @param control the control service to read through
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category constructors
 */
export const make = (
  control: ControlService,
  options: { readonly heartbeatMillis?: number | undefined } = {}
): Effect.Effect<Service, GatewayError> =>
  Effect.suspend(() => {
    const refusal = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis)
    return refusal === undefined
      ? Effect.succeed(makeService(control, options.heartbeatMillis ?? heartbeatIntervalMillis))
      : Effect.fail(refusal)
  })

/**
 * Provides the gateway read path over the ambient control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<Projections, GatewayError, Control> = Layer.effect(Projections)(
  Effect.flatMap(Control, (control) => make(control))
)

/**
 * Provides the gateway read path under an explicit keepalive cadence.
 *
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category layers
 */
export const layerWith = (
  options: { readonly heartbeatMillis?: number | undefined }
): Layer.Layer<Projections, GatewayError, Control> =>
  Layer.effect(Projections)(Effect.flatMap(Control, (control) => make(control, options)))
