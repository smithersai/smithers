export type ApprovalResolution = {
  readonly approved: boolean;
  readonly note?: string;
  readonly decidedBy?: string;
  readonly optionKey?: string;
  readonly payload?: unknown;
};
