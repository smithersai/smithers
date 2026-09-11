/**
 * Per-digest coordination for filesystem publication and removal.
 *
 * The semaphore is the cheap in-process path. A `wx` lock file is the actual
 * workspace-wide fence: every process that can mutate the object directory
 * observes it, and a crashed owner is recovered after its heartbeat expires.
 *
 * @since 1.0.0-rc.0
 */
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Random from "effect/Random"
import * as Semaphore from "effect/Semaphore"

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const locks = new WeakMap<FileSystem.FileSystem, Map<string, Entry>>()

/**
 * The subdirectory of the objects directory that holds lock files and their
 * stale-owner tombstones. Named here rather than spelled in each caller so the
 * store's crash-orphan sweep reclaims exactly what this module creates.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const directoryName = ".locks"
const heartbeatEvery = "10 seconds"
const staleAfterMs = 60_000
const acquireWithin = "2 minutes"
const retryEvery = "25 millis"

const isReason = (cause: unknown, tag: PlatformError.SystemErrorTag): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === tag

const token = Effect.gen(function*() {
  const first = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  const second = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  return `${first.toString(36)}-${second.toString(36)}-${yield* Clock.currentTimeMillis}`
})

/**
 * Coordinates publication, freshening, and sweep deletion for one digest.
 * `process` is the explicit weaker mode for hosts without atomic create.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const withDigest = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  digest: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  coordination: "required" | "process" = "required"
): Effect.Effect<A, E | E2, R> =>
  // Every execution of the returned effect claims its own share of the entry,
  // which is why the whole body is suspended rather than run when `withDigest`
  // is called. A count taken at construction is wrong in both directions: an
  // effect built and discarded pins an entry nothing will ever release, and one
  // built once and run repeatedly — `ArtifactBackupLease` builds its gate once
  // and runs it on every heartbeat — retires the entry underneath a live holder,
  // so the next caller mints a second semaphore for the same digest and the two
  // serialize against nothing.
  Effect.suspend(() => {
    let byKey = locks.get(fs)
    if (byKey === undefined) {
      byKey = new Map()
      locks.set(fs, byKey)
    }
    const key = JSON.stringify([directory, digest])
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      byKey.set(key, entry)
    }
    entry.users += 1
    const held = entry
    const table = byKey

    // The deadline starts before the semaphore wait and ends once both locks
    // are held. The protected operation and its release are never timed out.
    const ready = Deferred.makeUnsafe<void>()
    const deadline = Deferred.await(ready).pipe(
      Effect.timeout(acquireWithin),
      Effect.catchTag("TimeoutError", (cause) => Effect.fail(failure(cause))),
      Effect.andThen(Effect.never)
    )
    const coordinated = coordination === "process"
      ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(effect))
      : Effect.gen(function*() {
        const owner = yield* token
        const lockDirectory = `${directory}/${directoryName}`
        const lockPath = `${lockDirectory}/${digest}.lock`
        yield* fs.makeDirectory(lockDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failure))
        /**
         * Whether this call created the lock file, and therefore owes a release.
         * It is set in the same uninterruptible step that creates the file, so
         * interruption striking between the two cannot leak a lock nothing
         * releases — the only party that would ever reclaim it is a later
         * acquirer of the same digest, which may never come.
         */
        let acquired = false

        const readOwner = (path: string): Effect.Effect<Option.Option<string>, E2> =>
          fs.readFileString(path).pipe(
            Effect.map(Option.some),
            Effect.catch((cause): Effect.Effect<Option.Option<string>, E2> =>
              isReason(cause, "NotFound") ? Effect.succeed(Option.none()) : Effect.fail(failure(cause))
            )
          )

        const isStale = (path: string): Effect.Effect<boolean, E2> =>
          Effect.gen(function*() {
            const info = yield* fs.stat(path).pipe(
              Effect.map(Option.some),
              Effect.catch((cause): Effect.Effect<Option.Option<FileSystem.File.Info>, E2> =>
                isReason(cause, "NotFound") ? Effect.succeed(Option.none()) : Effect.fail(failure(cause))
              )
            )
            const modified = Option.isSome(info) ? Option.getOrUndefined(info.value.mtime) : undefined
            return modified !== undefined && (yield* Clock.currentTimeMillis) - modified.getTime() > staleAfterMs
          })

        const removeIfOwnedBy = (path: string, expected: string): Effect.Effect<void> =>
          fs.readFileString(path).pipe(
            Effect.flatMap((found) => found === expected ? fs.remove(path) : Effect.void),
            Effect.ignore
          )

        const acquire = Effect.gen(function*() {
          while (true) {
            const created = yield* Effect.uninterruptible(
              fs.writeFileString(lockPath, owner, { flag: "wx", mode: 0o600 }).pipe(
                Effect.andThen(Effect.sync(() => {
                  acquired = true
                  return true
                })),
                Effect.catch((cause): Effect.Effect<boolean, E2> =>
                  isReason(cause, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(failure(cause))
                )
              )
            )
            if (created) return

            // The owner is read before the age, so a stale verdict always
            // belongs to the lock generation this read named.
            const observed = yield* readOwner(lockPath)
            if (Option.isNone(observed)) continue
            if (yield* isStale(lockPath)) {
              const reclaimed = yield* reclaim(observed.value)
              if (reclaimed) continue
            }
            yield* Effect.sleep(retryEvery)
          }
        })

        /**
         * Moves away the stale lock generation `observed` names, at most once.
         *
         * Measuring a lock and renaming it are two steps, so two contenders
         * that both measure the same generation as stale would otherwise both
         * rename, and the second would move away the fresh lock the first just
         * took. Reclaimers of one generation therefore race for a `wx` claim
         * named after its owner token first. Only the winner renames, and only
         * after re-reading that the path still holds that stale generation. A
         * loser, or a winner whose generation is already gone, moves nothing.
         * Owner tokens are unique per acquisition, so a claim never outlives
         * the generation it names in any way that matters.
         */
        const reclaim = (observed: string): Effect.Effect<boolean, E2> => {
          const claimPath = `${lockPath}.reclaim-${observed.replace(/[^0-9A-Za-z-]/g, "_").slice(0, 96)}`
          return Effect.acquireUseRelease(
            fs.writeFileString(claimPath, owner, { flag: "wx", mode: 0o600 }).pipe(
              Effect.as(true),
              Effect.catch((cause): Effect.Effect<boolean, E2> =>
                isReason(cause, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(failure(cause))
              )
            ),
            (claimed) =>
              Effect.gen(function*() {
                if (!claimed) {
                  // A claimant that died mid-reclaim leaves its claim behind.
                  // It ages out on the same bound as a lock.
                  const holder = yield* readOwner(claimPath)
                  if (Option.isSome(holder) && (yield* isStale(claimPath))) {
                    yield* removeIfOwnedBy(claimPath, holder.value)
                  }
                  return false
                }
                const current = yield* readOwner(lockPath)
                if (Option.isNone(current) || current.value !== observed || !(yield* isStale(lockPath))) return true
                const tombstone = `${lockPath}.stale-${owner}`
                const moved = yield* fs.rename(lockPath, tombstone).pipe(
                  Effect.as(true),
                  Effect.catch((cause): Effect.Effect<boolean, E2> =>
                    isReason(cause, "NotFound") ? Effect.succeed(false) : Effect.fail(failure(cause))
                  )
                )
                if (!moved) return true
                // Only a stalled owner releasing between the re-read and the
                // rename, and a new owner acquiring in that gap, puts a live
                // lock here. Hand it back with an atomic create, which cannot
                // displace anyone who took the path since.
                const displaced = yield* readOwner(tombstone)
                if (Option.isSome(displaced) && displaced.value !== observed) {
                  yield* fs.writeFileString(lockPath, displaced.value, { flag: "wx", mode: 0o600 }).pipe(Effect.ignore)
                }
                yield* fs.remove(tombstone).pipe(Effect.ignore)
                return true
              }),
            (claimed) => claimed ? removeIfOwnedBy(claimPath, owner) : Effect.void
          )
        }

        const release = fs.readFileString(lockPath).pipe(
          Effect.flatMap((found) => found === owner ? fs.remove(lockPath) : Effect.void),
          // A concurrent stale-lock reaper can win release. `NotFound`
          // means no lock remains for this owner to release or leak.
          Effect.catch((cause): Effect.Effect<void, E2> =>
            isReason(cause, "NotFound") ? Effect.void : Effect.fail(failure(cause))
          )
        )

        // The finalizer is attached around acquisition itself, not just around
        // the protected effect, so a lock created moments before an interruption
        // is still released. A call that never created one owes nothing and must
        // not touch a file another owner holds.
        return yield* acquire.pipe(
          Effect.andThen(Deferred.succeed(ready, undefined)),
          Effect.andThen(Effect.scoped(Effect.gen(function*() {
            yield* Effect.forkScoped(
              Effect.gen(function*() {
                while (true) {
                  yield* Effect.sleep(heartbeatEvery)
                  // Freshen only a lock this call still owns, the same comparison
                  // the release below makes. A holder stalled past the stale
                  // bound has already been reaped and replaced, and touching that
                  // pathname anyway would hold a stranger's lock fresh forever: a
                  // replacement that is then hard-killed could never be judged
                  // stale while this zombie ran, so every later acquirer of the
                  // digest would burn the full two-minute deadline and fail.
                  const beat = yield* fs.readFileString(lockPath).pipe(
                    Effect.map((found) => found === owner ? "own" as const : "foreign" as const),
                    Effect.catch((cause) =>
                      Effect.succeed(isReason(cause, "NotFound") ? "gone" as const : "unreadable" as const)
                    )
                  )
                  if (beat === "own") {
                    const timestamp = new Date(yield* Clock.currentTimeMillis)
                    yield* Effect.ignore(fs.utimes(lockPath, timestamp, timestamp))
                    continue
                  }
                  // A read the host refused for any other reason is no evidence
                  // either way, so this beat is skipped and the next one retries.
                  // Ending the heartbeat on it would retire a lock this call
                  // still holds: the file goes stale within the minute, another
                  // process reaps it, and this holder keeps working unfenced.
                  if (beat === "unreadable") continue
                  // `gone` and `foreign` are the two states worth an operator
                  // signal: this call's lock was reaped, and possibly already
                  // replaced, while the effect it fences is still running, so
                  // the rest of that publication or sweep deletion proceeds
                  // unfenced against every other process. The heartbeat is the
                  // only party that ever observes it — the protected effect is
                  // not interrupted and the caller is not failed — so retiring
                  // the fiber silently would leave no trace at all.
                  yield* Effect.logWarning(
                    "Artifact lock was reclaimed while its holder was still running",
                    { digest, state: beat }
                  )
                  return
                }
              })
            )
            return yield* effect
          }))),
          Effect.onExit(() => acquired ? release : Effect.void)
        )
      })

    return held.semaphore.withPermit(coordinated).pipe(
      Effect.raceFirst(deadline),
      Effect.ensuring(Effect.sync(() => {
        held.users -= 1
        if (held.users === 0 && table.get(key) === held) table.delete(key)
      }))
    )
  })
