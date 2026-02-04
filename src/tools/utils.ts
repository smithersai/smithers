import { resolve, isAbsolute, sep, dirname } from "node:path";
import { realpath } from "node:fs/promises";

export function resolveSandboxPath(rootDir: string, inputPath: string): string {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("Path must be a string");
  }
  const resolved = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(rootDir, inputPath);
  const root = resolve(rootDir);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error("Path escapes sandbox root");
  }
  return resolved;
}

export async function assertPathWithinRoot(rootDir: string, resolvedPath: string) {
  const root = await realpath(resolve(rootDir));
  let current = resolvedPath;
  while (true) {
    try {
      const target = await realpath(current);
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error("Path escapes sandbox root (via symlink)");
      }
      return;
    } catch (err: any) {
      if (err?.message?.includes("Path escapes sandbox root")) {
        throw err;
      }
      if (err?.code && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
        throw err;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new Error("Path escapes sandbox root (via symlink)");
      }
      current = parent;
    }
  }
}
