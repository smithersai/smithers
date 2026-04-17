import type { DevToolsNode } from "./DevToolsNode.ts";

export type DevToolsDeltaOp =
  | { op: "addNode"; parentId: number; index: number; node: DevToolsNode }
  | { op: "removeNode"; id: number }
  | { op: "updateProps"; id: number; props: Record<string, unknown> }
  | { op: "updateTask"; id: number; task: DevToolsNode["task"] }
  | { op: "replaceRoot"; node: DevToolsNode };
