/**
 * The mount declaration an overlay's `.smithers/config.ts` exports: a pinned
 * upstream commit, a drift policy, explicit patches, and the overlay
 * directory laid over the checkout. Construction validates and performs no I/O.
 */
import { describe, expect, it } from "vitest"
import * as Mount from "../src/Mount.vibe"
import * as S from "../src/Smithers.ts"

const pin = "b04191b2941534754282c51ef2df2f965ac43a5c"

describe("S.Mount", () => {
  it("defaults to the warn policy, no patches, and the whole overlay directory", () => {
    const mount = S.Mount({ repository: "https://github.com/Effect-TS/effect.git", ref: pin })
    expect(mount).toEqual({
      _tag: "Mount",
      repository: "https://github.com/Effect-TS/effect.git",
      ref: pin,
      track: undefined,
      drift: "warn",
      patches: [],
      overlay: "."
    })
  })

  it("keeps a declared track, policy, patches, and overlay directory", () => {
    const mount = S.Mount({
      repository: "https://github.com/Effect-TS/effect.git",
      ref: pin,
      track: "main",
      drift: "follow",
      patches: ["patches/effect/0001-fix.patch"],
      overlay: "effect"
    })
    expect(mount.track).toBe("main")
    expect(mount.drift).toBe("follow")
    expect(mount.patches).toEqual(["patches/effect/0001-fix.patch"])
    expect(mount.overlay).toBe("effect")
  })

  it.each([
    ["a branch name", "main"],
    ["an abbreviated commit", "b04191b"],
    ["an uppercase commit", pin.toUpperCase()]
  ])("refuses %s as the pin", (_, ref) => {
    expect(() => S.Mount({ repository: "https://example.invalid/upstream.git", ref })).toThrow(/full commit/)
  })

  it.each(["refuse", "follow"] as const)("requires a track for the %s policy", (drift) => {
    expect(() => S.Mount({ repository: "https://example.invalid/upstream.git", ref: pin, drift })).toThrow(
      /needs a track/
    )
  })

  it.each([
    ["an absolute patch", { patches: ["/tmp/x.patch"] }],
    ["a patch that escapes .smithers", { patches: ["../x.patch"] }],
    ["a patch without the .patch suffix", { patches: ["patches/x.diff"] }],
    ["an overlay that escapes .smithers", { overlay: "../elsewhere" }]
  ])("refuses %s", (_, options) => {
    expect(() => S.Mount({ repository: "https://example.invalid/upstream.git", ref: pin, ...options })).toThrow()
  })
})

describe("S.Mounts", () => {
  it("names each mount and is recognized by its guard", () => {
    const mounts = S.Mounts({
      effect: S.Mount({ repository: "https://github.com/Effect-TS/effect.git", ref: pin })
    })
    expect(Mount.isMounts(mounts)).toBe(true)
    expect(Object.keys(mounts.mounts)).toEqual(["effect"])
    expect(Mount.isMounts({ mounts: {} })).toBe(false)
  })

  it.each(["Effect", "-effect", "effect/core", ""])("refuses the mount name %j", (name) => {
    expect(() => S.Mounts({ [name]: S.Mount({ repository: "https://example.invalid/upstream.git", ref: pin }) }))
      .toThrow(/mount name/)
  })

  it("refuses an empty declaration and a value that is not a mount", () => {
    expect(() => S.Mounts({})).toThrow(/at least one mount/)
    expect(() => S.Mounts({ effect: { repository: "x", ref: pin } as never })).toThrow(/S\.Mount/)
    const forged = { ...S.Mount({ repository: "https://example.invalid/upstream.git", ref: pin }), ref: "main" }
    expect(() => S.Mounts({ effect: forged })).toThrow(/S\.Mount/)
  })
})
