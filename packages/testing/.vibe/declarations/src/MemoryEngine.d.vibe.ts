/**
 * Reference in-memory flow engine with an externally owned replay store.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { type EngineSubject as EngineSubjectService, type ExecutionResult, type FlowSpec, type JournalEntryLike } from "./EngineSubject.vibe";
type ExecutionStatus = ExecutionResult["status"] | "running";
interface StoredExecution {
    readonly executionId: string;
    readonly flow: FlowSpec;
    readonly payload: unknown;
    readonly idempotencyKey: string | undefined;
    readonly journal: ReadonlyArray<JournalEntryLike>;
    readonly status: ExecutionStatus;
    readonly value: unknown;
}
interface StoreState {
    readonly executions: ReadonlyMap<string, StoredExecution>;
    readonly idempotencyIndex: ReadonlyMap<string, string>;
    readonly nextExecutionId: number;
}
declare const EngineStoreTypeId: unique symbol;
/**
 * Persistent state shared by one or more in-memory engine instances.
 *
 * The store owns flow specifications, journals, terminal results, and the
 * idempotency index. Live fibers are intentionally engine-local.
 *
 * @category models
 * @since 0.0.0
 */
export interface EngineStore {
    readonly [EngineStoreTypeId]: Ref.Ref<StoreState>;
}
/**
 * Creates an empty persistent store for memory-engine executions.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const makeStore: () => Effect.Effect<EngineStore>;
/**
 * Constructs an in-memory engine whose durable state is held by `store`.
 *
 * Closing the construction scope interrupts only this engine instance's live
 * fibers. A fresh engine built with the same store replays completed journal
 * entries and continues at the first unfinished step.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const make: (store: EngineStore) => Effect.Effect<EngineSubjectService, never, Scope.Scope>;
/**
 * Provides a scoped in-memory engine backed by `store`.
 *
 * @category layers
 * @since 0.0.0
 */
export declare const layer: (store: EngineStore) => Layer.Layer<EngineSubjectService>;
export {};
