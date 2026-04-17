import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import type { z } from "zod";

export type ToolContext = {
  db: SmithersDb;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  idempotencyKey?: string | null;
  rootDir: string;
  allowNetwork: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
  seq: number;
  emitEvent?: (event: SmithersEvent) => void | Promise<void>;
};

export type DefinedToolContext = ToolContext & {
  idempotencyKey: string | null;
  toolName: string;
  sideEffect: boolean;
  idempotent: boolean;
};

export type DefineToolOptions<Schema extends z.ZodTypeAny, Result> = {
  name: string;
  description?: string;
  schema: Schema;
  sideEffect?: boolean;
  idempotent?: boolean;
  execute: (
    args: z.infer<Schema>,
    ctx: DefinedToolContext,
  ) => Promise<Result> | Result;
};

export type DefinedToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
};

export declare function runWithToolContext<T>(
  ctx: ToolContext,
  fn: () => Promise<T>,
): Promise<T>;
export declare function getToolContext(): ToolContext | undefined;
export declare function getToolIdempotencyKey(
  ctx?: ToolContext,
): string | null;
export declare function nextToolSeq(ctx: ToolContext): number;
export declare function getDefinedToolMetadata(
  value: unknown,
): DefinedToolMetadata | null;
export declare function defineTool<
  Schema extends z.ZodTypeAny,
  Result,
>(options: DefineToolOptions<Schema, Result>): any;

export declare const read: any;
export declare const write: any;
export declare const edit: any;
export declare const grep: any;
export declare const bash: any;
export declare const tools: {
  read: typeof read;
  write: typeof write;
  edit: typeof edit;
  grep: typeof grep;
  bash: typeof bash;
};

export declare function readFileTool(path: string): Promise<string>;
export declare function writeFileTool(
  path: string,
  content: string,
): Promise<"ok">;
export declare function editFileTool(
  path: string,
  patch: string,
): Promise<"ok">;
export declare function grepTool(
  pattern: string,
  path?: string,
): Promise<string>;
export declare function bashTool(
  cmd: string,
  args?: string[],
  opts?: { cwd?: string },
): Promise<string>;
