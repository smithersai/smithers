import { AsyncLocalStorage } from "node:async_hooks";
import React from "react";

export type WorkflowPatchDecisions = Record<string, boolean>;

export type WorkflowVersioningRuntime = {
  resolve(patchId: string): boolean;
  flush(): Promise<void>;
  snapshot(): WorkflowPatchDecisions;
};

type WorkflowVersioningRuntimeOptions = {
  baseConfig: Record<string, unknown>;
  initialDecisions?: WorkflowPatchDecisions;
  isNewRun: boolean;
  persist: (config: Record<string, unknown>) => Promise<void>;
};

const storage = new AsyncLocalStorage<WorkflowVersioningRuntime>();

function normalizePatchId(value: string): string {
  return value.trim();
}

function normalizePatchDecisions(value: unknown): WorkflowPatchDecisions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const decisions: WorkflowPatchDecisions = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const patchId = normalizePatchId(String(key));
    if (!patchId) continue;
    if (typeof entry === "boolean") {
      decisions[patchId] = entry;
    }
  }
  return decisions;
}

export function createWorkflowVersioningRuntime(
  options: WorkflowVersioningRuntimeOptions,
): WorkflowVersioningRuntime {
  const decisions = new Map(
    Object.entries(normalizePatchDecisions(options.initialDecisions)),
  );
  let currentConfig = { ...options.baseConfig };
  let dirty = false;

  return {
    resolve(patchId: string): boolean {
      const normalized = normalizePatchId(patchId);
      if (!normalized) {
        return false;
      }
      const existing = decisions.get(normalized);
      if (typeof existing === "boolean") {
        return existing;
      }
      const decision = options.isNewRun;
      decisions.set(normalized, decision);
      dirty = true;
      return decision;
    },
    async flush() {
      if (!dirty) {
        return;
      }
      currentConfig = {
        ...currentConfig,
        workflowPatches: Object.fromEntries(decisions.entries()),
      };
      dirty = false;
      await options.persist(currentConfig);
    },
    snapshot() {
      return Object.fromEntries(decisions.entries());
    },
  };
}

export function withWorkflowVersioningRuntime<T>(
  runtime: WorkflowVersioningRuntime,
  execute: () => T,
): T {
  return storage.run(runtime, execute);
}

export function getWorkflowVersioningRuntime():
  | WorkflowVersioningRuntime
  | undefined {
  return storage.getStore();
}

export function getWorkflowPatchDecisions(
  config: Record<string, unknown> | null | undefined,
): WorkflowPatchDecisions {
  return normalizePatchDecisions(config?.workflowPatches);
}

export function usePatched(patchId: string): boolean {
  const runtime = getWorkflowVersioningRuntime();
  return React.useMemo(
    () => runtime?.resolve(patchId) ?? false,
    [runtime, patchId],
  );
}
