/**
 * Typed tools on a sandbox's working copy: run a command, read, write and list
 * files, and git status and diff, each over one `Sandbox.Session`.
 *
 * The sandbox exposes itself and these tools; it knows nothing about agents.
 * An agent, a button or an API route reaches a machine through them alike,
 * from whatever host runs it.
 *
 * - **Typed both ways.** A tool's input is a {@link Call} and its output a
 *   {@link Result}, both Schemas, so a durable flow declares them as its
 *   payload and success and its journal keeps them.
 * - **Bounded.** A command runs for at most `limits.maxTimeoutSeconds`. Each
 *   output stream, a read, a listing and a diff return at most their limit
 *   and say when they cut.
 * - **Confined.** Every path is taken under the session's workdir. A path
 *   that leaves it is refused before anything runs.
 * - **At most once.** {@link execute} fences a command by its call id in the
 *   guest. The same call again answers the result the first attempt recorded,
 *   or fails {@link ToolLost} when that attempt never finished. It never runs
 *   a command twice.
 * - **Portable.** The scripts are POSIX `sh` with git. A guest with GNU
 *   `timeout` stops a command's whole process group at its deadline; without
 *   it, the command's own process.
 *
 * {@link checkpoint} and {@link restore} carry a working copy from one machine
 * to the next: the commit it is based on, and a binary patch from that commit
 * covering every tracked and untracked change.
 *
 * Nothing here records a path, a command, a file's content or output in
 * telemetry: spans carry the tool, the outcome and byte counts.
 *
 * @since 1.0.0-rc.17
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Session } from "../Sandbox/Session.vibe";
/**
 * The tools' bounds.
 *
 * - `commandLength`: the longest command, in characters.
 * - `pathLength`: the longest path, in characters.
 * - `defaultTimeoutSeconds`, `maxTimeoutSeconds`: how long a command runs
 *   when it names no timeout, and at most.
 * - `outputBytes`: the bytes of each output stream a command returns.
 * - `fileBytes`: the largest file a write takes, and the bytes a read returns.
 * - `listEntries`: the entries a listing returns.
 * - `diffBytes`: the bytes a diff returns.
 * - `diffPaths`: the paths a diff may name.
 * - `checkpointBytes`: the largest working-copy patch a checkpoint takes.
 * - `maxObserveWaitSeconds`: the longest {@link observe} waits for a
 *   command to end.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const limits: {
    readonly commandLength: number;
    readonly pathLength: 4096;
    readonly defaultTimeoutSeconds: 60;
    readonly maxTimeoutSeconds: 600;
    readonly outputBytes: number;
    readonly fileBytes: number;
    readonly listEntries: 1000;
    readonly diffBytes: number;
    readonly diffPaths: 100;
    readonly checkpointBytes: number;
    readonly maxObserveWaitSeconds: 60;
};
/**
 * Run `command` with `sh -c` in the workdir, or in `cwd` under it, with no
 * input, for at most `timeoutSeconds` (`limits.defaultTimeoutSeconds` unless
 * set).
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Run: Schema.Struct<{
    readonly tool: Schema.Literal<"run">;
    readonly command: Schema.String;
    readonly cwd: Schema.optional<Schema.String>;
    readonly timeoutSeconds: Schema.optional<Schema.Int>;
}>;
/**
 * Read the text of the file at `path`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Read: Schema.Struct<{
    readonly tool: Schema.Literal<"read">;
    readonly path: Schema.String;
}>;
/**
 * Write `content` to the file at `path`, making its directories; it replaces
 * what was there.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Write: Schema.Struct<{
    readonly tool: Schema.Literal<"write">;
    readonly path: Schema.String;
    readonly content: Schema.String;
}>;
/**
 * List the directory at `path`, the workdir unless set.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const List: Schema.Struct<{
    readonly tool: Schema.Literal<"list">;
    readonly path: Schema.optional<Schema.String>;
}>;
/**
 * The working copy's git status.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Status: Schema.Struct<{
    readonly tool: Schema.Literal<"status">;
    /** Compare the complete working tree with this immutable base, including local commits. */
    readonly base: Schema.optional<Schema.String>;
}>;
/**
 * The working copy's changes from `HEAD` as a unified diff, untracked files
 * as new ones, limited to `paths` when set.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Diff: Schema.Struct<{
    readonly tool: Schema.Literal<"diff">;
    readonly paths: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/**
 * One tool call: its input, tagged by `tool`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Call: Schema.Union<readonly [Schema.Struct<{
    readonly tool: Schema.Literal<"run">;
    readonly command: Schema.String;
    readonly cwd: Schema.optional<Schema.String>;
    readonly timeoutSeconds: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"read">;
    readonly path: Schema.String;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"write">;
    readonly path: Schema.String;
    readonly content: Schema.String;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"list">;
    readonly path: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"status">;
    /** Compare the complete working tree with this immutable base, including local commits. */
    readonly base: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"diff">;
    readonly paths: Schema.optional<Schema.$Array<Schema.String>>;
}>]>;
/**
 * One tool call.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Call = typeof Call.Type;
/**
 * A tool's name.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Tool = Call["tool"];
/**
 * Every tool's name.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const tools: ReadonlyArray<Tool>;
/**
 * Whether a tool changes the working copy: `run` and `write`.
 *
 * @category predicates
 * @since 1.0.0-rc.17
 */
