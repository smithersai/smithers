/**
 * Apply a cache lifetime and restore workspace state before retrying a
 * compensable action.
 *
 * `CacheEnvironment.withCache` declares the result's scope and age bound. The
 * engine records its cache-age decision so a resumed execution can reuse that
 * decision.
 *
 * The compensable action captures a workspace pre-image and restores it before
 * another attempt. The example uses a directory-copying `Jj` implementation to
 * check the file state. Cross-run sealed reuse also needs an idempotency key, a
 * hard file boundary, and a complete cache environment.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { stubJj } from "./durable-layer.ts"

/** The failure the first attempt of the compensable step raises. */
export class Interrupted extends Schema.TaggedError<Interrupted>()("examples/Interrupted", {
  attempt: Schema.Number
}) {}

/**
 * What a snapshot the engine asked for is FOR, read off the message it passes.
 *
 * The engine takes two kinds of pre-image around a compensable dispatch and one
 * post-image after it, and each message names the step key and the attempt. The
 * digests are not stable across edits, so the example reports the readable
 * half, which attempt and whether the snapshot was taken before or after it,
 * and leaves the key out.
 */
const describe = (message: string | undefined): string => {
  const matched = /attempt (\d+)( settled)?$/.exec(message ?? "")
  if (matched === null) return message ?? "unknown"
  return `attempt-${matched[1]}-${matched[2] === undefined ? "pre" : "post"}`
}

/**
 * A version-control service that snapshots a directory by copying it.
 *
 * `stubJj` in `durable-layer.ts` records nothing, which is honest for examples
 * whose actions are sealed. A compensable action needs a real one: the engine
 * calls `snapshot` before each attempt and `restore` before a retry, and if
 * neither does anything then nothing is compensated. This one is the smallest
 * implementation that genuinely puts files back. Snapshots get unique IDs
 * across layers and are published only after copying completes. Restore stages
 * a complete copy before swapping the workspace, retaining a backup until the
 * swap succeeds. These synchronous operations assume one workspace writer.
 */
export const directoryJj = (options: {
  readonly workspace: string
  readonly snapshots: string
  readonly log: { readonly snapshots: Array<string>; readonly restores: Array<string> }
}) => {
  const taken = new Map<string, string>()
  return Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: (message) =>
        Effect.sync(() => {
          const changeId = `snapshot-${randomUUID()}`
          const destination = join(options.snapshots, changeId)
          mkdirSync(options.snapshots, { recursive: true })
          const staged = mkdtempSync(join(options.snapshots, ".snapshot-"))
          try {
            cpSync(options.workspace, staged, { recursive: true })
            // Never replace a published pre-image, even on an ID collision.
            if (existsSync(destination)) throw new Error(`Snapshot already exists: ${changeId}`)
            renameSync(staged, destination)
          } finally {
            rmSync(staged, { recursive: true, force: true })
          }
          taken.set(changeId, describe(message))
          options.log.snapshots.push(describe(message))
          return { changeId: changeId as never }
        }),
      restore: (changeId) =>
        Effect.sync(() => {
          const source = join(options.snapshots, changeId)
          if (!statSync(source).isDirectory()) throw new Error(`Snapshot is not a directory: ${changeId}`)
          const workspace = resolve(options.workspace)
          const temporary = mkdtempSync(join(dirname(workspace), ".restore-"))
          const staged = join(temporary, "workspace")
          const backup = join(temporary, "backup")
          let keepBackup = false
          try {
            // Copy failures can only damage staging, never the live workspace.
            cpSync(source, staged, { recursive: true })
            if (existsSync(workspace)) {
              renameSync(workspace, backup)
              keepBackup = true
            }
            try {
              renameSync(staged, workspace)
            } catch (error) {
              if (keepBackup) {
                renameSync(backup, workspace)
                keepBackup = false
              }
              throw error
            }
            keepBackup = false
            options.log.restores.push(taken.get(changeId) ?? changeId)
          } finally {
            // If rollback itself fails, leave the original backup for recovery.
            if (!keepBackup) {
              try {
                rmSync(temporary, { recursive: true, force: true })
              } catch {
                // Cleanup is best effort: the workspace is already settled.
              }
            }
          }
        }),
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  )
}

