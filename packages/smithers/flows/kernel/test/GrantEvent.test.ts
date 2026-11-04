import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { describe, expect, it } from "vitest"
import * as GrantEvent from "../src/GrantEvent.vibe"

const capability = new Capability({ action: "fs:read", resource: "/workspace/readme.md" })
const pattern = new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })

const events: ReadonlyArray<GrantEvent.GrantEvent> = [
  new GrantEvent.OnceGrant({
    eventType: "flows.kernel.grant.once.v1",
    requestId: "request-once",
    runId: "run-1",
    planDigest: "plan-1",
    capability,
    pattern,
    scope: "once",
    tier: "sealed"
  }),
  new GrantEvent.RunGrant({
    eventType: "flows.kernel.grant.run.v2",
    requestId: "request-run",
    runId: "run-1",
    planDigest: "plan-1",
    capability,
    pattern,
    ceiling: [],
    scope: "run",
    tier: "sealed"
  }),
  new GrantEvent.RememberedGrant({
    eventType: "flows.kernel.grant.remembered.v1",
    requestId: "request-remembered",
    runId: "run-1",
    capability,
    pattern,
    scope: "remembered",
    tier: "sealed"
  }),
  new GrantEvent.DeniedGrant({
    eventType: "flows.kernel.grant.denied.v1",
    requestId: "request-denied",
    runId: "run-1",
    capability,
    pattern,
    scope: "once",
    tier: "sealed"
  }),
  new GrantEvent.EnvelopeGrant({
    eventType: "flows.kernel.grant.envelope.v1",
    runId: "run-1",
    planDigest: "plan-1",
    patterns: [pattern],
    scope: "remembered"
  })
]

const encode = (event: GrantEvent.GrantEvent): Record<string, unknown> => {
  const result = GrantEvent.encode(event)
  if (result._tag === "Failure" || typeof result.success !== "object" || result.success === null) {
    throw new Error("expected an encoded grant event object")
  }
  return result.success as Record<string, unknown>
}

const goldenPayloads = [
  {
    name: "OnceGrant",
    event: events[0]!,
    payload: Object.freeze({
      _tag: "@smthrs/kernel/GrantEvent/OnceGrant",
      eventType: "flows.kernel.grant.once.v1",
      requestId: "request-once",
      runId: "run-1",
      planDigest: "plan-1",
      capability: Object.freeze({
        action: "fs:read",
        resource: "/workspace/readme.md"
      }),
      pattern: Object.freeze({
        action: "fs:read",
        resource: "/workspace/**"
      }),
      scope: "once",
      tier: "sealed"
    })
  },
  {
    name: "RunGrant",
    event: events[1]!,
    payload: Object.freeze({
      _tag: "@smthrs/kernel/GrantEvent/RunGrant",
      eventType: "flows.kernel.grant.run.v2",
      requestId: "request-run",
      runId: "run-1",
      planDigest: "plan-1",
      capability: Object.freeze({
        action: "fs:read",
        resource: "/workspace/readme.md"
      }),
      pattern: Object.freeze({
        action: "fs:read",
        resource: "/workspace/**"
      }),
      ceiling: [],
      scope: "run",
      tier: "sealed"
    })
  },
  {
    name: "RememberedGrant",
    event: events[2]!,
    payload: Object.freeze({
      _tag: "@smthrs/kernel/GrantEvent/RememberedGrant",
      eventType: "flows.kernel.grant.remembered.v1",
      requestId: "request-remembered",
      runId: "run-1",
      capability: Object.freeze({
        action: "fs:read",
        resource: "/workspace/readme.md"
      }),
      pattern: Object.freeze({
        action: "fs:read",
        resource: "/workspace/**"
      }),
      scope: "remembered",
      tier: "sealed"
    })
  },
  {
    name: "DeniedGrant",
    event: events[3]!,
    payload: Object.freeze({
      _tag: "@smthrs/kernel/GrantEvent/DeniedGrant",
      eventType: "flows.kernel.grant.denied.v1",
      requestId: "request-denied",
      runId: "run-1",
      capability: Object.freeze({
        action: "fs:read",
        resource: "/workspace/readme.md"
      }),
      pattern: Object.freeze({
        action: "fs:read",
        resource: "/workspace/**"
      }),
      scope: "once",
      tier: "sealed"
    })
  },
  {
    name: "EnvelopeGrant",
    event: events[4]!,
    payload: Object.freeze({
      _tag: "@smthrs/kernel/GrantEvent/EnvelopeGrant",
      eventType: "flows.kernel.grant.envelope.v1",
      runId: "run-1",
      planDigest: "plan-1",
      patterns: Object.freeze([
        Object.freeze({
          action: "fs:read",
          resource: "/workspace/**"
        })
      ]),
      scope: "remembered"
    })
  }
] as const

describe("GrantEvent schema", () => {
  for (const golden of goldenPayloads) {
    it("encodes " + golden.name + " as its exact durable wire payload", () => {
      const encoded = encode(golden.event)
      expect(encoded).toEqual(golden.payload)
      expect(JSON.stringify(encoded)).toBe(JSON.stringify(golden.payload))
    })
  }

  for (const event of events) {
    it(`round trips ${event.eventType}`, () => {
      const encoded = GrantEvent.encode(event)
      expect(encoded._tag).toBe("Success")
      if (encoded._tag === "Failure") {
        throw new Error("expected grant event encoding to succeed")
      }
      const decoded = GrantEvent.decode(encoded.success)
      expect(decoded).toMatchObject({ _tag: "Success", success: event })
    })
  }

  const once = encode(events[0]!)
  const envelope = encode(events[4]!)
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown event enum", { ...once, eventType: "flows.kernel.grant.unknown.v1" }],
    ["a scope that contradicts the event", { ...once, scope: "run" }],
    ["an unknown effect tier", { ...once, tier: "destructive" }],
    ["an unknown capability action", {
      ...once,
      capability: { action: "net:delete", resource: "example.test" }
    }],
    ["a tag and payload from different grant variants", {
      ...once,
      _tag: "@smthrs/kernel/GrantEvent/RunGrant",
      eventType: "flows.kernel.grant.run.v2"
    }],
    ["an envelope with a once scope", { ...envelope, scope: "once" }]
  ]

  for (const [name, input] of malformed) {
    it(`rejects ${name}`, () => {
      expect(GrantEvent.decode(input)._tag).toBe("Failure")
    })
  }

  it("requires a ceiling on v2 run grants and rejects the legacy version", () => {
    const run = encode(events[1]!)
    const { ceiling: _ceiling, ...withoutCeiling } = run
    expect(GrantEvent.decode(withoutCeiling)._tag).toBe("Failure")
    expect(GrantEvent.decode({ ...withoutCeiling, eventType: "flows.kernel.grant.run.v1" })._tag).toBe("Failure")
    expect(GrantEvent.decode({ ...run, ceiling: [pattern] })._tag).toBe("Failure")
  })

  it("rejects an envelope carrying request-only payload fields", () => {
    expect(
      GrantEvent.decode({
        ...envelope,
        requestId: "request",
        capability,
        pattern,
        tier: "sealed"
      })._tag
    ).toBe("Failure")
  })
})
