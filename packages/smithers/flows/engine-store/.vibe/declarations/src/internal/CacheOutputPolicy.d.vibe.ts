/**
 * Replay authority comes from the current descriptor, never the recorded paths.
 * This preflight performs no host I/O; every path is checked before replay can prune.
 * @since 1.0.0-rc.0
 */
import type { FileBoundary } from "@smthrs/flow/FileBoundary";
import type * as StepBoundary from "../../../../src/StepBoundary.ts";
/** A typed refusal leaves both the evidence and the workspace intact.
 * @category models
 * @since 1.0.0-rc.0
 */
export type Decision = {
    readonly _tag: "ReplayOutputs";
} | {
    readonly _tag: "Refused";
    readonly reason: "output-boundary-mismatch" | "unsupported-output-evidence";
};
/** Validate all recorded writes, removals and pruning roots before materialization.
 * Unknown output formats cannot establish current filesystem authority.
 * @category classifiers
 * @since 1.0.0-rc.0
 */
export declare const replay: (descriptor: FileBoundary | undefined, evidence: StepBoundary.BoundaryEvidence) => Decision;
