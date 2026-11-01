/**
 * Defines where supervision reports an unhealthy sandbox.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type { SandboxUnhealthy } from "./SandboxUnhealthy.vibe";
/**
 * The sink supervision reports retirements to.
 *
 * It is injected rather than resolved from the environment because the thing
 * that wants to know — a control plane, a test, a log — is not a service this
 * package may depend on, and because supervision must keep reporting after the
 * session it is reporting about is gone.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reporter {
    readonly unhealthy: (event: SandboxUnhealthy) => Effect.Effect<void>;
}
/**
 * Reports a retirement as a warning on the current logger.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const loggingReporter: Reporter;