/**
 * The engine `durable-layer.ts` builds, plus the two things this example needs
 * it to have: a real `Jj`, and the complete cache environment a cross-run key
 * is derived from.
 *
 * Both are provided BENEATH the engine, where the dispatch reads them, rather
 * than beside the caller.
 */
const engine = (filename: string, hostId: string, jj: Layer.Layer<Jj.Jj>) =>
  NodeRuntime.layer(
    { filename, workspaceRoot: dirname(filename), owner: { hostId }, isAlive: () => Effect.succeed(false) },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    Layer.empty
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(jj, Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(AtomicFileSystem.layer)
  )

/** The declared atom the caching flow's body names. */
export const Build = Action.make("examples/CachedBuild", {
  payload: { target: Schema.String },
  success: Schema.String
})

/** The flow that runs one cached build step. */
export const Package = Flow.make("examples/Package", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload: { readonly target: string }) => Build.call(payload)
})

/** The declared atom the compensating flow's body names. */
export const Apply = Action.make("examples/ApplyMigration", {
  payload: { migration: Schema.String },
  success: Schema.String,
  // The retry ladder can still run out, so the failure stays declared rather
  // than swallowed. It does not happen here, because attempt two succeeds, and
  // a caller that hid it would turn an exhausted migration into a silent one.
  error: Interrupted
})

/** The flow that runs one compensable migration step. */
export const Migrate = Flow.make("examples/Migrate", {
  payload: { migration: Schema.String },
  success: Schema.String,
  error: Interrupted,
  body: (payload: { readonly migration: string }) => Apply.call(payload)
})

/** What one cache scenario observed. */
export interface CacheSummary {
  /** What each of the two runs answered. */
  readonly results: readonly [string, string]
  /** How many times the sealed body executed across both runs. */
  readonly executions: number
  /** Every time-to-live verdict the runs journalled, in order. */
  readonly verdicts: ReadonlyArray<string>
}

/** What the compensation scenario observed. */
export interface CompensationSummary {
  /** The value the run settled with. */
  readonly result: string
  /** The attempt numbers the body saw. */
  readonly attempts: ReadonlyArray<number>
  /** The workspace file after the run, which is the evidence. */
  readonly workspace: string
  /**
   * The snapshots the engine took, in order.
   *
   * Two pre-images per attempt and one post-image after it. The pair is not a
   * duplicate: one is the rollback boundary around the whole compensable
   * dispatch, the other is the attempt row's own pre-image, which is what an
   * adopted attempt restores after a crash. The post-image is what the boundary
   * diffs the pre-image against.
   */
  readonly snapshots: ReadonlyArray<string>
  /** The pre-images the engine put back before the retry. */
  readonly restores: ReadonlyArray<string>
}

const ttlVerdicts = (
  runId: string
): Effect.Effect<ReadonlyArray<string>, never, Journal.Journal> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 500 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) => entry.payload as { readonly action?: string; readonly verdict?: string })
      .filter((payload) => payload.action === "ttl" && typeof payload.verdict === "string")
      .map((payload) => payload.verdict!)
  }).pipe(Effect.orDie)

/**
 * Runs the same sealed step in two separate runs under one cache policy.
 *
 * With a generous `ttlMs` the second run reads the recorded row and journals
 * `admitted`. With `ttlMs: 1` and a pause between the runs the row has aged
 * out, so the second run journals `expired` and executes the body again.
 */