export declare const mutates: (tool: Tool) => boolean;
/**
 * What a command did: its exit code, whether its timeout stopped it, and the
 * first `limits.outputBytes` of each stream with the stream's whole size.
 * `truncated` is true when either stream was cut.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const RunResult: Schema.Struct<{
    readonly tool: Schema.Literal<"run">;
    readonly exitCode: Schema.Int;
    readonly timedOut: Schema.Boolean;
    readonly stdout: Schema.String;
    readonly stderr: Schema.String;
    readonly stdoutBytes: Schema.Int;
    readonly stderrBytes: Schema.Int;
    readonly truncated: Schema.Boolean;
}>;
/**
 * A file's text: its first `limits.fileBytes` bytes as UTF-8, its size, and
 * whether it was cut. `path` is relative to the workdir.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const ReadResult: Schema.Struct<{
    readonly tool: Schema.Literal<"read">;
    readonly path: Schema.String;
    readonly content: Schema.String;
    readonly bytes: Schema.Int;
    readonly truncated: Schema.Boolean;
}>;
/**
 * A written file: its path relative to the workdir, and its size.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const WriteResult: Schema.Struct<{
    readonly tool: Schema.Literal<"write">;
    readonly path: Schema.String;
    readonly bytes: Schema.Int;
}>;
/**
 * One directory entry: its name, its kind, and a file's size.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Entry: Schema.Struct<{
    readonly name: Schema.String;
    readonly kind: Schema.Literals<readonly ["file", "directory", "symlink", "other"]>;
    readonly bytes: Schema.Int;
}>;
/**
 * One directory entry.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Entry = typeof Entry.Type;
/**
 * A directory's entries, in name order, at most `limits.listEntries`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const ListResult: Schema.Struct<{
    readonly tool: Schema.Literal<"list">;
    readonly path: Schema.String;
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly kind: Schema.Literals<readonly ["file", "directory", "symlink", "other"]>;
        readonly bytes: Schema.Int;
    }>>;
    readonly truncated: Schema.Boolean;
}>;
/**
 * One changed path in git's short form: `index` and `worktree` are the two
 * status letters (`?` for untracked), and `from` a rename's old path.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const StatusEntry: Schema.Struct<{
    readonly path: Schema.String;
    readonly index: Schema.String;
    readonly worktree: Schema.String;
    readonly from: Schema.optional<Schema.String>;
}>;
/**
 * One changed path.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type StatusEntry = typeof StatusEntry.Type;
/**
 * The working copy's status: its branch (`null` when detached) and every
 * changed path.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const StatusResult: Schema.Struct<{
    readonly tool: Schema.Literal<"status">;
    readonly branch: Schema.NullOr<Schema.String>;
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly index: Schema.String;
        readonly worktree: Schema.String;
        readonly from: Schema.optional<Schema.String>;
    }>>;
}>;
/**
 * A unified diff: its first `limits.diffBytes` bytes, its size, and whether
 * it was cut.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const DiffResult: Schema.Struct<{
    readonly tool: Schema.Literal<"diff">;
    readonly diff: Schema.String;
    readonly bytes: Schema.Int;
    readonly truncated: Schema.Boolean;
}>;
/**
 * One tool's output, tagged by `tool` as its call is.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Result: Schema.Union<readonly [Schema.Struct<{
    readonly tool: Schema.Literal<"run">;
    readonly exitCode: Schema.Int;
    readonly timedOut: Schema.Boolean;
    readonly stdout: Schema.String;
    readonly stderr: Schema.String;
    readonly stdoutBytes: Schema.Int;
    readonly stderrBytes: Schema.Int;
    readonly truncated: Schema.Boolean;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"read">;
    readonly path: Schema.String;
    readonly content: Schema.String;
    readonly bytes: Schema.Int;
    readonly truncated: Schema.Boolean;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"write">;
    readonly path: Schema.String;
    readonly bytes: Schema.Int;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"list">;
    readonly path: Schema.String;
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly kind: Schema.Literals<readonly ["file", "directory", "symlink", "other"]>;
        readonly bytes: Schema.Int;
    }>>;
    readonly truncated: Schema.Boolean;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"status">;
    readonly branch: Schema.NullOr<Schema.String>;
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly index: Schema.String;
        readonly worktree: Schema.String;
        readonly from: Schema.optional<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly tool: Schema.Literal<"diff">;
    readonly diff: Schema.String;
    readonly bytes: Schema.Int;
    readonly truncated: Schema.Boolean;
}>]>;
/**
 * One tool's output.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Result = typeof Result.Type;
declare const ToolRefused_base: Schema.Class<ToolRefused, Schema.TaggedStruct<"@smthrs/sandbox/SandboxTools/ToolRefused", {
    readonly reason: Schema.Literals<readonly ["path", "not_found", "not_a_file", "not_a_directory", "not_a_repository", "too_large"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * Why a tool refused a call, before or without changing anything:
 *
 * - `path`: the path leaves the workdir;
 * - `not_found`: nothing is at the path;
 * - `not_a_file`: the path is a directory, where a file was meant;
 * - `not_a_directory`: the path is not a directory, where one was meant;
 * - `not_a_repository`: the workdir is not a git working copy;
 * - `too_large`: the content or the working copy's patch is over its limit.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export declare class ToolRefused extends ToolRefused_base {
}
declare const ToolLost_base: Schema.Class<ToolLost, Schema.TaggedStruct<"@smthrs/sandbox/SandboxTools/ToolLost", {}>, import("effect/Cause").YieldableError>;
/**
 * The command was started by an earlier attempt of the same call, which never
 * recorded how it ended: it may have run, and it is not run again.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export declare class ToolLost extends ToolLost_base {
}
declare const ToolUnavailable_base: Schema.Class<ToolUnavailable, Schema.TaggedStruct<"@smthrs/sandbox/SandboxTools/ToolUnavailable", {
    readonly code: Schema.Literals<readonly ["aborted", "timeout", "unavailable", "not_found", "spawn_error", "unknown"]>;
    readonly exitCode: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
/**
 * The session failed: the machine couldn't run the tool. `code` is the
 * provider's failure kind; a caller may try the call again. `exitCode` is the
 * tool's script's own exit code when the script ran and failed (`code`
 * `unknown`), which names the step that failed; absent when the session
 * itself failed.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export declare class ToolUnavailable extends ToolUnavailable_base {
}
/**
 * What a tool can fail with.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const ToolFailure: Schema.Union<readonly [typeof ToolRefused, typeof ToolLost, typeof ToolUnavailable]>;
/**
 * What a tool can fail with.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type ToolFailure = typeof ToolFailure.Type;
/**
 * Where {@link execute} keeps what it needs between attempts.
 *
 * - `callId`: the call's own id. A command runs at most once per id.
 * - `callsDirectory`: an absolute guest directory outside the workdir, which
 *   the session's user may write, holding each command's fence, exit and
 *   output under its id.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ExecuteOptions {
    readonly callId: string;
    readonly callsDirectory: string;
}
/**
 * The absolute path `path` names under `workdir`, or `undefined` when it
 * leaves it. A relative path is taken under the workdir; `.` and `..` are
 * resolved by name, so a symbolic link is followed only by the guest.
 *
 * @category paths
 * @since 1.0.0-rc.17
 */
