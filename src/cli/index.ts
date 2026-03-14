#!/usr/bin/env bun
import { resolve, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Cli, z } from "incur";
import { runWorkflow, renderFrame, resolveSchema } from "../engine";
import { approveNode, denyNode } from "../engine/approvals";
import { loadInput, loadOutputs } from "../db/snapshot";
import { ensureSmithersTables } from "../db/ensure";
import { SmithersDb } from "../db/adapter";
import { buildContext } from "../context";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import { Smithers } from "../effect/builder";
import { revertToAttempt } from "../revert";

async function loadWorkflowAsync(path: string): Promise<SmithersWorkflow<any>> {
  const abs = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(abs).href);
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function loadWorkflowEffect(path: string) {
  return fromPromise("cli load workflow", () => loadWorkflowAsync(path)).pipe(
    Effect.annotateLogs({ workflowPath: path }),
    Effect.withLogSpan("cli:load-workflow"),
  );
}

async function loadWorkflow(path: string): Promise<SmithersWorkflow<any>> {
  return runPromise(loadWorkflowEffect(path));
}

function readPackageVersion(): string {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

type FailFn = (opts: { code: string; message: string; exitCode?: number }) => never;

function parseJsonInput(raw: string | undefined, label: string, fail: FailFn) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    return fail({
      code: "INVALID_JSON",
      message: `Invalid JSON for ${label}: ${err?.message ?? String(err)}`,
      exitCode: 4,
    });
  }
}

function formatStatusExitCode(status: string | undefined) {
  if (status === "finished") return 0;
  if (status === "waiting-approval") return 3;
  if (status === "cancelled") return 2;
  return 1;
}

function setupSqliteCleanup(workflow: SmithersWorkflow<any>) {
  const closeSqlite = () => {
    try {
      const client: any = (workflow.db as any)?.$client;
      if (client && typeof client.close === "function") {
        client.close();
      }
    } catch {
      // Best-effort — ignore errors during cleanup
    }
  };
  process.on("exit", closeSqlite);
  process.on("SIGINT", () => {
    closeSqlite();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    closeSqlite();
    process.exit(143);
  });
}

