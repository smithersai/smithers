import { tool, zodSchema } from "ai";
import { Effect } from "effect";
import type { z } from "zod";
import { nowMs } from "@smithers/scheduler/nowMs";
import {
  getToolContext,
  getToolIdempotencyKey,
  type ToolContext,
} from "./context";
import { logToolCallEffect, logToolCallStartEffect } from "./logToolCall";

const smithersToolMetadata = Symbol.for("smithers.tool.metadata");
const warnedToolNames = new Set<string>();

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

function warnMissingContextParam(name: string) {
  if (warnedToolNames.has(name)) {
    return;
  }
  warnedToolNames.add(name);
  console.warn(
    `[smithers] defineTool(${name}): sideEffect:true idempotent:false tools should accept the second ctx parameter so they can use ctx.idempotencyKey.`,
  );
}

export function getDefinedToolMetadata(value: unknown):
  | {
      name: string;
      sideEffect: boolean;
      idempotent: boolean;
    }
  | null {
  return value && typeof value === "object"
    ? ((value as any)[smithersToolMetadata] ?? null)
    : null;
}

export function defineTool<Schema extends z.ZodTypeAny, Result>(
  options: DefineToolOptions<Schema, Result>,
) {
  const sideEffect = options.sideEffect ?? false;
  const idempotent = options.idempotent ?? !sideEffect;

  if (sideEffect && !idempotent && options.execute.length < 2) {
    warnMissingContextParam(options.name);
  }

  const wrapped: any = tool({
    description: options.description ?? options.name,
    inputSchema: zodSchema(options.schema) as any,
    execute: async (args: z.infer<Schema>) => {
      const toolContext = getToolContext();
      const definedContext: DefinedToolContext = {
        ...(toolContext ?? {
          db: {} as any,
          runId: "",
          nodeId: "",
          iteration: 0,
          attempt: 0,
          rootDir: process.cwd(),
          allowNetwork: false,
          maxOutputBytes: 200_000,
          timeoutMs: 60_000,
          seq: 0,
        }),
        idempotencyKey: getToolIdempotencyKey(toolContext),
        toolName: options.name,
        sideEffect,
        idempotent,
      };

      const startedAtMs = nowMs();
      const seq = await Effect.runPromise(
        logToolCallStartEffect(options.name, startedAtMs),
      );
      try {
        const result = await options.execute(args, definedContext);
        await Effect.runPromise(
          logToolCallEffect(
            options.name,
            args,
            result,
            "success",
            undefined,
            startedAtMs,
            seq,
          ),
        );
        return result;
      } catch (error) {
        await Effect.runPromise(
          logToolCallEffect(
            options.name,
            args,
            null,
            "error",
            error,
            startedAtMs,
            seq,
          ),
        );
        throw error;
      }
    },
  } as any);

  wrapped[smithersToolMetadata] = {
    name: options.name,
    sideEffect,
    idempotent,
  };

  return wrapped as typeof wrapped & {
    [smithersToolMetadata]: {
      name: string;
      sideEffect: boolean;
      idempotent: boolean;
    };
  };
}
