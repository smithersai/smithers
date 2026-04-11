export type AgentCliCompletedEvent = {
  type: "completed";
  engine: string;
  ok: boolean;
  answer?: string;
  error?: string;
  resume?: string;
  usage?: Record<string, unknown>;
};
