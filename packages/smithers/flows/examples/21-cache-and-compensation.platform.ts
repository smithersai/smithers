// The platform code of 21-cache-and-compensation.vibe, which a .vibe file does not import as a value (EK4402).

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { NodeRuntime } from "@smthrs/platform-node"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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
 * `TestNodeRuntime.stubJj` in `TestNodeRuntime` records nothing, which is honest for examples
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
          // Published directory snapshots are immutable; both names resolve to this pre-image.
          return { changeId: changeId as never, commitId: changeId as never }
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
 * The engine `TestNodeRuntime` builds, plus the two things this example needs
 * it to have: a real `Jj`, and the complete cache environment a cross-run key
 * is derived from.
 *
 * Both are provided BENEATH the engine, where the dispatch reads them, rather
 * than beside the caller.
 */
export const engine = (filename: string, hostId: string, jj: Layer.Layer<Jj.Jj>) =>
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

/**
 * The migration ledger file inside the compensable step's workspace.
 *
 * @throws {never}
 */
export const ledgerIn = (workspace: string): string => join(workspace, "schema.sql")

/** Creates the workspace and snapshot directories and the base ledger. */
export const prepareDirectories = (
  directories: { readonly workspace: string; readonly snapshots: string },
  ledger: string
) =>
  Effect.sync(() => {
    mkdirSync(directories.workspace, { recursive: true })
    mkdirSync(directories.snapshots, { recursive: true })
    // A replay reuses migrate-1: it must preserve the already-applied schema.
    if (!existsSync(ledger)) writeFileSync(ledger, "-- base\n", { flag: "wx" })
  })

/** Appends the migration statement to the ledger: the write before the failure. */
export const appendMigration = (ledger: string) =>
  Effect.sync(() => {
    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}ALTER TABLE runs ADD COLUMN lane;\n`)
  })

/** The ledger file's content, which is the evidence. */
export const readLedger = (ledger: string) => Effect.sync(() => readFileSync(ledger, "utf8"))
