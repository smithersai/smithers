export type FrameRow = {
  readonly runId: string;
  readonly frameNo: number;
  readonly xmlJson?: string | null;
  readonly graphJson?: string | null;
  readonly xmlHash?: string | null;
  readonly xmlEncoding?: string | null;
  readonly createdAtMs?: number;
  readonly [key: string]: unknown;
};
