import { z } from "zod";
import { SmithersError } from "@smithers/errors/SmithersError";
import { defineTool } from "./defineTool.js";
import {
  captureProcess,
  getToolRuntimeOptions,
  resolveToolPath,
  truncateToBytes,
} from "./utils.js";

const DARWIN_NETWORK_DENY_PROFILE = "(version 1) (allow default) (deny network*)";
export const BASH_TOOL_MAX_COMMAND_LENGTH = 8_192;
export const BASH_TOOL_MAX_ARGS = 128;
export const BASH_TOOL_MAX_ARG_LENGTH = 8_192;
export const BASH_TOOL_MAX_CWD_LENGTH = 1_024;
export const BASH_TOOL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const BASH_TOOL_MAX_TIMEOUT_MS = 60 * 60 * 1000;

function resolveNetworkIsolatedCommand(cmd, args) {
  if (process.platform === "darwin") {
    const sandboxExec = globalThis.Bun?.which?.("sandbox-exec") ?? null;
    if (sandboxExec) {
      return {
        command: sandboxExec,
        args: ["-p", DARWIN_NETWORK_DENY_PROFILE, cmd, ...args],
      };
    }
  }
  return { command: cmd, args };
}

function assertOptionalStringMaxLength(name, value, maxLength) {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new SmithersError("INVALID_INPUT", `${name} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${name} exceeds ${maxLength} characters.`,
      { maxLength, length: value.length },
    );
  }
}

function validateBashInvocation(cmd, args, opts, ctx) {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new SmithersError("INVALID_INPUT", "cmd must be a non-empty string.");
  }
  assertOptionalStringMaxLength("cmd", cmd, BASH_TOOL_MAX_COMMAND_LENGTH);
  if (args !== undefined && !Array.isArray(args)) {
    throw new SmithersError("INVALID_INPUT", "args must be an array.");
  }
  if ((args?.length ?? 0) > BASH_TOOL_MAX_ARGS) {
    throw new SmithersError(
      "INVALID_INPUT",
      `args exceeds ${BASH_TOOL_MAX_ARGS} entries.`,
      { maxLength: BASH_TOOL_MAX_ARGS, length: args.length },
    );
  }
  for (const [index, arg] of (args ?? []).entries()) {
    assertOptionalStringMaxLength(
      `args[${index}]`,
      arg,
      BASH_TOOL_MAX_ARG_LENGTH,
    );
  }
  const commandLine = [cmd, ...(args ?? [])].join(" ");
  assertOptionalStringMaxLength(
    "command",
    commandLine,
    BASH_TOOL_MAX_COMMAND_LENGTH,
  );
  assertOptionalStringMaxLength("opts.cwd", opts?.cwd, BASH_TOOL_MAX_CWD_LENGTH);

  if (!Number.isFinite(ctx.maxOutputBytes) || ctx.maxOutputBytes <= 0) {
    throw new SmithersError("INVALID_INPUT", "maxOutputBytes must be positive.");
  }
  if (ctx.maxOutputBytes > BASH_TOOL_MAX_OUTPUT_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `maxOutputBytes exceeds ${BASH_TOOL_MAX_OUTPUT_BYTES}.`,
      {
        maxOutputBytes: ctx.maxOutputBytes,
        maxAllowed: BASH_TOOL_MAX_OUTPUT_BYTES,
      },
    );
  }
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) {
    throw new SmithersError("INVALID_INPUT", "timeoutMs must be positive.");
  }
  if (ctx.timeoutMs > BASH_TOOL_MAX_TIMEOUT_MS) {
    throw new SmithersError(
      "INVALID_INPUT",
      `timeoutMs exceeds ${BASH_TOOL_MAX_TIMEOUT_MS}.`,
      { timeoutMs: ctx.timeoutMs, maxAllowed: BASH_TOOL_MAX_TIMEOUT_MS },
    );
  }
}

function assertNetworkAllowed(cmd, args, allowNetwork) {
  if (allowNetwork) {
    return;
  }
  const hay = [cmd, ...(args ?? [])].join(" ");
  const networkCommands = [
    "curl",
    "wget",
    "http://",
    "https://",
    "npm",
    "bun",
    "pip",
  ];
  if (networkCommands.some((fragment) => hay.includes(fragment))) {
    throw new SmithersError(
      "TOOL_NETWORK_DISABLED",
      "Network access is disabled for bash tool",
    );
  }
  if (hay.includes("git")) {
    const gitRemoteOps = ["push", "pull", "fetch", "clone", "remote"];
    if (gitRemoteOps.some((op) => hay.includes(op))) {
      throw new SmithersError(
        "TOOL_GIT_REMOTE_DISABLED",
        "Git remote operations are disabled for bash tool",
      );
    }
  }
}

export async function bashTool(cmd, args = [], opts = undefined) {
  const runtime = getToolRuntimeOptions();
  validateBashInvocation(cmd, args, opts, runtime);
  assertNetworkAllowed(cmd, args, runtime.allowNetwork);
  const cwd = opts?.cwd
    ? await resolveToolPath(runtime.rootDir, opts.cwd)
    : runtime.rootDir;
  const resolvedCommand = !runtime.allowNetwork
    ? resolveNetworkIsolatedCommand(cmd, args)
    : { command: cmd, args };
  const result = await captureProcess(
    resolvedCommand.command,
    resolvedCommand.args,
    {
      cwd,
      env: process.env,
      detached: true,
      maxOutputBytes: runtime.maxOutputBytes,
      timeoutMs: runtime.timeoutMs,
    },
  );
  const output = truncateToBytes(
    `${result.stdout}${result.stderr}`,
    runtime.maxOutputBytes,
  );
  if (result.exitCode !== 0) {
    throw new SmithersError(
      "TOOL_COMMAND_FAILED",
      `Command failed with exit code ${result.exitCode}`,
      { cmd, args, output },
    );
  }
  return output;
}

export const bash = defineTool({
  name: "bash",
  description: "Execute a shell command",
  schema: z.object({
    cmd: z.string(),
    args: z.array(z.string()).optional(),
    opts: z.object({ cwd: z.string().optional() }).optional(),
  }),
  sideEffect: true,
  idempotent: false,
  execute: async ({ cmd, args, opts }) => bashTool(cmd, args, opts),
});
