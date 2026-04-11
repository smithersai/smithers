import type { SmithersEvent } from "./SmithersEvent";
import type { RunAuthContext } from "./RunAuthContext";
import type { HotReloadOptions } from "./HotReloadOptions";

export type { HotReloadOptions } from "./HotReloadOptions";

export type RunOptions = {
  runId?: string;
  parentRunId?: string | null;
  input: Record<string, unknown>;
  maxConcurrency?: number;
  onProgress?: (e: SmithersEvent) => void;
  signal?: AbortSignal;
  resume?: boolean;
  force?: boolean;
  workflowPath?: string;
  rootDir?: string;
  logDir?: string | null;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  toolTimeoutMs?: number;
  hot?: boolean | HotReloadOptions;
  auth?: RunAuthContext | null;
  config?: Record<string, unknown>;
  cliAgentToolsDefault?: "all" | "explicit-only";
  resumeClaim?: {
    claimOwnerId: string;
    claimHeartbeatAtMs: number;
    restoreRuntimeOwnerId?: string | null;
    restoreHeartbeatAtMs?: number | null;
  };
};
