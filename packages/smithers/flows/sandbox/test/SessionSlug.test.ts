/**
 * Recorded handles retain their original machine name. Fresh acquisitions
 * use a SHA-256 identity over the full key.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { legacySessionSlug, sessionSlug } from "../src/internal/sessionSlug.ts"

describe("sessionSlug", () => {
  it("recognizes machine names stored in older handles", () => {
    const vectors: ReadonlyArray<readonly [string, string]> = [
      // An empty key is still a name: the digest carries all of it.
      ["", "-00001505811c9dc5"],
      ["a", "a-0002b606e40c292c"],
      // A slash sanitizes to the same prefix a dash does, so only the digest
      // keeps `a/b` and `a-b` on separate machines.
      ["a/b", "a-b-0b8855f73a8e75c1"],
      ["a-b", "a-b-0b8855b52a89df63"],
      // The shape `packages/smithers/flows` actually passes.
      ["child:run-1234", "child-run-1234-eba83d0f3b8502bd"],
      ["flow.step_1", "flow.step_1-0102be5747744cf7"],
      // Non-ASCII sanitizes away entirely and survives only in the digest.
      ["café ☕", "caf----f5e4fbed2ad693d3"],
      ["é", "--0002b68e6c0b6c44"],
      // Exactly the prefix length, and one character past it.
      ["a".repeat(40), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-e6b47eadeb83bc4d"],
      ["a".repeat(41), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bd4454aeec613944"]
    ]
    for (const [key, slug] of vectors) expect(legacySessionSlug(key)).toBe(slug)
  })

  it("derives the full-key digest independently of the readable prefix", () => {
    // djb2's tail is linear, so two keys sharing the truncated prefix collide
    // as soon as `33 * c1 + c2` agrees: '1r' and '30' both reduce to 1731.
    // Under the old single-hash digest both keys named one machine, and the
    // first holder to close its scope tore it down under the other.
    const left = `${"a".repeat(48)}1r`
    const right = `${"a".repeat(48)}30`
    for (const key of [left, right, "a/b", "", "\ud800", "\udfff"]) {
      const digest = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 32)
      expect(sessionSlug(key).endsWith(`-${digest}`)).toBe(true)
    }
    expect(sessionSlug(left)).not.toBe(sessionSlug(right))
    expect(sessionSlug("\ud800")).not.toBe(sessionSlug("\udfff"))
  })

  it("gives every generated key its own name", () => {
    const alphabet = "ab/-.:_1"
    const keys = new Set<string>()
    // Every key up to three characters over an alphabet that mixes the
    // sanitized and the surviving classes, plus long keys that share the whole
    // readable prefix and differ only past it.
    const walk = (prefix: string, depth: number): void => {
      keys.add(prefix)
      if (depth === 0) return
      for (const character of alphabet) walk(prefix + character, depth - 1)
    }
    walk("", 3)
    for (let index = 0; index < 512; index++) keys.add(`${"z".repeat(48)}${index}`)

    const slugs = new Map<string, string>()
    for (const key of keys) {
      const slug = sessionSlug(key)
      expect(slugs.get(slug), `${JSON.stringify(key)} collides with ${JSON.stringify(slugs.get(slug))}`)
        .toBeUndefined()
      slugs.set(slug, key)
    }
    expect(slugs.size).toBe(keys.size)
  })

  it("emits only characters every vendor's name grammar accepts", () => {
    for (const key of ["", "a/b", "café ☕", "A B C!", "../../etc/passwd", "a".repeat(200)]) {
      expect(sessionSlug(key)).toMatch(/^[A-Za-z0-9._-]*-[0-9a-f]{32}$/)
    }
  })
})
