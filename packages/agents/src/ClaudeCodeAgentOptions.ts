import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type ClaudeCodeAgentOptions = BaseCliAgentOptions & {
  addDir?: string[];
  agent?: string;
  agents?:
    | Record<string, { description?: string; prompt?: string }>
    | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  betas?: string[];
  chrome?: boolean;
  continue?: boolean;
  dangerouslySkipPermissions?: boolean;
  debug?: boolean | string;
  debugFile?: string;
  disableSlashCommands?: boolean;
  disallowedTools?: string[];
  fallbackModel?: string;
  file?: string[];
  forkSession?: boolean;
  fromPr?: string;
  ide?: boolean;
  includePartialMessages?: boolean;
  inputFormat?: "text" | "stream-json";
  jsonSchema?: string;
  maxBudgetUsd?: number;
  mcpConfig?: string[];
  mcpDebug?: boolean;
  model?: string;
  noChrome?: boolean;
  noSessionPersistence?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  permissionMode?:
    | "acceptEdits"
    | "bypassPermissions"
    | "default"
    | "delegate"
    | "dontAsk"
    | "plan";
  pluginDir?: string[];
  replayUserMessages?: boolean;
  resume?: string;
  sessionId?: string;
  settingSources?: string;
  settings?: string;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  tools?: string[] | "default" | "";
  verbose?: boolean;
};
