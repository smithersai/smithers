import { Context, Effect, Layer } from "effect"
import { expectTypeOf } from "vitest"
import type { PluginInput } from "../../src/index.ts"
import type { PluginError } from "../../src/PluginError.ts"
import * as Resolve from "../../src/Resolve.ts"

/** What the plugin layers in `Input` provide. */
type Provided<Input> = Input extends ReadonlyArray<infer Item> ? Provided<Item>
  : Input extends { readonly layer: Layer.Layer<infer ROut, infer _E, infer _RIn> } ? ROut
  : never

/** What the plugin layers in `Input` need. */
type Needed<Input> = Input extends ReadonlyArray<infer Item> ? Needed<Item>
  : Input extends { readonly layer: Layer.Layer<infer _ROut, infer _E, infer RIn> } ? RIn
  : never

/**
 * Types the test helper from the actual input layers, because `Resolve.layer`
 * exposes `Layer<any, PluginError, any>`. Removing a provider must leave its
 * consumer's requirements unsatisfied (#2704).
 */
export const resolvedLayer = async <const Input extends ReadonlyArray<PluginInput>>(
  plugins: Input,
  options?: Resolve.Options
) => {
  const resolved = await Effect.runPromise(Resolve.resolve(plugins, options))
  const layer = Resolve.layer(resolved) as Layer.Layer<
    Provided<Input>,
    PluginError,
    Exclude<Needed<Input>, Provided<Input>>
  >
  return { resolved, layer }
}

class Marker extends Context.Service<Marker, { readonly value: string }>()("test/plugin/ResolvedLayer/Marker") {}
class Unprovided
  extends Context.Service<Unprovided, { readonly value: string }>()("test/plugin/ResolvedLayer/Unprovided")
{}

/**
 * Compile-only helper regression: the check target enforces these
 * `expectTypeOf` assertions. This function is never called by runtime tests.
 */
export const unprovidedServiceProbe = async () => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
  const { layer } = await resolvedLayer([{ name: "marker", layer: Layer.succeed(Marker)({ value: "marker" }) }])
  run(Effect.map(Marker, (service) => service.value).pipe(Effect.provide(layer)))
  const unmet = Effect.map(Unprovided, (service) => service.value).pipe(Effect.provide(layer))
  expectTypeOf<typeof unmet>().not.toExtend<Parameters<typeof run>[0]>()
  const { layer: withoutMarker } = await resolvedLayer([{ name: "marker" }])
  const missing = Effect.map(Marker, (service) => service.value).pipe(Effect.provide(withoutMarker))
  expectTypeOf<typeof missing>().not.toExtend<Parameters<typeof run>[0]>()
}
