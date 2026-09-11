/**
 * Persistent history reads and mutation/control reconciliation.
 * @since 1.0.0
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Journal, SqlJournal } from "@smthrs/journal"
import type { Entry, RunId, Seq } from "@smthrs/journal/JournalEvent"
import { Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { EffectBoundary, ReadOnlyTimeTravel, SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import { forkWorkspaceName, type Position } from "@smthrs/time-travel/TimeTravel"
import { TimeTravelStore } from "@smthrs/time-travel/TimeTravelStore"
import { Cause, Effect, Exit, Layer } from "effect"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { hasTable } from "../internal/SqliteTable.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as Projection from "./Projection.ts"
import * as Workspace from "./Workspace.ts"

/**
 * Local history address and resource limits.
 * @since 1.0.0
 * @category models
 */
export interface Options {
  readonly root?: string | undefined
  readonly remote?: string | undefined
  readonly sequence?: number | undefined
  readonly lineage?: string | undefined
  readonly limit?: number | undefined
}

/**
 * Resolve local history using the CLI's project and environment rules.
 * @since 1.0.0
 * @category constructors
 */
export { localRoot } from "../Project.ts"

const requireDatabase = (root: string): string => {
  const file = NodeControl.executionDatabasePath(root)
  if (!existsSync(file)) throw new Error(`No execution history at ${file}`)
  return file
}

const readStorage = (root: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer, CacheStore.layer).pipe(
    Layer.provideMerge(
      DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({
        filename: requireDatabase(root),
        sqlite: { readonly: true, disableWAL: true }
      })))
    )
  )

const readerLayer = (root: string) => TimeTravel.readOnly.pipe(Layer.provideMerge(readStorage(root)))
const writerLayer = (root: string, workspace: string) => {
  const persistent = SqlTimeTravelStore.layer.pipe(
    Layer.provideMerge(NodeRuntime.storage(requireDatabase(root), workspace))
  )
  // Startup recovery may restore a worktree. Only recover audits belonging
  // to the worktree bound to this service; other hosts will recover theirs.
  const stores = Layer.effect(TimeTravelStore)(Effect.gen(function*() {
    const store = yield* TimeTravelStore
    return {
      ...store,
      pendingAudits: () =>
        store.pendingAudits().pipe(
          Effect.map((audits) => audits.filter((audit) => Workspace.workspaceFor(root, audit.runId) === workspace))
        )
    }
  })).pipe(Layer.provideMerge(persistent))
  return TimeTravel.layerWith({ isAlive: Ownership.sameHostPidProbe }).pipe(
    Layer.provideMerge(stores),
    Layer.provide(NodeJj.layerAt(workspace)),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeCrypto.layer)
  )
}

const runEffect = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal })
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return exit.value
}

const lineageOf = (entry: Entry): string | undefined => {
  const meta = entry.meta as { readonly lineageId?: unknown } | null
  return typeof meta?.lineageId === "string" ? meta.lineageId : undefined
}

/** Resolves an exact stored frame; a supplied sequence must exist in this run. */
const resolvePosition = (runId: string, options: Options) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const journal = yield* Journal.Journal
    let after: Seq | undefined
    let target: Entry | undefined
    let first: Entry | undefined
    let count = 0
    const limit = options.limit ?? 10_000
    while (true) {
      const page = yield* journal.entries({
        runId: runId as RunId,
        limit: 250,
        ...(after === undefined ? {} : { after })
      })
      for (const entry of page.entries) {
        first ??= entry
        if (options.sequence !== undefined && entry.seq > options.sequence) break
        if (++count > limit) throw new Error(`History exceeds --limit ${limit}; increase it explicitly`)
        if (options.lineage === undefined || lineageOf(entry) === options.lineage) target = entry
      }
      const tail = page.entries.at(-1)?.seq
      if (!page.hasMore || tail === undefined || (options.sequence !== undefined && tail >= options.sequence)) break
      if (after !== undefined && tail <= after) throw new Error("History pagination did not advance")
      after = tail
    }
    const sequence = options.sequence ?? target?.seq
    const lineage = options.lineage ?? (target === undefined ? undefined : lineageOf(target)) ??
      (first === undefined ? undefined : lineageOf(first))
    if (sequence === undefined || lineage === undefined) {
      throw new Error(`Run ${runId} has no addressable execution history`)
    }
    if (sequence !== 0 && target?.seq !== sequence) {
      throw new Error(`Run ${runId} has no frame at sequence ${sequence} in this lineage`)
    }
    return { row, position: { runId, frame: { lineageId: lineage, seq: sequence } } satisfies Position }
  })

