/**
 * Provides a supervised spawner as a layer.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { Provider } from "../../../../src/RemoteChildProcessSpawner/Provider.ts";
import type { Options } from "./Options.vibe";
/**
 * Provides `ChildProcessSpawner` backed by a supervised remote session.
 *
 * Use it in place of `RemoteChildProcessSpawner.layer` when the provider can
 * be pinged. The two differ in one way that matters: under the plain adapter a
 * session that dies leaves its commands waiting forever, and under this one it
 * fails them so a retry policy can move the work to a fresh session.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (provider: Provider, options: Options) => Layer.Layer<ChildProcessSpawner>;
