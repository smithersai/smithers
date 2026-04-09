import React from "react";
import { getTaskRuntime } from "../effect/task-runtime";
import { SmithersDb } from "../db/adapter";
import { buildHumanRequestId } from "../human-requests";
import { SmithersError } from "../utils/errors";
import type { RetryPolicy } from "../RetryPolicy";

/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type HumanTaskProps = {
  id: string;
  /** Where to store the human's response. */
  output: OutputTarget;
  /** Zod schema the human must conform to. Used for validation. */
  outputSchema?: import("zod").ZodObject<any>;
  /** Instructions for the human (string or ReactNode). */
  prompt: string | React.ReactNode;
  /** Max validation retries before failure. */
  maxAttempts?: number;
  /** Do not block unrelated downstream flow while waiting for human input. */
  async?: boolean;
  skipIf?: boolean;
  timeoutMs?: number;
  continueOnFail?: boolean;
  /** Explicit dependency on other task node IDs. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
};

function isZodObject(value: any): value is import("zod").ZodObject<any> {
  return Boolean(value && typeof value === "object" && "shape" in value);
}

export function HumanTask(props: HumanTaskProps) {
  if (props.skipIf) return null;

  const maxAttempts = props.maxAttempts ?? 10;
  const outputSchema =
    props.outputSchema ?? (isZodObject(props.output) ? props.output : undefined);

  const promptText =
    typeof props.prompt === "string"
      ? props.prompt
      : String(props.prompt ?? "");

  const humanMeta = {
    humanTask: true,
    maxAttempts,
    prompt: promptText,
    ...(props.meta ?? {}),
  };

  const computeHumanInput = async (): Promise<unknown> => {
    const runtime = getTaskRuntime();
    if (!runtime) {
      throw new SmithersError(
        "HUMAN_TASK_OUTSIDE_RUNTIME",
        "HumanTask can only be resolved while a Smithers task is executing.",
      );
    }
    const adapter = new SmithersDb(runtime.db);
    const requestId = buildHumanRequestId(
      runtime.runId,
      props.id,
      runtime.iteration,
    );
    const humanRequest = await adapter.getHumanRequest(requestId);
    const approval = await adapter.getApproval(runtime.runId, props.id, runtime.iteration);

    let rawInput = humanRequest?.responseJson ?? null;
    if (
      rawInput == null &&
      humanRequest?.status !== "cancelled" &&
      humanRequest?.status !== "expired" &&
      typeof approval?.note === "string"
    ) {
      rawInput = approval.note;
      await adapter.answerHumanRequest(
        requestId,
        rawInput,
        approval.decidedAtMs ?? Date.now(),
        approval.decidedBy ?? null,
      );
    }

    if (rawInput == null) {
      if (humanRequest?.status === "cancelled") {
        throw new SmithersError(
          "HUMAN_TASK_CANCELLED",
          `Human input for task "${props.id}" was cancelled.`,
        );
      }
      throw new SmithersError(
        "HUMAN_TASK_NO_INPUT",
        `No human input received for task "${props.id}".`,
      );
    }

    let parsed: unknown;
    try {
      parsed = typeof rawInput === "string" ? JSON.parse(rawInput) : rawInput;
    } catch {
      throw new SmithersError(
        "HUMAN_TASK_INVALID_JSON",
        `Human input for task "${props.id}" is not valid JSON.`,
      );
    }

    // Validate against output schema if provided
    if (outputSchema) {
      const result = outputSchema.safeParse(parsed);
      if (!result.success) {
        throw new SmithersError(
          "HUMAN_TASK_VALIDATION_FAILED",
          `Human input for task "${props.id}" does not match the output schema: ${result.error.message}`,
        );
      }
      return result.data;
    }

    return parsed;
  };

  return React.createElement("smithers:task", {
    id: props.id,
    key: props.key,
    output: props.output,
    outputSchema,
    dependsOn: props.dependsOn,
    needs: props.needs,
    needsApproval: true,
    waitAsync: props.async === true,
    approvalMode: "decision",
    timeoutMs: props.timeoutMs,
    retries: maxAttempts - 1,
    retryPolicy: { backoff: "fixed", initialDelayMs: 0 } satisfies RetryPolicy,
    continueOnFail: props.continueOnFail,
    label: props.label ?? `human:${props.id}`,
    meta: humanMeta,
    __smithersKind: "human",
    __smithersComputeFn: computeHumanInput,
  });
}
