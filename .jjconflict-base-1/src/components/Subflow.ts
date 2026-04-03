import React from "react";
import type { CachePolicy } from "../CachePolicy";
import type { RetryPolicy } from "../RetryPolicy";

/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type SubflowProps = {
  id: string;
  /** The child workflow definition (a smithers workflow function). */
  workflow: (...args: any[]) => any;
  /** Input to pass to the child workflow. */
  input?: unknown;
  /** `"childRun"` gets its own DB row/run; `"inline"` embeds in parent. */
  mode?: "childRun" | "inline";
  /** Where to store the subflow's result. */
  output: OutputTarget;
  skipIf?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryPolicy?: RetryPolicy;
  continueOnFail?: boolean;
  cache?: CachePolicy;
  /** Explicit dependency on other task node IDs. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: React.ReactNode;
};

export function Subflow(props: SubflowProps) {
  if (props.skipIf) return null;

  return React.createElement("smithers:subflow", {
    id: props.id,
    key: props.key,
    workflow: props.workflow,
    input: props.input,
    mode: props.mode ?? "childRun",
    output: props.output,
    timeoutMs: props.timeoutMs,
    retries: props.retries,
    retryPolicy: props.retryPolicy,
    continueOnFail: props.continueOnFail,
    cache: props.cache,
    dependsOn: props.dependsOn,
    needs: props.needs,
    label: props.label ?? props.id,
    meta: props.meta,
    __smithersSubflowWorkflow: props.workflow,
    __smithersSubflowInput: props.input,
    __smithersSubflowMode: props.mode ?? "childRun",
  });
}
