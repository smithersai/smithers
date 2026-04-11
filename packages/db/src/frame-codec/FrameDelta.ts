import type { FrameDeltaOp } from "./FrameDeltaOp";

export type FrameDelta = {
  version: 1;
  ops: FrameDeltaOp[];
};
