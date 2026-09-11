// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Issues #98/#100/#101: the canonical allocation-scope derivation.
 *
 * Action identity has produced residuals for three review rounds because
 * each surface (string keys, object keys, internal operations, structural
 * dispatch sites) derived its scope its own way. `StepIdentity.allocationScope`
 * is now the single path, and these property tests pin its two contracts:
 * distinct identities never alias, and identical identities are stable
 * across repeated derivation.
 */
import { StepIdentity } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { runSync } from "./Crypto.ts"

// Total extraction for test material known to be canonical; the typed
// failure surface of `allocationScope` is exercised by "fails with a typed
// SchemaError on uncanonical object idempotency" below (issue #151).
const allocationScope = (identity: StepIdentity.AllocationIdentity): string =>
  runSync(StepIdentity.allocationScope(identity).pipe(Effect.orDie))

const content = (body: Schema.Json): Schema.JsonObject => ({ body })

/** Deterministic PRNG so the generated corpus is reproducible. */
const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const alphabet = "ab/:#s.c0123456789-"
const randomName = (rand: () => number): string => {
  const length = 1 + Math.floor(rand() * 12)
  let out = ""
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(rand() * alphabet.length)]
  }
  return out
}

describe("StepIdentity.allocationScope", () => {
  it("fails with a typed SchemaError on uncanonical object idempotency", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const error = runSync(
      StepIdentity.allocationScope({
        kind: "action",
        name: "a",
        idempotency: cyclic as Schema.JsonObject
      }).pipe(Effect.flip)
    )
    expect(Schema.isSchemaError(error)).toBe(true)
  })

  it("is stable: identical declarations derive identical scopes", () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 200; i++) {
      const identity: StepIdentity.AllocationIdentity = {
        kind: rand() < 0.5 ? "action" : "internal",
        name: randomName(rand),
        idempotency: rand() < 0.34
          ? undefined
          : rand() < 0.5
          ? randomName(rand)
          : content({ n: Math.floor(rand() * 4) }),
        site: rand() < 0.5 ? undefined : randomName(rand)
      }
      expect(allocationScope(identity)).toBe(
        allocationScope({ ...identity })
      )
    }
  })

  it("never aliases distinct declarations across a generated corpus", () => {
    const rand = mulberry32(42)
    const seen = new Map<string, string>()
    const record = (identity: StepIdentity.AllocationIdentity) => {
      const canonical = JSON.stringify([
        identity.kind,
        identity.name,
        typeof identity.idempotency === "string"
          ? ["s", identity.idempotency]
          : identity.idempotency === undefined
          ? null
          : ["c", identity.idempotency],
        identity.site ?? null
      ])
      const scope = allocationScope(identity)
      const prior = seen.get(scope)
      if (prior !== undefined) {
        // A repeated scope is only legal for a repeated declaration.
        expect(prior).toBe(canonical)
      }
      seen.set(scope, canonical)
    }
    for (let i = 0; i < 1000; i++) {
      const name = randomName(rand)
      record({ kind: rand() < 0.5 ? "action" : "internal", name })
      record({ kind: "action", name, idempotency: randomName(rand) })
      record({ kind: "action", name, idempotency: content({ i: Math.floor(rand() * 50) }) })
      record({ kind: "internal", name: "idempotency", idempotency: name })
      record({ kind: "action", name, site: randomName(rand) })
    }
    expect(seen.size).toBeGreaterThan(1000)
  })

  it("keeps adversarial separator-bearing names apart", () => {
    // Names may contain every character the encoding itself uses; the
    // length prefix is what keeps these from folding into each other.
    const key = "user-a"
    const pairs: ReadonlyArray<
      readonly [StepIdentity.AllocationIdentity, StepIdentity.AllocationIdentity]
    > = [
      [{ kind: "action", name: "a/1:b" }, { kind: "action", name: "b" }],
      [
        { kind: "action", name: `pay/s:${key}` },
        { kind: "action", name: "pay", idempotency: key }
      ],
      [
        { kind: "action", name: "pay", idempotency: "a" },
        { kind: "action", name: "pay", idempotency: "b" }
      ],
      [
        { kind: "action", name: "pay", site: "root/s:key/g:4:tail" },
        { kind: "action", name: "pay", site: "root/s:key/g:5:tail!" }
      ],
      [
        { kind: "action", name: "pay" },
        { kind: "action", name: "pay", site: "" }
      ],
      [
        { kind: "action", name: "pay" },
        { kind: "internal", name: "pay" }
      ]
    ]
    for (const [left, right] of pairs) {
      expect(allocationScope(left)).not.toBe(allocationScope(right))
    }
  })

  it("appends a length-prefixed structural site without moving the absent-site scope", () => {
    expect(allocationScope({ kind: "action", name: "body/shared" })).toBe(
      "action/11:body/shared"
    )
    expect(allocationScope({
      kind: "action",
      name: "body/shared",
      site: "root.flow.all.left"
    })).toBe(
      "action/11:body/shared/g:18:root.flow.all.left"
    )
  })

  it("keeps the string form and the object form disjoint even when the string spells the object's digest", () => {
    const object = content({ payload: "x" })
    const objectScope = allocationScope({
      kind: "action",
      name: "pay",
      idempotency: object
    })
    // Extract the object component's digest and replay it as a string key.
    const digest = objectScope.slice(objectScope.lastIndexOf("c:") + 2)
    const stringScope = allocationScope({
      kind: "action",
      name: "pay",
      idempotency: digest
    })
    expect(stringScope).not.toBe(objectScope)
  })

  it("refines the scope for distinct object identities (issue #101)", () => {
    const scopes = [
      allocationScope({ kind: "action", name: "notify", idempotency: content({ user: "a" }) }),
      allocationScope({ kind: "action", name: "notify", idempotency: content({ user: "b" }) }),
      allocationScope({ kind: "action", name: "notify" })
    ]
    expect(new Set(scopes).size).toBe(3)
  })
})
