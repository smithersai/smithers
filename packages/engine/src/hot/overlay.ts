import { readdir, mkdir, link, copyFile, rm } from "node:fs/promises";
import { resolve, relative, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { toSmithersError } from "@smithers/errors/toSmithersError";

const DEFAULT_EXCLUDE = [
  "node_modules",
  ".git",
  ".jj",
  ".smithers",
  ".DS_Store",
];

export type OverlayOptions = {
  /** Directory basenames to exclude from overlay */
  exclude?: string[];
};

/**
 * Build a generation overlay by hardlinking (or copying) the hot root
 * tree into a new generation directory.
 *
 * Returns the absolute path to the overlay directory.
 */
export function buildOverlayEffect(
  hotRoot: string,
  outDir: string,
  generation: number,
  opts?: OverlayOptions,
): Effect.Effect<string, SmithersError> {
  const exclude = new Set(opts?.exclude ?? DEFAULT_EXCLUDE);
  const genDir = join(outDir, `gen-${generation}`);
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(genDir, { recursive: true }),
      catch: (cause) => toSmithersError(cause, "create hot overlay generation dir", {
        code: "HOT_OVERLAY_FAILED",
        details: { hotRoot, outDir, generation },
      }),
    });
    yield* mirrorTreeEffect(hotRoot, genDir, exclude);
    return genDir;
  }).pipe(
    Effect.annotateLogs({
      hotRoot,
      outDir,
      generation,
      excludeCount: exclude.size,
    }),
    Effect.withLogSpan("hot:build-overlay"),
  );
}

export async function buildOverlay(
  hotRoot: string,
  outDir: string,
  generation: number,
  opts?: OverlayOptions,
): Promise<string> {
  return Effect.runPromise(buildOverlayEffect(hotRoot, outDir, generation, opts));
}

/**
 * Recursively mirror `src` into `dest`, using hardlinks where possible
 * and falling back to copy. Skips excluded directory basenames.
 */
function mirrorTreeEffect(
  src: string,
  dest: string,
  exclude: Set<string>,
): Effect.Effect<void, SmithersError> {
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(src, { withFileTypes: true }),
      catch: (cause) => toSmithersError(cause, "read hot overlay source dir", {
        code: "HOT_OVERLAY_FAILED",
        details: { src, dest },
      }),
    });

    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        yield* Effect.tryPromise({
          try: () => mkdir(destPath, { recursive: true }),
          catch: (cause) => toSmithersError(cause, "create mirrored hot overlay dir", {
            code: "HOT_OVERLAY_FAILED",
            details: { srcPath, destPath },
          }),
        });
        yield* mirrorTreeEffect(srcPath, destPath, exclude);
      } else if (entry.isFile()) {
        const linked = yield* Effect.either(
          Effect.tryPromise({
            try: () => link(srcPath, destPath),
            catch: (cause) => toSmithersError(cause, "hardlink overlay file", {
              code: "HOT_OVERLAY_FAILED",
              details: { srcPath, destPath },
            }),
          }),
        );
        if (linked._tag === "Left") {
          yield* Effect.tryPromise({
            try: () => mkdir(dirname(destPath), { recursive: true }),
            catch: (cause) => toSmithersError(cause, "create overlay file parent dir", {
              code: "HOT_OVERLAY_FAILED",
              details: { srcPath, destPath },
            }),
          });
          yield* Effect.tryPromise({
            try: () => copyFile(srcPath, destPath),
            catch: (cause) => toSmithersError(cause, "copy overlay file", {
              code: "HOT_OVERLAY_FAILED",
              details: { srcPath, destPath },
            }),
          });
        }
      }
    }
  });
}

/**
 * Remove old generation directories, keeping only the last `keepLast`.
 */
export function cleanupGenerationsEffect(
  outDir: string,
  keepLast: number,
): Effect.Effect<void, SmithersError> {
  return Effect.gen(function* () {
    if (!existsSync(outDir)) return;

    const entries = yield* Effect.tryPromise({
      try: () => readdir(outDir, { withFileTypes: true }),
      catch: (cause) => toSmithersError(cause, "read hot overlay generations", {
        code: "HOT_OVERLAY_FAILED",
        details: { outDir, keepLast },
      }),
    });
    const genDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("gen-"))
      .map((e) => {
        const num = parseInt(e.name.slice(4), 10);
        return { name: e.name, num: isNaN(num) ? -1 : num };
      })
      .filter((e) => e.num >= 0)
      .sort((a, b) => a.num - b.num);

    const toRemove = genDirs.slice(0, Math.max(0, genDirs.length - keepLast));
    for (const dir of toRemove) {
      yield* Effect.either(
        Effect.tryPromise({
          try: () => rm(join(outDir, dir.name), { recursive: true, force: true }),
          catch: (cause) => toSmithersError(cause, "remove stale hot overlay generation", {
            code: "HOT_OVERLAY_FAILED",
            details: { outDir, generationDir: dir.name },
          }),
        }),
      );
    }
  }).pipe(
    Effect.annotateLogs({
      outDir,
      keepLast,
    }),
    Effect.withLogSpan("hot:cleanup-generations"),
  );
}

export async function cleanupGenerations(
  outDir: string,
  keepLast: number,
): Promise<void> {
  await Effect.runPromise(cleanupGenerationsEffect(outDir, keepLast));
}

/**
 * Resolve the overlay entry path given the original entry path,
 * the hot root, and the overlay generation directory.
 */
export function resolveOverlayEntry(
  entryPath: string,
  hotRoot: string,
  genDir: string,
): string {
  const rel = relative(hotRoot, entryPath);
  return resolve(genDir, rel);
}
