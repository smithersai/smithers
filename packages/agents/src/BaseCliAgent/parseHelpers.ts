import type { AgentCliActionKind } from "./AgentCliActionKind";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function truncate(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

const TOOL_KIND_KEYWORDS: ReadonlyArray<readonly [string[], AgentCliActionKind]> = [
  [["bash", "shell", "command"], "command"],
  [["search", "web"], "web_search"],
  [["todo", "plan"], "todo_list"],
  [["write", "edit", "file"], "file_change"],
];

export function toolKindFromName(
  name: string | undefined,
  extraRules?: ReadonlyArray<readonly [string[], AgentCliActionKind]>,
): AgentCliActionKind {
  const normalized = (name ?? "").toLowerCase();
  if (!normalized) return "tool";

  const rules = extraRules
    ? [...TOOL_KIND_KEYWORDS, ...extraRules]
    : TOOL_KIND_KEYWORDS;

  for (const [keywords, kind] of rules) {
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) {
        return kind;
      }
    }
  }

  return "tool";
}

const RUNTIME_METADATA_MARKERS = [
  "\"mcp_servers\"",
  "\"slash_commands\"",
  "\"permissionmode\"",
  "\"claude_code_version\"",
  "\"apikeysource\"",
  "\"plugins\"",
  "\"skills\"",
];

export function isLikelyRuntimeMetadata(value: string): boolean {
  const lower = value.toLowerCase();
  let matchCount = 0;
  for (const marker of RUNTIME_METADATA_MARKERS) {
    if (lower.includes(marker)) {
      matchCount += 1;
    }
  }
  return matchCount >= 3;
}

export function shouldSurfaceUnparsedStdout(line: string): boolean {
  if (isLikelyRuntimeMetadata(line)) {
    return false;
  }
  if (line.length > 220) {
    return false;
  }

  const lower = line.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("denied") ||
    lower.includes("exception") ||
    lower.includes("timeout")
  );
}

export function createSyntheticIdGenerator(): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}