export declare const resolve: (workdir: string, path: string) => string | undefined;
/**
 * Runs `call` on `session`'s working copy. A `run` runs at most once per
 * `options.callId`: the same call again answers the result the first attempt
 * recorded, or fails {@link ToolLost} when that attempt never finished.
 *
 * Each call is a span `sandbox.tool` with the tool, its outcome and, for a
 * command, its exit code; never a path, a command, content or output.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const execute: (session: Session, call: Call, options: ExecuteOptions) => Effect.Effect<Result, ToolFailure>;
/**
 * Where a command started with {@link start} keeps what outlives the exec
 * session that started it.
 *
 * - `key`: the command's own key. One key starts one command, ever.
 * - `callsDirectory`: an absolute guest directory outside the workdir, which
 *   the session's user may write, as for {@link execute}. The command's pid,
 *   exit and output live there under its key.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface CommandOptions {
    readonly key: string;
    readonly callsDirectory: string;
}
/**
 * A started command's handle: the pid of the process that runs it, which
 * leads its process group, and when it started, in epoch seconds. Both are
 * 0 when an earlier start of the same key never got as far as recording
 * them, or the key was cancelled first; the command then observes `lost`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Started: Schema.Struct<{
    readonly pid: Schema.Int;
    readonly startedAt: Schema.Int;
}>;
/**
 * A started command's handle.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Started = typeof Started.Type;
/**
 * What a started command is doing: `running` while its process group lives
 * (the heartbeat), `finished` once it recorded its exit code and whether
 * its timeout stopped it, or `lost` when neither holds: the box restarted,
 * or something killed the process before it recorded how it ended.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const Observed: Schema.Union<readonly [Schema.Struct<{
    readonly state: Schema.Literal<"running">;
    readonly pid: Schema.Int;
}>, Schema.Struct<{
    readonly state: Schema.Literal<"finished">;
    readonly exitCode: Schema.Int;
    readonly timedOut: Schema.Boolean;
}>, Schema.Struct<{
    readonly state: Schema.Literal<"lost">;
}>]>;
/**
 * What a started command is doing.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Observed = typeof Observed.Type;
/**
 * Starts `call`'s command in the session's working copy, detached from the
 * exec session that starts it: in a process session and group of its own
 * where the guest has `setsid`, with its streams in files, so it outlives
 * that session, the host that asked and any number of hosts after it. It
 * runs for at most its timeout, as {@link execute}'s do.
 *
 * It answers at once, with the command's {@link Started} handle. The same
 * key again answers the same handle and never starts the command twice, so a
 * caller that lost the answer asks again. Follow it with {@link observe},
 * {@link collect} and {@link cancel}.
 *
 * A cwd that leaves the workdir is refused `path` before anything runs; one
 * that isn't a directory finishes the command, which then collects as
 * `not_a_directory`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const start: (session: Session, call: typeof Run.Type, options: CommandOptions) => Effect.Effect<Started, ToolRefused | ToolUnavailable>;
/**
 * What the command started under `options.key` is doing ({@link Observed}).
 * It reads only: asking changes nothing in the box. With `waitMs`, it first
 * waits for the command to end, answering `finished` as soon as it does
 * (within 50 ms) and what it sees once the wait is over otherwise; the wait
 * is whole seconds, `waitMs` rounded up, at most {@link limits}`.maxObserveWaitSeconds`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const observe: (session: Session, options: CommandOptions & {
    readonly waitMs?: number | undefined;
}) => Effect.Effect<Observed, ToolRefused | ToolUnavailable>;
/**
 * The result of the command started under `options.key`, once it finished:
 * the same {@link RunResult} {@link execute} answers, as often as it is
 * asked. A command that never recorded how it ended fails {@link ToolLost};
 * one whose cwd wasn't a directory, `not_a_directory`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const collect: (session: Session, options: CommandOptions) => Effect.Effect<typeof RunResult.Type, ToolFailure>;
/**
 * Stops the command started under `options.key`: its runner's and its own
 * process groups, TERM and then KILL. A key not started yet is cancelled
 * too, and a later {@link start} of it starts nothing. A command that
 * finished, or ran in a box that has since restarted, is left as it is.
 * Asking again changes nothing.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const cancel: (session: Session, options: CommandOptions) => Effect.Effect<void, ToolRefused | ToolUnavailable>;
/**
 * A working copy, carried to another machine: the commit it is based on, a
 * binary patch from that commit with every tracked and untracked change, and
 * a git bundle of the commits no remote has, such as a commit made in the
 * box, so a fresh clone can reach that commit. Ignored files are not carried.
 *
 * `bundle` is empty when every commit is on a remote; a checkpoint without
 * one restores as one with an empty bundle.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Checkpoint {
    readonly head: string;
    readonly patch: Uint8Array;
    readonly bundle?: Uint8Array | undefined;
}
/**
 * Captures the session's working copy without changing it: its `HEAD`, a
 * binary patch from it, and a bundle of the commits no remote has. A patch
 * and bundle together over `limits.checkpointBytes` are refused
 * `too_large`; a workdir with no commit, `not_a_repository`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const checkpoint: (session: Session) => Effect.Effect<Checkpoint & {
    readonly bundle: Uint8Array;
}, ToolRefused | ToolUnavailable>;
/**
 * Puts a {@link Checkpoint} back on the session's working copy: moves `HEAD`
 * to its commit when it is elsewhere, then applies its patch. A commit the
 * working copy lacks comes from the checkpoint's bundle, whose base commits
 * are fetched from `origin` by their ids first, else is fetched from `origin`
 * by its id; `not_found` when neither has it. An `origin` that can't be
 * reached fails `ToolUnavailable` with code `unavailable`, so the caller can
 * try again. Restore onto a clean
 * checkout: a working copy with changes may refuse the patch.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const restore: (session: Session, saved: Checkpoint) => Effect.Effect<void, ToolRefused | ToolUnavailable>;
/**
 * Where {@link rebaseCall}'s script leaves the paths it found, relative to
 * the workdir, NUL-separated: the files that conflict, or the files whose
 * contents the move changes. Read it with the `read` tool and
 * {@link rebasePaths}.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const REBASE_PATHS = ".git/smithers-rebase";
/**
 * Moving a working copy onto commit `onto` of `branch`, which `origin` serves.
 * Without `expect` the call only plans; with it, the call applies the plan if
 * the working copy's tree is still `expect`, the tree its plan answered.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RebaseOptions {
    readonly branch: string;
    readonly onto: string;
    readonly expect?: string | undefined;
    readonly timeoutSeconds?: number | undefined;
}
/**
 * How a {@link rebaseCall} ended, each with the working copy's tree (`tree`,
 * every tracked and untracked change staged, ignored files left out):
 *
 * - `Current`: `HEAD` is `onto` already; nothing to do.
 * - `Unrelated`: `onto` and `HEAD` share no commit.
 * - `Conflicted`: `paths` files conflict, listed in {@link REBASE_PATHS};
 *   nothing changed.
 * - `Planned`: the move is clean; it would change `paths` files' contents
 *   (listed) and leave the working copy at tree `result`.
 * - `Moved`: the working copy is no longer `expect`; nothing changed.
 * - `Applied`: `HEAD` is `onto` and the working copy is `result`, its own
 *   changes on top of `onto` as uncommitted ones; `paths` files changed.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Rebased = {
    readonly _tag: "Current";
    readonly tree: string;
} | {
    readonly _tag: "Unrelated";
    readonly tree: string;
} | {
    readonly _tag: "Conflicted";
    readonly tree: string;
    readonly paths: number;
} | {
    readonly _tag: "Planned";
    readonly tree: string;
    readonly result: string;
    readonly paths: number;
} | {
    readonly _tag: "Moved";
    readonly tree: string;
} | {
    readonly _tag: "Applied";
    readonly tree: string;
    readonly result: string;
    readonly paths: number;
};
/**
 * The `run` call that moves the working copy onto commit `options.onto` of
 * `options.branch`, fetched from `origin` when the working copy lacks it:
 * every change the working copy holds, local commits included, merged onto
 * `onto` with git's own merge base, so a change both sides made alike merges
 * clean. It plans unless `options.expect` names the tree its plan answered;
 * then it applies a clean merge and leaves the working copy's own changes
 * uncommitted on top of `onto`, its commits flattened into them. A conflict
 * changes nothing. Decode its result with {@link rebased}.
 *
 * Git 2.38 or later (`merge-tree --write-tree`). It runs as long as
 * `options.timeoutSeconds`, at most `limits.maxTimeoutSeconds` (the default):
 * a remote that answers the whole history again for every fetch takes as
 * long as a clone.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const rebaseCall: (options: RebaseOptions) => typeof Run.Type;
/**
 * How a {@link rebaseCall} ended, from its `run` result: a refusal for a
 * workdir that isn't a git working copy (`not_a_repository`) or a commit
 * `origin` doesn't serve (`not_found`); `ToolUnavailable` for an `origin`
 * that couldn't be reached (`unavailable`), a run its timeout stopped
 * (`timeout`), or a step that failed (`unknown`, with its exit code).
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const rebased: (result: typeof RunResult.Type) => Effect.Effect<Rebased, ToolRefused | ToolUnavailable>;
/**
 * The paths a {@link rebaseCall} left in {@link REBASE_PATHS}, read with the
 * `read` tool: each once, in git's order.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export declare const rebasePaths: (read: typeof ReadResult.Type) => ReadonlyArray<string>;
export {};