export const cached = (
  filename: string,
  options: { readonly ttlMs: number; readonly pauseMs: number; readonly prefix: string }
): Effect.Effect<CacheSummary> =>
  Effect.gen(function*() {
    let executions = 0

    /**
     * The sealed step whose result is addressable across runs. `idempotencyKey`
     * gives it an identity a second run can derive, the hard boundary declares
     * it hermetic, and the policy states how long the row stays good.
     */
    const compile = CacheEnvironment.withCache(
      Action.make({
        name: "examples/CachedCompile",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "examples/cached-compile/v1",
        metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
        execute: Effect.sync(() => {
          executions += 1
          return "dist/server.js"
        })
      }),
      { ttlMs: options.ttlMs, scope: "shared" }
    )

    const stack = Layer.mergeAll(
      Build.toLayer(({ target }) => Effect.map(compile, (artifact) => `${artifact}?target=${target}`)),
      Interpreter.layer(Package)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      // A sealed step never asks for a pre-image, so the cache half runs on
      // `durable-layer.ts`'s recording-nothing stub. Only the compensable half
      // below needs a version-control service that really moves files.
      Layer.provideMerge(engine(filename, "examples-cache", stubJj))
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const first = yield* Package.execute({ target: "server" }, { executionId: `${options.prefix}-1` })
        if (options.pauseMs > 0) yield* Effect.sleep(`${options.pauseMs} millis`)
        const second = yield* Package.execute({ target: "server" }, { executionId: `${options.prefix}-2` })
        const verdicts = [
          ...yield* ttlVerdicts(`${options.prefix}-1`),
          ...yield* ttlVerdicts(`${options.prefix}-2`)
        ]
        return { results: [first, second] as const, executions, verdicts } satisfies CacheSummary
      }).pipe(Effect.provide(stack))
    )
  }).pipe(Effect.orDie)

/**
 * Runs a compensable step that fails halfway through its first attempt.
 *
 * The body appends to a real file before it fails, so the pre-image is the only
 * thing standing between attempt two and a doubled migration.
 */
export const compensated = (
  filename: string,
  directories: { readonly workspace: string; readonly snapshots: string }
): Effect.Effect<CompensationSummary> =>
  Effect.gen(function*() {
    const log = { snapshots: [] as Array<string>, restores: [] as Array<string> }
    const attempts: Array<number> = []
    const ledger = join(directories.workspace, "schema.sql")

    yield* Effect.sync(() => {
      mkdirSync(directories.workspace, { recursive: true })
      mkdirSync(directories.snapshots, { recursive: true })
      writeFileSync(ledger, "-- base\n")
    })

    /**
     * A compensable step: it writes before it can fail, so the engine takes a
     * pre-image first and restores it before the retry.
     */
    const applyMigration = Action.make({
      name: "examples/ApplyMigrationStep",
      success: Schema.String,
      error: Interrupted,
      tier: "compensable",
      execute: Effect.gen(function*() {
        const attempt = yield* Action.CurrentAttempt
        attempts.push(attempt)
        yield* Effect.sync(() => {
          writeFileSync(ledger, `${readFileSync(ledger, "utf8")}ALTER TABLE runs ADD COLUMN lane;\n`)
        })
        // The write is already on disk. Failing here is what a half-applied
        // migration looks like, and it is what the pre-image undoes.
        if (attempt === 1) return yield* Effect.fail(new Interrupted({ attempt }))
        return "applied"
      })
    })

    const stack = Layer.mergeAll(
      Apply.toLayer(({ migration }) =>
        Action.retry(applyMigration, { times: 1 }).pipe(
          Effect.map((outcome) => `${migration}:${outcome}`)
        )
      ),
      Interpreter.layer(Migrate)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(engine(filename, "examples-compensate", directoryJj({ ...directories, log })))
    )

    const result = yield* Effect.scoped(
      Migrate.execute({ migration: "0007-lane" }, { executionId: "migrate-1" }).pipe(
        Effect.provide(stack)
      )
    )

    return {
      result,
      attempts,
      workspace: readFileSync(ledger, "utf8"),
      snapshots: log.snapshots,
      restores: log.restores
    } satisfies CompensationSummary
  }).pipe(Effect.orDie)
