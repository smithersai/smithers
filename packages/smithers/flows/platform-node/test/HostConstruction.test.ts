/** Host discovery belongs to layer acquisition, not composition or import. */
import { ProcessConfinement as KernelConfinement } from "@smthrs/kernel"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

describe("host construction", () => {
  it("defers confinement host discovery until the layer is built", async () => {
    let discoveries = 0
    const confinement = ProcessConfinement.layer({
      get host() {
        discoveries++
        return ProcessSandbox.host()
      }
    })
    expect(discoveries).toBe(0)
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(confinement)
      expect(typeof Context.get(context, KernelConfinement.ProcessConfinement).confine).toBe("function")
    })))
    expect(discoveries).toBe(1)
  })

  it("shares ambient host discovery while honoring explicit environments", () => {
    expect(ProcessSandbox.host()).toBe(ProcessSandbox.host())
    expect(ProcessSandbox.host({ PATH: "", DEVELOPER_DIR: "selected" }).developerDirectory).toBe("selected")
    expect(ProcessSandbox.host({ PATH: "", DEVELOPER_DIR: "selected" }).executable("missing")).toBeUndefined()
  })
})
