/**
 * Buffered shell execution over the permission-aware process spawner.
 *
 * `@smthrs/kernel` used to expose a `Shell` service whose `exec` returned a
 * buffered `{ stdout, stderr, exitCode }`. The kernel replaced it with
 * `ChildProcessSpawner`, Effect's own process boundary, which streams and has
 * no buffered form. This module is the buffered form the shell flows still
 * want, expressed in terms of the spawner so the `proc:spawn` capability check
 * and the command-line resource stay exactly where the kernel put them.
 *
 * Commands run through the platform shell (`shell: true`), matching the old
 * service: the flows take a command *line*, not an argv.
 *
 * @since 1.0.0
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as StdError from "../StdError.vibe";
/**
 * Failure codes a buffered execution can report, matching the codes the
 * removed kernel `Shell` used so handler-level mapping is unchanged.
 *
 * @category models
 * @since 1.0.0
 */
export declare const ExecErrorCode: Schema.Literals<readonly ["timeout", "spawn_error", "arguments_too_long", "capture_overflow"]>;
/**
 * Failure codes a buffered execution can report.
 *
 * @category models
 * @since 1.0.0
 */
export type ExecErrorCode = typeof ExecErrorCode.Type;
declare const ExecError_base: Schema.Class<ExecError, Schema.TaggedStruct<"@smthrs/std/ExecError", {
    readonly code: Schema.Literals<readonly ["timeout", "spawn_error", "arguments_too_long", "capture_overflow"]>;
    readonly message: Schema.String;
    /** The limit a `timeout` ran past, in milliseconds. */
    readonly limitMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/**
 * A command that never produced an exit code.
 *
 * A non-zero exit is a successful {@link ExecResult}, not a failure; this
 * error is reserved for a command that could not start (`arguments_too_long`
 * when the operating system refused it for the size of its arguments) or was
 * cut off by its timeout, or whose captured output exceeded a refusing capture
 * bound.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class ExecError extends ExecError_base {
}
/**
 * The buffered result of one command.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    /** UTF-8 bytes of stdout dropped to stay inside the capture bound; see `overflow`. */
    readonly stdoutDroppedBytes: number;
    /** UTF-8 bytes of stderr dropped to stay inside the capture bound; see `overflow`. */
    readonly stderrDroppedBytes: number;
}
/**
 * Options accepted by {@link exec}.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecOptions {
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly timeoutMs?: number | undefined;
    /**
     * The program's arguments. Present means an argv, absent means a command
     * line for the platform shell. An argv is how a payload reaches a program
     * without being quoted into a string: nothing between here and `execve`
     * re-parses it.
     */
    readonly args?: ReadonlyArray<string> | undefined;
    /**
     * Text written to the program's standard input, as data. A script delivered
     * this way is never quoted, escaped, or heredoc-terminated, which is the
     * whole point: quoting corruption cost the measured SWE-bench program twelve
     * probe failures and one instance's most expensive frame. Absent, the
     * program's standard input is /dev/null.
     */
    readonly stdin?: string | undefined;
    /**
     * Bytes retained per captured stream. A stream that prints more keeps what
     * `overflow` names and reports what it dropped, so a command printing
     * gigabytes costs a bounded amount of memory rather than the whole of what it
     * printed.
     *
     * Absent means unbounded, which is what a caller wants when it needs every
     * byte a tool produced (`rg --files`, `git worktree list`).
     */
    readonly maxCaptureBytes?: number | undefined;
    /**
     * What a stream past the bound keeps. `tail`, the default, keeps its last
     * bytes. `ends` keeps its first and last halves and puts one line naming the
     * dropped bytes where the middle was. `refuse` fails if either stream exceeds
     * the bound.
     */
    readonly overflow?: Overflow | undefined;
}
type Overflow = "tail" | "ends" | "refuse";
/**
 * Runs a command line through the platform shell and buffers its output.
 *
 * Cancellation is scope closure: the spawn is scoped, so an interrupted fiber
 * — including the one a `timeoutMs` interrupts — terminates the process rather
 * than leaking it.
 *
 * @category execution
 * @since 1.0.0
 */
export declare const exec: (command: string, options?: ExecOptions) => Effect.Effect<ExecResult, ExecError, ChildProcessSpawner.ChildProcessSpawner>;
/**
 * The model-facing failure code a command that never produced an exit code
 * carries.
 *
 * A timeout keeps its own code, because "the command never finished" and "the
 * command never started" are different things to a caller deciding whether to
 * retry. Arguments the operating system refused for their size are the
 * caller's own input, which a shell flow publishes, so they read as
 * `invalid_input`. Every other way of producing no exit code is a host failure.
 *
 * @category errors
 * @since 1.0.0
 */
export declare const toStdErrorCode: (error: ExecError) => StdError.Code;
/**
 * The model-facing failure one execution error becomes.
 *
 * A timeout names the command, which is what the caller asked for and all a
 * timeout has to say. Arguments too long to start carry the reason and the
 * fix, and nothing of the command. Any other failure carries the message the
 * execution produced, which already names the command.
 *
 * @category errors
 * @since 1.0.0
 */
export declare const toStdError: (command: string, error: ExecError) => StdError.StdError;
export {};
