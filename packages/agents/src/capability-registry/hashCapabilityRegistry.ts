import { createHash } from "node:crypto";
import type { AgentCapabilityRegistry } from "./AgentCapabilityRegistry";
import { normalizeCapabilityRegistry } from "./normalizeCapabilityRegistry";

type StableJson =
  | null
  | boolean
  | number
  | string
  | StableJson[]
  | { [key: string]: StableJson };

function toStableJson(value: unknown): StableJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toStableJson(entry));
  }

  if (!value || typeof value !== "object") {
    return String(value);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, toStableJson(entry)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value));
}

export function hashCapabilityRegistry(
  registry: AgentCapabilityRegistry | null | undefined,
): string {
  const input = stableStringify({
    capabilityRegistry: normalizeCapabilityRegistry(registry),
  });
  return createHash("sha256").update(input).digest("hex");
}
