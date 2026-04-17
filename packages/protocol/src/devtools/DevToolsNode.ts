import type { DevToolsNodeType } from "./DevToolsNodeType.ts";

export type DevToolsNode = {
  id: number;
  type: DevToolsNodeType;
  name: string;
  props: Record<string, unknown>;
  task?: {
    nodeId: string;
    kind: "agent" | "compute" | "static";
    agent?: string;
    label?: string;
    outputTableName?: string;
    iteration?: number;
  };
  children: DevToolsNode[];
  depth: number;
};
