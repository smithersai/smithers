/**
 * Changesets status and version operations.
 *
 * This module also declares the irreversible exec action shared by the
 * release targets that mutate external or working-tree state.
 *
 * @since 0.1.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow";
import type * as Layer from "effect/Layer";
/**
 * The irreversible variant of the shared exec action.
 *
 * It carries the same payload, result, and error as {@link Exec.Exec} but is
 * declared at the `irreversible` tier, so the engine refuses to retry it
 * blindly and no verification, replay, or cache-population path may execute
 * it. Release targets use it for every run that mutates manifests or external
 * registries.
 *
 * @category actions
 * @since 0.1.0
 */
export declare const ExecIrreversible: Action.Declared<"smithers-build/exec-irreversible", import("effect/Schema").Struct<{
    readonly cwd: import("effect/Schema").NonEmptyString;
    readonly argv: import("effect/Schema").NonEmptyArray<import("effect/Schema").String>;
    readonly env: import("effect/Schema").withConstructorDefault<import("effect/Schema").$Record<import("effect/Schema").String, import("effect/Schema").String>>;
    readonly secrets: import("effect/Schema").withConstructorDefault<import("effect/Schema").$Array<import("effect/Schema").TaggedStruct<"HttpCredential", {
        readonly secret: import("effect/Schema").TaggedStruct<"Secret", {
            readonly env: import("effect/Schema").NonEmptyString;
            readonly fallback: import("effect/Schema").optional<import("effect/Schema").NonEmptyString>;
        }>;
        readonly audiences: import("effect/Schema").NonEmptyArray<import("effect/Schema").NonEmptyString>;
    }>>>;
    readonly expectedExitCodes: import("effect/Schema").withConstructorDefault<import("effect/Schema").$Array<import("effect/Schema").Int>>;
    readonly timeoutMs: import("effect/Schema").withConstructorDefault<import("effect/Schema").Union<readonly [import("effect/Schema").Int, import("effect/Schema").Literal<"unbounded">]>>;
    readonly after: import("effect/Schema").optional<import("effect/Schema").Unknown>;
}>, import("effect/Schema").Struct<{
    readonly exitCode: import("effect/Schema").Int;
    readonly stdout: import("effect/Schema").String;
    readonly stderr: import("effect/Schema").String;
}>, import("effect/Schema").Struct<{
    readonly _tag: import("effect/Schema").Literal<"smithers-build/ExecError">;
    readonly argv: import("effect/Schema").NonEmptyArray<import("effect/Schema").String>;
    readonly cwd: import("effect/Schema").String;
    readonly exitCode: import("effect/Schema").Number;
    readonly stdout: import("effect/Schema").String;
    readonly stderr: import("effect/Schema").String;
    readonly code: import("effect/Schema").Literals<readonly ["invalid_payload", "spawn_failed", "timed_out", "signaled", "stream_failed", "secret_proxy_failed", "sandbox_unenforceable", "exit_status"]>;
    readonly signal: import("effect/Schema").optional<import("effect/Schema").NonEmptyString>;
}>, Action.Requirement<"smithers-build/exec-irreversible">>;
/**
 * Implements {@link ExecIrreversible} with `node:child_process` spawn.
 *
 * It delegates to the shared confined exec runner, so environment scrubbing,
 * bounded output capture, and process-group interruption match sealed execs.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const ExecIrreversibleLive: (options: {
    readonly workspaceRoot: string;
}) => Layer.Layer<Action.Requirement<"smithers-build/exec-irreversible">, never, FlowRuntime.FlowRuntime>;
