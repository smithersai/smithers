import { actorSharedState } from "../ActorBindings"
/*
 * The target-graph controller (docs/LOCAL-APP.md "Cards: target graph"): the
 * chat commands' door to the five graph cards. `show graph` loads the typed
 * DAG into a graph card (focused on a label when one is named); a run started
 * while a graph card is up overlays its node frames live; `timeline` streams
 * one run's Gantt; `history` lists the recorded runs and selecting one
 * replays its events — the scrubber re-derives the timeline and the graph
 * overlay at the cursor; `affected` and `show ci` fill their cards from the
 * routes in @smthrs/rpc/TargetGraph TARGET_GRAPH_ROUTES. Every store
 * change goes through the dispatcher with its actor; while the backend's
 * routes land in parallel, an explicit dev flag (dev/fixtureRunStream.ts)
 * swaps the routes for the captured fixtures — never in the product path.
 */
import type { TargetRunFrame } from "@smthrs/rpc/LocalApp"
import type {
  AffectedResponse,
  CiMatrixResponse,
  NodeTiming,
  RunHistoryResponse,
  RunReplayResponse,
  RunSummary,
  TargetRunEvent
} from "@smthrs/rpc/TargetGraph"
import {
  AffectedResponseSchema,
  CiMatrixResponseSchema,
  RunHistoryResponseSchema,
  RunReplayResponseSchema,
  TARGET_GRAPH_ROUTES,
  TargetGraphResponseSchema
} from "@smthrs/rpc/TargetGraph"

import type { Card } from "../AppState"
import { resolveOpenRepo } from "../RepoContext"
import type { TargetRunClient } from "../TargetRunClient"
import type { TargetGraphDevFixtures } from "../../dev/fixtureRunStream"
import type { ControllerContext } from "./context"

export interface TargetGraphController {
  /** `show graph` / `graph <label>`: the DAG card, optionally focused on one label. */
  readonly showGraph: (repoId: string | undefined, label?: string) => Promise<string | void>
  /** The drawer's focus: pin the graph card on one label, or clear it when the label goes unnamed. */
  readonly focusGraph: (repoId: string | undefined, label?: string) => string | void
  /** The canvas' toolbar: the label filter and the private-node toggle, both in the card payload. */
  readonly filterGraph: (
    repoId: string | undefined,
    change: { readonly query?: string; readonly showPrivate?: boolean }
  ) => string | void
  /** `timeline [runId]`: one run's Gantt card, streamed live when the run is live. */
  readonly showTimeline: (repoId: string | undefined, runId?: string) => Promise<string | void>
  /** `history`: the recorded runs table. */
  readonly showHistory: (repoId: string | undefined) => Promise<string | void>
  /** A history row: replay the recorded run into a timeline card (with the scrubber) and the graph overlay. */
  readonly selectRun: (repoId: string | undefined, runId: string) => Promise<string | void>
  /** The scrubber: re-derive the timeline and the overlay at the cursor (time travel). */
  readonly scrubRun: (runId: string, cursor: number) => Promise<string | void>
  /** `affected`: the working-tree diff's changed files and the labels they re-key. */
  readonly showAffected: (repoId: string | undefined) => Promise<string | void>
  /** `show ci`: the generated GitHub workflows/jobs/matrix card. */
  readonly showCi: (repoId: string | undefined) => Promise<string | void>
  /** targets.runTarget's hook: a live run paints any graph card of its repo. */
  readonly noteRunStarted: (repoId: string, runId: string, label: string) => void
  /** The drawer's "open" affordance: hand the declaration site to the backend. */
  readonly openSource: (repoId: string, file: string, line?: number) => Promise<string | void>
}

export interface TargetGraphControllerDependencies {
  readonly nextOrdinal: () => number
  readonly runs: TargetRunClient
  /** Dev-only fixture seam (dev/fixtureRunStream.ts); undefined outside the explicit flag. */
  readonly devFixtures?: TargetGraphDevFixtures | undefined
}

