/**
 * Derives run-local keys for internal durable operations.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import * as Effect from "effect/Effect";
import { FlowInstance } from "../FlowRuntime/FlowInstance.vibe";
/**
 * Computes a run-local invocation key for an internal durable operation.
 *
 * The caller name separates durable declarations that share a parent scope.
 * An explicit parent scope takes precedence over `includeAttempt`; changing
 * that precedence would change persisted keys and their ordinal allocation.
 *
 * @category idempotency
 * @since 0.1.0
 */
export declare const idempotencyKey: (name: string, options?: {
    readonly includeAttempt?: boolean | undefined;
    readonly parentScope?: string | undefined;
} | undefined) => Effect.Effect<string, never, FlowInstance | Crypto.Crypto>;
