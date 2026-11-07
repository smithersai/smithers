import type * as KernelJj from "@smthrs/kernel/Jj"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
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
      (EffectDigest.Digest | SecureRandom.SecureRandom) | FileSystem.FileSystem | KernelJj.Jj | Scope.Scope
    >
  >,
  Expect<
    LayerRequirementsAre<
      ReturnType<typeof NodeRuntime.layer<never, never, never, never, never, never, never>>,
      (EffectDigest.Digest | SecureRandom.SecureRandom) | FileSystem.FileSystem | KernelJj.Jj
    >
  >,
  Expect<Complete<ReturnType<typeof NodeRuntime.layerHost<never, never, never>>>>
]

/** Additional services distinguish registry-provided and still-required dependencies. */
interface RegisteredService {
  readonly registeredService: unique symbol
}
interface ExternalService {
  readonly externalService: unique symbol
}

/** Registry wiring removes its outputs and Scope while retaining external dependencies. */
type _NativeRegistryRequirements = Expect<
  LayerRequirementsAre<
    ReturnType<
      typeof NodeRuntime.layer<
        "boundary-failed",
        Scope.Scope,
        "sandbox-failed",
        Scope.Scope,
        never,
        "registration-failed",
        RegisteredService | ExternalService | Scope.Scope,
        RegisteredService,
        "registry-failed",
        ExternalService | Scope.Scope
      >
    >,
    (EffectDigest.Digest | SecureRandom.SecureRandom) | FileSystem.FileSystem | KernelJj.Jj | ExternalService
  >
>

/**
 * The runtime entry point publishes exactly these type names. The assertions
 * above are deliberately absent: a compile-time guard is checking machinery,
 * and re-exporting one widens the published declarations of `NodeRuntime`
 * with a name no consumer can call, construct, or narrow.
 * `@smthrs/platform-bun`'s `BunRuntime.types.test.ts` pins the Bun twin.
 */
const publishedTypeNames = (module: "NodeRuntime") => {
  const source = readFileSync(fileURLToPath(new URL(`../src/${module}.ts`, import.meta.url)), "utf8")
  return [...source.matchAll(/^export type (?:\{([^}]*)\}|(\w+))/gm)]
    .flatMap(([, braced, declared]) => declared === undefined ? (braced ?? "").split(",") : [declared])
    .map((name) => name.trim().split(/\s+as\s+/).at(-1) ?? "")
    .filter((name) => name.length > 0)
    .sort()
}

describe("native runtime public type surface", () => {
  it.each(["NodeRuntime"] as const)("%s publishes no compile-time assertion type", (module) => {
    expect(publishedTypeNames(module)).toEqual(["HostOptions", "Options"])
  })
})
