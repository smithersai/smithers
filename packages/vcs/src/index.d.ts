import { Effect } from 'effect';
import * as _effect_platform_CommandExecutor from '@effect/platform/CommandExecutor';

/**
 * Walk up from `startDir` to find the nearest directory containing `.jj` or `.git`.
 * Prefers `.jj` over `.git` so colocated repos (both exist) use jj semantics.
 * Returns the VCS type and root path, or null if neither is found.
 *
 * @param {string} startDir
 * @returns {Effect.Effect<{ type: "jj"; root: string } | { type: "git"; root: string } | null, never, never>}
 */
declare function findVcsRoot(startDir: string): Effect.Effect<{
    type: "jj";
    root: string;
} | {
    type: "git";
    root: string;
} | null, never, never>;

type WorkspaceResult$1 = {
    success: boolean;
    error?: string;
};

type WorkspaceInfo$1 = {
    name: string;
    path: string | null;
    selected: boolean;
};

type WorkspaceAddOptions$1 = {
    cwd?: string;
    atRev?: string;
};

type RunJjResult$1 = {
    code: number;
    stdout: string;
    stderr: string;
};

type RunJjOptions$1 = {
    cwd?: string;
};

type JjRevertResult$1 = {
    success: boolean;
    error?: string;
};

/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 *
 * @param {string[]} args
 * @param {RunJjOptions} [opts]
 * @returns {Effect.Effect<RunJjResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function runJj(args: string[], opts?: RunJjOptions): Effect.Effect<RunJjResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Returns the current workspace change id (jj `change_id`) or null on failure.
 * Accepts optional `cwd` to run inside a target repository.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<string | null, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function getJjPointer(cwd?: string): Effect.Effect<string | null, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Restore the working copy to a previously recorded jujutsu `change_id`.
 * Used by the engine to revert attempts within the correct repo/worktree (via `cwd`).
 *
 * @param {string} pointer
 * @param {string} [cwd]
 * @returns {Effect.Effect<JjRevertResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function revertToJjPointer(pointer: string, cwd?: string): Effect.Effect<JjRevertResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Quick repo detection by executing a read-only jj command.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<boolean, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function isJjRepo(cwd?: string): Effect.Effect<boolean, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 *
 * @param {string} name
 * @param {string} path
 * @param {WorkspaceAddOptions} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function workspaceAdd(name: string, path: string, opts?: WorkspaceAddOptions): Effect.Effect<WorkspaceResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 *
 * @param {string} [cwd]
 * @returns {Effect.Effect<WorkspaceInfo[], never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function workspaceList(cwd?: string): Effect.Effect<WorkspaceInfo[], never, _effect_platform_CommandExecutor.CommandExecutor>;
/**
 * Close the given workspace by name.
 *
 * @param {string} name
 * @param {{ cwd?: string }} [opts]
 * @returns {Effect.Effect<WorkspaceResult, never, import("@effect/platform/CommandExecutor").CommandExecutor>}
 */
declare function workspaceClose(name: string, opts?: {
    cwd?: string;
}): Effect.Effect<WorkspaceResult, never, _effect_platform_CommandExecutor.CommandExecutor>;
type JjRevertResult = JjRevertResult$1;
type RunJjOptions = RunJjOptions$1;
type RunJjResult = RunJjResult$1;
type WorkspaceAddOptions = WorkspaceAddOptions$1;
type WorkspaceInfo = WorkspaceInfo$1;
type WorkspaceResult = WorkspaceResult$1;

export { findVcsRoot, getJjPointer, isJjRepo, revertToJjPointer, runJj, workspaceAdd, workspaceClose, workspaceList };
