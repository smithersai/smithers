/**
 * Defines the complete sandbox health state.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
import { Healthy } from "./Healthy.vibe";
import { Unhealthy } from "./Unhealthy.vibe";
/**
 * Schema for every state a sandbox health probe can report.
 *
 * @category models
 * @since 0.1.0
 */
export declare const HealthState: Schema.Union<readonly [typeof Healthy, typeof Unhealthy]>;
/**
 * A state reported by a sandbox health probe.
 *
 * @category models
 * @since 0.1.0
 */
export type HealthState = typeof HealthState.Type;
