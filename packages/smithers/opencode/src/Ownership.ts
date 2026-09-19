/**
 * Which server owns the directory it serves.
 *
 * One directory is one server's. Two servers over the same directory share
 * its store and do not share their event hubs, so each client is told half of
 * what happened: the second server answers a card the first one parked, takes
 * the row down, publishes the reply to its own subscribers, and hands the
 * answer to a driver with no turn to resume. The second server refuses to
 * start instead.
 *
 * The claim is a record of who holds the directory, not a lock on it.
 * `<directory>/.smithers/opencode.server.json` names the owner the way the
 * engine names the owner of a run, as an `OwnerId`: the host, the process,
 * and a nonce that separates two incarnations on one host. A server that
 * finds a record asks the question the engine asks before it takes a run from
 * a peer owner, with the engine's own probe
 * (`Ownership.sameHostPidProbe` in `@smthrs/run-store`): is that process still
 * there? `process.kill(pid, 0)` sends no signal, and only `ESRCH`, no such
 * process, counts as death. A record whose process is gone is what a crashed
 * server left behind, so it is replaced rather than obeyed, and a SIGKILL
 * does not cost the person their directory.
 *
 * A process id means nothing outside the namespace that issued it, so a
 * record written on another host is refused rather than probed. That is the
 * answer `@smthrs/platform-node`'s `HostLiveness.isAlive` gives for the same
 * reason, and the refusal names the record so the person can remove it. The
 * one case the probe cannot separate is a process id the operating system
 * reused: the record then names a live process that is not a server, and
 * the refusal says which file to delete.
 *
 * The record is created exclusively, so of two servers starting on one
 * directory at the same moment one creates it and the other reads it and
 * refuses.
 *
 * The claim is taken before the driver opens the store, because a second
 * server that got as far as its store has already done the damage: the
 * engine re-drives whatever turn the store holds open.
 *
 * @since 1.0.0
 */
import { Ownership } from "@smthrs/run-store"
import { Effect, Schema, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * The server that holds a directory: the owner identity the engine uses for
 * a run, and the address that server serves.
 *
 * @category models
 * @since 1.0.0
 */
export interface Claim {
  readonly owner: Ownership.OwnerId
  readonly url: string
}

/**
 * The record naming the server that holds a directory:
 * `<directory>/.smithers/opencode.server.json`, beside the store both
 * servers would otherwise share.
 *
 * @category getters
 * @since 1.0.0
 */
export const claimPath = (directory: string): string => join(resolve(directory), ".smithers", "opencode.server.json")

/**
 * A directory another live server holds. The message is the refusal.
 *
 * @category errors
 * @since 1.0.0
 */
export class ClaimRefused extends Schema.TaggedError<ClaimRefused>()("@smthrs/opencode/ClaimRefused", {
  message: Schema.String
}) {}

/**
 * The sentence a second server refuses with: which server holds the
 * directory, why that is not shareable, and the three ways out.
 *
 * @category conversions
 * @since 1.0.0
 */
export const refusal = (held: Claim, directory: string): string =>
  `Refusing to serve ${
    resolve(directory)
  }: process ${held.owner.pid} on ${held.owner.hostId} already serves it at ${held.url}. Two servers over one directory share its store and not their events, so each client sees half of what happened. Stop that server, serve another directory, or, if process ${held.owner.pid} is not that server, delete ${
    claimPath(directory)
  } and start again.`

/**
 * Whether the server a record names is still there.
 *
 * On the claimant's own host this is the engine's probe, unchanged: the
 * process is alive unless the operating system says no such process exists.
 * The probe reads neither the lease nor the clock, which the engine's runs
 * carry and a server's directory does not, so both are passed empty. A
 * record from another host names a process this host cannot ask about, so it
 * is treated as live.
 *
 * @category predicates
 * @since 1.0.0
 */
export const live = (
  held: Claim,
  claimant: Ownership.OwnerId
): Effect.Effect<boolean> =>
  Ownership.sameHostIncarnation(held.owner, claimant)
    ? Ownership.sameHostPidProbe(held.owner, { claimant, heartbeatAtMs: null, nowMs: 0 })
    : Effect.succeed(true)

/**
 * The record on disk, or `undefined` when there is none and when what is
 * there is not one. A record nothing can read is a truncated write or a
 * file someone else put there, and either way it names no server.
 *
 * @category getters
 * @since 1.0.0
 */
export const read = (directory: string): Claim | undefined => {
  let content: string
  try {
    content = readFileSync(claimPath(directory), "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { readonly owner?: unknown; readonly url?: unknown }
  const owner = record.owner
  if (typeof owner !== "object" || owner === null) return undefined
  const fields = owner as { readonly hostId?: unknown; readonly pid?: unknown; readonly nonce?: unknown }
  if (typeof fields.hostId !== "string" || typeof fields.pid !== "number" || typeof fields.nonce !== "string") {
    return undefined
  }
  if (typeof record.url !== "string") return undefined
  return { owner: { hostId: fields.hostId, pid: fields.pid, nonce: fields.nonce }, url: record.url }
}

/** Writes the record, and says whether this call is the one that created it. */
const create = (directory: string, mine: Claim): boolean => {
  const path = claimPath(directory)
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, `${JSON.stringify(mine)}\n`, { flag: "wx" })
    return true
  } catch {
    return false
  }
}

/**
 * How the claim identifies this server.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly directory: string
  /** The address this server serves, for the refusal the next one prints. */
  readonly url: string
  /** This server's identity. A fresh nonce on this host and process by default. */
  readonly owner?: Ownership.OwnerId | undefined
}

/**
 * Takes the directory for this server, and gives it back when the scope
 * closes. Fails with {@link ClaimRefused} when another live server holds it.
 *
 * The record of a server that is gone is replaced. The record this server
 * wrote is removed on shutdown, so an ordinary stop and start needs no
 * probe at all; a server that was killed leaves its record behind and the
 * next one replaces it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const claim = (options: Options): Effect.Effect<Claim, ClaimRefused, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function*() {
      const mine: Claim = {
        owner: options.owner ?? { hostId: hostname(), pid: process.pid, nonce: randomUUID() },
        url: options.url
      }
      if (create(options.directory, mine)) return mine
      const held = read(options.directory)
      if (held !== undefined && (yield* live(held, mine.owner))) {
        return yield* Effect.fail(new ClaimRefused({ message: refusal(held, options.directory) }))
      }
      // The record names a server that is gone, or is not a record at all.
      writeFileSync(claimPath(options.directory), `${JSON.stringify(mine)}\n`)
      return mine
    }),
    (mine) =>
      Effect.sync(() => {
        // Another server may have replaced a record this one was too slow to
        // remove; releasing then would hand it the directory it is serving.
        if (read(options.directory)?.owner.nonce === mine.owner.nonce) {
          rmSync(claimPath(options.directory), { force: true })
        }
      })
  )
