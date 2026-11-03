/**
 * Probes sandbox liveness under a deadline.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type { HealthState } from "./HealthState.vibe";
import type { PingProvider } from "./PingProvider.vibe";
import type { ProbeOptions } from "./ProbeOptions.vibe";
/**
 * Runs one ping under a deadline and reports a typed health state.
 *
 * A failed ping becomes `Unhealthy(reason: "ping_failed")`; a ping that
 * outlives the deadline becomes `Unhealthy(reason: "unresponsive")`. The
 * probe opens a `SandboxHealth.probe` span annotated with the outcome.
 *
 * A failed ping is logged at debug level as its provider `code` and its
 * `message`, bounded at 512 characters with control characters collapsed, and
 * the verdict carries that same bounded message. The `ProviderError` itself,
 * and above all its `cause`, never reaches a logger from here: adapters attach
 * raw vendor errors there, which can quote credentials, request headers,
 * proxies, or response bodies, and rendering an arbitrary object can throw or
 * run without bound. A host that wants the raw failure taps the ping it hands
 * in, `Effect.tapError` on `PingProvider.ping`, and applies its own redaction.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const probe: (provider: PingProvider, options?: ProbeOptions) => Effect.Effect<HealthState>;
