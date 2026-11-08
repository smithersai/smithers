import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Factory from "../src/Factory.ts"
import * as FactoryPolicy from "../src/FactoryPolicy.ts"
import { Smithers } from "../src/index.ts"

const defaults = {
  lifecycle: { docs: "evergreen", tests: "evergreen" },
  notifications: { quietHours: [] },
  approvals: { approve: "person", merge: "person" }
} as const satisfies FactoryPolicy.Policy

const projection = () => JSON.parse(Factory.renderProjection(Smithers.Factory({ summary: "Policy fixture" }), []))

describe("Factory policy contract", () => {
  it("accepts an empty policy through the public authoring API and projects safe defaults", () => {
    const factory = Smithers.Factory({ summary: "Policy fixture", policy: {} })
    expect(factory).toHaveProperty("policy", defaults)
    expect(JSON.parse(Factory.renderProjection(factory, []))).toHaveProperty("policy", defaults)
  })

  it("rejects an agent approver in an untrusted projection", () => {
    expect(() =>
      Schema.decodeUnknownSync(Factory.Projection)({
        ...projection(),
        policy: { ...defaults, approvals: { approve: "agent", merge: "person" } }
      })
    ).toThrow()
  })

  it("rejects unknown policy fields instead of silently discarding them", () => {
    expect(() =>
      Schema.decodeUnknownSync(Factory.Projection)({
        ...projection(),
        policy: { ...defaults, approvals: { ...defaults.approvals, delegate: "agent" } }
      })
    ).toThrow()
  })
})

