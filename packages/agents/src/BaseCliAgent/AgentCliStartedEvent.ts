export type AgentCliStartedEvent = {
  type: "started";
  engine: string;
  title: string;
  resume?: string;
  detail?: Record<string, unknown>;
};
