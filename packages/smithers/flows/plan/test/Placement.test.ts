/**
 * The one placement model, and the copy its constructors make.
 *
 * `sandbox` and `remote` take caller options. A recorded directive is hashed
 * into `KeyMaterial.placement`, so a constructor that kept the caller's object
 * would let a later mutation change a key that was already computed.
 */
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Placement from "../src/Placement.ts"

describe("Placement", () => {
  it("tags the four directives with the values a step key hashes", () => {
    expect(Placement.local()._tag).toBe("flows/core/Placement/Local")
    expect(Placement.client()._tag).toBe("flows/core/Placement/Client")
    expect(Placement.sandbox()._tag).toBe("flows/core/Placement/Sandbox")
    expect(Placement.remote()._tag).toBe("flows/core/Placement/Remote")
  })

  it("carries host-selection detail and defaults it to none", () => {
    expect(Placement.sandbox({ image: "ubuntu-22" })).toEqual({
      _tag: "flows/core/Placement/Sandbox",
      image: "ubuntu-22"
    })
    expect(Placement.remote({ profile: "gpu", target: "us-east" })).toEqual({
      _tag: "flows/core/Placement/Remote",
      profile: "gpu",
      target: "us-east"
    })
    expect(Placement.sandbox()).toEqual({ _tag: "flows/core/Placement/Sandbox" })
    expect(Placement.remote()).toEqual({ _tag: "flows/core/Placement/Remote" })
  })

  it("copies the caller's options instead of keeping them", () => {
    const options = { image: "ubuntu-22" }
    const directive = Placement.sandbox(options)
    options.image = "changed after the directive was built"
    expect(directive).toEqual({ _tag: "flows/core/Placement/Sandbox", image: "ubuntu-22" })
  })

  it("annotates under one key", () => {
    expect(Placement.Annotation.key).toBe("@smthrs/plan/Placement")
    const bag = Context.add(Context.empty(), Placement.Annotation, Placement.local())
    expect(Context.getOption(bag, Placement.Annotation)).toEqual(Option.some(Placement.local()))
  })
})