export const graphCardId = (repoId: string): string => `graph-${repoId}`
export const runTimelineCardId = (runId: string): string => `run-timeline-${runId}`
export const runHistoryCardId = (repoId: string): string => `run-history-${repoId}`
export const affectedCardId = (repoId: string): string => `affected-${repoId}`
export const ciMatrixCardId = (repoId: string): string => `ci-${repoId}`

/*
 * A per-node log tail cap, matching controller/targets.ts: these logs ride in
 * a card payload, and card payloads are persisted, so a chatty node must not
 * grow the store without bound. The TAIL is what a human reads.
 */
const MAX_LOG_CHARS = 200_000
const capLog = (text: string): string => (text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text)

type ReplayState = {
  readonly nodes: Array<NodeTiming>
  readonly summary: RunSummary | undefined
  readonly logs: Record<string, string>
  readonly error: string | undefined
}
type Version<T> = { readonly at: number; readonly order: number; readonly value: T }

/* Keep histories once, not a full log tail at every checkpoint. Binary search
 * finds each label's cursor; only its last MAX_LOG_CHARS are joined. Untimed
 * frames inherit the preceding clock. Unordered clocks retain recording order
 * via a linear fallback, rather than silently changing replay semantics. */
const indexReplay = (events: ReadonlyArray<TargetRunEvent>) => {
  const nodes = new Map<string, Array<Version<NodeTiming>>>()
  const logs = new Map<string, Array<Version<string>>>()
  const summaries: Array<Version<RunSummary>> = []
  const errors: Array<Version<string>> = []
  const exits: Array<Version<string>> = []
  let clock = Number.NEGATIVE_INFINITY
  let ordered = true
  let bytes = 0
  let order = 0
  const append = <T>(history: Array<Version<T>>, value: T, size: number): void => {
    history.push({ at: clock, order: order++, value })
    bytes += 64 + size
  }
  const history = <T>(map: Map<string, Array<Version<T>>>, label: string): Array<Version<T>> => {
    let values = map.get(label)
    if (values === undefined) {
      values = []
      map.set(label, values)
      bytes += 64 + label.length * 2
    }
    return values
  }
  for (const event of events) {
    if ("at" in event) {
      if (event.at < clock) ordered = false
      clock = event.at
    }
    switch (event.type) {
      case "node": append(history(nodes, event.node.label), event.node, JSON.stringify(event.node).length * 2); break
      case "summary": append(summaries, event.summary, JSON.stringify(event.summary).length * 2); break
      case "error": append(errors, event.message, event.message.length * 2); break
      case "exit":
        if (event.code !== 0) {
          const message = event.code === null ? "The run ended without an exit code." : `The run exited ${event.code}.`
          append(exits, message, message.length * 2)
        }
        break
      case "stdout":
      case "stderr":
        if (event.label !== undefined) {
          const tail = capLog(event.data)
          // A sliced string may retain its source buffer. Charge the original
          // chunk so a huge frame cannot bypass the recording byte budget.
          const chunks = history(logs, event.label)
          // Preserve an empty attributed log, but do not index empty chunks
          // forever: they add no output and would make a tail scan unbounded.
          if (tail.length > 0 || chunks.length === 0 || !ordered) append(chunks, tail, event.data.length * 2)
        }
        break
    }
  }
  const last = <T>(values: Array<Version<T>>, cursor: number): number => {
    if (!ordered) {
      for (let i = values.length - 1; i >= 0; i--) if (values[i]!.at <= cursor) return i
      return -1
    }
    let lo = 0
    let hi = values.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (values[mid]!.at <= cursor) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }
  const atCursor = (cursor: number): ReplayState => {
    const visibleNodes: Array<{ node: NodeTiming; order: number }> = []
    for (const values of nodes.values()) {
      const value = values[last(values, cursor)]?.value
      if (value !== undefined) {
        const first = ordered ? values[0]! : values.find((entry) => entry.at <= cursor)!
        visibleNodes.push({ node: value, order: first.order })
      }
    }
    if (!ordered) visibleNodes.sort((a, b) => a.order - b.order)
    const visibleLogs: Array<[string, string]> = []
    for (const [label, values] of logs) {
      const end = last(values, cursor)
      if (end < 0) continue
      const chunks: string[] = []
      let remaining = MAX_LOG_CHARS
      for (let i = end; i >= 0 && remaining > 0; i--) {
        const chunk = values[i]!
        if (chunk.at > cursor) continue
        chunks.push(chunk.value.length > remaining ? chunk.value.slice(-remaining) : chunk.value)
        remaining -= chunk.value.length
      }
      visibleLogs.push([label, chunks.reverse().join("")])
    }
    const firstExit = ordered ? exits[0] : exits.find((exit) => exit.at <= cursor)
    return {
      nodes: visibleNodes.map((entry) => entry.node),
      summary: summaries[last(summaries, cursor)]?.value,
      logs: Object.fromEntries(visibleLogs),
      error: errors[last(errors, cursor)]?.value ?? (firstExit !== undefined && firstExit.at <= cursor ? firstExit.value : undefined)
    }
  }
  return { atCursor, bytes }
}

