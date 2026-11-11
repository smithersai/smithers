/**
 * The liveness answer the engine steals runs on.
 *
 * `EngineStore` asks this before it takes a run whose recorded owner it is
 * not, so the two ways of being wrong are not symmetric: a wrong `true`
 * strands a run until an operator looks at it, and a wrong `false` runs one
 * run twice. These cases pin which way each input errs.
 */
import { describe, expect, it } from "@effect/vitest"
import type * as OwnerId from "@smthrs/journal/OwnerId"
import { Effect } from "effect"
import * as HostLiveness from "../src/HostLiveness.ts"

/** Throws the way `process.kill` does for one errno. */
const throwing = (code: string) => (pid: number): never => {
  const error: Error & { code?: string } = new Error(`${code}: ${pid}`)
  error.code = code
  throw error
}

describe("HostLiveness.isAlive", () => {
  it.effect("reports this host's own live process as alive", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({ hostId: "engine" })

      expect(yield* isAlive({ hostId: "engine", pid: process.pid })).toBe(true)
    }))

  it.effect("reports a pid this host no longer has as dead", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({ hostId: "engine" })

      // Pid 0 is the caller's own process group on POSIX and never a process,
      // so the probe is asked about a pid that cannot be a running owner.
      expect(yield* isAlive({ hostId: "engine", pid: 2_147_483_646 })).toBe(false)
    }))

  it.effect("never declares another host's owner dead", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({
        hostId: "engine",
        signal: () => {
          throw new Error("a foreign host's pid must not be probed on this machine")
        }
      })

      expect(yield* isAlive({ hostId: "other-machine", pid: 2_147_483_646 })).toBe(true)
    }))

  it.effect("treats a pid it may not signal as a live owner", () =>
    Effect.gen(function*() {
      // `process.kill` reports a process owned by another user as EPERM: the
      // owner exists, and this host simply may not touch it.
      const isAlive = HostLiveness.isAlive({ hostId: "engine", signal: throwing("EPERM") })

      expect(yield* isAlive({ hostId: "engine", pid: 1 })).toBe(true)
    }))

  it.effect("treats an unknown signal error as a live owner", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({ hostId: "engine", signal: throwing("EINVAL") })

      expect(yield* isAlive({ hostId: "engine", pid: 1 })).toBe(true)
    }))

  it.effect("reads a missing-process error as a dead owner", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({ hostId: "engine", signal: throwing("ESRCH") })

      expect(yield* isAlive({ hostId: "engine", pid: 1 })).toBe(false)
    }))

  /**
   * The engine asks only after the owner's lease expired. An owner with the
   * claimant's host and pid but another nonce is an earlier incarnation of
   * the claimant, so the process its pid names is the claimant itself (#4998).
   */
  it.effect("reports an earlier incarnation under the claimant's own pid as dead", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({
        hostId: "engine",
        signal: () => {
          throw new Error("the claimant's own pid must not be probed")
        }
      })
      const claimant: OwnerId.OwnerId = { hostId: "engine", pid: 1, nonce: "restarted" }

      expect(yield* isAlive({ hostId: "engine", pid: 1, nonce: "crashed" }, { claimant })).toBe(false)
    }))

  it.effect("probes an owner that differs from the claimant by pid", () =>
    Effect.gen(function*() {
      const probed: Array<number> = []
      const isAlive = HostLiveness.isAlive({ hostId: "engine", signal: (pid) => void probed.push(pid) })
      const claimant: OwnerId.OwnerId = { hostId: "engine", pid: 1, nonce: "claimant" }

      expect(yield* isAlive({ hostId: "engine", pid: 2, nonce: "sibling" }, { claimant })).toBe(true)
      expect(yield* isAlive({ hostId: "engine", pid: 1, nonce: "claimant" }, { claimant })).toBe(true)
      expect(probed).toEqual([2, 1])
    }))

  it.effect("keeps another host's owner alive whatever the claimant's pid", () =>
    Effect.gen(function*() {
      const isAlive = HostLiveness.isAlive({ hostId: "engine" })
      const claimant: OwnerId.OwnerId = { hostId: "other", pid: 1, nonce: "restarted" }

      expect(yield* isAlive({ hostId: "other", pid: 1, nonce: "crashed" }, { claimant })).toBe(true)
    }))

  /**
   * The probe reads `code` off whatever was thrown. A thrown string, or a
   * thrown `null`, carries no `code` at all, and the rule that only `ESRCH`
   * means gone has to hold for those too: an owner nobody could ask about is a
   * live owner, not a run to steal.
   */
  it.effect("treats a throw that carries no errno as a live owner", () =>
    Effect.gen(function*() {
      const nonObject = HostLiveness.isAlive({
        hostId: "engine",
        signal: () => {
          throw "boom"
        }
      })
      const nullish = HostLiveness.isAlive({
        hostId: "engine",
        signal: () => {
          throw null
        }
      })

      expect(yield* nonObject({ hostId: "engine", pid: 1 })).toBe(true)
      expect(yield* nullish({ hostId: "engine", pid: 1 })).toBe(true)
    }))

  /**
   * `Owner` is structural on purpose: the JSDoc claims a journal `OwnerId` is
   * accepted here without this package taking a dependency on the journal to
   * name a type. A claim about another package's type is only true while that
   * type still has the shape, so it is asserted rather than restated.
   */
  it.effect("accepts a journal OwnerId as the owner it decides about", () =>
    Effect.gen(function*() {
      const owner: OwnerId.OwnerId = { hostId: "engine", pid: process.pid, nonce: "abc" }
      const accepted: HostLiveness.Owner = owner

      expect(yield* HostLiveness.isAlive({ hostId: "engine" })(accepted)).toBe(true)
      expect(yield* HostLiveness.isAlive({ hostId: "other" })(accepted)).toBe(true)
    }))
})
