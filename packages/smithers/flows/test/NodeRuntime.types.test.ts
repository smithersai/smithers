import type * as KernelJj from "@smthrs/kernel/Jj"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type * as BunRuntime from "../src/BunRuntime.ts"
import type * as NodeRuntime from "../src/NodeRuntime.ts"

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

/**
 * Pins every full runtime composition to its documented host boundary.
 *
 * `make` builds in the caller's scope, while `layer` leaves the raw host's
 * crypto, filesystem, and Jj services to its caller. `layerHost` supplies
 * those services and manages its own child scope. Its registration and
 * registry arguments may still declare requirements, so the closed generic
 * instantiation below proves only that the host itself owes nothing.
 *
 * These assertions used to be an exported type on the runtime modules, which
 * shipped test machinery in the published declarations. They live here instead,
 * where `tsc -p tsconfig.test.json` still compiles them on every `pnpm check`.
 * A changed boundary stops compiling here rather than reaching a consumer as a
 * missing service at run time.
 */
type _NodeCompositionRootsAreComplete = [
  Expect<
    EffectRequirementsAre<
      ReturnType<typeof NodeRuntime.make<never, never, never, never, never, never, never>>,
      Crypto.Crypto | FileSystem.FileSystem | KernelJj.Jj | Scope.Scope
    >
  >,
  Expect<
    LayerRequirementsAre<
      ReturnType<typeof NodeRuntime.layer<never, never, never, never, never, never, never>>,
      Crypto.Crypto | FileSystem.FileSystem | KernelJj.Jj
    >
  >,
  Expect<Complete<ReturnType<typeof NodeRuntime.layerHost<never, never, never>>>>
]

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
 * The two runtime entry points publish exactly these type names. The
 * assertions above are deliberately absent: a compile-time guard is checking
 * machinery, and re-exporting one widens the published declarations of
 * `@smthrs/flows/NodeRuntime` and `@smthrs/flows/BunRuntime` with a name no
 * consumer can call, construct, or narrow.
 */
const publishedTypeNames = (module: "NodeRuntime" | "BunRuntime") => {
  const source = readFileSync(fileURLToPath(new URL(`../src/${module}.ts`, import.meta.url)), "utf8")
  return [...source.matchAll(/^export type (?:\{([^}]*)\}|(\w+))/gm)]
    .flatMap(([, braced, declared]) => declared === undefined ? (braced ?? "").split(",") : [declared])
    .map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
    .filter((name) => name.length > 0)
    .sort()
}

describe("native runtime public type surface", () => {
  it.each(["NodeRuntime", "BunRuntime"] as const)("%s publishes no compile-time assertion type", (module) => {
    expect(publishedTypeNames(module)).toEqual(["HostOptions", "Options"])
  })
})