/**
 * Reads the stored prefix without executing effects or startup recovery.
 * @since 1.0.0
 * @category constructors
 */
export const read = async (root: string, runId: string, options: Options, replay: boolean, signal?: AbortSignal) =>
  runEffect(
    Effect.gen(function*() {
      const { row, position } = yield* resolvePosition(runId, options)
      const reader = yield* ReadOnlyTimeTravel
      const fold = Projection.make(replay)
      const result = fold.finish(
        position.frame.seq === 0
          ? fold.initial
          : yield* reader.replay(position, fold, { maxHistoryEntries: options.limit ?? 10_000 })
      )
      return {
        position,
        executionFlow: (JSON.parse(row.stateJson) as { flowName?: string } | null)?.flowName,
        status: row.status,
        parentRunId: row.parentRunId,
        ...result,
        ...(replay ? {} : { events: undefined })
      }
    }).pipe(Effect.provide(readerLayer(root)), Effect.scoped),
    signal
  )

/**
 * Lists exactly the suffix/effects a rewind would cross; never mutates it.
 * @since 1.0.0
 * @category constructors
 */
export const preview = async (root: string, runId: string, options: Options, signal?: AbortSignal) =>
  runEffect(
    Effect.gen(function*() {
      const { row, position } = yield* resolvePosition(runId, options)
      const journal = yield* Journal.Journal
      const entries: Array<Entry> = []
      let after = position.frame.seq as Seq
      while (true) {
        const page = yield* journal.entries({ runId: runId as RunId, after, limit: 250 })
        entries.push(...page.entries)
        if (entries.length > (options.limit ?? 10_000)) throw new Error("Rewind suffix exceeds --limit")
        const tail = page.entries.at(-1)?.seq
        if (!page.hasMore || tail === undefined) break
        if (tail <= after) throw new Error("History pagination did not advance")
        after = tail
      }
      const effects = yield* EffectBoundary.fromEntries(entries)
      return {
        preview: true,
        position,
        status: row.status,
        entriesToArchive: entries.length,
        effects,
        blockedEffects: effects.filter((effect) => effect.tier !== "sealed"),
        active: row.owner !== null || row.claim !== null,
        requiresConfirmation: true
      }
    }).pipe(Effect.provide(readStorage(root)), Effect.scoped),
    signal
  )

const openControl = (root: string) => {
  const file = NodeControl.databasePath(root)
  if (!existsSync(file)) throw new Error("This operation requires a public CLI run with an approved control plan")
  const db = new DatabaseSync(file)
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}
const controlSummary = (db: DatabaseSync, runId: string, allowActive = false): Record<string, unknown> => {
  const row = db.prepare("SELECT state_json,status,owner_nonce,claim_nonce FROM flows_runs WHERE run_id=?").get(runId)
  if (row === undefined) {
    throw new Error(`No control-plane run ${runId}; use the TimeTravel API for standalone engine executions`)
  }
  if (!allowActive && (row.status === "running" || row.owner_nonce !== null || row.claim_nonce !== null)) {
    throw new Error(`Run ${runId} is active or claimed; park it before changing history`)
  }
  const summary = JSON.parse(String(row.state_json)) as Record<string, unknown>
  if (typeof summary.planId !== "string" || typeof summary.flowId !== "string") {
    throw new Error(`Run ${runId} has no approved public CLI plan`)
  }
  const plan = db.prepare("SELECT decision FROM control_plans WHERE plan_id=?").get(summary.planId)
  if (plan?.decision !== "approved") throw new Error(`Run ${runId}'s plan is not approved`)
  return summary
}

