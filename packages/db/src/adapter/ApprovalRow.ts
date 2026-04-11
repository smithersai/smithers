export type ApprovalRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  status: string;
  requestedAtMs: number | null;
  decidedAtMs: number | null;
  note: string | null;
  decidedBy: string | null;
  requestJson: string | null;
  decisionJson: string | null;
  autoApproved: boolean;
};
