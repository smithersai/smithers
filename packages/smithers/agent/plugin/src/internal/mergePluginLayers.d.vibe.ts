/**
 * Effect layer composition for a resolved plugin list.
 *
 * @private
 * @since 1.0.0-rc.0
 */
import { Action } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import type { FlowsPlugin } from "../Plugin.vibe";
import { PluginError } from "../PluginError.vibe";
/**
 * Merges plugin layers left-to-right, wrapping each build failure as
 * `layer_failed`, then seals the cache environment: it is supplied beneath
 * the plugin layers and overrides anything they output, and an absent
 * declaration stays absent.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export declare const mergePluginLayers: <H>(plugins: ReadonlyArray<FlowsPlugin<H>>, cacheEnvironment: Action.CacheEnvironment | undefined) => Layer.Layer<any, PluginError, any>;
