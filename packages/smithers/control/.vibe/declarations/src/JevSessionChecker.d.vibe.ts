/**
 * Session activity judged by the host's existing evaluator.
 * @since 1.0.0
 */
import type * as Evaluator from "@smthrs/model/Evaluator";
import { Schema } from "effect";
import type { HealthChecker } from "./Health.vibe";
declare const JevProbeError_base: Schema.Class<JevProbeError, Schema.TaggedStruct<"JevProbeError", {
    readonly reason: Schema.Literals<readonly ["unconfigured", "http", "timeout", "unreachable", "malformed"]>;
    readonly status: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/** The configured judge could not produce a usable observation.
 * @category errors
 * @since 1.0.0
 */
export declare class JevProbeError extends JevProbeError_base {
}
/** Maximum terminal evidence retained for one judgment.
 * @category constants
 * @since 1.0.0
 */
export declare const jevStateTailCharacters: number;
/** Subscription judgments have a bounded deadline.
 * @category constants
 * @since 1.0.0
 */
export declare const jevRequestTimeoutMs = 45000;
/** Probe budget, longer than the request deadline.
 * @category constants
 * @since 1.0.0
 */
export declare const jevProbeTimeoutMs = 50000;
/** Minimum confidence for an activity report.
 * @category constants
 * @since 1.0.0
 */
export declare const jevConfidenceFloor = 0.7;
/** The host evaluator and its bounded request deadline.
 * @category models
 * @since 1.0.0
 */
export interface JevSessionCheckerOptions {
    readonly evaluator?: Evaluator.Evaluator | undefined;
    readonly timeoutMs?: number | undefined;
}
/** Uses the same judge as flow completion, with no independent auth path.
 * @category constructors
 * @since 1.0.0
 */
export declare const makeJevSessionChecker: (options?: JevSessionCheckerOptions) => HealthChecker;
/** Registered but unconfigured until a host supplies its evaluator.
 * @category constants
 * @since 1.0.0
 */
export declare const jevSessionChecker: HealthChecker;
export {};
