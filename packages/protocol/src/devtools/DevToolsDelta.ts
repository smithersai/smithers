import type { DevToolsDeltaOp } from "./DevToolsDeltaOp.ts";

export type DevToolsDelta = {
  version: 1;
  baseSeq: number;
  seq: number;
  ops: DevToolsDeltaOp[];
};
