import type { DevToolsNode } from "./DevToolsNode.ts";

type RunState =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "recovering"
  | "stale"
  | "orphaned"
  | "failed"
  | "cancelled"
  | "succeeded"
  | "unknown";

type ReasonBlocked =
  | { kind: "approval"; nodeId: string; requestedAt: string }
  | { kind: "event"; nodeId: string; correlationKey: string }
  | { kind: "timer"; nodeId: string; wakeAt: string }
  | {
      kind: "provider";
      nodeId: string;
      code: "rate-limit" | "auth" | "timeout";
    }
  | { kind: "tool"; nodeId: string; toolName: string; code: string };

type ReasonUnhealthy =
  | { kind: "engine-heartbeat-stale"; lastHeartbeatAt: string }
  | { kind: "ui-heartbeat-stale"; lastSeenAt: string }
  | { kind: "db-lock" }
  | { kind: "sandbox-unreachable" }
  | { kind: "supervisor-backoff"; attempt: number; nextAt: string };

export type RunStateView = {
  runId: string;
  state: RunState;
  blocked?: ReasonBlocked;
  unhealthy?: ReasonUnhealthy;
  computedAt: string;
};

export type DevToolsSnapshot = {
  tree: DevToolsNode | null;
  nodeCount: number;
  taskCount: number;
  timestamp: number;
  runState?: RunStateView;
};
