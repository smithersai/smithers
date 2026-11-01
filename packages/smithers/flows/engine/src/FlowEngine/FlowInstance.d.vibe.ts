/**
 * Construction of the per-execution state an engine hands to a flow run.
 *
 * @since 0.1.0
 */
import type { Flow, FlowRuntime } from "@smthrs/flow";
import * as Lineage from "./Lineage.ts";
/**
 * Creates the initial `FlowInstance` state for one flow execution.
 *
 * **When to use**
 *
 * Use when a runtime starts — or restarts, on resume — a flow run and needs
 * the mutable state its suspension, interruption, and action coordination
 * are tracked in.
 *
 * The returned `lineageId` keeps its {@link module:Lineage.JournalLineageId}
 * brand, so it cannot pass for a trampoline root execution id.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeInstance: (flow: Flow.Any, executionId: string, lineageDeadline?: Flow.LineageDeadline | undefined) => FlowRuntime.FlowInstance["Service"] & {
    readonly lineageId: Lineage.JournalLineageId;
};
