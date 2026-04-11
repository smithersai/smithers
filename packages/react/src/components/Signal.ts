import React from "react";
import { z } from "zod";
import { SmithersContext } from "../context";
import { stripAutoColumns } from "@smithers/db/react-output";
import { SmithersError } from "@smithers/errors/SmithersError";
import { WaitForEvent } from "./WaitForEvent";

export type SignalProps<Schema extends z.ZodObject<any> = z.ZodObject<any>> = {
  id: string;
  schema: Schema;
  correlationId?: string;
  timeoutMs?: number;
  onTimeout?: "fail" | "skip" | "continue";
  /** Do not block unrelated downstream flow while waiting for the signal. */
  async?: boolean;
  skipIf?: boolean;
  dependsOn?: string[];
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: (data: z.infer<Schema>) => React.ReactNode;
  smithersContext?: React.Context<any>;
};

export function Signal<Schema extends z.ZodObject<any>>(props: SignalProps<Schema>) {
  if (props.skipIf) return null;

  const smithersContext = props.smithersContext ?? SmithersContext;
  const ctx = React.useContext(smithersContext);
  const waitNode = React.createElement(WaitForEvent, {
    id: props.id,
    key: props.key,
    event: props.id,
    correlationId: props.correlationId,
    output: props.schema,
    outputSchema: props.schema,
    timeoutMs: props.timeoutMs,
    onTimeout: props.onTimeout,
    async: props.async,
    dependsOn: props.dependsOn,
    needs: props.needs,
    label: props.label ?? `signal:${props.id}`,
    meta: props.meta,
  });

  if (!props.children) {
    return waitNode;
  }

  if (!ctx) {
    throw new SmithersError(
      "CONTEXT_OUTSIDE_WORKFLOW",
      "Signal children require a workflow context. Build the workflow with createSmithers().",
    );
  }

  const signalRow = ctx.outputMaybe(props.schema, { nodeId: props.id });
  if (signalRow === undefined) {
    return waitNode;
  }

  const signalData = props.schema.parse(stripAutoColumns(signalRow)) as z.infer<Schema>;
  return React.createElement(
    React.Fragment,
    null,
    waitNode,
    props.children(signalData),
  );
}
