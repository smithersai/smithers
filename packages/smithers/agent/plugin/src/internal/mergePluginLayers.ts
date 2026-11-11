/**
 * Effect layer composition for a resolved plugin list.
 *
 * @private
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { FlowsPlugin } from "../Plugin.ts"
import { PluginError } from "../PluginError.ts"

/**
 * Merges plugin layers left-to-right, wrapping each build failure as
 * `layer_failed`, and seals the cache environment: it is supplied beneath
 * every plugin layer, overrides anything they output, and an absent
 * declaration stays absent.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const mergePluginLayers = <H>(
  plugins: ReadonlyArray<FlowsPlugin<H>>,
  cacheEnvironment: Action.CacheEnvironment | undefined
): Layer.Layer<any, PluginError, any> => {
  const layers = plugins.flatMap((plugin) =>
    plugin.layer
      ? [
        Layer.catchCause(plugin.layer, (cause) =>
          Layer.effectDiscard(
            Effect.fail(
              new PluginError({
                code: "layer_failed",
                message: `plugin "${plugin.name}" failed to build its layer`,
                plugin: plugin.name,
                cause
              })
            )
          )) as Layer.Layer<any, PluginError, any>
      ]
      : []
  )
  // An absent declaration is sealed as `undefined`, so no plugin layer can
  // declare or replace the composition's cache identity.
  const environment = Layer.succeed(Action.CurrentCacheEnvironment)(cacheEnvironment) as unknown as Layer.Layer<
    any,
    PluginError,
    any
  >
  // Each plugin layer builds over the output of the layers before it, so the
  // sealed environment is laid over that output before every later layer
  // builds: a later plugin reads the declared environment, never one an
  // earlier plugin provided (#4869). It is provided beneath the first layer
  // the same way, then merged last so it overrides any plugin output.
  const merged = (layers.length === 0
    ? Layer.empty
    : layers.reduce((accumulated, next) =>
      Layer.provideMerge(next, Layer.merge(accumulated, environment))
    )) as Layer.Layer<any, PluginError, any>
  return Layer.merge(Layer.provideMerge(merged, environment), environment)
}
