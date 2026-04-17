import { tool, zodSchema } from "ai";
import { getToolContext, getToolIdempotencyKey } from "./context.js";

const smithersToolMetadata = Symbol.for("smithers.tool.metadata");
const warnedToolNames = new Set();

function warnMissingContextParam(name) {
  if (warnedToolNames.has(name)) {
    return;
  }
  warnedToolNames.add(name);
  console.warn(
    `[smithers] defineTool(${name}): sideEffect:true idempotent:false tools should accept the second ctx parameter so they can use ctx.idempotencyKey.`,
  );
}

function defaultToolContext() {
  return {
    db: {},
    runId: "",
    nodeId: "",
    iteration: 0,
    attempt: 0,
    rootDir: process.cwd(),
    allowNetwork: false,
    maxOutputBytes: 200_000,
    timeoutMs: 60_000,
    seq: 0,
  };
}

export function getDefinedToolMetadata(value) {
  return value && typeof value === "object"
    ? (value[smithersToolMetadata] ?? null)
    : null;
}

export function defineTool(options) {
  const sideEffect = options.sideEffect ?? false;
  const idempotent = options.idempotent ?? !sideEffect;

  if (sideEffect && !idempotent && options.execute.length < 2) {
    warnMissingContextParam(options.name);
  }

  const wrapped = tool({
    description: options.description ?? options.name,
    inputSchema: zodSchema(options.schema),
    execute: async (args) => {
      const toolContext = getToolContext();
      const definedContext = {
        ...(toolContext ?? defaultToolContext()),
        idempotencyKey: getToolIdempotencyKey(toolContext),
        toolName: options.name,
        sideEffect,
        idempotent,
      };
      return options.execute(args, definedContext);
    },
  });

  wrapped[smithersToolMetadata] = {
    name: options.name,
    sideEffect,
    idempotent,
  };

  return wrapped;
}
