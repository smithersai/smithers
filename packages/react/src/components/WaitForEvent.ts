import React from "react";
// TODO: verify @smithers/driver/task-runtime resolves correctly
import { getTaskRuntime } from "@smithers/driver/task-runtime";
import { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";

/** Valid output targets: a Zod schema, a Drizzle table object, or a string key. */
type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type WaitForEventProps = {
  id: string;
  /** Event name/type to wait for. */
  event: string;
  /** Correlation key to match the right event instance. */
  correlationId?: string;
  /** Where to store the event payload. */
  output: OutputTarget;
  /** Zod schema for the event payload. */
  outputSchema?: import("zod").ZodObject<any>;
  /** Max wait time in ms before timing out. */
  timeoutMs?: number;
  /** Behavior on timeout: fail (default), skip the node, or continue with null. */
  onTimeout?: "fail" | "skip" | "continue";
  /** Do not block unrelated downstream flow while waiting for the event. */
  async?: boolean;
  skipIf?: boolean;
  /** Explicit dependency on other task node IDs. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
};

export function WaitForEvent(props: WaitForEventProps) {
  if (props.skipIf) return null;

  const eventMeta = {
    event: props.event,
    ...(props.correlationId ? { correlationId: props.correlationId } : {}),
    ...(props.onTimeout ? { onTimeout: props.onTimeout } : {}),
    ...props.meta,
  };

  return React.createElement("smithers:wait-for-event", {
    id: props.id,
    key: props.key,
    event: props.event,
    correlationId: props.correlationId,
    output: props.output,
    outputSchema: props.outputSchema,
    timeoutMs: props.timeoutMs,
    onTimeout: props.onTimeout ?? "fail",
    waitAsync: props.async === true,
    dependsOn: props.dependsOn,
    needs: props.needs,
    label: props.label ?? `wait:${props.event}`,
    meta: Object.keys(eventMeta).length > 0 ? eventMeta : undefined,
    __smithersEventName: props.event,
    __smithersCorrelationId: props.correlationId,
    __smithersOnTimeout: props.onTimeout ?? "fail",
  });
}
