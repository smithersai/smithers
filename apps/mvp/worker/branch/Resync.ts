import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { SandboxTools } from "@smthrs/sandbox"
import { SharedText } from "@smthrs/sync"
import { Clock, Effect, Metric, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { SqlClient, SqlError } from "effect/sql"
import { TEXT_NAMESPACE, textName } from "../../src/features/coedit/contract.ts"
import { SAVED_MARK, savedMarkOf } from "../../src/features/coedit/saved.ts"
import { codeOf } from "../ErrorCode.ts"
import type { Repository } from "../github/Config.ts"
import { Forge } from "./Forge.ts"
import { Machines } from "./Machines.ts"
import type { BranchRow, Publication } from "./Publish.ts"
import type { SandboxBranch } from "./Sandboxes.ts"

// Resync (docs/features/branch-publish.md#resync; ruling GH-6, Will, 2026-10-20 06:39: "update branch resync"): a
// published branch's GitHub branch moves on GitHub (an Update branch's merge, a push, a commit on github.com), and the
// Smithers branch and its working copy follow it, keeping every change only the working copy has.
//
//   the Smithers branch    its ephemeral ref on Code Storage moved to GitHub's head (`Forge.move`), so the machine's
//                          scoped fetch reaches it; a commit the mirror hasn't synced yet asks it to sync, then waits
//   plan                   on the machine, as the person: the working copy merged onto GitHub's head with git's own
//                          merge base, changing nothing (`SandboxTools.rebaseCall`): conflicted files, or the files
//                          whose contents would change
//   co-edited files        each changed file's open text must hold what the working copy holds; one with typing the
//                          working copy hasn't (unsaved) stops the resync, listed, before anything changes
//   apply                  HEAD to GitHub's head, the working copy's own changes uncommitted on top; fenced by the tree
//                          the plan saw, so a Save meanwhile plans again
//   texts, the record      each recorded text brought to the file's new contents, and the publication synced to the
//                          head, in one transaction
//
// Every step can run again: the ref move is to one commit, the plan changes nothing, the apply is fenced and a no-op once
// HEAD is there, and the texts to bring along are recorded before the working copy changes. Nothing here retries; a step
// that fails `ResyncUnavailable` is tried again by its flow. Records carry ids, counts and outcomes, never a path.

/** The machine, Code Storage or Postgres couldn't answer, or the mirror hasn't GitHub's head yet: tried again. */
export class ResyncUnavailable extends Schema.TaggedError<ResyncUnavailable>()("@smthrs/mvp/branch/ResyncUnavailable", {
  retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/** The machine or the forge refused (`invalid`), or more paths changed than one read lists (`too_large`). */
export class ResyncRefused extends Schema.TaggedError<ResyncRefused>()("@smthrs/mvp/branch/ResyncRefused", {
  failure: Schema.Literals(["invalid", "too_large"]),
}) {}

/** How long a resync waits before trying again when the mirror hasn't synced GitHub's head yet. */
export const MIRROR_WAIT_MS = 5_000

/** How a resync ended: the working copy at GitHub's head, or the files that stopped it. */
export type Resynced =
  | { readonly state: "synced"; readonly sha: string }
  | { readonly state: "conflict"; readonly paths: ReadonlyArray<string> }

/** Resyncs, by `outcome`: `synced`, `conflict`, `unavailable` or the refusal. */
export const resyncs = Metric.counter("smithers_branch_resyncs", {
  description: "Resyncs of a published branch's working copy, by outcome",
  incremental: true,
})

/** The namespace a resync's machine call ids and text update ids are version 5 UUIDs of `<key>:<name>` in. */
export const RESYNC_NAMESPACE = "5b8e2c4d-1f3a-4e6b-9c7d-2a0f8e1b3c95"

/** What a resync works with: the branch, its publication, GitHub's head, as whom, and the key its ids derive from. */
export interface Resyncing {
  readonly branch: BranchRow
  readonly publication: Publication
  readonly repository: Repository
  /** The head GitHub's branch reached. */
  readonly onto: string
  /** The person whose own user runs the machine's tools, and who writes the texts' updates. */
  readonly actorId: string
  /** The write the resync runs for: its machine calls and text updates derive their ids from it. */
  readonly key: string
}

/** A file's text as Postgres holds it: every update, applied to a replica. */
interface Found {
  readonly textId: string
  readonly content: string
  readonly saved: string | undefined
  readonly updates: ReadonlyArray<Uint8Array>
}

/** The open texts of `paths` in branch `branchId`'s conversations, by path. */
const textsOf = (branchId: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (paths.length === 0) return new Map<string, Found>()
    const sql = yield* SqlClient.SqlClient
    const conversations = yield* sql<{ readonly id: string }>`
      SELECT id::text AS id FROM conversations WHERE branch_id = ${branchId}::uuid`
    const pathOf = new Map<string, string>()
    for (const { id } of conversations) {
      for (const path of paths) {
        const textId = yield* Uuid.v5(TEXT_NAMESPACE, textName({ kind: "file", conversation: id, path })).pipe(
          Effect.provide(WebCrypto.layer),
          Effect.orDie,
        )
        pathOf.set(textId, path)
      }
    }
    const rows = yield* sql<{ readonly textId: string; readonly data: string }>`
      SELECT text_id::text AS "textId", data FROM text_updates
      WHERE scope = ${`branch:${branchId}`} AND text_id = ANY(${[...pathOf.keys()]}::uuid[])`
    const updates = new Map<string, Array<Uint8Array>>()
    for (const row of rows) {
      const decoded = Base64.decode(row.data)
      // ChatApi stores only updates it validated; a row that isn't one is no text's content.
      if (decoded._tag === "Failure") continue
      updates.set(row.textId, [...(updates.get(row.textId) ?? []), decoded.success])
    }
    const found = new Map<string, Found>()
    for (const [textId, list] of updates) {
      const replica = yield* replicaOf(list)
      found.set(pathOf.get(textId)!, { textId, ...replica, updates: list })
    }
    return found
  })

/** A replica holding `updates`: its text and its `saved` mark. */
const replicaOf = (updates: ReadonlyArray<Uint8Array>) =>
  Effect.scoped(Effect.gen(function* () {
    const replica = yield* SharedText.make
    for (const update of updates) yield* Effect.ignore(replica.apply(update))
    return { content: yield* replica.text, saved: (yield* replica.marks).get(SAVED_MARK) }
  }))

/**
 * The updates that make `found`'s text `next`, keeping a `saved` mark that said the old text was saved: a Save wrote
 * it, so the working copy's new contents are saved too.
 */
const updatesTo = (found: Found, next: string) =>
  Effect.scoped(Effect.gen(function* () {
    const replica = yield* SharedText.make
    for (const update of found.updates) yield* Effect.ignore(replica.apply(update))
    const edit = yield* replica.replace(next)
    const mark = found.saved === savedMarkOf(found.content) ? yield* replica.mark(SAVED_MARK, savedMarkOf(next)) : undefined
    return [edit, mark].filter((update): update is Uint8Array => update !== undefined)
  }))

/** Brings branch `input.branch`'s Smithers branch and working copy to GitHub's head, as the module comment says. */
export const resync = (input: Resyncing) =>
  Effect.gen(function* () {
    const { branch, onto, actorId, key, repository } = input
    const sql = yield* SqlClient.SqlClient
    const machines = yield* Machines
    const forge = yield* Forge
    const machine: SandboxBranch = {
      branchId: branch.branchId,
      owner: repository.owner,
      name: repository.name,
      branch: branch.name,
      namespace: "ephemeral",
    }
    const idOf = (name: string) =>
      Uuid.v5(RESYNC_NAMESPACE, `${key}:${name}`).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)
    // Each attempt's calls are its own: every one can run again, and a call an earlier attempt lost stays lost.
    const attempt = yield* Clock.currentTimeMillis
    const call = (name: string, request: SandboxTools.Call) =>
      Effect.flatMap(idOf(`${onto}:${attempt}:${name}`), (callId) => machines.tool(machine, actorId, callId, request)).pipe(
        Effect.map((ran) => ran.result),
      )
    /** A machine that refused the call or couldn't check the branch out refuses the resync; one that didn't answer, retried. */
    const failureOf = (error: { readonly _tag: string }) =>
      error._tag === "@smthrs/mvp/branch/CheckoutFailed" || error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused"
        ? new ResyncRefused({ failure: "invalid" })
        : new ResyncUnavailable({})
    const tool = (name: string, request: SandboxTools.Call) => call(name, request).pipe(Effect.mapError(failureOf))
    const rebase = (name: string, options: SandboxTools.RebaseOptions) =>
      Effect.flatMap(tool(name, SandboxTools.rebaseCall(options)), (result) =>
        SandboxTools.rebased(result as typeof SandboxTools.RunResult.Type).pipe(
          // `not_found`: the ref's move hasn't reached the machine's fetch yet. Tried again, as an outage is.
          Effect.mapError((error) =>
            error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused" && error.reason === "not_a_repository"
              ? new ResyncRefused({ failure: "invalid" })
              : new ResyncUnavailable({})
          ),
        ))
    const listed = (name: string, count: number) =>
      count === 0
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.flatMap(tool(name, { tool: "read", path: SandboxTools.REBASE_PATHS }), (result) => {
          const read = result as typeof SandboxTools.ReadResult.Type
          return read.truncated
            ? Effect.fail(new ResyncRefused({ failure: "too_large" }))
            : Effect.succeed(SandboxTools.rebasePaths(read))
        })
    /** The working copy's file at `path`, or none when it has none; a file read only in part is none of a text's. */
    const fileOf = (name: string, path: string) =>
      call(name, { tool: "read", path }).pipe(
        Effect.map((result) => {
          const read = result as typeof SandboxTools.ReadResult.Type
          return read.truncated ? Option.none<string>() : Option.some(read.content)
        }),
        Effect.catchIf(
          (error) => error._tag === "@smthrs/sandbox/SandboxTools/ToolRefused" && error.reason === "not_found",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError(failureOf),
      )
    const conflicted = (paths: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE branch_publications SET sync_state = 'conflict', sync_conflicts = ${JSON.stringify(paths)}::jsonb,
            updated_at = now()
          WHERE branch_id = ${branch.branchId}::uuid`
        return { state: "conflict", paths } satisfies Resynced
      })

    // 1. The Smithers branch to GitHub's head, where the machine's scoped fetch finds it.
    yield* forge.move(repository, branch.name, onto).pipe(
      Effect.catchTag("CreateRefused", (refused) =>
        refused.code === "not_found"
          // The mirror hasn't synced GitHub's head yet: ask it to, then try again shortly.
          ? forge.pull(repository).pipe(
            Effect.catchTag("CreateRefused", (pulled) =>
              Effect.logWarning("branch.resync").pipe(
                Effect.annotateLogs({ writeId: key, outcome: "mirror_pull_failed", errorCode: pulled.code }),
              )),
            Effect.andThen(Effect.fail(new ResyncUnavailable({ retryAfterMillis: MIRROR_WAIT_MS }))),
          )
          : Effect.fail(refused.code === "unavailable" ? new ResyncUnavailable({}) : new ResyncRefused({ failure: "invalid" }))),
    )

    // 2. The plan, which changes nothing. Texts an earlier attempt recorded still come along.
    const plan = yield* rebase("plan", { branch: branch.name, onto })
    const texts: Record<string, string> = { ...input.publication.syncing }
    if (plan._tag === "Unrelated") return yield* conflicted([])
    if (plan._tag === "Conflicted") return yield* conflicted(yield* listed("conflicts", plan.paths))
    if (plan._tag === "Planned") {
      const changed = yield* listed("changed", plan.paths)
      const open = yield* textsOf(branch.branchId, changed)
      const unsaved: Array<string> = []
      for (const [path, found] of open) {
        const before = yield* fileOf(`before:${path}`, path)
        const recorded = texts[path]
        if (recorded !== undefined && digestSync(found.content) === recorded) continue
        // Its contents are the working copy's; a text of a file the working copy hasn't is empty to be.
        if (Option.getOrElse(before, () => "") === found.content) texts[path] = digestSync(found.content)
        else unsaved.push(path)
      }
      if (unsaved.length > 0) return yield* conflicted(unsaved)
      // Recorded before the working copy changes, so a step that runs again after it still brings these texts along.
      yield* sql`
        UPDATE branch_publications SET syncing = ${JSON.stringify(texts)}::jsonb WHERE branch_id = ${branch.branchId}::uuid`
      const applied = yield* rebase("apply", { branch: branch.name, onto, expect: plan.tree })
      // A Save landed between the plan and the apply: the next attempt plans again.
      if (applied._tag !== "Applied") return yield* new ResyncUnavailable({})
    }
    // Otherwise HEAD is GitHub's head already: a plan names no tree to apply on, so it never answers Moved or Applied.

    // 3. Each recorded text, if it still holds what it held, to the file's new contents; one someone typed in since is
    // left as it is and listed.
    const now = yield* textsOf(branch.branchId, Object.keys(texts))
    const typed: Array<string> = []
    const writes: Array<{ readonly id: string; readonly textId: string; readonly data: string }> = []
    for (const [path, found] of now) {
      const next = Option.getOrElse(yield* fileOf(`after:${path}`, path), () => "")
      if (found.content === next) continue
      if (digestSync(found.content) !== texts[path]) {
        typed.push(path)
        continue
      }
      const updates = yield* updatesTo(found, next)
      for (const [index, update] of updates.entries()) {
        writes.push({ id: yield* idOf(`${onto}:text:${found.textId}:${index}`), textId: found.textId, data: Base64.encode(update) })
      }
    }
    const state = typed.length > 0 ? "conflict" : "synced"
    yield* sql.withTransaction(Effect.gen(function* () {
      for (const write of writes) {
        yield* sql`
          INSERT INTO text_updates (id, scope, text_id, data, person_id)
          VALUES (${write.id}::uuid, ${`branch:${branch.branchId}`}, ${write.textId}::uuid, ${write.data}, ${actorId})
          ON CONFLICT (id) DO NOTHING`
      }
      yield* sql`
        UPDATE branch_publications SET synced_sha = ${onto}, head_sha = ${onto}, pushed_sha = ${onto}, pushed = '{}'::jsonb,
          sync_state = ${state}, sync_conflicts = ${typed.length > 0 ? JSON.stringify(typed) : null}::jsonb, syncing = NULL,
          updated_at = now()
        WHERE branch_id = ${branch.branchId}::uuid`
    }))
    return (typed.length > 0 ? { state: "conflict", paths: typed } : { state: "synced", sha: onto }) satisfies Resynced
  }).pipe(
    // Postgres didn't answer: tried again, as the machine's outage is.
    Effect.mapError((error) => SqlError.isSqlError(error) ? new ResyncUnavailable({}) : error),
    Effect.tap((resynced) =>
      Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(resyncs, { outcome: resynced.state }), 1)
        yield* Effect.logWithLevel(resynced.state === "synced" ? "Info" : "Warn")("branch.resync").pipe(
          Effect.annotateLogs({
            writeId: input.key,
            outcome: resynced.state,
            ...(resynced.state === "conflict" ? { files: resynced.paths.length } : {}),
          }),
        )
      })
    ),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const outcome = error._tag === "@smthrs/mvp/branch/ResyncRefused" ? error.failure : "unavailable"
        yield* Metric.update(Metric.withAttributes(resyncs, { outcome }), 1)
        yield* Effect.logWarning("branch.resync").pipe(Effect.annotateLogs({ writeId: input.key, outcome, errorCode: codeOf(error) }))
      })
    ),
    Effect.withSpan("branch.resync", { attributes: { "smithers.github.write": input.key } }),
  )
