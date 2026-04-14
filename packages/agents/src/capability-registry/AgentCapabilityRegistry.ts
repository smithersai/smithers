import type { AgentToolDescriptor } from "./AgentToolDescriptor";

export type AgentCapabilityRegistry = {
  version: 1;
  engine: "claude-code" | "codex" | "gemini" | "kimi" | "pi" | "amp" | "forge" | "opencode";
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
