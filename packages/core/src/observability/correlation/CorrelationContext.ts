export type CorrelationContext = {
  runId: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  workflowName?: string;
  parentRunId?: string;
  traceId?: string;
  spanId?: string;
};
