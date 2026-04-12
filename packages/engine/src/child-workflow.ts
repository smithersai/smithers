import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { RunResult } from "@smithers/driver/RunResult";
import { Effect } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
import { SmithersDb } from "@smithers/db/adapter";
import { requireTaskRuntime } from "@smithers/driver/task-runtime";
import { getWorkflowMakeBridgeRuntime } from "./effect/workflow-make-bridge";

export type ChildWorkflowDefinition =
  | SmithersWorkflow<any>
  | (() => SmithersWorkflow<any> | unknown);

export type ChildWorkflowExecuteOptions = {
  workflow: ChildWorkflowDefinition;
  input?: unknown;
  runId?: string;
  parentRunId?: string;
  rootDir?: string;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  toolTimeoutMs?: number;
  workflowPath?: string;
  signal?: AbortSignal;
};

function isWorkflowLike(value: unknown): value is SmithersWorkflow<any> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "build" in (value as Record<string, unknown>) &&
      typeof (value as any).build === "function",
  );
}

function normalizeChildInput(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

function stripSystemColumns(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(stripSystemColumns);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "runId" || key === "nodeId" || key === "iteration") continue;
    out[key] = val;
  }
  return out;
}

function normalizeChildOutput(runResult: RunResult): unknown {
  const output = runResult.output;
  if (!Array.isArray(output)) return stripSystemColumns(output);
  const rows = output.map((row) => stripSystemColumns(row));
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return rows;
}

function buildChildWorkflowRunId(
  parentRunId: string,
  stepId: string,
  iteration: number,
): string {
  return [
    parentRunId,
    "child",
    stepId,
    String(iteration),
  ].join(":");
}

function resolveChildWorkflow(
  definition: ChildWorkflowDefinition,
  parentWorkflow?: SmithersWorkflow<any>,
): SmithersWorkflow<any> {
  const resolved =
    typeof definition === "function" ? definition() : definition;

  if (isWorkflowLike(resolved)) {
    return {
      db: (resolved as any).db ?? parentWorkflow?.db,
      build: resolved.build,
      opts: (resolved as any).opts ?? {},
      schemaRegistry:
        (resolved as any).schemaRegistry ?? parentWorkflow?.schemaRegistry,
      zodToKeyName:
        (resolved as any).zodToKeyName ?? parentWorkflow?.zodToKeyName,
    };
  }

  if (typeof resolved === "function") {
    if (!parentWorkflow) {
      throw new SmithersError(
        "INVALID_INPUT",
        "Child workflow function requires a parent workflow context.",
      );
    }
    const render = resolved as (ctx: any) => any;
    return {
      db: parentWorkflow.db,
      build: (ctx: any) => render(ctx),
      opts: {},
      schemaRegistry: parentWorkflow.schemaRegistry,
      zodToKeyName: parentWorkflow.zodToKeyName,
    };
  }

  throw new SmithersError(
    "INVALID_INPUT",
    "Child workflow must be a Smithers workflow object or function.",
  );
}

export async function executeChildWorkflow(
  parentWorkflow: SmithersWorkflow<any> | undefined,
  options: ChildWorkflowExecuteOptions,
): Promise<{
  runId: string;
  status: RunResult["status"];
  output: unknown;
}> {
  const runtime = requireTaskRuntime();
  const childWorkflow = resolveChildWorkflow(options.workflow, parentWorkflow);
  const input = normalizeChildInput(options.input);
  const childRunId =
    options.runId ??
    buildChildWorkflowRunId(
      options.parentRunId ?? runtime.runId,
      runtime.stepId,
      runtime.iteration,
    );
  const adapter = new SmithersDb(childWorkflow.db as any);
  const existingChildRun = await adapter.getRun(childRunId);
  const resume = Boolean(existingChildRun);
  const bridgeRuntime = getWorkflowMakeBridgeRuntime();
  if (bridgeRuntime) {
    const result = await bridgeRuntime.executeChildWorkflow(childWorkflow, {
      input,
      runId: childRunId,
      resume,
      parentRunId: options.parentRunId ?? runtime.runId,
      rootDir: options.rootDir,
      workflowPath: options.workflowPath,
      allowNetwork: options.allowNetwork,
      maxOutputBytes: options.maxOutputBytes,
      toolTimeoutMs: options.toolTimeoutMs,
      signal: options.signal ?? runtime.signal,
    });
    return {
      runId: result.runId,
      status: result.status,
      output: normalizeChildOutput(result),
    };
  }
  const { runWorkflow } = await import("./index");
  const result = await Effect.runPromise(runWorkflow(childWorkflow, {
    input,
    runId: childRunId,
    resume,
    parentRunId: options.parentRunId ?? runtime.runId,
    rootDir: options.rootDir,
    workflowPath: options.workflowPath,
    allowNetwork: options.allowNetwork,
    maxOutputBytes: options.maxOutputBytes,
    toolTimeoutMs: options.toolTimeoutMs,
    signal: options.signal ?? runtime.signal,
  }));
  return {
    runId: result.runId,
    status: result.status,
    output: normalizeChildOutput(result),
  };
}
