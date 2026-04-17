import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type KimiAgentOptions = BaseCliAgentOptions & {
  workDir?: string;
  session?: string;
  continue?: boolean;
  thinking?: boolean;
  outputFormat?: "text" | "stream-json";
  finalMessageOnly?: boolean;
  quiet?: boolean;
  agent?: "default" | "okabe";
  agentFile?: string;
  mcpConfigFile?: string[];
  mcpConfig?: string[];
  skillsDir?: string;
  maxStepsPerTurn?: number;
  maxRetriesPerStep?: number;
  maxRalphIterations?: number;
  verbose?: boolean;
  debug?: boolean;
};
