import { Layer, ManagedRuntime } from "effect";
import { SmithersCoreLayer } from "./SmithersCoreLayer.ts";

export function makeSmithersRuntime<R = never>(
  layer: Layer.Layer<R, never, never> = SmithersCoreLayer as Layer.Layer<
    R,
    never,
    never
  >,
) {
  return ManagedRuntime.make(layer);
}
