import { existsSync } from "node:fs";
import { resolve, dirname, parse } from "node:path";

/**
 * Walk up from `startDir` to find the nearest directory containing `.jj` or `.git`.
 * Prefers `.jj` over `.git` so colocated repos (both exist) use jj semantics.
 * Returns the VCS type and root path, or null if neither is found.
 */
export function findVcsRoot(startDir: string): { type: "git" | "jj"; root: string } | null {
  let dir = resolve(startDir);
  const { root: fsRoot } = parse(dir);
  while (true) {
    if (existsSync(resolve(dir, ".jj"))) return { type: "jj", root: dir };
    if (existsSync(resolve(dir, ".git"))) return { type: "git", root: dir };
    const parent = dirname(dir);
    if (parent === dir || dir === fsRoot) return null;
    dir = parent;
  }
}
