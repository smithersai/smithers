export type ApprovalRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly status: string;
  readonly requestedAtMs?: number | null;
  readonly decidedAtMs?: number | null;
  readonly note?: string | null;
  readonly decidedBy?: string | null;
  readonly requestJson?: string | null;
  readonly decisionJson?: string | null;
  readonly autoApproved?: boolean;
};
