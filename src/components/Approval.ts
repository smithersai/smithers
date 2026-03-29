import React from "react";
import { z } from "zod";
import { getTaskRuntime } from "../effect/task-runtime";
import { SmithersDb } from "../db/adapter";
import { SmithersError } from "../utils/errors";

export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export type ApprovalRequest = {
  title: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

/** Valid output targets for Approval: Zod schema, Drizzle table, or string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type ApprovalProps<Row = ApprovalDecision, Output extends OutputTarget = OutputTarget> = {
  id: string;
  /** Where to persist the approval decision. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
  output: Output;
  outputSchema?: import("zod").ZodObject<any>;
  request: ApprovalRequest;
  onDeny?: "fail" | "continue" | "skip";
  /** Explicit dependency on other task node IDs. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  skipIf?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryPolicy?: import("../RetryPolicy").RetryPolicy;
  continueOnFail?: boolean;
  cache?: import("../CachePolicy").CachePolicy;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: React.ReactNode;
};

export function Approval<Row = ApprovalDecision>(props: ApprovalProps<Row>) {
  if (props.skipIf) return null;

  const requestMeta = {
    ...(props.request.summary ? { requestSummary: props.request.summary } : {}),
    ...(props.request.metadata ?? {}),
    ...(props.meta ?? {}),
  };

  const computeDecision = async (): Promise<ApprovalDecision> => {
    const runtime = getTaskRuntime();
    if (!runtime) {
      throw new SmithersError(
        "APPROVAL_OUTSIDE_TASK",
        "Approval decisions can only be resolved while a Smithers task is executing.",
      );
    }
    const adapter = new SmithersDb(runtime.db);
    const approval = await adapter.getApproval(
      runtime.runId,
      props.id,
      runtime.iteration,
    );
    return {
      approved: approval?.status === "approved",
      note: approval?.note ?? null,
      decidedBy: approval?.decidedBy ?? null,
      decidedAt:
        typeof approval?.decidedAtMs === "number"
          ? new Date(approval.decidedAtMs).toISOString()
          : null,
    };
  };

  return React.createElement("smithers:task", {
    id: props.id,
    key: props.key,
    output: props.output,
    outputSchema: props.outputSchema ?? approvalDecisionSchema,
    dependsOn: props.dependsOn,
    needs: props.needs,
    needsApproval: true,
    approvalMode: "decision",
    approvalOnDeny: props.onDeny,
    timeoutMs: props.timeoutMs,
    retries: props.retries,
    retryPolicy: props.retryPolicy,
    continueOnFail: props.continueOnFail,
    cache: props.cache,
    label: props.label ?? props.request.title,
    meta: Object.keys(requestMeta).length > 0 ? requestMeta : undefined,
    __smithersKind: "compute",
    __smithersComputeFn: computeDecision,
  });
}