function buildProgressReporter() {
  const startTime = Date.now();
  const formatElapsed = () => {
    const elapsed = Date.now() - startTime;
    const secs = Math.floor(elapsed / 1000);
    const mins = Math.floor(secs / 60);
    const hrs = Math.floor(mins / 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(hrs)}:${pad(mins % 60)}:${pad(secs % 60)}`;
  };

  return (event: any) => {
    const ts = formatElapsed();
    switch (event.type) {
      case "NodeStarted":
        process.stderr.write(
          `[${ts}] → ${event.nodeId} (attempt ${event.attempt ?? 1}, iteration ${event.iteration ?? 0})\n`,
        );
        break;
      case "NodeFinished":
        process.stderr.write(
          `[${ts}] ✓ ${event.nodeId} (attempt ${event.attempt ?? 1})\n`,
        );
        break;
      case "NodeFailed":
        process.stderr.write(
          `[${ts}] ✗ ${event.nodeId} (attempt ${event.attempt ?? 1}): ${typeof event.error === "string" ? event.error : (event.error?.message ?? "failed")}\n`,
        );
        break;
      case "NodeRetrying":
        process.stderr.write(
          `[${ts}] ↻ ${event.nodeId} retrying (attempt ${event.attempt ?? 1})\n`,
        );
        break;
      case "RunFinished":
        process.stderr.write(`[${ts}] ✓ Run finished\n`);
        break;
      case "RunFailed":
        process.stderr.write(
          `[${ts}] ✗ Run failed: ${typeof event.error === "string" ? event.error : (event.error?.message ?? "unknown")}\n`,
        );
        break;
      case "FrameCommitted":
        // Don't print frame commits - too noisy
        break;
      case "WorkflowReloadDetected":
        process.stderr.write(
          `[${ts}] ⟳ File change detected: ${(event as any).changedFiles?.length ?? 0} file(s)\n`,
        );
        break;
      case "WorkflowReloaded":
        process.stderr.write(
          `[${ts}] ⟳ Workflow reloaded (generation ${(event as any).generation})\n`,
        );
        break;
      case "WorkflowReloadFailed":
        process.stderr.write(
          `[${ts}] ⚠ Workflow reload failed: ${typeof (event as any).error === "string" ? (event as any).error : ((event as any).error?.message ?? "unknown")}\n`,
        );
        break;
      case "WorkflowReloadUnsafe":
        process.stderr.write(
          `[${ts}] ⚠ Workflow reload blocked: ${(event as any).reason}\n`,
        );
        break;
    }
  };
}

function setupAbortSignal() {
  const abort = new AbortController();
  let signalHandled = false;
  const handleSignal = (signal: string) => {
    if (signalHandled) return;
    signalHandled = true;
    process.stderr.write(`\n[smithers] received ${signal}, cancelling run...\n`);
    abort.abort();
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  return abort;
}

const workflowArgs = z.object({
  workflow: z.string().describe("Path to a .tsx or .toon workflow file"),
});

const commonRunOptions = z.object({
  runId: z.string().optional().describe("Explicit run ID (must not already exist)"),
  maxConcurrency: z.number().int().min(1).optional().describe("Maximum parallel tasks (default: 4)"),
  root: z.string().optional().describe("Tool sandbox root directory (default: workflow's directory)"),
  log: z.boolean().default(true).describe("Enable NDJSON event log file output"),
  logDir: z.string().optional().describe("NDJSON event logs directory"),
  allowNetwork: z.boolean().default(false).describe("Allow bash tool network requests"),
  maxOutputBytes: z.number().int().min(1).optional().describe("Max bytes a single tool call can return (default: 200000)"),
  toolTimeoutMs: z.number().int().min(1).optional().describe("Max wall-clock time per tool call in ms (default: 60000)"),
  hot: z.boolean().default(false).describe("Enable hot module replacement for .tsx workflows"),
});

const runOptions = commonRunOptions.extend({
  input: z.string().optional().describe("Input data as JSON string"),
  resume: z.boolean().default(false).describe("Resume a previous run instead of starting fresh"),
});

const resumeOptions = commonRunOptions.extend({
  runId: z.string().describe("Run ID to resume"),
  input: z.string().optional().describe("Input data as JSON string (overrides persisted input)"),
  force: z.boolean().default(false).describe("Resume even if the run is still marked as running"),
});

const approvalOptions = z.object({
  runId: z.string().describe("Run ID containing the approval gate"),
  nodeId: z.string().describe("Node ID of the approval gate"),
  iteration: z.number().int().min(0).default(0).describe("Loop iteration number"),
  note: z.string().optional().describe("Approval/denial note"),
  decidedBy: z.string().optional().describe("Name or identifier of the approver"),
});

const statusOptions = z.object({
  runId: z.string().describe("Run ID to query"),
});

const framesOptions = z.object({
  runId: z.string().describe("Run ID to query"),
  tail: z.number().int().min(1).default(20).describe("Number of recent frames to return"),
  compact: z.boolean().default(false).describe("Omit full XML tree, show only task states"),
});

const listOptions = z.object({
  limit: z.number().int().min(1).default(50).describe("Maximum runs to return"),
  status: z.string().optional().describe("Filter by status: running, finished, failed, cancelled, waiting-approval"),
});

const graphOptions = z.object({
  runId: z.string().default("graph").describe("Run ID for context"),
  input: z.string().optional().describe("Input data as JSON (overrides persisted input)"),
});

const revertOptions = z.object({
  runId: z.string().describe("Run ID to revert"),
  nodeId: z.string().describe("Node ID to revert to"),
  attempt: z.number().int().min(1).default(1).describe("Attempt number to revert to"),
  iteration: z.number().int().min(0).default(0).describe("Loop iteration number"),
});

const cancelOptions = z.object({
  runId: z.string().describe("Run ID to cancel"),
});

let commandExitOverride: number | undefined;

const cli = Cli.create({
  name: "smithers",
  description:
    "Run, resume, approve, inspect, and revert Smithers workflows from the command line.",
  version: readPackageVersion(),
  format: "json",
})
  .command("run", {
    description: "Execute a workflow from a .tsx or .toon file.",
    args: workflowArgs,
    options: runOptions,
    alias: { runId: "r", input: "i", maxConcurrency: "c" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };

      try {
        const workflowPath = args.workflow;
        const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
        const isToon = extname(resolvedWorkflowPath) === ".toon";
        const input = parseJsonInput(options.input, "input", fail) ?? {};
        const runId = options.runId;
        const resume = Boolean(options.resume);

        if (options.hot) {
          process.env.SMITHERS_HOT = "1";
        }

        let workflow: SmithersWorkflow<any> | null = null;
        if (!isToon) {
          workflow = await loadWorkflow(workflowPath);
          ensureSmithersTables(workflow.db as any);
          if (options.hot) {
            process.stderr.write(`[hot] Hot reload enabled\n`);
          }
          setupSqliteCleanup(workflow);
        }

        if (resume && !runId) {
          return fail({
            code: "MISSING_RUN_ID",
            message: "Missing --run-id for resume",
            exitCode: 4,
          });
        }

        const adapter = workflow ? new SmithersDb(workflow.db as any) : null;

        if (!resume && adapter) {
          const staleRuns = await adapter.listRuns(10, "running");
          if (staleRuns.length > 0) {
            process.stderr.write(
              `⚠ Found ${staleRuns.length} run(s) still marked as 'running':\n`,
            );
            for (const r of staleRuns as any[]) {
              process.stderr.write(
                `  ${r.runId} (started ${new Date(r.startedAtMs ?? r.createdAtMs).toISOString()})\n`,
              );
            }
            process.stderr.write(
              "  Use 'smithers cancel' to mark them as cancelled, or 'smithers resume' to continue.\n",
            );
          }
        }

        if (runId && adapter) {
          const existing = await adapter.getRun(runId);
          if (resume && !existing) {
            return fail({
              code: "RUN_NOT_FOUND",
              message: `Run not found: ${runId}`,
              exitCode: 4,
            });
          }
          if (resume && existing?.status === "running") {
            return fail({
              code: "RUN_STILL_RUNNING",
              message: `Run is still marked running: ${runId}. Use --force to resume anyway.`,
              exitCode: 4,
            });
          }
          if (!resume && existing) {
            return fail({
              code: "RUN_EXISTS",
              message: `Run already exists: ${runId}`,
              exitCode: 4,
            });
          }
        }

        const rootDir = options.root
          ? resolve(process.cwd(), options.root)
          : dirname(resolvedWorkflowPath);
        const logDir = options.log ? options.logDir : null;
        const onProgress = buildProgressReporter();
        const abort = setupAbortSignal();

        if (isToon) {
          const dbPath = resolve(dirname(resolvedWorkflowPath), "smithers.db");
          const toonWorkflow = Smithers.loadToon(workflowPath);
          const result = await runPromise(
            toonWorkflow
              .execute(input, {
                runId,
                resume,
                workflowPath: resolvedWorkflowPath,
                maxConcurrency: options.maxConcurrency,
                rootDir,
                logDir,
                allowNetwork: options.allowNetwork,
                maxOutputBytes: options.maxOutputBytes,
                toolTimeoutMs: options.toolTimeoutMs,
                hot: options.hot,
                onProgress,
                signal: abort.signal,
              })
              .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
          );
          const status = (result as any)?.status;
          process.exitCode = formatStatusExitCode(
            typeof status === "string" ? status : undefined,
          );
          return ok(result);
        }

        const result = await runWorkflow(workflow!, {
          input,
          runId,
          resume,
          workflowPath: resolvedWorkflowPath,
          maxConcurrency: options.maxConcurrency,
          rootDir,
          logDir,
          allowNetwork: options.allowNetwork,
          maxOutputBytes: options.maxOutputBytes,
          toolTimeoutMs: options.toolTimeoutMs,
          hot: options.hot,
          onProgress,
          signal: abort.signal,
        });

        process.exitCode = formatStatusExitCode(result.status);
        return ok(result);
      } catch (err: any) {
        return fail({
          code: "RUN_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("resume", {
    description: "Resume a paused or crashed run.",
    args: workflowArgs,
    options: resumeOptions,
    alias: { runId: "r", maxConcurrency: "c" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };

      try {
        const workflowPath = args.workflow;
        const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
        const isToon = extname(resolvedWorkflowPath) === ".toon";
        const input = parseJsonInput(options.input, "input", fail) ?? {};
        const runId = options.runId;

        if (options.hot) {
          process.env.SMITHERS_HOT = "1";
        }

        let workflow: SmithersWorkflow<any> | null = null;
        if (!isToon) {
          workflow = await loadWorkflow(workflowPath);
          ensureSmithersTables(workflow.db as any);
          if (options.hot) {
            process.stderr.write(`[hot] Hot reload enabled\n`);
          }
          setupSqliteCleanup(workflow);
        }

        const adapter = workflow ? new SmithersDb(workflow.db as any) : null;
        if (adapter) {
          const existing = await adapter.getRun(runId);
          if (!existing) {
            return fail({
              code: "RUN_NOT_FOUND",
              message: `Run not found: ${runId}`,
              exitCode: 4,
            });
          }
          if (existing?.status === "running" && !options.force) {
            return fail({
              code: "RUN_STILL_RUNNING",
              message: `Run is still marked running: ${runId}. Use --force to resume anyway.`,
              exitCode: 4,
            });
          }
        }

        const rootDir = options.root
          ? resolve(process.cwd(), options.root)
          : dirname(resolvedWorkflowPath);
        const logDir = options.log ? options.logDir : null;
        const onProgress = buildProgressReporter();
        const abort = setupAbortSignal();

        if (isToon) {
          const dbPath = resolve(dirname(resolvedWorkflowPath), "smithers.db");
          const toonWorkflow = Smithers.loadToon(workflowPath);
          const result = await runPromise(
            toonWorkflow
              .execute(input, {
                runId,
                resume: true,
                workflowPath: resolvedWorkflowPath,
                maxConcurrency: options.maxConcurrency,
                rootDir,
                logDir,
                allowNetwork: options.allowNetwork,
                maxOutputBytes: options.maxOutputBytes,
                toolTimeoutMs: options.toolTimeoutMs,
                hot: options.hot,
                onProgress,
                signal: abort.signal,
              })
              .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
          );
          const status = (result as any)?.status;
          process.exitCode = formatStatusExitCode(
            typeof status === "string" ? status : undefined,
          );
          return ok(result);
        }

        const result = await runWorkflow(workflow!, {
          input,
          runId,
          resume: true,
          workflowPath: resolvedWorkflowPath,
          maxConcurrency: options.maxConcurrency,
          rootDir,
          logDir,
          allowNetwork: options.allowNetwork,
          maxOutputBytes: options.maxOutputBytes,
          toolTimeoutMs: options.toolTimeoutMs,
          hot: options.hot,
          onProgress,
          signal: abort.signal,
        });

        process.exitCode = formatStatusExitCode(result.status);
        return ok(result);
      } catch (err: any) {
        return fail({
          code: "RESUME_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("approve", {
    description: "Approve a task that requires human approval.",
    args: workflowArgs,
    options: approvalOptions,
    alias: { runId: "r", nodeId: "n" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        await approveNode(
          adapter,
          options.runId,
          options.nodeId,
          options.iteration,
          options.note,
          options.decidedBy,
        );
        return ok({
          runId: options.runId,
          nodeId: options.nodeId,
          status: "approve",
        });
      } catch (err: any) {
        return fail({
          code: "APPROVE_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("deny", {
    description: "Deny a task approval.",
    args: workflowArgs,
    options: approvalOptions,
    alias: { runId: "r", nodeId: "n" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        await denyNode(
          adapter,
          options.runId,
          options.nodeId,
          options.iteration,
          options.note,
          options.decidedBy,
        );
        return ok({
          runId: options.runId,
          nodeId: options.nodeId,
          status: "deny",
        });
      } catch (err: any) {
        return fail({
          code: "DENY_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("status", {
    description: "Print the current status of a run as JSON.",
    args: workflowArgs,
    options: statusOptions,
    alias: { runId: "r" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        const run = await adapter.getRun(options.runId);
        return ok(run);
      } catch (err: any) {
        return fail({
          code: "STATUS_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("frames", {
    description: "List render frames for a run.",
    args: workflowArgs,
    options: framesOptions,
    alias: { runId: "r", tail: "t" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        const frames = await adapter.listFrames(options.runId, options.tail);
        if (!options.compact) return ok(frames);
        const compact = frames.map((frame: any) => {
          const result: Record<string, any> = {
            frameNo: frame.frameNo,
            createdAtMs: frame.createdAtMs,
          };
          if (frame.taskIndexJson) {
            try {
              result.tasks = JSON.parse(frame.taskIndexJson);
            } catch {}
          }
          if (frame.mountedTaskIdsJson) {
            try {
              result.mountedTaskIds = JSON.parse(frame.mountedTaskIdsJson);
            } catch {}
          }
          return result;
        });
        return ok(compact);
      } catch (err: any) {
        return fail({
          code: "FRAMES_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("list", {
    description: "List workflow runs stored in the database.",
    args: workflowArgs,
    options: listOptions,
    alias: { limit: "l", status: "s" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        const runs = await adapter.listRuns(options.limit, options.status);
        return ok(runs);
      } catch (err: any) {
        return fail({
          code: "LIST_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("graph", {
    description: "Render the workflow graph without executing it.",
    args: workflowArgs,
    options: graphOptions,
    alias: { runId: "r" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const schema = resolveSchema(workflow.db);
        const inputTable = schema.input;
        const inputRow = options.input
          ? parseJsonInput(options.input, "input", fail)
          : inputTable
            ? ((await loadInput(workflow.db as any, inputTable, options.runId)) ?? {})
            : {};
        const outputs = await loadOutputs(workflow.db as any, schema, options.runId);
        const ctx = buildContext({
          runId: options.runId,
          iteration: 0,
          input: inputRow ?? {},
          outputs,
        });
        const resolvedWorkflowPath = resolve(process.cwd(), args.workflow);
        const baseRootDir = dirname(resolvedWorkflowPath);
        const snap = await renderFrame(workflow, ctx, { baseRootDir });
        const seen = new WeakSet<object>();
        return ok(
          JSON.parse(
            JSON.stringify(snap, (_key, value) => {
              if (typeof value === "function") return undefined;
              if (typeof value === "object" && value !== null) {
                if (seen.has(value)) return undefined;
                seen.add(value);
              }
              return value;
            }),
          ),
        );
      } catch (err: any) {
        return fail({
          code: "GRAPH_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("revert", {
    description: "Revert the workspace to a previous task attempt's filesystem state.",
    args: workflowArgs,
    options: revertOptions,
    alias: { runId: "r", nodeId: "n" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        const result = await revertToAttempt(adapter, {
          runId: options.runId,
          nodeId: options.nodeId,
          iteration: options.iteration,
          attempt: options.attempt,
          onProgress: (e) => console.log(JSON.stringify(e)),
        });
        process.exitCode = result.success ? 0 : 1;
        return ok(result);
      } catch (err: any) {
        return fail({
          code: "REVERT_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("cancel", {
    description: "Cancel a running or waiting-approval workflow.",
    args: workflowArgs,
    options: cancelOptions,
    alias: { runId: "r" },
    async run({ args, options, ok, error }) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return error(opts);
      };
      try {
        const workflow = await loadWorkflow(args.workflow);
        ensureSmithersTables(workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        const run = await adapter.getRun(options.runId);
        if (!run) {
          return fail({
            code: "RUN_NOT_FOUND",
            message: `Run not found: ${options.runId}`,
            exitCode: 4,
          });
        }
        if (run.status !== "running" && run.status !== "waiting-approval") {
          return fail({
            code: "RUN_NOT_ACTIVE",
            message: `Run is not active (status: ${run.status})`,
            exitCode: 4,
          });
        }
        const inProgress = await adapter.listInProgressAttempts(options.runId);
        const now = Date.now();
        for (const attempt of inProgress) {
          await adapter.updateAttempt(
            options.runId,
            attempt.nodeId,
            attempt.iteration,
            attempt.attempt,
            {
              state: "cancelled",
              finishedAtMs: now,
            },
          );
        }
        await adapter.updateRun(options.runId, {
          status: "cancelled",
          finishedAtMs: now,
        });
        process.exitCode = 2;
        return ok({
          runId: options.runId,
          status: "cancelled",
          cancelledAttempts: inProgress.length,
        });
      } catch (err: any) {
        return fail({
          code: "CANCEL_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  });

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv.map((arg) => (arg === "-v" ? "--version" : arg));
  let exitCodeFromServe: number | undefined;

  try {
    await cli.serve(argv, {
      exit(code) {
        exitCodeFromServe = code;
      },
    });
  } catch (err: any) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }

  if (exitCodeFromServe !== undefined) {
    const mapped =
      commandExitOverride !== undefined
        ? commandExitOverride
        : exitCodeFromServe === 1
          ? 4
          : exitCodeFromServe;
    process.exit(mapped);
  }

  process.exit(process.exitCode ?? 0);
}

main();
