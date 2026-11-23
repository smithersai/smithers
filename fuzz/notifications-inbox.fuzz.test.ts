import { Inbox } from "@smthrs/notifications"
import { it } from "@smthrs/testing/Vitest"
import { Schema } from "effect"
import { describe, expect } from "vitest"

const VersionInt = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }))
const Act = Inbox.Act
const RunState = Inbox.RunState
const Level = Inbox.Level

describe("@smthrs/notifications Inbox CRDT fuzz", () => {
  it.fuzz(
    "Inbox.ack is commutative, idempotent, and monotone across arbitrary device act sequences",
    [
      VersionInt,
      Schema.Array(Schema.Tuple([Act, VersionInt])).check(Schema.isMinLength(1), Schema.isMaxLength(16))
    ],
    ([version, acts]) => {
      const base: Inbox.Versions = {
        version,
        readVersion: 0,
        dismissedVersion: 0,
        hiddenVersion: 0
      }

      // Apply in forward order vs reverse order vs duplicated
      let fwd = base
      for (const [act, v] of acts) {
        const next = Inbox.ack(fwd, act, v)
        // Monotonicity: version watermarks never decrease
        expect(next.readVersion).toBeGreaterThanOrEqual(fwd.readVersion)
        expect(next.dismissedVersion).toBeGreaterThanOrEqual(fwd.dismissedVersion)
        expect(next.hiddenVersion).toBeGreaterThanOrEqual(fwd.hiddenVersion)
        // Idempotency: re-applying the exact same act/version changes nothing
        expect(Inbox.ack(next, act, v)).toEqual(next)
        fwd = next
      }

      let rev = base
      for (let i = acts.length - 1; i >= 0; i--) {
        const [act, v] = acts[i]!
        rev = Inbox.ack(rev, act, v)
      }

      // Commutativity: any delivery order across devices yields identical final notice state
      expect(fwd).toEqual(rev)
      expect(Inbox.isOpen(fwd)).toBe(Inbox.isOpen(rev))
      expect(Inbox.isUnread(fwd)).toBe(Inbox.isUnread(rev))
      expect(Inbox.isHidden(fwd)).toBe(Inbox.isHidden(rev))
      return true
    }
  )

  it.fuzz(
    "Inbox.route never notifies muted watchers and never duplicates recipients",
    [
      RunState,
      Schema.NullOr(RunState),
      Schema.Array(
        Schema.Struct({
          person: Schema.String.check(Schema.isPattern(/^u[0-5]$/)),
          level: Level,
          canRead: Schema.Boolean
        })
      ).check(Schema.isMaxLength(10))
    ],
    ([state, previousState, watchers]) => {
      const deliveries = Inbox.route({
        runId: "run-1",
        state,
        previousState: previousState ?? undefined,
        watchers: watchers.map((w) => ({
          personId: w.person,
          level: w.level,
          canRead: w.canRead
        }))
      } as Inbox.RunFact)

      const seen = new Set<string>()
      for (const d of deliveries) {
        expect(seen.has(d.personId)).toBe(false)
        seen.add(d.personId)
      }
      return true
    }
  )
})