/** A standalone projection; controllers retain the index for subsequent scrubs. */
export const replayAtCursor = (events: ReadonlyArray<TargetRunEvent>, cursor: number): ReplayState =>
  indexReplay(events).atCursor(cursor)

const MAX_CACHED_RUNS = 16
const MAX_CACHE_BYTES = 16 * 1024 * 1024

/** Maps are ordered by last use; an oversize recording is projected but not retained. */
const trimCache = <T>(cache: Map<string, T>, size: (value: T) => number): void => {
  let bytes = 0
  for (const [key, value] of cache) {
    const retained = size(value)
    if (retained > MAX_CACHE_BYTES) cache.delete(key)
    else bytes += retained
  }
  for (const [key, value] of cache) {
    if (cache.size <= MAX_CACHED_RUNS && bytes <= MAX_CACHE_BYTES) break
    bytes -= size(value)
    cache.delete(key)
  }
}
const touch = <T>(cache: Map<string, T>, key: string): T | undefined => {
  const value = cache.get(key)
  if (value !== undefined) { cache.delete(key); cache.set(key, value) }
  return value
}

/** A live frame folds into the same per-run state the replay fold produces. */
export const foldRunFrame = (
  state: { nodes: Map<string, NodeTiming>; summary: RunSummary | undefined; logs: Map<string, string>; error?: string },
  frame: TargetRunFrame
): void => {
  if (frame.type === "node") state.nodes.set(frame.node.label, frame.node)
  else if (frame.type === "summary") state.summary = frame.summary
  else if (frame.type === "error") state.error = frame.message
  else if (frame.type === "exit" && frame.code !== 0 && state.error === undefined) state.error = frame.code === null ? "The run ended without an exit code." : `The run exited ${frame.code}.`
  else if ((frame.type === "stdout" || frame.type === "stderr") && "label" in frame && frame.label !== undefined) {
    state.logs.set(frame.label, capLog((state.logs.get(frame.label) ?? "") + frame.data))
  }
}

