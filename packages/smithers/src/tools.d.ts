import type { Tool } from "ai";
import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
import type { SmithersEvent } from "@smithers-orchestrator/observability/SmithersEvent";
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

/**
 * A tool produced by {@link defineTool} — an `ai` SDK {@link Tool} whose input
 * type has been narrowed from its Zod schema and whose output type is the
 * caller-declared `Result`.
 */
export type DefinedTool<Schema extends z.ZodTypeAny, Result> = Tool<
  z.infer<Schema>,
  Result
>;

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
>(options: DefineToolOptions<Schema, Result>): DefinedTool<Schema, Result>;

export declare const read: DefinedTool<
  z.ZodObject<{ path: z.ZodString }>,
  string
>;
export declare const write: DefinedTool<
  z.ZodObject<{ path: z.ZodString; content: z.ZodString }>,
  "ok"
>;
export declare const edit: DefinedTool<
  z.ZodObject<{ path: z.ZodString; patch: z.ZodString }>,
  "ok"
>;
export declare const grep: DefinedTool<
  z.ZodObject<{ pattern: z.ZodString; path: z.ZodOptional<z.ZodString> }>,
  string
>;
export declare const bash: DefinedTool<
  z.ZodObject<{
    cmd: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    opts: z.ZodOptional<z.ZodObject<{ cwd: z.ZodOptional<z.ZodString> }>>;
  }>,
  string
>;
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
