/**
 * Provides the healthy no-op sandbox health layer.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer";
import type { Service } from "./Service.vibe";
/**
 * Layer form of `makeNoop`.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: Layer.Layer<Service>;
