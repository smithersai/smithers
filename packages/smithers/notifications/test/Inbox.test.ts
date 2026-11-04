/**
 * The per-person notice rules: who hears about a run or a subject, when a
 * notice raises again, and how acks from several devices merge.
 *
 * The merge cases are written as laws (either order, never back, never past the
 * notice's version) rather than as a second implementation, so a mistake made
 * twice cannot pass them.
 */
import { Schema } from "effect"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import * as Inbox from "../src/Inbox.vibe"
import { Inbox as RootInbox } from "../src/index.ts"

const params = {
  numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100),
  ...(process.env["FC_SEED"] === undefined ? {} : { seed: Number(process.env["FC_SEED"]) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const states: ReadonlyArray<Inbox.RunState> = ["working", "waiting", "needs_you", "failed", "done"]

describe("Inbox from the package root", () => {
  it("is the same module the subpath exports", () => {
    expect(RootInbox.route).toBe(Inbox.route)
    expect(RootInbox.ack).toBe(Inbox.ack)
  })
})

describe("Inbox schemas", () => {
  it("accept exactly the documented literals", () => {
    expect(Schema.decodeUnknownSync(Inbox.Level)("muted")).toBe("muted")
    expect(() => Schema.decodeUnknownSync(Inbox.Level)("loud")).toThrow()
    expect(Schema.decodeUnknownSync(Inbox.RunState)("needs_you")).toBe("needs_you")
    expect(() => Schema.decodeUnknownSync(Inbox.RunState)("live")).toThrow()
    expect(Schema.decodeUnknownSync(Inbox.Act)("hide")).toBe("hide")
    expect(() => Schema.decodeUnknownSync(Inbox.Act)("snooze")).toThrow()
  })

  it("default a watch to attention", () => {
    expect(Inbox.DEFAULT_LEVEL).toBe("attention")
  })
})

describe("Inbox.route", () => {
  it("puts the launcher first with the run's own state, even when the launcher's watch is muted", () => {
    const deliveries = Inbox.route({
      launcher: "ana",
      state: "needs_you",
      watchers: [
        { principal: "ben", level: "all" },
        { principal: "ana", level: "muted" }
      ]
    })
    expect(deliveries).toEqual([
      { recipient: "ana", mine: true, state: "needs_you", quiet: false },
      { recipient: "ben", mine: false, state: "waiting", quiet: false }
    ])
  })

  it("drops the launcher when mayRead refuses everyone", () => {
    expect(Inbox.route({ launcher: "ana", state: "failed", watchers: [], mayRead: () => false })).toEqual([])
  })

  it("ignores the launcher's own watch entries, whatever their level", () => {
    const deliveries = Inbox.route({
      launcher: "ana",
      state: "done",
      watchers: [{ principal: "ana", level: "all" }, { principal: "ana", level: "attention" }]
    })
    expect(deliveries).toEqual([{ recipient: "ana", mine: true, state: "done", quiet: false }])
  })

  it("shows a watcher needs_you as waiting and passes every other state through", () => {
    for (const state of states) {
      const [watcher] = Inbox.route({ launcher: undefined, state, watchers: [{ principal: "ben", level: "all" }] })
      expect(watcher?.state).toBe(state === "needs_you" ? "waiting" : state)
    }
  })

  it("makes an attention watcher quiet and an all watcher loud", () => {
    const deliveries = Inbox.route({
      launcher: "ana",
      state: "working",
      watchers: [
        { principal: "ben", level: "attention" },
        { principal: "cy", level: "all" }
      ]
    })
    expect(deliveries.map((delivery) => [delivery.recipient, delivery.quiet])).toEqual([
      ["ana", false],
      ["ben", true],
      ["cy", false]
    ])
  })

  it("drops muted watchers", () => {
    const deliveries = Inbox.route({
      launcher: "ana",
      state: "failed",
      watchers: [
        { principal: "ben", level: "muted" },
        { principal: "cy", level: "attention" }
      ]
    })
    expect(deliveries.map((delivery) => delivery.recipient)).toEqual(["ana", "cy"])
  })

  it("drops watchers who may not read the run", () => {
    const readers = new Set(["ana", "cy"])
    const deliveries = Inbox.route({
      launcher: "ana",
      state: "done",
      watchers: [
        { principal: "ben", level: "all" },
        { principal: "cy", level: "all" }
      ],
      mayRead: (principal) => readers.has(principal)
    })
    expect(deliveries.map((delivery) => delivery.recipient)).toEqual(["ana", "cy"])
  })

  it("lets everyone read when mayRead is undefined", () => {
    const deliveries = Inbox.route({
      launcher: undefined,
      state: "done",
      watchers: [{ principal: "ben", level: "all" }],
      mayRead: undefined
    })
    expect(deliveries.map((delivery) => delivery.recipient)).toEqual(["ben"])
  })

  it("delivers to each principal once, decided by its first entry", () => {
    const loudFirst = Inbox.route({
      launcher: undefined,
      state: "failed",
      watchers: [
        { principal: "ben", level: "all" },
        { principal: "cy", level: "attention" },
        { principal: "ben", level: "attention" },
        { principal: "ben", level: "muted" }
      ]
    })
    expect(loudFirst).toEqual([
      { recipient: "ben", mine: false, state: "failed", quiet: false },
      { recipient: "cy", mine: false, state: "failed", quiet: true }
    ])

    // A muted branch watch listed before the repository watch silences the run.
    const mutedFirst = Inbox.route({
      launcher: undefined,
      state: "failed",
      watchers: [
        { principal: "ben", level: "muted" },
        { principal: "ben", level: "all" }
      ]
    })
    expect(mutedFirst).toEqual([])
  })

  it("routes only to watchers when the run has no launcher", () => {
    const deliveries = Inbox.route({
      launcher: undefined,
      state: "needs_you",
      watchers: [{ principal: "ben", level: "attention" }]
    })
    expect(deliveries).toEqual([{ recipient: "ben", mine: false, state: "waiting", quiet: true }])
    expect(deliveries.some((delivery) => delivery.mine)).toBe(false)
  })

  it("routes to nobody when there is no launcher and no audible watcher", () => {
    expect(Inbox.route({ launcher: undefined, state: "done", watchers: [] })).toEqual([])
  })
})

describe("Inbox.audience", () => {
  it("keeps input order and each principal once, decided by its first entry", () => {
    expect(
      Inbox.audience([
        { principal: "cy", level: "all" },
        { principal: "ana", level: "attention" },
        { principal: "cy", level: "muted" },
        { principal: "ben", level: "muted" },
        { principal: "ben", level: "all" },
        { principal: "dee", level: "attention" }
      ])
    ).toEqual(["cy", "ana", "dee"])
  })

  it("drops principals who may not read the subject", () => {
    expect(
      Inbox.audience(
        [
          { principal: "ana", level: "all" },
          { principal: "ben", level: "attention" }
        ],
        (principal) => principal !== "ana"
      )
    ).toEqual(["ben"])
  })

  it("hears nobody when nobody watches", () => {
    expect(Inbox.audience([])).toEqual([])
  })
})

describe("Inbox.raises", () => {
  it("raises every new notice", () => {
    for (const after of states) expect(Inbox.raises(undefined, after)).toBe(true)
  })

  it("raises a change into needs_you, failed or done and nothing else", () => {
    const table: ReadonlyArray<readonly [Inbox.RunState, Inbox.RunState, boolean]> = [
      ["working", "working", false],
      ["working", "waiting", false],
      ["working", "needs_you", true],
      ["working", "failed", true],
      ["working", "done", true],
      ["waiting", "working", false],
      ["waiting", "waiting", false],
      ["waiting", "needs_you", true],
      ["waiting", "failed", true],
      ["waiting", "done", true],
      ["needs_you", "working", false],
      ["needs_you", "waiting", false],
      ["needs_you", "needs_you", false],
      ["needs_you", "failed", true],
      ["needs_you", "done", true],
      ["failed", "working", false],
      ["failed", "waiting", false],
      ["failed", "needs_you", true],
      ["failed", "failed", false],
      ["failed", "done", true],
      ["done", "working", false],
      ["done", "waiting", false],
      ["done", "needs_you", true],
      ["done", "failed", true],
      ["done", "done", false]
    ]
    expect(table).toHaveLength(states.length * states.length)
    for (const [before, after, expected] of table) {
      expect([before, after, Inbox.raises(before, after)]).toEqual([before, after, expected])
    }
  })
})

interface Row extends Inbox.Versions {
  readonly subject: string
}

const row = (versions: Partial<Inbox.Versions> = {}): Row => ({
  subject: "run:1",
  version: 3,
  readVersion: 0,
  dismissedVersion: 0,
  hiddenVersion: 0,
  ...versions
})

describe("Inbox.ack", () => {
  it("ignores fractional and unsafe versions for every act", () => {
    const notice = row()
    for (const act of ["read", "dismiss", "hide"] as const) {
      for (const version of [0.5, 2.5, 3.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(Inbox.ack(notice, act, version)).toBe(notice)
      }
    }
  })

  it("records each act in its own field and keeps the rest", () => {
    const notice = row({ readVersion: 1, dismissedVersion: 1, hiddenVersion: 1 })
    expect(Inbox.ack(notice, "read", 2)).toEqual({ ...notice, readVersion: 2 })
    expect(Inbox.ack(notice, "dismiss", 2)).toEqual({ ...notice, dismissedVersion: 2 })
    expect(Inbox.ack(notice, "hide", 2)).toEqual({ ...notice, hiddenVersion: 2 })
  })

  it("never moves a field back", () => {
    const notice = row({ readVersion: 2 })
    const acked = Inbox.ack(notice, "read", 1)
    expect(acked.readVersion).toBe(2)
    expect(acked).toBe(notice)
  })

  it("never passes the notice's own version", () => {
    expect(Inbox.ack(row({ version: 3 }), "dismiss", 9).dismissedVersion).toBe(3)
  })

  it("returns the same notice when the act is already recorded", () => {
    const notice = row({ hiddenVersion: 3 })
    expect(Inbox.ack(notice, "hide", 3)).toBe(notice)
  })

  it("ignores a version that is not a number", () => {
    const notice = row()
    expect(Inbox.ack(notice, "read", Number.NaN)).toBe(notice)
  })

  it("does not mutate the notice it was given", () => {
    const notice = row()
    Inbox.ack(notice, "dismiss", 3)
    expect(notice.dismissedVersion).toBe(0)
  })

  it("keeps a newer version open after a late ack for an older one", () => {
    // A phone dismissed version 2 offline; the notice raised to version 3 meanwhile.
    const notice = row({ version: 3 })
    expect(Inbox.isOpen(Inbox.ack(notice, "dismiss", 2))).toBe(true)
    expect(Inbox.isOpen(Inbox.ack(notice, "dismiss", 3))).toBe(false)
  })

  it("merges acks from two devices to the same notice in either order", () => {
    const acts: ReadonlyArray<Inbox.Act> = ["read", "dismiss", "hide"]
    const arbitrary = FastCheck.record({
      version: FastCheck.integer({ min: 0, max: 20 }),
      readVersion: FastCheck.integer({ min: 0, max: 20 }),
      dismissedVersion: FastCheck.integer({ min: 0, max: 20 }),
      hiddenVersion: FastCheck.integer({ min: 0, max: 20 }),
      first: FastCheck.record({
        act: FastCheck.constantFrom(...acts),
        version: FastCheck.integer({ min: -5, max: 30 })
      }),
      second: FastCheck.record({
        act: FastCheck.constantFrom(...acts),
        version: FastCheck.integer({ min: -5, max: 30 })
      })
    })
    FastCheck.assert(
      FastCheck.property(arbitrary, ({ first, second, ...versions }) => {
        const notice = row(versions)
        const ab = Inbox.ack(Inbox.ack(notice, first.act, first.version), second.act, second.version)
        const ba = Inbox.ack(Inbox.ack(notice, second.act, second.version), first.act, first.version)
        expect(ab).toEqual(ba)
        // Idempotent: the same ack delivered twice changes nothing more.
        expect(Inbox.ack(ab, first.act, first.version)).toBe(ab)
        // Never back, never past the version; no other field moves.
        for (const key of ["readVersion", "dismissedVersion", "hiddenVersion"] as const) {
          expect(ab[key]).toBeGreaterThanOrEqual(notice[key])
          expect(ab[key]).toBeLessThanOrEqual(Math.max(notice[key], notice.version))
        }
        expect(ab.version).toBe(notice.version)
        expect(ab.subject).toBe(notice.subject)
      }),
      params
    )
  })
})

describe("Inbox predicates", () => {
  it("isOpen holds while the dismissed version is below the version", () => {
    expect(Inbox.isOpen({ version: 2, dismissedVersion: 1 })).toBe(true)
    expect(Inbox.isOpen({ version: 2, dismissedVersion: 2 })).toBe(false)
    expect(Inbox.isOpen({ version: 2, dismissedVersion: 3 })).toBe(false)
  })

  it("isUnread holds while the read version is below the version", () => {
    expect(Inbox.isUnread({ version: 2, readVersion: 1 })).toBe(true)
    expect(Inbox.isUnread({ version: 2, readVersion: 2 })).toBe(false)
    expect(Inbox.isUnread({ version: 2, readVersion: 3 })).toBe(false)
  })

  it("isHidden holds once the hidden version reaches the version", () => {
    expect(Inbox.isHidden({ version: 2, hiddenVersion: 1 })).toBe(false)
    expect(Inbox.isHidden({ version: 2, hiddenVersion: 2 })).toBe(true)
    expect(Inbox.isHidden({ version: 2, hiddenVersion: 3 })).toBe(true)
  })

  it("a raised notice is open, unread and shown again after every act on the old version", () => {
    let notice = row({ version: 1 })
    for (const act of ["read", "dismiss", "hide"] as const) notice = Inbox.ack(notice, act, 1)
    expect([Inbox.isOpen(notice), Inbox.isUnread(notice), Inbox.isHidden(notice)]).toEqual([false, false, true])
    const raised = { ...notice, version: notice.version + 1 }
    expect([Inbox.isOpen(raised), Inbox.isUnread(raised), Inbox.isHidden(raised)]).toEqual([true, true, false])
  })
})
