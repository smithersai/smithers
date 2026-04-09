import { sha256Hex } from "../utils/hash";

export type AgentToolDescriptor = {
  description?: string;
  source?: "builtin" | "mcp" | "extension" | "skill" | "runtime";
};

export type AgentCapabilityRegistry = {
  version: 1;
  engine: "claude-code" | "codex" | "gemini" | "kimi" | "pi" | "amp";
  runtimeTools: Record<string, AgentToolDescriptor>;
  mcp: {
    bootstrap: "inline-config" | "project-config" | "allow-list" | "unsupported";
    supportsProjectScope: boolean;
    supportsUserScope: boolean;
  };
  skills: {
    supportsSkills: boolean;
    installMode?: "files" | "dir" | "plugin";
    smithersSkillIds: string[];
  };
  humanInteraction: {
    supportsUiRequests: boolean;
    methods: string[];
  };
  builtIns: string[];
};

type StableJson =
  | null
  | boolean
  | number
  | string
  | StableJson[]
  | { [key: string]: StableJson };

export function normalizeCapabilityStringList(
  values: readonly string[] | null | undefined,
): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

function normalizeToolDescriptor(
  descriptor: AgentToolDescriptor | null | undefined,
): AgentToolDescriptor {
  return {
    description: descriptor?.description?.trim() || undefined,
    source: descriptor?.source,
  };
}

export function normalizeCapabilityRegistry(
  registry: AgentCapabilityRegistry | null | undefined,
): AgentCapabilityRegistry | null {
  if (!registry) {
    return null;
  }

  const runtimeTools = Object.fromEntries(
    Object.entries(registry.runtimeTools ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, descriptor]) => [name, normalizeToolDescriptor(descriptor)]),
  );

  return {
    version: 1,
    engine: registry.engine,
    runtimeTools,
    mcp: {
      bootstrap: registry.mcp.bootstrap,
      supportsProjectScope: registry.mcp.supportsProjectScope,
      supportsUserScope: registry.mcp.supportsUserScope,
    },
    skills: registry.skills.supportsSkills
      ? {
          supportsSkills: true,
          installMode: registry.skills.installMode,
          smithersSkillIds: normalizeCapabilityStringList(
            registry.skills.smithersSkillIds,
          ),
        }
      : {
          supportsSkills: false,
          smithersSkillIds: normalizeCapabilityStringList(
            registry.skills.smithersSkillIds,
          ),
        },
    humanInteraction: {
      supportsUiRequests: registry.humanInteraction.supportsUiRequests,
      methods: normalizeCapabilityStringList(registry.humanInteraction.methods),
    },
    builtIns: normalizeCapabilityStringList(registry.builtIns),
  };
}

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
  return sha256Hex(
    stableStringify({
      capabilityRegistry: normalizeCapabilityRegistry(registry),
    }),
  );
}
