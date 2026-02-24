import { readdir, mkdir, link, copyFile, rm, stat } from "node:fs/promises";
import { resolve, relative, join, dirname } from "node:path";
import { existsSync } from "node:fs";

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
export async function buildOverlay(
  hotRoot: string,
  outDir: string,
  generation: number,
  opts?: OverlayOptions,
): Promise<string> {
  const exclude = new Set(opts?.exclude ?? DEFAULT_EXCLUDE);
  const genDir = join(outDir, `gen-${generation}`);
  await mkdir(genDir, { recursive: true });
  await mirrorTree(hotRoot, genDir, exclude);
  return genDir;
}

/**
 * Recursively mirror `src` into `dest`, using hardlinks where possible
 * and falling back to copy. Skips excluded directory basenames.
 */
async function mirrorTree(
  src: string,
  dest: string,
  exclude: Set<string>,
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    // Skip hidden files/dirs (dotfiles)
    if (entry.name.startsWith(".")) continue;

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await mirrorTree(srcPath, destPath, exclude);
    } else if (entry.isFile()) {
      try {
        await link(srcPath, destPath);
      } catch {
        // Hardlink failed (cross-device, permissions, etc.) — fall back to copy
        await mkdir(dirname(destPath), { recursive: true });
        await copyFile(srcPath, destPath);
      }
    }
    // Skip symlinks, sockets, etc.
  }
}

/**
 * Remove old generation directories, keeping only the last `keepLast`.
 */
export async function cleanupGenerations(
  outDir: string,
  keepLast: number,
): Promise<void> {
  if (!existsSync(outDir)) return;

  const entries = await readdir(outDir, { withFileTypes: true });
  const genDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("gen-"))
    .map((e) => {
      const num = parseInt(e.name.slice(4), 10);
      return { name: e.name, num: isNaN(num) ? -1 : num };
    })
    .filter((e) => e.num >= 0)
    .sort((a, b) => a.num - b.num);

  // Keep only the last `keepLast` generations
  const toRemove = genDirs.slice(0, Math.max(0, genDirs.length - keepLast));
  for (const dir of toRemove) {
    try {
      await rm(join(outDir, dir.name), { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
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
