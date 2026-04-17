import type { DevToolsNode } from "./DevToolsNode.ts";

export type DevToolsSnapshotV1 = {
  version: 1;
  runId: string;
  frameNo: number;
  seq: number;
  root: DevToolsNode;
};
