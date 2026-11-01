/**
 * The mandatory pin registry must survive a consumer that writes to what it
 * hands back.
 *
 * `coreSuite()` used to return the registry's own array, so a consumer could
 * splice a mandatory pin out and every later call in the process returned the
 * shortened list. Freezing the array alone left the same hole one level down:
 * the case records were shared mutable objects, so assigning to a returned
 * case's `name` or `run` replaced a mandatory pin's assertion for every later
 * caller.
 */
import { describe, expect, it } from "vitest"
import { type ConformanceCase, coreSuite } from "../src/Conformance.vibe"

const mutate = (target: object, key: string, value: unknown) => () => {
  ;(target as Record<string, unknown>)[key] = value
}

describe("coreSuite hands back a registry a caller cannot edit", () => {
  it("refuses to lose a pin from the returned list", () => {
    const suite = coreSuite()
    expect(suite.length).toBeGreaterThan(0)
    expect(() => (suite as Array<ConformanceCase>).splice(0, 1)).toThrow(TypeError)
    expect(coreSuite().length).toBe(suite.length)
  })

  it("refuses to rename a pin", () => {
    const first = coreSuite()[0]!
    expect(mutate(first, "name", "renamed")).toThrow(TypeError)
    expect(coreSuite()[0]!.name).toBe(first.name)
  })

  it("refuses to replace a pin's assertion", () => {
    const first = coreSuite()[0]!
    const original = first.run
    expect(mutate(first, "run", () => undefined)).toThrow(TypeError)
    expect(coreSuite()[0]!.run).toBe(original)
  })

  it("filters without exposing the registry", () => {
    const filtered = coreSuite({ filter: (conformanceCase) => conformanceCase.name === coreSuite()[0]!.name })
    expect(filtered.length).toBe(1)
    expect(() => (filtered as Array<ConformanceCase>).pop()).toThrow(TypeError)
  })
})