const parkedSummary = (summary: Record<string, unknown>, runId: string, parentRunId?: string) => ({
  ...summary,
  runId,
  status: "parked",
  updatedAt: Date.now(),
  ...(parentRunId === undefined ? {} : { parentRunId, createdAt: Date.now() }),
  ownerId: undefined,
  parkedBy: undefined,
  waitingReason: undefined
})

const parkControl = (db: DatabaseSync, runId: string, summary: Record<string, unknown>) => {
  const changed = db.prepare(
    "UPDATE flows_runs SET status='suspended', state_json=?, finished_at_ms=NULL, cancel_requested_at_ms=NULL, waiting_reason='history', waiting_wake_at_ms=NULL, waiting_token=NULL WHERE run_id=? AND status <> 'running' AND owner_nonce IS NULL AND claim_nonce IS NULL"
  )
    .run(JSON.stringify(parkedSummary(summary, runId)), runId)
  if (changed.changes !== 1) throw new Error(`Run ${runId} acquired an owner during history reconciliation`)
  if (hasTable(db, "control_run_resumes")) db.prepare("DELETE FROM control_run_resumes WHERE run_id=?").run(runId)
}

const linkFork = (engine: DatabaseSync, control: DatabaseSync, root: string, childId: string, parentId: string) => {
  const summary = controlSummary(control, parentId, true)
  const workspace = join(Project.stateDirectory(root), "forks", forkWorkspaceName(childId))
  if (!existsSync(join(workspace, ".jj"))) throw new Error(`Fork ${childId} has no retained workspace at ${workspace}`)
  const existing = control.prepare("SELECT 1 FROM flows_runs WHERE run_id=?").get(childId)
  if (existing === undefined) {
    const row = engine.prepare("SELECT state_json,status FROM flows_runs WHERE run_id=?").get(childId)
    if (row === undefined || row.status === "running") throw new Error(`Fork ${childId} is absent or already active`)
    const state = JSON.parse(String(row.state_json)) as { flowName?: unknown } | null
    if (state?.flowName !== "agent/run") {
      throw new Error(`Fork ${childId} is not a public agent flow and cannot be resumed by this CLI`)
    }
    control.prepare(
      "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES(?,'suspended',?,?,?)"
    )
      .run(childId, Date.now(), parentId, JSON.stringify(parkedSummary(summary, childId, parentId)))
  }
  engine.exec("CREATE TABLE IF NOT EXISTS smthrs_history_workspaces(run_id TEXT PRIMARY KEY, workspace TEXT NOT NULL)")
  engine.prepare("INSERT INTO smthrs_history_workspaces(run_id,workspace) VALUES(?,?) ON CONFLICT(run_id) DO NOTHING")
    .run(childId, workspace)
  return workspace
}

/**
 * Repairs the narrow crash gap between committed engine history and its
 * control projection. Every operation is idempotent and owns the control lock.
 * @since 1.0.0
 * @category constructors
 */
export const reconcile = (root: string): void => {
  if (!existsSync(NodeControl.executionDatabasePath(root)) || !existsSync(NodeControl.databasePath(root))) return
  const engine = new DatabaseSync(NodeControl.executionDatabasePath(root))
  const control = openControl(root)
  try {
    control.exec("BEGIN IMMEDIATE")
    control.exec("CREATE TABLE IF NOT EXISTS smthrs_history_applied(audit_id TEXT PRIMARY KEY)")
    if (hasTable(engine, "flows_time_travel_edges")) {
      const forks = engine.prepare(
        "SELECT child_run_id,parent_run_id FROM flows_time_travel_edges WHERE kind='fork' ORDER BY rowid"
      ).all()
      for (const fork of forks) {
        if (control.prepare("SELECT 1 FROM flows_runs WHERE run_id=?").get(String(fork.child_run_id))) continue
        // A standalone engine fork is outside the public control adapter.
        if (!control.prepare("SELECT 1 FROM flows_runs WHERE run_id=?").get(String(fork.parent_run_id))) continue
        linkFork(engine, control, root, String(fork.child_run_id), String(fork.parent_run_id))
      }
    }
    if (hasTable(engine, "flows_time_travel_audits")) {
      const audits = engine.prepare(
        "SELECT id,run_id FROM flows_time_travel_audits WHERE status='completed' ORDER BY rowid"
      ).all()
      for (const audit of audits) {
        const id = String(audit.id)
        const runId = String(audit.run_id)
        if (control.prepare("SELECT 1 FROM smthrs_history_applied WHERE audit_id=?").get(id)) continue
        const row = engine.prepare("SELECT status FROM flows_runs WHERE run_id=?").get(runId)
        if (row?.status === "suspended") parkControl(control, runId, controlSummary(control, runId))
        control.prepare("INSERT INTO smthrs_history_applied(audit_id) VALUES(?)").run(id)
      }
    }
    control.exec("COMMIT")
  } catch (cause) {
    try {
      control.exec("ROLLBACK")
    } catch { /* The original failure is the actionable one. */ }
    throw cause
  } finally {
    engine.close()
    control.close()
  }
}

