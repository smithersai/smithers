export type BaseCliAgentOptions = {
  id?: string;
  model?: string;
  systemPrompt?: string;
  instructions?: string;
  cwd?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  extraArgs?: string[];
};
