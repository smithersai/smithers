import { Option, Schema } from "effect"
import { systemError } from "effect/PlatformError"
import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern, maxMatchWork } from "../src/Capability.ts"
import {
  evaluate,
  fromPlatformError,
  PermissionDenied,
  permissionDenied,
  PermissionRequired,
  permissionRequired,
  Rule,
  type RuleEffect,
  toPlatformError
} from "../src/Permission.ts"

const capability = new Capability({
  action: "fs:read",
  resource: "/workspace/readme.md"
})

const rule = (
  effect: "allow" | "deny" | "ask",
  action: "fs:read" | "fs:*" | "*",
  resource: string
): Rule =>
  new Rule({
    effect,
    pattern: new CapabilityPattern({ action, resource })
  })

const fiveRulesetsWithFinalMatch = (
  decisivePosition: number,
  decisiveEffect: RuleEffect
): ReadonlyArray<ReadonlyArray<Rule>> =>
  Array.from({ length: 5 }, (_, position) => {
    if (position > decisivePosition) {
      return [rule("deny", "fs:read", "/does-not-match/**")]
    }
    if (position === decisivePosition) {
      return [rule(decisiveEffect, "fs:read", "/workspace/readme.md")]
    }
    if (position === 0) {
      return [rule("ask", "fs:read", "/workspace/readme.md")]
    }
    return [
      rule(
        decisiveEffect === "allow" ? "deny" : "allow",
        "fs:read",
        "/workspace/readme.md"
      )
    ]
  })

describe("Permission policy", () => {
  it("uses the last matching rule across ordered rulesets", () => {
    expect(
      evaluate(
        [
          [
            rule("deny", "fs:read", "/tmp/**"),
            rule("ask", "fs:*", "/workspace/**")
          ],
          [rule("allow", "fs:read", "/workspace/**")],
          [rule("deny", "fs:read", "/workspace/private/**")]
        ],
        capability
      )
    ).toBe("allow")

    expect(
      evaluate(
        [
          [rule("ask", "fs:*", "/workspace/**")],
          [
            rule("allow", "fs:read", "/workspace/**"),
            rule("deny", "fs:read", "/workspace/readme.md")
          ]
        ],
        capability
      )
    ).toBe("deny")
  })

  it("reduces configured rules last-match-wins before applying deny precedence", () => {
    expect(
      evaluate(
        [
          [
            rule("deny", "fs:*", "/workspace/**"),
            rule("allow", "fs:read", "/workspace/readme.md")
          ],
          [],
          [],
          [rule("allow", "*", "**")]
        ],
        capability
      )
    ).toBe("allow")

    expect(
      evaluate(
        [
          [
            rule("allow", "fs:read", "/workspace/readme.md"),
            rule("deny", "fs:*", "/workspace/**")
          ],
          [rule("allow", "*", "**")]
        ],
        capability
      )
    ).toBe("deny")
  })

  it("treats rulesets[0] as configured policy when the same rulesets are reordered", () => {
    const denied = [rule("deny", "fs:read", "/workspace/readme.md")]
    const allowed = [rule("allow", "fs:read", "/workspace/readme.md")]
    const asked = [rule("ask", "fs:read", "/workspace/readme.md")]

    expect(evaluate([denied, asked, allowed], capability)).toBe("deny")
    expect(evaluate([allowed, denied, asked], capability)).toBe("ask")
  })

  it.each(
    [
      [
        "configured deny wildcard",
        rule("deny", "fs:*", "/workspace/**"),
        rule("allow", "fs:read", "/workspace/readme.md"),
        "deny"
      ],
      [
        "configured ask wildcard",
        rule("ask", "fs:*", "/workspace/**"),
        rule("allow", "fs:read", "/workspace/**"),
        "allow"
      ]
    ] as const
  )("applies the configured veto semantics when %s overlaps a later session/tool grant", (
    _scenario,
    configured,
    later,
    expected
  ) => {
    // The module docs name only an effective configured `deny` as a hard veto;
    // a configured `ask` remains subject to last-match-wins.
    expect(evaluate([[configured], [later]], capability)).toBe(expected)
  })

  it.each(
    [
      [0, "allow"],
      [1, "deny"],
      [2, "allow"],
      [3, "deny"],
      [4, "allow"]
    ] as const
  )("uses the final match when it sits in ruleset position %i of five", (position, expected) => {
    expect(evaluate(fiveRulesetsWithFinalMatch(position, expected), capability)).toBe(expected)
  })

  it("re-evaluates a replacement denial after an earlier grant is revoked", () => {
    const allowed = [[rule("allow", "fs:read", "/workspace/readme.md")]]
    const revoked = [[rule("deny", "fs:read", "/workspace/readme.md")]]

    expect(evaluate(allowed, capability)).toBe("allow")
    expect(evaluate(revoked, capability)).toBe("deny")
  })

  it("defaults to ask when no rule matches", () => {
    expect(
      evaluate(
        [[rule("allow", "fs:read", "/other/**")]],
        capability
      )
    ).toBe("ask")
    expect(evaluate([], capability)).toBe("ask")
  })

  it("vetoes a decision when any rule cannot be matched within the work budget", () => {
    const big = new Capability(
      { action: "proc:spawn", resource: "x".repeat(100_000) },
      { disableChecks: true }
    )
    const allow = new Rule({
      effect: "allow",
      pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" })
    })
    const deny = new Rule({
      effect: "deny",
      pattern: new CapabilityPattern({ action: "proc:spawn", resource: `${"x".repeat(170)}*` })
    })

    expect(deny.pattern.resource.length * big.resource.length).toBeGreaterThan(maxMatchWork)
    expect(evaluate([[deny], [allow]], big)).toBe("deny")
    expect(evaluate([[allow, deny]], big)).toBe("deny")
  })

  it("does not veto for an over-budget rule whose action does not select the capability", () => {
    const big = new Capability(
      { action: "proc:spawn", resource: "x".repeat(100_000) },
      { disableChecks: true }
    )
    const deny = new Rule({
      effect: "deny",
      pattern: new CapabilityPattern({ action: "fs:read", resource: `${"x".repeat(170)}*` })
    })
    const allow = new Rule({
      effect: "allow",
      pattern: new CapabilityPattern({ action: "proc:spawn", resource: "*" })
    })

    expect(evaluate([[deny], [allow]], big)).toBe("allow")
  })
})