/**
 * Fork or rewind a run and reconcile its durable control identity.
 * @since 1.0.0
 * @category constructors
 */
export const mutate = async (
  root: string,
  runId: string,
  options: Options,
  operation: "fork" | "rewind",
  signal?: AbortSignal
) => {
  // Resolve the frame through a genuinely read-only connection before a lock
  // or time-travel recovery is constructed.
  const observed = await read(root, runId, options, false, signal)
  if (operation === "fork" && observed.executionFlow !== "agent/run") {
    throw new Error(`Run ${runId} is not a public agent flow; use the TimeTravel API for standalone engine forks`)
  }
  const workspace = Workspace.workspaceFor(root, runId)
  if (workspace === undefined) throw new Error(`Fork ${runId} needs history reconciliation before it can be used`)
  const control = openControl(root)
  try {
    control.exec("BEGIN IMMEDIATE")
    const summary = controlSummary(control, runId)
    if (operation === "fork") mkdirSync(join(Project.stateDirectory(root), "forks"), { recursive: true })
    const result = await runEffect(
      Effect.gen(function*() {
        const service = yield* TimeTravel
        return operation === "fork"
          ? {
            kind: "fork" as const,
            result: yield* service.fork(observed.position, {
              workspaceRoot: join(Project.stateDirectory(root), "forks"),
              retainWorkspace: true,
              maxHistoryEntries: options.limit ?? 10_000
            })
          }
          : {
            kind: "rewind" as const,
            result: yield* service.rewind(observed.position, { maxHistoryEntries: options.limit ?? 10_000 })
          }
      }).pipe(Effect.provide(writerLayer(root, workspace)), Effect.scoped),
      signal
    )
    const engine = new DatabaseSync(NodeControl.executionDatabasePath(root))
    try {
      if (result.kind === "fork") {
        const childWorkspace = linkFork(engine, control, root, result.result.runId, runId)
        control.exec("COMMIT")
        return {
          ...result.result,
          workspace: childWorkspace,
          status: "parked",
          next: `smthrs runs resume ${result.result.runId}`
        }
      }
      parkControl(control, runId, summary)
      control.exec("CREATE TABLE IF NOT EXISTS smthrs_history_applied(audit_id TEXT PRIMARY KEY)")
      control.prepare("INSERT OR IGNORE INTO smthrs_history_applied(audit_id) VALUES(?)").run(result.result.auditId)
      control.exec("COMMIT")
      return { ...result.result, runId, status: "parked", next: `smthrs runs resume ${runId}` }
    } finally {
      engine.close()
    }
  } catch (cause) {
    try {
      control.exec("ROLLBACK")
    } catch { /* Preserve the original failure. */ }
    throw cause
  } finally {
    control.close()
  }
}

/**
 * Called before resuming so the executor binds to this run's real worktree.
 * @since 1.0.0
 * @category constructors
 */
export const prepare = (root: string, runId: string): { readonly executionRoot: string } => {
  reconcile(root)
  const workspace = Workspace.workspaceFor(root, runId)
  if (workspace === undefined) throw new Error(`Fork ${runId} has not been linked to its workspace`)
  if (!existsSync(workspace)) throw new Error(`Run workspace no longer exists: ${workspace}`)
  return { executionRoot: workspace }
}
