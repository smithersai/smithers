/**
 * Provides sandbox health services as Effect layers.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer";
import type { PingProvider } from "./PingProvider.vibe";
import type { ProbeOptions } from "./ProbeOptions.vibe";
import type { Service } from "./Service.vibe";
/**
 * Provides `SandboxHealth` backed by the given provider's ping.
 *
 * Layer form of {@link make}, so a provider without `ping` provides the noop
 * service that always answers `Healthy`.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (provider: {
    readonly ping?: PingProvider["ping"] | undefined;
}, options?: ProbeOptions) => Layer.Layer<Service>;
