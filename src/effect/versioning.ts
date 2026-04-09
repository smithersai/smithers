import { AsyncLocalStorage } from "node:async_hooks";
import React from "react";

export type WorkflowPatchDecisions = Record<string, boolean>;

export type WorkflowVersioningRuntime = {
  resolve(patchId: string): boolean;
  flush(): Promise<void>;
  snapshot(): WorkflowPatchDecisions;
};

export type WorkflowPatchDecisionRecord = {
  patchId: string;
  decision: boolean;
};

type WorkflowVersioningRuntimeOptions = {
  baseConfig: Record<string, unknown>;
  initialDecisions?: WorkflowPatchDecisions;
  isNewRun: boolean;
  persist: (config: Record<string, unknown>) => Promise<void>;
  recordDecision?: (record: WorkflowPatchDecisionRecord) => Promise<void>;
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
  const pendingRecords: WorkflowPatchDecisionRecord[] = [];

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
      pendingRecords.push({ patchId: normalized, decision });
      return decision;
    },
    async flush() {
      if (!dirty && pendingRecords.length === 0) {
        return;
      }
      const nextConfig = dirty
        ? {
            ...currentConfig,
            workflowPatches: Object.fromEntries(decisions.entries()),
          }
        : currentConfig;

      if (dirty) {
        await options.persist(nextConfig);
        currentConfig = nextConfig;
        dirty = false;
      }

      if (pendingRecords.length > 0 && options.recordDecision) {
        const records = pendingRecords.slice();
        for (const record of records) {
          await options.recordDecision(record);
        }
        pendingRecords.splice(0, records.length);
      }
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
