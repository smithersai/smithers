/**
 * Cache identity admission for a resolved plugin list.
 *
 * @private
 * @since 1.0.0-rc.0
 */
import { Action } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import type { FlowsPlugin } from "../Plugin.vibe";
import { PluginError } from "../PluginError.vibe";
/**
 * Admits a caller cache environment and prepends one escaped `name@version`
 * identity per plugin, in resolved order. An absent input stays absent. A
 * versionless plugin is refused at the dollar-path it was admitted from.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export declare const snapshotCacheEnvironment: <H>(input: unknown, plugins: ReadonlyArray<{
    readonly plugin: FlowsPlugin<H>;
    readonly path: string;
}>) => Effect.Effect<Action.CacheEnvironment | undefined, PluginError>;