export const createTargetGraphController = (
  ctx: ControllerContext,
  dependencies: TargetGraphControllerDependencies
): TargetGraphController => {
  const { store, baseUrl } = ctx
  const { nextOrdinal, runs, devFixtures } = dependencies
  /** Recorded/replayed events per runId, for the scrubber. */
  const replayEvents = actorSharedState(ctx, "target-replays", () => new Map<string, ReturnType<typeof indexReplay>>())
  /** Live folds per runId, shared by the graph overlay and the timeline card. */
  const liveRuns = actorSharedState(ctx, "target-live-runs", () => new Map<string, { nodes: Map<string, NodeTiming>; summary: RunSummary | undefined; logs: Map<string, string>; error?: string }>())

  const completed = actorSharedState(ctx, "target-completed-runs", () => new Map<string, number>())
  const lifetime = actorSharedState(ctx, "target-graph-lifetime", () => ({ disposed: false }))
  const pendingScrubs = actorSharedState(ctx, "target-pending-scrubs", () => new Map<string, {
    cursor: number; promise: Promise<string | void>; cancel: () => void
  }>())

  const upsert = (card: Card): void => {
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
  }

  const patch = <K extends Card["kind"]>(
    id: string,
    kind: K,
    update: (card: Extract<Card, { kind: K }>) => { payload: Extract<Card, { kind: K }>["payload"]; status?: Card["status"] }
  ): void => {
    const existing = store.collections.cards.get(id)
    if (existing === undefined || existing.kind !== kind) return
    const next = update(existing as unknown as Extract<Card, { kind: K }>)
    // This helper replaces a projection. card.updated merges payload fields,
    // so explicitly clear omitted fields (notably summary/error on rewind).
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id,
      patch: {
        payload: { ...Object.fromEntries(Object.keys(existing.payload).filter((key) => !(key in next.payload)).map((key) => [key, undefined])), ...next.payload },
        ...(next.status === undefined ? {} : { status: next.status })
      }
    })
  }

  /** The repo a command names, or the one open repo when it goes unnamed. */
  /*
   * The repository a bare command means (RepoContext.ts resolveOpenRepo),
   * read from the repos collection. This used to read the transcript's repo
   * CARD, which opening no longer renders.
   */
  const resolveRepoId = (repoId: string | undefined): string | { readonly error: string } => {
    if (repoId !== undefined && repoId !== "") return repoId
    const open = resolveOpenRepo(store)
    return "repo" in open ? open.repo.id : { error: "Open a repository first — there is no graph to show." }
  }

  const post = async <T>(
    route: string,
    body: unknown,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
    shapeError: string
  ): Promise<T | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    if (!response.ok) return { error: await ctx.errorMessageOf(response, `The request answered ${response.status}`) }
    const parsed = schema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success || parsed.data === undefined) return { error: shapeError }
    return parsed.data
  }

  /** Paint a live fold into the graph overlay and the timeline card of one run. */
  const paintRun = (repoId: string, runId: string): void => {
    const fold = touch(liveRuns, runId)
    touch(completed, runId)
    if (fold === undefined) return
    const nodes = [...fold.nodes.values()]
    const summary = fold.summary
    patch(graphCardId(repoId), "graph", (card) => ({
      payload: { ...card.payload, runId, run: { nodes, ...(summary === undefined ? {} : { summary }) } }
    }))
    const timelineId = runTimelineCardId(runId)
    if (store.collections.cards.get(timelineId)?.kind === "run-timeline") {
      patch(timelineId, "run-timeline", (card) => ({
        payload: {
          ...card.payload,
          status: fold.error !== undefined ? "failed" : summary !== undefined ? (summary.ok ? "done" : "failed") : "running",
          nodes,
          ...(summary === undefined ? {} : { summary }),
          logs: Object.fromEntries(fold.logs),
          ...(fold.error === undefined ? {} : { error: fold.error })
        }
      }))
    }
  }

  /*
   * Attach one run's frames into the overlay and (when open) its timeline card.
   *
   * The attachment has to be RELEASED when the run exits. TargetRunClient keeps
   * a topic subscribed while any listener is registered and re-announces
   * `target-run.attach` for every live topic after a reconnect, so a listener
   * left on a finished run makes the app re-attach to dead runs forever. The
   * accumulated fold outlives the attachment on purpose: a timeline card opened
   * after the run settled still paints from it.
   */
  const detachers = actorSharedState(ctx, "target-detachers", () => new Map<string, () => void>())
  const releaseRun = (runId: string): void => {
    const detach = detachers.get(runId)
    if (detach === undefined) return
    detachers.delete(runId)
    detach()
  }
  const watchRun = (repoId: string, runId: string, label: string): void => {
    if (lifetime.disposed || liveRuns.has(runId)) return
    liveRuns.set(runId, { nodes: new Map(), summary: undefined, logs: new Map() })
    const onFrame = (frame: TargetRunFrame): void => {
      const fold = liveRuns.get(runId)
      if (fold === undefined) return
      foldRunFrame(fold, frame)
      paintRun(repoId, runId)
      if (frame.type === "exit") {
        releaseRun(runId)
        let bytes = 128 + (fold.error?.length ?? 0) * 2
        for (const node of fold.nodes.values()) bytes += 64 + JSON.stringify(node).length * 2
        for (const [label, log] of fold.logs) bytes += 64 + (label.length + log.length) * 2
        if (fold.summary !== undefined) bytes += JSON.stringify(fold.summary).length * 2
        completed.set(runId, bytes)
        trimCache(completed, (bytes) => bytes)
        for (const id of liveRuns.keys()) if (!detachers.has(id) && !completed.has(id)) liveRuns.delete(id)
      }
    }
    detachers.set(runId, devFixtures !== undefined ? devFixtures.streamRun(runId, label, onFrame) : runs.attach(runId, onFrame))
  }
  actorSharedState(ctx, "target-cache-cleanup", () => {
    const subscription = store.collections.cards.subscribeChanges(() => {
      const visible = new Set<string>()
      for (const card of store.collections.cards.values()) {
        if (card.kind === "run-timeline") visible.add(card.payload.runId)
        if (card.kind === "graph" && card.payload.runId !== undefined) visible.add(card.payload.runId)
      }
      for (const id of replayEvents.keys()) if (!visible.has(id)) replayEvents.delete(id)
      for (const id of liveRuns.keys()) if (!visible.has(id)) {
        releaseRun(id)
        liveRuns.delete(id)
        completed.delete(id)
      }
      for (const [id, pending] of pendingScrubs) if (store.collections.cards.get(runTimelineCardId(id))?.kind !== "run-timeline") {
        pending.cancel()
        pendingScrubs.delete(id)
      }
    })
    ctx.onDispose(() => {
      lifetime.disposed = true
      subscription.unsubscribe()
      for (const runId of [...detachers.keys()]) releaseRun(runId)
      replayEvents.clear()
      liveRuns.clear()
      completed.clear()
      for (const pending of pendingScrubs.values()) pending.cancel()
      pendingScrubs.clear()
    })
    return true
  })

  const showGraph: TargetGraphController["showGraph"] = async (repoIdArg, label) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = graphCardId(repoId)
    const repoName = repoId
    upsert({
      id,
      kind: "graph",
      title: `${repoName} graph`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, repoName, status: "pending", ...(label === undefined ? {} : { focus: label }) }
    })
    if (devFixtures !== undefined) {
      const graph = devFixtures.graph(repoId)
      patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "done", graph }, status: "acted" }))
      return
    }
    /*
     * Two phases, deliberately.
     *
     * The DAG and the plan facts used to be ONE request, and `plan: true`
     * with no label plans `//...` — every target in the workspace. On the
     * real force checkout that is ~4.7s for the graph against ~15.9s for
     * graph+plan, and under the load of a real session (the auto-loaded
     * targets card querying the loader at the same time) it crosses the
     * boundedFetch deadline and the card dies with `seam timeout` showing
     * NOTHING — a DAG that was ready in seconds, thrown away for facts only
     * the drawer reads. So: paint the graph as soon as it lands, then patch
     * the plan facts in. The card's final state is unchanged.
     */
    const labels = label === undefined ? {} : { labels: [label] }
    const answer = await post(
      TARGET_GRAPH_ROUTES.graph,
      { repoId, ...labels },
      TargetGraphResponseSchema,
      "The graph route answered an unexpected shape."
    )
    if ("error" in answer) {
      patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "done", graph: answer }, status: "acted" }))

    const planned = await post(
      TARGET_GRAPH_ROUTES.graph,
      { repoId, plan: true, ...labels },
      TargetGraphResponseSchema,
      "The graph route answered an unexpected shape."
    )
    /*
     * A plan that fails leaves the painted graph exactly as it is. The drawer
     * shows the facts it has and omits the ones it does not, which it already
     * does for every node the planner refuses.
     */
    if ("error" in planned) return
    patch(id, "graph", (card) => ({ payload: { ...card.payload, status: "done", graph: planned }, status: "acted" }))
  }

  /*
   * The drawer opens on the card payload's focus, so dismissing it has to
   * clear that focus — local component state alone would let the drawer
   * spring back on the next render of a `graph //src:lint` card.
   */
  const focusGraph: TargetGraphController["focusGraph"] = (repoIdArg, label) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = graphCardId(repoId)
    if (store.collections.cards.get(id)?.kind !== "graph") return "There is no graph card open to focus."
    patch(id, "graph", (card) => {
      const { focus: _cleared, ...rest } = card.payload
      return { payload: label === undefined || label === "" ? rest : { ...rest, focus: label } }
    })
  }

  /*
   * The toolbar's filter belongs to the card, not to the component: a graph
   * opened in a sidebar tab or restored after a reload paints the same view
   * the human left, exactly as the targets table's view does.
   */
  const filterGraph: TargetGraphController["filterGraph"] = (repoIdArg, change) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = graphCardId(repoId)
    if (store.collections.cards.get(id)?.kind !== "graph") return "There is no graph card open to filter."
    patch(id, "graph", (card) => {
      const view = { ...card.payload.view }
      if (change.query !== undefined) {
        if (change.query.trim() === "") delete view.query
        else view.query = change.query
      }
      if (change.showPrivate !== undefined) {
        if (change.showPrivate) view.showPrivate = true
        else delete view.showPrivate
      }
      const { view: _replaced, ...rest } = card.payload
      return { payload: Object.keys(view).length === 0 ? rest : { ...rest, view } }
    })
  }

  const showTimeline: TargetGraphController["showTimeline"] = async (repoIdArg, runIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    if (runIdArg === undefined) return "Name the run to show — pick one from the history card."
    /*
     * A run this session never folded (started before the app opened, or
     * settled before anything watched it) has no frames left to stream: the
     * live path below would open a RUNNING card that never changes. Its
     * recording is the timeline, so a settled run paints from the replay,
     * and a run the recording still calls running attaches live as before.
     *
     * A run the recording REFUSES (unknown id, a route that 500s) or never
     * recorded at all has neither. Falling through would attach to a topic no
     * run publishes on and report the command executed, so the timeline says
     * what the history row's replay already says: nothing to show.
     */
    if (!liveRuns.has(runIdArg)) {
      const recorded = await fetchReplay(runIdArg)
      if (recorded === undefined) return `There is no recording of run ${runIdArg}.`
      if (typeof recorded === "string") return recorded
      if (recorded.run.status !== "running" && recorded.run.status !== "pending") {
        paintReplay(repoId, runIdArg, recorded)
        return
      }
    }
    upsert({
      id: runTimelineCardId(runIdArg),
      kind: "run-timeline",
      title: `Run ${runIdArg}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, runId: runIdArg, label: runIdArg, status: "running", nodes: [] }
    })
    watchRun(repoId, runIdArg, runIdArg)
    /* A run the overlay has been folding since it started is already known; paint it now rather than waiting for the next frame (a settled run has none). */
    paintRun(repoId, runIdArg)
  }

  const showHistory: TargetGraphController["showHistory"] = async (repoIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = runHistoryCardId(repoId)
    upsert({
      id,
      kind: "run-history",
      title: `${repoId} runs`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, status: "pending", runs: [] }
    })
    const answer = devFixtures !== undefined
      ? devFixtures.history(repoId)
      : await post(
        TARGET_GRAPH_ROUTES.runs,
        { repoId },
        RunHistoryResponseSchema,
        "The runs route answered an unexpected shape."
      )
    if ("error" in answer) {
      patch(id, "run-history", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "run-history", (card) => ({
      payload: { ...card.payload, status: "done", runs: (answer as RunHistoryResponse).runs },
      status: "acted"
    }))
  }

  /** One run's recording: the replay, the refusal text, or undefined when nothing was recorded. */
  const fetchReplay = async (runId: string): Promise<RunReplayResponse | string | undefined> => {
    const answer = devFixtures !== undefined
      ? devFixtures.replay(runId)
      : await post(
        TARGET_GRAPH_ROUTES.replay,
        { runId },
        RunReplayResponseSchema,
        "The replay route answered an unexpected shape."
      )
    if (answer === undefined) return undefined
    if ("error" in answer) return answer.error
    return answer as RunReplayResponse
  }

  const selectRun: TargetGraphController["selectRun"] = async (repoIdArg, runId) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const recorded = await fetchReplay(runId)
    if (recorded === undefined) return `There is no recording of run ${runId}.`
    if (typeof recorded === "string") return recorded
    paintReplay(repoId, runId, recorded)
  }

  /** Paint a recording as the (replay) timeline card, the history selection, and the graph overlay. */
  const paintReplay = (repoId: string, runId: string, replay: RunReplayResponse): void => {
    if (lifetime.disposed) return
    const index = indexReplay(replay.events)
    /*
     * The end of a run that never recorded `endedAt` is its last timed frame.
     * A fold, never `Math.max(...events)`: a chatty run retains ~10^6 tiny
     * log frames under the store's cap, and spreading a million arguments
     * overflows the call stack — selecting such a run crashed the controller
     * instead of opening its timeline.
     */
    let endCursor = replay.run.startedAt
    if (replay.run.endedAt === undefined) {
      for (const event of replay.events) {
        if ("at" in event && event.at > endCursor) endCursor = event.at
      }
    } else {
      endCursor = replay.run.endedAt
    }
    const state = index.atCursor(endCursor)
    patch(runHistoryCardId(repoId), "run-history", (card) => ({ payload: { ...card.payload, selected: runId } }))
    upsert({
      id: runTimelineCardId(runId),
      kind: "run-timeline",
      title: `${replay.run.label} (replay)`,
      status: "acted",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: {
        repoId,
        runId,
        label: replay.run.label,
        status: replay.run.status,
        nodes: state.nodes,
        ...(state.summary === undefined ? {} : { summary: state.summary }),
        ...(state.error === undefined ? {} : { error: state.error }),
        cursor: endCursor,
        extent: { start: replay.run.startedAt, end: endCursor },
        logs: state.logs
      }
    })
    replayEvents.delete(runId)
    replayEvents.set(runId, index)
    trimCache(replayEvents, (entry) => entry.bytes)
    // Time travel paints the graph overlay too, when the graph card is up.
    if (store.collections.cards.get(graphCardId(repoId))?.kind === "graph") {
      patch(graphCardId(repoId), "graph", (card) => ({
        payload: {
          ...card.payload,
          runId,
          run: { nodes: state.nodes, ...(state.summary === undefined ? {} : { summary: state.summary }) }
        }
      }))
    }
  }

  const scrubRun: TargetGraphController["scrubRun"] = (runId, cursor) => {
    if (lifetime.disposed) return Promise.resolve()
    const queued = pendingScrubs.get(runId)
    if (queued !== undefined) {
      queued.cursor = cursor
      return queued.promise
    }
    const entry = { cursor, promise: Promise.resolve() as Promise<string | void>, cancel: () => {} }
    pendingScrubs.set(runId, entry)
    // One projection per animation frame while dragging. Headless callers use
    // the next task, and await the same completion as every coalesced caller.
    const scheduled = new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        const frame = requestAnimationFrame(() => resolve())
        entry.cancel = () => { cancelAnimationFrame(frame); resolve() }
      } else {
        const timer = setTimeout(resolve, 0)
        entry.cancel = () => { clearTimeout(timer); resolve() }
      }
    })
    entry.promise = scheduled.then(async () => {
      const cardId = runTimelineCardId(runId)
      const card = store.collections.cards.get(cardId)
      if (lifetime.disposed || pendingScrubs.get(runId) !== entry) return
      if (card?.kind !== "run-timeline") return `There is no recording of run ${runId} to scrub.`
      let index = touch(replayEvents, runId)
      if (index === undefined) {
        const recorded = await fetchReplay(runId)
        if (lifetime.disposed || pendingScrubs.get(runId) !== entry || store.collections.cards.get(cardId) !== card) return
        if (recorded === undefined) return `There is no recording of run ${runId} to scrub.`
        if (typeof recorded === "string") return recorded
        index = indexReplay(recorded.events)
        replayEvents.set(runId, index)
        trimCache(replayEvents, (value) => value.bytes)
      }
      paintCursor(runId, entry.cursor, index.atCursor(entry.cursor))
    }).finally(() => {
      if (pendingScrubs.get(runId) === entry) pendingScrubs.delete(runId)
    })
    return entry.promise
  }

  const paintCursor = (runId: string, cursor: number, state: ReplayState): void => {
    const cardId = runTimelineCardId(runId)
    const card = store.collections.cards.get(cardId)
    if (card?.kind !== "run-timeline") return
    const repoId = card.payload.repoId
    /*
     * Time travel replaces the fold, it does not merge into it: a cursor
     * BEFORE the summary frame has no summary, so spreading the old payload
     * would leave the finished run's totals and critical path painted over a
     * half-replayed run.
     */
    patch(cardId, "run-timeline", (current) => {
      const { summary: _dropped, error: _oldError, ...rest } = current.payload
      return {
        payload: {
          ...rest,
          nodes: state.nodes,
          ...(state.summary === undefined ? {} : { summary: state.summary }),
          ...(state.error === undefined ? {} : { error: state.error }),
          cursor,
          logs: state.logs
        }
      }
    })
    if (store.collections.cards.get(graphCardId(repoId))?.kind === "graph") {
      patch(graphCardId(repoId), "graph", (current) => ({
        payload: {
          ...current.payload,
          runId,
          run: { nodes: state.nodes, ...(state.summary === undefined ? {} : { summary: state.summary }) }
        }
      }))
    }
  }

  const showAffected: TargetGraphController["showAffected"] = async (repoIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = affectedCardId(repoId)
    upsert({
      id,
      kind: "affected",
      title: `${repoId} affected`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, status: "pending" }
    })
    const answer = devFixtures !== undefined
      ? devFixtures.affected(repoId)
      : await post(
        TARGET_GRAPH_ROUTES.affected,
        { repoId },
        AffectedResponseSchema,
        "The affected route answered an unexpected shape."
      )
    if ("error" in answer) {
      patch(id, "affected", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "affected", (card) => ({
      payload: { ...card.payload, status: "done", result: answer as AffectedResponse },
      status: "acted"
    }))
  }

  const showCi: TargetGraphController["showCi"] = async (repoIdArg) => {
    const repoId = resolveRepoId(repoIdArg)
    if (typeof repoId !== "string") return repoId.error
    const id = ciMatrixCardId(repoId)
    upsert({
      id,
      kind: "ci-matrix",
      title: `${repoId} CI`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId, status: "pending" }
    })
    const answer = devFixtures !== undefined
      ? devFixtures.ci(repoId)
      : await post(
        TARGET_GRAPH_ROUTES.ci,
        { repoId },
        CiMatrixResponseSchema,
        "The CI route answered an unexpected shape."
      )
    if ("error" in answer) {
      patch(id, "ci-matrix", (card) => ({ payload: { ...card.payload, status: "failed", error: answer.error }, status: "error" }))
      return answer.error
    }
    patch(id, "ci-matrix", (card) => ({
      payload: { ...card.payload, status: "done", result: answer as CiMatrixResponse },
      status: "acted"
    }))
  }

  const noteRunStarted: TargetGraphController["noteRunStarted"] = (repoId, runId, label) => {
    if (store.collections.cards.get(graphCardId(repoId))?.kind !== "graph") return
    patch(graphCardId(repoId), "graph", (card) => ({ payload: { ...card.payload, runId } }))
    watchRun(repoId, runId, label)
  }

  const openSource: TargetGraphController["openSource"] = async (repoId, file, line) => {
    const answer = await post(
      TARGET_GRAPH_ROUTES.openSource,
      { repoId, file, ...(line === undefined ? {} : { line }) },
      { safeParse: (value: unknown) => ({ success: true, data: value as Record<string, unknown> }) },
      "The open-source route answered an unexpected shape."
    )
    if (answer !== null && "error" in answer && typeof answer.error === "string") {
      return `Could not open the declaration: ${answer.error}`
    }
  }

  return {
    showGraph,
    focusGraph,
    filterGraph,
    showTimeline,
    showHistory,
    selectRun,
    scrubRun,
    showAffected,
    showCi,
    noteRunStarted,
    openSource
  }
}
