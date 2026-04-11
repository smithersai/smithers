import type { SmithersNodeType } from "./SmithersNodeType.ts";

export type DevToolsNode = {
  id: number;
  /** Smithers-level type: "workflow" | "task" | "sequence" | etc. */
  type: SmithersNodeType;
  /** Display name (component function name or host tag) */
  name: string;
  /** Props snapshot (serializable subset) */
  props: Record<string, unknown>;
  /** Task-specific fields extracted from renderer raw props */
  task?: {
    nodeId: string;
    kind: "agent" | "compute" | "static";
    agent?: string;
    label?: string;
    outputTableName?: string;
    iteration?: number;
  };
  children: DevToolsNode[];
  /** Depth in the Smithers tree (not renderer tree depth) */
  depth: number;
};
