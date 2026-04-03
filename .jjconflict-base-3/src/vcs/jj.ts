import * as Command from "@effect/platform/Command";
import { Effect, Fiber, Metric, Stream } from "effect";
import { runPromise } from "../effect/runtime";
import { vcsDuration } from "../effect/metrics";

/**
 * Cross-version-safe JJ helpers.
 *
 * - Every helper accepts an optional `cwd` so callers can target a repo path.
 * - Spawning errors (e.g. jj not installed) are normalized to `code: 127`
 *   instead of throwing, giving stable error shapes for callers and tests.
 * - Workspace operations try multiple syntaxes to tolerate JJ version drift.
 */

export type RunJjOptions = {
  cwd?: string;
};

export type RunJjResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function collectUtf8(stream: Stream.Stream<Uint8Array, unknown, never>) {
  const decoder = new TextDecoder("utf-8");
  return Stream.runFold(stream, "", (acc, chunk) =>
    acc + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((acc) => acc + decoder.decode()));
}

/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 */
export function runJjEffect(
  args: string[],
  opts: RunJjOptions = {},
) {
  let command = Command.make("jj", ...args);
  if (opts.cwd) {
    command = Command.workingDirectory(command, opts.cwd);
  }

  return Effect.scoped(
    Effect.gen(function* () {
      const start = performance.now();
      yield* Effect.logDebug(`jj ${args.join(" ")}`);
      const process = yield* Command.start(command);
      const stdoutFiber = yield* Effect.fork(collectUtf8(process.stdout));
      const stderrFiber = yield* Effect.fork(collectUtf8(process.stderr));
      const exitCode = yield* process.exitCode;
      const stdout = yield* Fiber.join(stdoutFiber);
      const stderr = yield* Fiber.join(stderrFiber);
      yield* Metric.update(vcsDuration, performance.now() - start);
      return {
        code: Number(exitCode as unknown as number),
        stdout,
        stderr,
      };
    }),
  ).pipe(
    Effect.annotateLogs({
      vcs: "jj",
      cwd: opts.cwd ?? "",
      args: args.join(" "),
    }),
    Effect.withLogSpan("vcs:jj"),
    Effect.catchAll((error) =>
      Effect.succeed({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
}

export function runJj(
  args: string[],
  opts: RunJjOptions = {},
): Promise<RunJjResult> {
  return runPromise(runJjEffect(args, opts));
}

function jjError(res: RunJjResult): string {
  return res.stderr.trim() || `jj exited with code ${res.code}`;
}

/**
 * Returns the current workspace change id (jj `change_id`) or null on failure.
 * Accepts optional `cwd` to run inside a target repository.
 */
export function getJjPointerEffect(cwd?: string) {
  return runJjEffect(
    ["log", "-r", "@", "--no-graph", "--template", "change_id"],
    { cwd },
  ).pipe(
    Effect.map((res) => {
      if (res.code !== 0) return null;
      const out = res.stdout.trim();
      return out ? out : null;
    }),
    Effect.annotateLogs({ cwd: cwd ?? "" }),
    Effect.withLogSpan("vcs:jj-pointer"),
  );
}

export function getJjPointer(cwd?: string): Promise<string | null> {
  return runPromise(getJjPointerEffect(cwd));
}

export type JjRevertResult = {
  success: boolean;
  error?: string;
};

/**
 * Restore the working copy to a previously recorded jujutsu `change_id`.
 * Used by the engine to revert attempts within the correct repo/worktree (via `cwd`).
 */
export function revertToJjPointerEffect(
  pointer: string,
  cwd?: string,
) {
  return runJjEffect(["restore", "--from", pointer], { cwd }).pipe(
    Effect.map((res) =>
      res.code === 0
        ? { success: true as const }
        : { success: false as const, error: jjError(res) },
    ),
    Effect.annotateLogs({ cwd: cwd ?? "", pointer }),
    Effect.withLogSpan("vcs:jj-revert"),
  );
}

export function revertToJjPointer(
  pointer: string,
  cwd?: string,
): Promise<JjRevertResult> {
  return runPromise(revertToJjPointerEffect(pointer, cwd));
}

/**
 * Quick repo detection by executing a read-only jj command.
 */
export function isJjRepoEffect(cwd?: string) {
  return runJjEffect(["log", "-r", "@", "-n", "1", "--no-graph"], {
    cwd,
  }).pipe(
    Effect.map((res) => res.code === 0),
    Effect.annotateLogs({ cwd: cwd ?? "" }),
    Effect.withLogSpan("vcs:jj-is-repo"),
  );
}

export function isJjRepo(cwd?: string): Promise<boolean> {
  return runPromise(isJjRepoEffect(cwd));
}

export type WorkspaceAddOptions = {
  cwd?: string;
  atRev?: string;
};

export type WorkspaceResult = {
  success: boolean;
  error?: string;
};

/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 */
export function workspaceAddEffect(
  name: string,
  path: string,
  opts: WorkspaceAddOptions = {},
) {
  const attempts: string[][] = [];
  const revTail = opts.atRev ? ["-r", opts.atRev] : [];

  attempts.push(["workspace", "add", path, "--name", name, ...revTail]);
  if (opts.atRev) {
    attempts.push(["workspace", "add", "-r", opts.atRev, path, "--name", name]);
  }
  attempts.push(["workspace", "add", name, path, ...revTail]);
  attempts.push(["workspace", "add", "--wc-path", path, name, ...revTail]);

  return Effect.gen(function* () {
    // Pre-check: forget stale workspace + ensure parent dir exists
    const listRes = yield* runJjEffect(["workspace", "list"], { cwd: opts.cwd });
    if (listRes.code === 0 && listRes.stdout.includes(`${name}:`)) {
      yield* runJjEffect(["workspace", "forget", name], { cwd: opts.cwd });
    }
    try {
      const fs = require("node:fs");
      const nodePath = require("node:path");
      if (fs.existsSync(path)) {
        fs.rmSync(path, { recursive: true, force: true });
      }
      const parentDir = nodePath.dirname(path);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
    } catch {}

    let lastErr = "";
    for (const args of attempts) {
      const res = yield* runJjEffect(args, { cwd: opts.cwd });
      if (res.code === 0) {
        return { success: true as const };
      }
      lastErr = jjError(res);
    }
    const hint =
      ` (partial state may exist at ${path}; consider removing it before retrying)`;
    return { success: false as const, error: lastErr + hint };
  }).pipe(
    Effect.annotateLogs({
      cwd: opts.cwd ?? "",
      workspaceName: name,
      workspacePath: path,
      workspaceAtRev: opts.atRev ?? "",
    }),
    Effect.withLogSpan("vcs:jj-workspace-add"),
  );
}

export function workspaceAdd(
  name: string,
  path: string,
  opts: WorkspaceAddOptions = {},
): Promise<WorkspaceResult> {
  return runPromise(workspaceAddEffect(name, path, opts));
}

export type WorkspaceInfo = {
  name: string;
  path: string | null;
  selected: boolean;
};

/**
 * List existing workspaces using a JJ template for structured output.
 * Falls back to parsing human output if `-T` is unavailable.
 */
export function workspaceListEffect(
  cwd?: string,
) {
  return Effect.gen(function* () {
    let res = yield* runJjEffect(["workspace", "list", "-T", 'name ++ "\\n"'], {
      cwd,
    });
    if (res.code === 0) {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.map((name) => ({ name, path: null, selected: false }));
    }

    res = yield* runJjEffect(["workspace", "list"], { cwd });
    if (res.code !== 0) return [];
    const rows: WorkspaceInfo[] = [];
    for (const raw of res.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const selected = line.startsWith("*");
      const rawName = selected ? line.replace(/^\*\s*/, "").trim() : line;
      const name = rawName.split(/\s+/)[0] ?? "";
      if (!name) continue;
      rows.push({ name, path: null, selected });
    }
    return rows;
  }).pipe(
    Effect.annotateLogs({ cwd: cwd ?? "" }),
    Effect.withLogSpan("vcs:jj-workspace-list"),
  );
}

export function workspaceList(cwd?: string): Promise<WorkspaceInfo[]> {
  return runPromise(workspaceListEffect(cwd));
}

/**
 * Close the given workspace by name.
 */
export function workspaceCloseEffect(
  name: string,
  opts: { cwd?: string } = {},
) {
  return runJjEffect(["workspace", "forget", name], { cwd: opts.cwd }).pipe(
    Effect.map((res) =>
      res.code === 0
        ? { success: true as const }
        : { success: false as const, error: jjError(res) },
    ),
    Effect.annotateLogs({ cwd: opts.cwd ?? "", workspaceName: name }),
    Effect.withLogSpan("vcs:jj-workspace-close"),
  );
}

export function workspaceClose(
  name: string,
  opts: { cwd?: string } = {},
): Promise<WorkspaceResult> {
  return runPromise(workspaceCloseEffect(name, opts));
}
