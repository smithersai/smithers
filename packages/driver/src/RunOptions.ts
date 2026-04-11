import type { RunAuthContext } from "./RunAuthContext.ts";

export type HotReloadOptions = {
  /** Root directory to watch for changes (default: auto-detect from workflow entry) */
  rootDir?: string;
  /** Directory for generation overlays (default: .smithers/hmr/<runId>) */
  outDir?: string;
  /** Max overlay generations to keep (default: 3) */
  maxGenerations?: number;
  /** Whether to cancel tasks that become unmounted after hot reload (default: false) */
  cancelUnmounted?: boolean;
  /** Debounce interval in ms for file change events (default: 100) */
  debounceMs?: number;
};

export type RunOptions = {
  runId?: string;
  parentRunId?: string | null;
  input: Record<string, unknown>;
  maxConcurrency?: number;
  onProgress?: (e: unknown) => void;
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
