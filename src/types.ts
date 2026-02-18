import type React from "react";
import type { z } from "zod";

export type XmlNode = XmlElement | XmlText;

export type XmlElement = {
  kind: "element";
  tag: string;
  props: Record<string, string>;
  children: XmlNode[];
};

export type XmlText = {
  kind: "text";
  text: string;
};

export type TaskDescriptor = {
  nodeId: string;
  ordinal: number;
  iteration: number;
  ralphId?: string;

  /** Set when task is inside <Worktree>. */
  worktreeId?: string;
  worktreePath?: string;

  outputTable: any | null;
  outputTableName: string;
  outputSchema?: import("zod").ZodObject<any>;

  /**
   * When task is nested under a <Parallel> or <MergeQueue> group,
   * this captures the stable group id and the group-level max concurrency.
   * The scheduler enforces this cap when selecting runnable tasks so that
   * at most `parallelMaxConcurrency` tasks sharing the same group run
   * concurrently across the workflow.
   */
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;

  needsApproval: boolean;
  skipIf: boolean;
  retries: number;
  timeoutMs: number | null;
  continueOnFail: boolean;

  agent?: AgentLike;
  prompt?: string;
  staticPayload?: unknown;
  computeFn?: () => unknown | Promise<unknown>;

  label?: string;
  meta?: Record<string, unknown>;
};

/**
 * Minimal agent surface Smithers relies on at runtime.
 *
 * Tests use lightweight mocks that only implement `generate()` and may omit
 * optional fields like `id` or `tools`. Keep this structural type narrow to
 * avoid over-constraining users and tests.
 */
export type AgentLike = {
  id?: string;
  tools?: Record<string, any>;
  generate: (args: {
    options?: any;
    prompt: string;
    timeout?: { totalMs: number } | undefined;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    outputSchema?: import("zod").ZodObject<any>;
  }) => Promise<any>;
  // Allow additional fields provided by specific agent implementations
  [key: string]: any;
};

export type GraphSnapshot = {
  runId: string;
  frameNo: number;
  xml: XmlNode | null;
  tasks: TaskDescriptor[];
};

export type RunStatus =
  | "running"
  | "waiting-approval"
  | "finished"
  | "failed"
  | "cancelled";

export type RunOptions = {
  runId?: string;
  input: Record<string, unknown>;
  maxConcurrency?: number;
  onProgress?: (e: SmithersEvent) => void;
  signal?: AbortSignal;
  resume?: boolean;
  workflowPath?: string;
  rootDir?: string;
  logDir?: string | null;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  toolTimeoutMs?: number;
};

export type RunResult = {
  runId: string;
  status: "finished" | "failed" | "cancelled" | "waiting-approval";
  output?: unknown;
  error?: unknown;
};

export type OutputKey = { nodeId: string; iteration?: number };

export type SmithersWorkflowOptions = {
  cache?: boolean;
};

export type SchemaRegistryEntry = {
  table: any;
  zodSchema: import("zod").ZodObject<any>;
};

export type SmithersWorkflow<Schema> = {
  db: unknown;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  /** Reverse lookup: ZodObject reference → schema key name */
  zodToKeyName?: Map<import("zod").ZodObject<any>, string>;
};

export interface SmithersCtx<Schema> {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: Schema extends { input: infer T } ? T : Record<string, unknown>;
  outputs: OutputAccessor<Schema>;

  /** Get an output row by string key and output key. Throws if not found. */
  output<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]>;

  /** Get an output row by string key and output key. Returns undefined if not found. */
  outputMaybe<K extends keyof Schema & string>(
    table: K,
    key: OutputKey,
  ): InferOutputEntry<Schema[K]> | undefined;

  /** Get the latest output row for a nodeId (highest iteration). */
  latest<K extends keyof Schema & string>(
    table: K,
    nodeId: string,
  ): InferOutputEntry<Schema[K]> | undefined;

  /** Get latest output row, then safely parse/validate an array field using a Zod schema. Drops invalid items. */
  latestArray(value: unknown, schema: import("zod").ZodType): any[];

  /** Count distinct iterations for a nodeId in a table. */
  iterationCount(table: any, nodeId: string): number;
}

export type OutputAccessor<Schema> = {
  <K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>;
} & {
  [K in keyof Schema & string]: Array<InferOutputEntry<Schema[K]>>;
};

export type InferRow<TTable> = TTable extends { $inferSelect: infer R }
  ? R
  : never;

/**
 * Infer the output type from either a Zod schema or a Drizzle table.
 * Used by the string-key overloads on SmithersCtx.
 */
export type InferOutputEntry<T> = T extends z.ZodTypeAny
  ? z.infer<T>
  : T extends { $inferSelect: any }
    ? InferRow<T>
    : never;

export type SmithersEvent =
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | {
      type: "RunStatusChanged";
      runId: string;
      status: RunStatus;
      timestampMs: number;
    }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; error: unknown; timestampMs: number }
  | { type: "RunCancelled"; runId: string; timestampMs: number }
  | {
      type: "FrameCommitted";
      runId: string;
      frameNo: number;
      xmlHash: string;
      timestampMs: number;
    }
  | {
      type: "NodePending";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFailed";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "NodeCancelled";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt?: number;
      reason?: string;
      timestampMs: number;
    }
  | {
      type: "NodeSkipped";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeRetrying";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeWaitingApproval";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalRequested";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalGranted";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalDenied";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      status: "success" | "error";
      timestampMs: number;
    }
  | {
      type: "NodeOutput";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      text: string;
      stream: "stdout" | "stderr";
      timestampMs: number;
    }
  | {
      type: "RevertStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      timestampMs: number;
    }
  | {
      type: "RevertFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      success: boolean;
      error?: string;
      timestampMs: number;
    };

export type WorkflowProps = {
  name: string;
  cache?: boolean;
  children?: React.ReactNode;
};

export type TaskProps<Row> = {
  key?: string;
  id: string;
  output: import("zod").ZodObject<any> | string;
  agent?: AgentLike;
  skipIf?: boolean;
  needsApproval?: boolean;
  timeoutMs?: number;
  retries?: number;
  continueOnFail?: boolean;
  label?: string;
  meta?: Record<string, unknown>;
  children: string | Row | (() => Row | Promise<Row>) | React.ReactNode;
};

export type SequenceProps = {
  skipIf?: boolean;
  children?: React.ReactNode;
};

export type ParallelProps = {
  id?: string;
  maxConcurrency?: number;
  skipIf?: boolean;
  children?: React.ReactNode;
};

/**
 * Queue tasks so that at most `maxConcurrency` run concurrently across the group.
 * Defaults to 1, providing an easy merge queue primitive.
 */
export type MergeQueueProps = {
  id?: string;
  maxConcurrency?: number; // defaults to 1
  skipIf?: boolean;
  children?: React.ReactNode;
};

export type BranchProps = {
  if: boolean;
  then: React.ReactElement;
  else?: React.ReactElement;
  skipIf?: boolean;
};

export type RalphProps = {
  id?: string;
  until: boolean;
  maxIterations?: number;
  onMaxReached?: "fail" | "return-last";
  skipIf?: boolean;
  children?: React.ReactNode;
};

/**
 * Execute a subtree of tasks in a separate worktree rooted at `path`.
 *
 * - `id` provides stable identification for state tracking and scheduling.
 */
export type WorktreeProps = {
  id?: string;
  path: string;
  skipIf?: boolean;
  children?: React.ReactNode;
};

export type SmithersError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
