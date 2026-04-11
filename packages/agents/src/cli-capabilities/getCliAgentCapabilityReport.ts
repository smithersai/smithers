import {
  hashCapabilityRegistry,
  normalizeCapabilityRegistry,
  type AgentCapabilityRegistry,
} from "../capability-registry";
import { createClaudeCodeCapabilityRegistry } from "../ClaudeCodeAgent";
import { createCodexCapabilityRegistry } from "../CodexAgent";
import { createGeminiCapabilityRegistry } from "../GeminiAgent";
import { createKimiCapabilityRegistry } from "../KimiAgent";
import { createPiCapabilityRegistry } from "../PiAgent";
import type { CliAgentCapabilityAdapterId } from "./CliAgentCapabilityAdapterId";
import type { CliAgentCapabilityReportEntry } from "./CliAgentCapabilityReportEntry";

type CliAgentCapabilityAdapter = {
  id: CliAgentCapabilityAdapterId;
  binary: string;
  buildRegistry: () => AgentCapabilityRegistry;
};

const CLI_AGENT_CAPABILITY_ADAPTERS: readonly CliAgentCapabilityAdapter[] = [
  {
    id: "claude",
    binary: "claude",
    buildRegistry: () => createClaudeCodeCapabilityRegistry(),
  },
  {
    id: "codex",
    binary: "codex",
    buildRegistry: () => createCodexCapabilityRegistry(),
  },
  {
    id: "gemini",
    binary: "gemini",
    buildRegistry: () => createGeminiCapabilityRegistry(),
  },
  {
    id: "kimi",
    binary: "kimi",
    buildRegistry: () => createKimiCapabilityRegistry(),
  },
  {
    id: "pi",
    binary: "pi",
    buildRegistry: () => createPiCapabilityRegistry(),
  },
] as const;

export function getCliAgentCapabilityReport(): CliAgentCapabilityReportEntry[] {
  return CLI_AGENT_CAPABILITY_ADAPTERS.map((adapter) => {
    const capabilities = normalizeCapabilityRegistry(adapter.buildRegistry());
    if (!capabilities) {
      throw new Error(`Capability registry missing for adapter ${adapter.id}`);
    }
    return {
      id: adapter.id,
      binary: adapter.binary,
      fingerprint: hashCapabilityRegistry(capabilities),
      capabilities,
    };
  });
}
