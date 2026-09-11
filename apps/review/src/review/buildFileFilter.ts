import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FileFilter } from "./fileFilter.ts";

function readProjectRule(path: string): { include?: string[]; exclude?: string[] } | null {
  if (!path || !existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    include: Array.isArray(record.include) ? record.include.filter((v): v is string => typeof v === "string") : [],
    exclude: Array.isArray(record.exclude) ? record.exclude.filter((v): v is string => typeof v === "string") : [],
  };
}

/**
 * Picks the first non-empty rule file: `--rule`, then the repository's
 * `.opencodereview/rule.json`, then the one in the home directory.
 */
export function buildFileFilter(repoDir: string, customRulePath: string): FileFilter | null {
  const candidates = [
    customRulePath ? readProjectRule(resolve(customRulePath)) : null,
    readProjectRule(join(repoDir, ".opencodereview", "rule.json")),
    readProjectRule(join(homedir(), ".opencodereview", "rule.json")),
  ];
  const picked = candidates.find(
    (rule) => rule && ((rule.include?.length ?? 0) > 0 || (rule.exclude?.length ?? 0) > 0),
  );
  if (!picked) return null;
  return {
    include: (picked.include ?? []).map((pattern) => pattern.toLowerCase()),
    exclude: (picked.exclude ?? []).map((pattern) => pattern.toLowerCase()),
  };
}
