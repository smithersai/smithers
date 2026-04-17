import type { DevToolsNode } from "./DevToolsNode.ts";

export type DevToolsSnapshot = {
  version: 1;
  runId: string;
  frameNo: number;
  seq: number;
  root: DevToolsNode;
};