describe("Factory policy validation and compatibility", () => {
  const window = { start: "22:00", end: "08:00", timeZone: "UTC" as const }

  it("keeps old declarations and projections valid without changing their output", () => {
    const factory = Smithers.Factory({ summary: "Policy fixture" })
    expect(factory).not.toHaveProperty("policy")
    expect(Schema.decodeUnknownSync(Factory.Projection)(projection())).not.toHaveProperty("policy")
    expect(FactoryPolicy.make()).toEqual(defaults)
    expect(FactoryPolicy.make(undefined)).toEqual(defaults)
    expect(FactoryPolicy.make({ lifecycle: {}, notifications: {}, approvals: {} })).toEqual(defaults)
    expect(FactoryPolicy.make({ lifecycle: undefined, notifications: undefined, approvals: undefined })).toEqual(
      defaults
    )
  })

  it("round-trips explicit preferences without changing GitHub or artifact execution policy", () => {
    const github = Smithers.Github.Policy({ mirror: "push", issues: "two-way", changes: "land" })
    const lifecycle = Smithers.Lifecycle.Policy({ tests: { artifact: { blocking: false, run: "never" } } })
    const factory = Smithers.Factory({
      summary: "Policy fixture",
      github,
      lifecycle,
      policy: { lifecycle: { docs: "artifact", tests: "artifact" }, notifications: { quietHours: [window] } }
    })
    expect(factory.github).toEqual(github)
    expect(factory.lifecycle).toEqual(lifecycle)
    const decoded = Schema.decodeUnknownSync(Factory.Projection)(JSON.parse(Factory.renderProjection(factory, [])))
    expect(decoded.policy).toEqual({
      lifecycle: { docs: "artifact", tests: "artifact" },
      notifications: { quietHours: [window] },
      approvals: defaults.approvals
    })
    expect(decoded.lifecycle).toEqual(lifecycle)
    expect(decoded.github).toEqual({ mirror: "push", issues: "two-way", changes: "land" })
    expect(FactoryPolicy.make({ lifecycle: { docs: "artifact" } }).lifecycle).toEqual({
      docs: "artifact",
      tests: "evergreen"
    })
  })

  it("copies and deeply freezes policy without retaining or freezing the caller's objects", () => {
    const quietHours = [{ ...window }]
    const options = { notifications: { quietHours } }
    const policy = FactoryPolicy.make(options)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.lifecycle)).toBe(true)
    expect(Object.isFrozen(policy.approvals)).toBe(true)
    expect(Object.isFrozen(policy.notifications)).toBe(true)
    expect(Object.isFrozen(policy.notifications.quietHours)).toBe(true)
    expect(Object.isFrozen(policy.notifications.quietHours[0])).toBe(true)
    expect(Object.isFrozen(options.notifications)).toBe(false)
    quietHours[0]!.start = "21:00"
    quietHours.push({ ...window })
    expect(policy.notifications.quietHours).toEqual([window])
  })

  it("accepts bounded UTC intervals including midnight and a full list", () => {
    for (const interval of [window, { start: "00:00", end: "23:59", timeZone: "UTC" as const }]) {
      const policy = FactoryPolicy.make({ notifications: { quietHours: [interval] } })
      expect(Schema.decodeUnknownSync(FactoryPolicy.Policy)(policy)).toEqual(policy)
    }
    const intervals = Array.from({ length: 24 }, (_, hour) => ({
      start: `${String(hour).padStart(2, "0")}:00`,
      end: `${String(hour).padStart(2, "0")}:30`,
      timeZone: "UTC" as const
    }))
    expect(FactoryPolicy.make({ notifications: { quietHours: intervals } }).notifications.quietHours).toEqual(intervals)
    expect(() => FactoryPolicy.make({ notifications: { quietHours: [...intervals, window] } })).toThrow()
  })

  it("rejects malformed quiet hours on authoring and projection read", () => {
    for (
      const quietHours of [
        null,
        {},
        [null],
        [{ ...window, start: "24:00" }],
        [{ ...window, end: "08:60" }],
        [{ ...window, start: "8:00" }],
        [{ ...window, start: "08:00" }],
        [{ ...window, start: "22:00\n" }],
        [{ ...window, timeZone: "Europe/London" }],
        [{ start: "22:00", end: "08:00" }],
        [{ ...window, recipients: ["outsider"] }]
      ]
    ) {
      expect(() => FactoryPolicy.make({ notifications: { quietHours } } as never)).toThrow()
      expect(() =>
        Schema.decodeUnknownSync(Factory.Projection)({
          ...projection(),
          policy: { ...defaults, notifications: { quietHours } }
        })
      ).toThrow()
    }
  })

  it("refuses authority widening at construction, declaration decoding, projection decoding and rendering", () => {
    const factory = Smithers.Factory({ summary: "Policy fixture" })
    for (const field of ["approve", "merge"]) {
      for (const actor of ["agent", "anyone", "auto", "none", false, null]) {
        const policy = { ...defaults, approvals: { ...defaults.approvals, [field]: actor } }
        expect(() => Smithers.Factory({ summary: "Policy fixture", policy } as never)).toThrow()
        expect(() => Schema.decodeUnknownSync(Factory.Declaration)({ ...factory, policy })).toThrow()
        expect(() => Schema.decodeUnknownSync(Factory.Projection)({ ...projection(), policy })).toThrow()
        expect(() => Factory.renderProjection({ ...factory, policy } as never, [])).toThrow()
      }
    }
  })

  it("refuses unknown options at every policy level without executing accessors", () => {
    const extras = [
      { ...defaults, capabilities: ["approve"] },
      { ...defaults, lifecycle: { ...defaults.lifecycle, blocking: false } },
      { ...defaults, notifications: { ...defaults.notifications, recipients: ["outsider"] } },
      { ...defaults, approvals: { ...defaults.approvals, delegate: "agent" } }
    ]
    for (const policy of extras) {
      expect(() => FactoryPolicy.make(policy as never)).toThrow()
      expect(() => Schema.decodeUnknownSync(Factory.Projection)({ ...projection(), policy })).toThrow()
      expect(() => Factory.renderProjection({ ...Smithers.Factory({ summary: "Fixture" }), policy } as never, []))
        .toThrow()
    }
    let reads = 0
    const policy = {
      ...defaults,
      get capabilities() {
        reads++
        return ["approve"]
      }
    }
    expect(() => FactoryPolicy.make(policy)).toThrow()
    expect(() => Schema.decodeUnknownSync(Factory.Projection)({ ...projection(), policy })).toThrow()
    expect(reads).toBe(0)
  })

  it("fails on malformed supplied values instead of treating them as absent defaults", () => {
    for (const policy of [null, false, [], "default", new Date(0)]) {
      expect(() => FactoryPolicy.make(policy as never)).toThrow()
      expect(() => Schema.decodeUnknownSync(Factory.Projection)({ ...projection(), policy })).toThrow()
    }
    for (const field of ["lifecycle", "notifications", "approvals"]) {
      for (const value of [null, false, [], "default"]) {
        expect(() => FactoryPolicy.make({ [field]: value } as never)).toThrow()
        expect(() =>
          Schema.decodeUnknownSync(Factory.Projection)({
            ...projection(),
            policy: { ...defaults, [field]: value }
          })
        ).toThrow()
      }
    }
    for (const lifecycle of [{ docs: "temporary" }, { tests: null }]) {
      expect(() => FactoryPolicy.make({ lifecycle } as never)).toThrow()
    }
    // Wire documents must carry normalized values, so a truncated section fails.
    for (const policy of [{}, { ...defaults, approvals: {} }, { ...defaults, notifications: {} }]) {
      expect(() => Schema.decodeUnknownSync(Factory.Projection)({ ...projection(), policy })).toThrow()
    }
  })

  it("keeps GitHub and artifact policies independently typed", () => {
    expect(() => Smithers.Factory({ summary: "Fixture", policy: Smithers.Github.Policy() } as never)).toThrow()
    expect(() =>
      Smithers.Factory({
        summary: "Fixture",
        policy: Smithers.Lifecycle.Policy({ tests: { artifact: { blocking: false, run: "never" } } })
      } as never)
    ).toThrow()
    expect(() => Smithers.Factory({ summary: "Fixture", github: FactoryPolicy.make() } as never)).toThrow()
    expect(() => Smithers.Factory({ summary: "Fixture", lifecycle: FactoryPolicy.make() } as never)).toThrow()
  })

  it("also rejects person-only authority widening at the public TypeScript boundary", () => {
    expect(() =>
      Smithers.Factory({
        summary: "Fixture",
        policy: {
          approvals: {
            // @ts-expect-error Repository policy cannot authorize an agent to merge.
            merge: "agent"
          }
        }
      })
    ).toThrow()
  })
})
