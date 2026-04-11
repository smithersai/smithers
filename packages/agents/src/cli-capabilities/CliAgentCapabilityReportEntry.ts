import type { AgentCapabilityRegistry } from "../capability-registry";
import type { CliAgentCapabilityAdapterId } from "./CliAgentCapabilityAdapterId";

export type CliAgentCapabilityReportEntry = {
  id: CliAgentCapabilityAdapterId;
  binary: string;
  fingerprint: string;
  capabilities: AgentCapabilityRegistry;
};
