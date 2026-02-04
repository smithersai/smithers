import { resolve, isAbsolute, sep } from "node:path";

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
