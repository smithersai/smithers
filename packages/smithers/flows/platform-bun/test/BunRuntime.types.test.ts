import type { Crypto } from "@smthrs/crypto"
import type * as KernelJj from "@smthrs/kernel/Jj"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type * as BunRuntime from "../src/BunRuntime.ts"

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Refuses a layer composition whose allowed requirement channel is not exact. */
type LayerRequirementsAre<L, Expected> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>]
  ? [R] extends [Expected] ? [Expected] extends [R] ? true : false : false
  : false

/** Refuses an effect composition whose requirement channel is not exact. */
type EffectRequirementsAre<F, Expected> = [F] extends [Effect.Effect<infer _A, infer _E, infer R>]
  ? [R] extends [Expected] ? [Expected] extends [R] ? true : false : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/** The Bun host composes the same contracts, so it owes the same boundary. */
type _BunCompositionRootsAreComplete = [
  Expect<
    EffectRequirementsAre<
      ReturnType<typeof BunRuntime.make<never, never, never, never, never, never, never>>,
      Crypto.Crypto | FileSystem.FileSystem | KernelJj.Jj | Scope.Scope
    >
  >,
  Expect<
    LayerRequirementsAre<
      ReturnType<typeof BunRuntime.layer<never, never, never, never, never, never, never>>,
      Crypto.Crypto | FileSystem.FileSystem | KernelJj.Jj
    >
  >,
  Expect<Complete<ReturnType<typeof BunRuntime.layerHost<never, never, never>>>>
]

/**
 * The runtime entry point publishes exactly these type names, as
 * `@smthrs/platform-node`'s `NodeRuntime` does. A compile-time guard is
 * checking machinery, and re-exporting one widens the published declarations
 * with a name no consumer can call, construct, or narrow.
 */
const publishedTypeNames = () => {
  const source = readFileSync(fileURLToPath(new URL("../src/BunRuntime.ts", import.meta.url)), "utf8")
  return [...source.matchAll(/^export type (?:\{([^}]*)\}|(\w+))/gm)]
    .flatMap(([, braced, declared]) => declared === undefined ? (braced ?? "").split(",") : [declared])
    .map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
    .filter((name) => name.length > 0)
    .sort()
}

describe("Bun runtime public type surface", () => {
  it("publishes no compile-time assertion type", () => {
    expect(publishedTypeNames()).toEqual(["HostOptions", "Options"])
  })
})
