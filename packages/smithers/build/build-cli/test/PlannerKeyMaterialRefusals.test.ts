/**
 * Key material the encoder must refuse rather than flatten.
 *
 * Each refusal names the exact path that failed, so a plan error points the
 * author at the attr that cannot become cache identity.
 */
import * as Target from "@smthrs/targets/Target"
import { Schema } from "effect"
import * as Vm from "node:vm"
import { describe, expect, it } from "vitest"
import { type KeyMaterial, KeyMaterialError, keyOf, targetKeyBody } from "../src/Planner.ts"

const material = (body: unknown): KeyMaterial => ({ body, inputs: null, layers: [], capabilities: [] })

/** Captures the refusal keyOf raises, so a test can read its path and sentence. */
const refusal = (body: unknown): KeyMaterialError => {
  try {
    keyOf(material(body))
  } catch (cause) {
    if (cause instanceof KeyMaterialError) return cause
    throw cause
  }
  throw new Error("keyOf accepted material it should refuse")
}

/**
 * A real host object whose own-key enumeration runs a Proxy trap.
 *
 * A `vm` context global is not a Proxy as far as `util.types.isProxy` can see,
 * yet its interceptors forward key enumeration to the sandbox. With a Proxy
 * sandbox whose traps throw, reading the global's own keys executes hostile
 * code. Its prototype is cleared so it passes the plain-object check first.
 */
const hostileGlobal = (): object => {
  const sandbox = new Proxy({}, {
    ownKeys: () => {
      throw new Error("hostile ownKeys trap")
    },
    getOwnPropertyDescriptor: () => {
      throw new Error("hostile descriptor trap")
    }
  })
  return Vm.runInContext("Object.setPrototypeOf(globalThis, null); globalThis", Vm.createContext(sandbox)) as object
}

class Listing extends Array<number> {}

describe("keyOf refusals", () => {
  it("refuses an array subclass instance at its path", () => {
    const error = refusal({ values: Listing.from([1, 2]) })
    expect(error.path).toBe("body.values")
    expect(error.message).toBe("cache key material at body.values is an array subclass instance")
  })

  it("refuses an array that carries a symbol-keyed own property", () => {
    const tagged = Object.assign([1, 2], { [Symbol.for("smthrs/test")]: true })
    const error = refusal({ tagged })
    expect(error.path).toBe("body.tagged")
    expect(error.message).toBe("cache key material at body.tagged carries symbol-keyed own properties")
  })

  it("turns a hostile host object's thrown trap into a key material refusal", () => {
    const error = refusal({ context: hostileGlobal() })
    expect(error).toBeInstanceOf(KeyMaterialError)
    expect(error.path).toBe("body.context")
    expect(error.message).toBe(
      "cache key material at body.context could not be inspected without executing hostile object behavior"
    )
  })

  it("still encodes an ordinary array with the same members", () => {
    expect(keyOf(material({ values: [1, 2] }))).toBe(keyOf(material({ values: Array.of(1, 2) })))
  })
})

describe("targetKeyBody outputs", () => {
  const target = Target.make("PlannerDeclaredOutputs", {
    attrs: Schema.Struct({}),
    kinds: ["build"],
    implementation: () => Target.notImplemented("PlannerDeclaredOutputs")
  })({})
  const metadata = Target.metadata(target)

  it("records declared outputs as a fresh copy of their cwd and paths", () => {
    const paths = ["dist/index.js", "dist/index.d.ts"]
    const body = targetKeyBody(target, metadata, { cwd: "packages/app", paths })
    expect(body).toMatchObject({ outputs: { cwd: "packages/app", paths } })
    expect((body as { readonly outputs: { readonly paths: ReadonlyArray<string> } }).outputs.paths).not.toBe(paths)
  })

  it("keys a target with declared outputs apart from one without", () => {
    const withOutputs = targetKeyBody(target, metadata, { cwd: "packages/app", paths: ["dist/index.js"] })
    const without = targetKeyBody(target, metadata, undefined)
    expect(without).toMatchObject({ outputs: null })
    expect(keyOf(material(withOutputs))).not.toBe(keyOf(material(without)))
  })
})
