/**
 * A value a host already redacted and clipped (apps/mvp decision 0014 §1, step
 * inputs and outputs): JSON text cut at the host's bound, its size before the
 * cut, and whether it was cut. Framework-free, so a terminal reads it the same.
 */
import { MAX_JSON_DEPTH } from "../agentic/formatJsonSafe";

/** One value as the host hands it over: `text` is never HTML and never parsed for markup. */
export interface JsonValueData {
  readonly text: string;
  /** The value's size in bytes before any clip. */
  readonly bytes: number;
  /** Whether `text` was cut at the host's bound. */
  readonly clipped: boolean;
}

/** Whether a parsed value holds anything deeper than `maxDepth` levels, the root at depth zero. */
const nestsBeyond = (parsed: unknown, maxDepth: number): boolean => {
  let level: unknown[] = [parsed];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth > maxDepth) return true;
    const next: unknown[] = [];
    for (const item of level) {
      if (typeof item === "object" && item !== null) for (const child of Object.values(item)) next.push(child);
    }
    level = next;
  }
  return false;
};

/**
 * The text a value shows: pretty-printed when it parses as JSON, wasn't
 * clipped (a clipped value is a cut string, so it shows as is) and nests no
 * deeper than `MAX_JSON_DEPTH`, else the text. Indentation grows with depth,
 * so a deeper value's print would take space quadratic in its size.
 */
export const jsonValueText = (value: JsonValueData): string => {
  if (value.clipped) return value.text;
  try {
    const parsed: unknown = JSON.parse(value.text);
    if (typeof parsed === "string") return parsed;
    return nestsBeyond(parsed, MAX_JSON_DEPTH) ? value.text : JSON.stringify(parsed, null, 2);
  } catch {
    return value.text;
  }
};

/** A size in bytes as it reads: `512 B`, `1.5 KB`, `16 KB`, `2.3 MB` (1 KB = 1,024 B). */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unit]}`;
};
