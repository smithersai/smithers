import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

/**
 * Configuration options for the AmpAgent.
 */
export type AmpAgentOptions = BaseCliAgentOptions & {
  /** Visibility setting for the new thread (e.g., private, public) */
  visibility?: "private" | "public" | "workspace" | "group";
  /** Path to a specific MCP configuration file */
  mcpConfig?: string;
  /** Path to a specific settings file */
  settingsFile?: string;
  /** Logging severity level */
  logLevel?: "error" | "warn" | "info" | "debug" | "audit";
  /** File path to write logs to */
  logFile?: string;
  /**
   * If true, dangerously allows all commands without asking for permission.
   * Equivalent to yolo mode but explicit.
   */
  dangerouslyAllowAll?: boolean;
  /** Whether to enable IDE integrations (disabled by default in AmpAgent) */
  ide?: boolean;
  /** Whether to enable JetBrains IDE integration */
  jetbrains?: boolean;
};