describe("Permission construction and PlatformError projection", () => {
  it("copies caller metadata when constructing a permission request", () => {
    const callerMeta = { source: "original" }
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: callerMeta
    })

    callerMeta.source = "mutated"

    expect(required.meta).toEqual({ source: "original" })
  })

  it("takes a deeply independent metadata snapshot", () => {
    const callerMeta = { a: { b: 1 } }
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: callerMeta
    })

    callerMeta.a.b = 2

    expect(required.meta).toEqual({ a: { b: 1 } })
  })

  it.each([
    "{\"__proto__\":\"audit context\",\"ok\":1}",
    "{\"__proto__\":{\"audit\":\"context\"},\"ok\":1}",
    "{\"nested\":{\"__proto__\":\"audit context\"}}",
    "{\"nested\":[{\"__proto__\":{\"audit\":\"context\"}}]}"
  ])("preserves own __proto__ data in the snapshot and journal round-trip: %s", (json) => {
    const meta = JSON.parse(json)
    const required = permissionRequired({ requestId: "request-1", capability, tier: "sealed", meta })
    const encoded = Schema.encodeUnknownSync(PermissionRequired)(required)
    const decoded = Schema.decodeUnknownSync(PermissionRequired)(JSON.parse(JSON.stringify(encoded)))

    expect(JSON.stringify(required.meta)).toBe(json)
    expect(JSON.stringify(encoded.meta)).toBe(json)
    expect(JSON.stringify(decoded.meta)).toBe(json)
    expect(required.meta).toEqual(meta)
  })

  it("copies each shared DAG container once", () => {
    let graph: Record<string, unknown> = { leaf: "context" }
    for (let depth = 0; depth < 7; depth++) graph = { left: graph, right: graph }
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "sealed",
      meta: { graph }
    })
    const seen = new Set<object>()
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object" || seen.has(value)) return
      seen.add(value)
      expect(Object.isFrozen(value)).toBe(true)
      for (const child of Object.values(value)) visit(child)
    }
    visit(required.meta)
    expect(seen.size).toBe(9)
    expect(required.meta.graph).not.toBe(graph)
    expect(Schema.encodeUnknownSync(PermissionRequired)(required).meta).toEqual({ graph })
  })

  it("rejects a deep chain with a field-specific schema failure", () => {
    let chain: Record<string, unknown> = {}
    for (let depth = 0; depth < 10_000; depth++) chain = { next: chain }
    const construct = () =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "sealed",
        meta: { deepChain: chain }
      })
    expect(construct).toThrow(Schema.SchemaError)
    expect(construct).toThrow(/deepChain.*depth 16/)
  })

  it("bounds the expanded member count of a shared DAG", () => {
    let graph: Record<string, unknown> = { leaf: true }
    for (let depth = 0; depth < 14; depth++) graph = { left: graph, right: graph }
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "sealed",
        meta: { sharedGraph: graph }
      })
    ).toThrow(/sharedGraph.*1024 members/)
  })

  it("accepts depth 16 and checks a shared subtree at its deepest occurrence", () => {
    const shared = { leaf: true }
    let nested: Record<string, unknown> = shared
    for (let depth = 0; depth < 14; depth++) nested = { next: nested }
    const meta = { shallow: shared, deep: nested }
    expect(permissionRequired({ requestId: "r", capability, tier: "sealed", meta }).meta).toEqual(meta)
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { shallow: shared, tooDeep: { next: nested } }
      })
    ).toThrow(/tooDeep.*depth 16/)
  })

  it("accepts 1024 members and refuses the next array element", () => {
    const items = Array.from({ length: 1023 }, () => null)
    expect(
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { items }
      }).meta.items
    ).toEqual(items)
    items.push(null)
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { items }
      })
    ).toThrow(/items.*1024 members/)
  })

  it("counts omitted properties toward the member work budget, including shared records", () => {
    const shared = Object.fromEntries(Array.from({ length: 511 }, (_, index) => [String(index), undefined]))
    expect(
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { first: shared, second: shared }
      }).meta
    ).toEqual({ first: {}, second: {} })
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { first: shared, second: shared, omitted: undefined }
      })
    ).toThrow(/omitted.*1024 members/)
  })

  it("accepts exactly 64 KiB of serialized JSON and refuses one more byte", () => {
    const text = "a".repeat(64 * 1024 - 11)
    const required = permissionRequired({ requestId: "r", capability, tier: "sealed", meta: { text } })
    expect(new TextEncoder().encode(JSON.stringify(required.meta)).byteLength).toBe(64 * 1024)
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { text: text + "a" }
      })
    ).toThrow(/text.*65536 bytes/)
  })

  it.each([
    ["huge", "a".repeat(65_537)],
    ["unicode", "😀".repeat(16_384)],
    ["escaped", "\n".repeat(32_768)]
  ])("bounds serialized bytes for %s strings", (key, value) => {
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { [key]: value }
      })
    ).toThrow(new RegExp(`${key}.*65536 bytes`))
  })

  it("counts keys and shared values toward the serialized byte limit", () => {
    const shared = { text: "a".repeat(32_760) }
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { first: shared, second: shared }
      })
    ).toThrow(/second.*65536 bytes/)
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { longKey: { ["a".repeat(65_537)]: null } }
      })
    ).toThrow(/longKey.*65536 bytes/)
    expect(() =>
      permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { longKey: { ["😀".repeat(16_384)]: null } }
      })
    ).toThrow(/longKey.*65536 bytes/)
  })

  it.each([[null], [[]], [new Date()], ["text"]])("rejects non-record metadata roots: %s", (meta) => {
    expect(() =>
      new PermissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: meta as unknown as Record<string, unknown>
      })
    ).toThrow(/meta.*plain record/)
  })

  it.each([NaN, Infinity, -Infinity, Symbol("context"), new Map(), new class Context {}()])(
    "rejects non-JSON values with a field-specific schema error: %s",
    (value) => {
      const construct = () =>
        permissionRequired({
          requestId: "r",
          capability,
          tier: "sealed",
          meta: { invalid: value }
        })
      expect(construct).toThrow(Schema.SchemaError)
      expect(construct).toThrow(/invalid/)
    }
  )

  it("preserves sharing through arrays and snapshots null-prototype records", () => {
    const record = Object.assign(Object.create(null), { kept: true, omitted: undefined })
    const shared = [record]
    const required = permissionRequired({
      requestId: "r",
      capability,
      tier: "sealed",
      meta: { first: shared, second: shared }
    })
    expect(required.meta.first).toBe(required.meta.second)
    expect(required.meta).toEqual({ first: [{ kept: true }], second: [{ kept: true }] })
    expect(Object.isFrozen(record)).toBe(false)
  })

  it("ignores inherited enumerable properties", () => {
    Object.defineProperty(Object.prototype, "inheritedMetadata", {
      value: "ignored",
      enumerable: true,
      configurable: true
    })
    let snapshot: unknown
    try {
      snapshot = permissionRequired({
        requestId: "r",
        capability,
        tier: "sealed",
        meta: { own: true }
      }).meta
    } finally {
      Reflect.deleteProperty(Object.prototype, "inheritedMetadata")
    }
    expect(snapshot).toEqual({ own: true })
  })

  it("drops an undefined metadata property before encoding", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { cwd: undefined }
    })
    const encoded = Schema.encodeUnknownSync(PermissionRequired)(required)

    expect(required.meta).toEqual({})
    expect(required.meta).not.toHaveProperty("cwd")
    expect(encoded.meta).toEqual({})
    expect(encoded.meta).not.toHaveProperty("cwd")
  })

  it("drops nested undefined metadata properties", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { spawn: { cwd: undefined } }
    })

    expect(required.meta).toEqual({ spawn: {} })
  })

  it("rejects undefined metadata array elements rather than changing them to null", () => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { list: [undefined] }
      })
    ).toThrow(/list/)
  })

  it("rejects bigint metadata at construction and names the field", () => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { offendingBigint: 1n }
      })
    ).toThrow(/offendingBigint/)
  })

  it.each([
    ["offendingFunction", () => undefined],
    ["offendingDate", new Date("2026-08-31T00:00:00.000Z")]
  ])("rejects non-JSON metadata at construction and names %s", (key, value) => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { [key]: value }
      })
    ).toThrow(new RegExp(key))
  })

  it("rejects a Date value instead of flattening the non-plain object", () => {
    expect(() =>
      permissionRequired({
        requestId: "request-1",
        capability,
        tier: "compensable",
        meta: { dateValue: new Date("2026-08-31T00:00:00.000Z") }
      })
    ).toThrow(/dateValue/)
  })

  it("deep-freezes the metadata snapshot", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { k: 0, nested: { value: 1 }, list: [{ value: 2 }] }
    })

    expect(Object.isFrozen(required.meta)).toBe(true)
    expect(Object.isFrozen(required.meta.nested)).toBe(true)
    const list = required.meta.list
    expect(Array.isArray(list)).toBe(true)
    if (!Array.isArray(list)) throw new Error("expected metadata list")
    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list[0])).toBe(true)
    expect(() => {
      ;(required.meta as Record<string, unknown>).k = 1
    }).toThrow()
  })

  it("makes the metadata slot non-writable", () => {
    const required = permissionRequired({
      requestId: "request-1",
      capability,
      tier: "compensable",
      meta: { source: "original" }
    })

    expect(() => {
      ;(required as any).meta = { unsafe: 1n }
    }).toThrow()
    expect(required.meta).toEqual({ source: "original" })
    expect(() => Schema.encodeUnknownSync(PermissionRequired)(required)).not.toThrow()
  })

  it("does not retain the caller's capability in a permission request", () => {
    const callerCapability = new Capability({ action: "fs:read", resource: "/a" })
    const required = permissionRequired({
      requestId: "request-1",
      capability: callerCapability,
      tier: "sealed"
    })
    ;(callerCapability as any).resource = "/b"

    expect(required.capability.resource).toBe("/a")
  })

  it("does not retain the caller's capability in a permission denial", () => {
    const callerCapability = new Capability({ action: "fs:read", resource: "/a" })
    const denied = permissionDenied(callerCapability, "no")
    ;(callerCapability as any).resource = "/b"

    expect(denied.capability.resource).toBe("/a")
  })

  it.each([
    permissionRequired({ requestId: "request-1", capability, tier: "sealed" }),
    permissionDenied(capability, "no")
  ])("makes a permission failure's capability slot non-writable", (error) => {
    expect(() => {
      ;(error as any).capability = new Capability({ action: "fs:read", resource: "/replacement" })
    }).toThrow()
    expect(error.capability.resource).toBe("/workspace/readme.md")
  })

  it.each([
    permissionRequired({ requestId: "request-1", capability, tier: "sealed" }),
    permissionDenied(capability, "no")
  ])("makes a permission failure's carried capability immutable", (error) => {
    expect(() => {
      ;(error.capability as any).resource = "/replacement"
    }).toThrow()
    expect(error.capability.resource).toBe("/workspace/readme.md")
  })

  it("reports cyclic metadata as a schema failure instead of overflowing", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const cyclicArray: Array<unknown> = []
    cyclicArray.push(cyclicArray)

    expect(() => permissionRequired({ requestId: "request-1", capability, tier: "sealed", meta: cyclic })).toThrow(
      /Expected JSON value/
    )
    expect(() => permissionRequired({ requestId: "request-2", capability, tier: "sealed", meta: { cyclicArray } }))
      .toThrow(/Expected JSON value/)
    expect(() => permissionRequired({ requestId: "r", capability, tier: "sealed", meta: { cyclicArray } }))
      .toThrow(/cyclicArray.*cycles/)
  })

  it("preserves a numeric file descriptor in the PlatformError projection", () => {
    const error = permissionDenied(capability, "descriptor denied")
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      pathOrDescriptor: 17,
      error
    })

    expect(projected.reason).toMatchObject({ _tag: "PermissionDenied", pathOrDescriptor: 17 })
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
  })

  it("does not unwrap an intervening PlatformError cause", () => {
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      error: permissionDenied(capability, "denied")
    })
    const doublyWrapped = systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "write",
      cause: projected
    })

    expect(fromPlatformError(doublyWrapped)).toStrictEqual(Option.none())
  })
})
