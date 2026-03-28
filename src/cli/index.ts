#!/usr/bin/env bun
import { resolve, dirname, extname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, openSync } from "node:fs";
import { Effect } from "effect";
import { Cli, z } from "incur";
import { runWorkflow, renderFrame, resolveSchema } from "../engine";
import { mdxPlugin } from "../mdx-plugin";
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
import { trackEvent } from "../effect/metrics";
import { runSync } from "../effect/runtime";
import { spawn } from "node:child_process";
import { SmithersError } from "../utils/errors";
import { findAndOpenDb } from "./find-db";
import {
  chatAttemptKey,
  formatChatAttemptHeader,
  formatChatBlock,
  parseChatAttemptMeta,
  parseNodeOutputEvent,
  selectChatAttempts,
} from "./chat";
import { formatAge, formatElapsedCompact, formatEventLine } from "./format";
import { detectAvailableAgents } from "./agent-detection";
import { initWorkflowPack } from "./workflow-pack";
import { createWorkflowFile, discoverWorkflows, resolveWorkflow } from "./workflows";
import { ask } from "./ask";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadWorkflowAsync(path: string): Promise<SmithersWorkflow<any>> {
  const abs = resolve(process.cwd(), path);
  mdxPlugin();
  const mod = await import(pathToFileURL(abs).href);
  if (!mod.default) throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "Workflow must export default");
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

async function loadWorkflowDb(
  workflowPath: string,
): Promise<{ adapter: SmithersDb; cleanup?: () => void }> {
  const resolvedPath = resolve(process.cwd(), workflowPath);
  if (extname(resolvedPath) === ".toon") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const dbPath = resolve(dirname(resolvedPath), "smithers.db");
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db as any);
    return {
      adapter: new SmithersDb(db as any),
      cleanup: () => { try { sqlite.close(); } catch {} },
    };
  }
  const workflow = await loadWorkflow(workflowPath);
  ensureSmithersTables(workflow.db as any);
  setupSqliteCleanup(workflow);
  return { adapter: new SmithersDb(workflow.db as any) };
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
    } catch {}
  };
  process.on("exit", closeSqlite);
  process.on("SIGINT", () => { closeSqlite(); process.exit(130); });
  process.on("SIGTERM", () => { closeSqlite(); process.exit(143); });
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
    try { runSync(trackEvent(event)); } catch {}

    const ts = formatElapsed();
    switch (event.type) {
      case "NodeStarted":
        process.stderr.write(
          `[${ts}] → ${event.nodeId} (attempt ${event.attempt ?? 1}, iteration ${event.iteration ?? 0})\n`,
        );
        break;
      case "NodeFinished":
        process.stderr.write(`[${ts}] ✓ ${event.nodeId} (attempt ${event.attempt ?? 1})\n`);
        break;
      case "NodeFailed":
        process.stderr.write(
          `[${ts}] ✗ ${event.nodeId} (attempt ${event.attempt ?? 1}): ${typeof event.error === "string" ? event.error : (event.error?.message ?? "failed")}\n`,
        );
        break;
      case "NodeRetrying":
        process.stderr.write(`[${ts}] ↻ ${event.nodeId} retrying (attempt ${event.attempt ?? 1})\n`);
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
        break;
      case "WorkflowReloadDetected":
        process.stderr.write(`[${ts}] ⟳ File change detected: ${(event as any).changedFiles?.length ?? 0} file(s)\n`);
        break;
      case "WorkflowReloaded":
        process.stderr.write(`[${ts}] ⟳ Workflow reloaded (generation ${(event as any).generation})\n`);
        break;
      case "WorkflowReloadFailed":
        process.stderr.write(`[${ts}] ⚠ Workflow reload failed: ${typeof (event as any).error === "string" ? (event as any).error : ((event as any).error?.message ?? "unknown")}\n`);
        break;
      case "WorkflowReloadUnsafe":
        process.stderr.write(`[${ts}] ⚠ Workflow reload blocked: ${(event as any).reason}\n`);
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

async function listAllEvents(adapter: SmithersDb, runId: string) {
  const events: any[] = [];
  let lastSeq = -1;
  while (true) {
    const batch = await adapter.listEvents(runId, lastSeq, 1000);
    if ((batch as any[]).length === 0) break;
    events.push(...(batch as any[]));
    lastSeq = (batch as any[])[(batch as any[]).length - 1]!.seq;
    if ((batch as any[]).length < 1000) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const workflowArgs = z.object({
  workflow: z.string().describe("Path to a .tsx or .toon workflow file"),
});

const upOptions = z.object({
  detach: z.boolean().default(false).describe("Run in background, print run ID, exit"),
  runId: z.string().optional().describe("Explicit run ID"),
  maxConcurrency: z.number().int().min(1).optional().describe("Maximum parallel tasks (default: 4)"),
  root: z.string().optional().describe("Tool sandbox root directory"),
  log: z.boolean().default(true).describe("Enable NDJSON event log file output"),
  logDir: z.string().optional().describe("NDJSON event logs directory"),
  allowNetwork: z.boolean().default(false).describe("Allow bash tool network requests"),
  maxOutputBytes: z.number().int().min(1).optional().describe("Max bytes a single tool call can return"),
  toolTimeoutMs: z.number().int().min(1).optional().describe("Max wall-clock time per tool call in ms"),
  hot: z.boolean().default(false).describe("Enable hot module replacement for .tsx workflows"),
  input: z.string().optional().describe("Input data as JSON string"),
  resume: z.boolean().default(false).describe("Resume a previous run instead of starting fresh"),
  force: z.boolean().default(false).describe("Resume even if still marked running"),
});

const psOptions = z.object({
  status: z.string().optional().describe("Filter by status: running, finished, failed, cancelled, waiting-approval"),
  limit: z.number().int().min(1).default(20).describe("Maximum runs to return"),
  all: z.boolean().default(false).describe("Include all statuses"),
});

const logsOptions = z.object({
  follow: z.boolean().default(true).describe("Keep tailing (default true for active runs)"),
  since: z.number().int().optional().describe("Start from event sequence number"),
  tail: z.number().int().min(1).default(50).describe("Show last N events first"),
});

const chatArgs = z.object({
  runId: z.string().optional().describe("Run ID to inspect (default: latest run)"),
});

const chatOptions = z.object({
  all: z.boolean().default(false).describe("Show all agent attempts in the run (default: latest only)"),
  follow: z.boolean().default(false).describe("Watch for new agent output"),
  tail: z.number().int().min(1).optional().describe("Show only the last N chat blocks"),
  stderr: z.boolean().default(true).describe("Include agent stderr output"),
});

const inspectArgs = z.object({
  runId: z.string().describe("Run ID to inspect"),
});

const approveArgs = z.object({
  runId: z.string().describe("Run ID containing the approval gate"),
});

const approveOptions = z.object({
  node: z.string().optional().describe("Node ID (required if multiple pending)"),
  iteration: z.number().int().min(0).default(0).describe("Loop iteration number"),
  note: z.string().optional().describe("Approval/denial note"),
  by: z.string().optional().describe("Name or identifier of the approver"),
});

const cancelArgs = z.object({
  runId: z.string().describe("Run ID to cancel"),
});

const graphOptions = z.object({
  runId: z.string().default("graph").describe("Run ID for context"),
  input: z.string().optional().describe("Input data as JSON"),
});

const revertOptions = z.object({
  runId: z.string().describe("Run ID to revert"),
  nodeId: z.string().describe("Node ID to revert to"),
  attempt: z.number().int().min(1).default(1).describe("Attempt number"),
  iteration: z.number().int().min(0).default(0).describe("Loop iteration number"),
});

const initOptions = z.object({
  force: z.boolean().default(false).describe("Overwrite existing scaffold files"),
});

const workflowPathArgs = z.object({
  name: z.string().describe("Workflow ID"),
});

const workflowDoctorArgs = z.object({
  name: z.string().optional().describe("Workflow ID"),
});

const workflowCli = Cli.create({
  name: "workflow",
  description: "Discover local workflows from .smithers/workflows.",
})
  .command("list", {
    description: "List discovered local workflows.",
    run(c) {
      return c.ok({
        workflows: discoverWorkflows(process.cwd()),
      });
    },
  })
  .command("path", {
    description: "Resolve a workflow ID to its entry file.",
    args: workflowPathArgs,
    run(c) {
      const workflow = resolveWorkflow(c.args.name, process.cwd());
      return c.ok({
        id: workflow.id,
        path: workflow.entryFile,
        sourceType: workflow.sourceType,
      });
    },
  })
  .command("create", {
    description: "Create a new flat workflow scaffold in .smithers/workflows.",
    args: workflowPathArgs,
    run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        return c.ok(createWorkflowFile(c.args.name, process.cwd()));
      } catch (err: any) {
        if (err instanceof SmithersError) {
          return fail({
            code: err.code,
            message: err.message,
            exitCode: 4,
          });
        }
        return fail({
          code: "WORKFLOW_CREATE_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })
  .command("doctor", {
    description: "Inspect workflow discovery, preload files, and detected agents.",
    args: workflowDoctorArgs,
    run(c) {
      const workflows = c.args.name
        ? [resolveWorkflow(c.args.name, process.cwd())]
        : discoverWorkflows(process.cwd());
      const workflowRoot = resolve(process.cwd(), ".smithers");
      return c.ok({
        workflowRoot,
        workflows,
        preload: {
          path: resolve(workflowRoot, "preload.ts"),
          exists: existsSync(resolve(workflowRoot, "preload.ts")),
        },
        bunfig: {
          path: resolve(workflowRoot, "bunfig.toml"),
          exists: existsSync(resolve(workflowRoot, "bunfig.toml")),
        },
        agents: detectAvailableAgents(),
      });
    },
  });

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let commandExitOverride: number | undefined;

const cli = Cli.create({
  name: "smithers",
  description: "Durable AI workflow orchestrator. Run, monitor, and manage workflow executions.",
  version: readPackageVersion(),
  format: "toon",
})

  // =========================================================================
  // smithers init
  // =========================================================================
  .command("init", {
    description: "Install the local Smithers workflow pack into .smithers/.",
    options: initOptions,
    run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        return c.ok(initWorkflowPack({ force: c.options.force }));
      } catch (err: any) {
        if (err instanceof SmithersError) {
          return fail({
            code: err.code,
            message: err.message,
            exitCode: 4,
          });
        }
        return fail({
          code: "INIT_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })

  // =========================================================================
  // smithers up [workflow]
  // =========================================================================
  .command("up", {
    description: "Start a workflow execution. Use -d for detached (background) mode.",
    args: workflowArgs,
    options: upOptions,
    alias: { detach: "d", runId: "r", input: "i", maxConcurrency: "c" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };

      try {
        const workflowPath = c.args.workflow;
        const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
        const isToon = extname(resolvedWorkflowPath) === ".toon";
        const input = parseJsonInput(c.options.input, "input", fail) ?? {};
        const runId = c.options.runId;
        const resume = Boolean(c.options.resume);

        // Detached mode: spawn ourselves as a background process
        if (c.options.detach) {
          const cliPath = new URL(import.meta.url).pathname;
          const childArgs = ["up", workflowPath];
          if (runId) childArgs.push("--run-id", runId);
          if (c.options.input) childArgs.push("--input", c.options.input);
          if (c.options.maxConcurrency) childArgs.push("--max-concurrency", String(c.options.maxConcurrency));
          if (c.options.root) childArgs.push("--root", c.options.root);
          if (!c.options.log) childArgs.push("--no-log");
          if (c.options.logDir) childArgs.push("--log-dir", c.options.logDir);
          if (c.options.allowNetwork) childArgs.push("--allow-network");
          if (c.options.maxOutputBytes) childArgs.push("--max-output-bytes", String(c.options.maxOutputBytes));
          if (c.options.toolTimeoutMs) childArgs.push("--tool-timeout-ms", String(c.options.toolTimeoutMs));
          if (c.options.hot) childArgs.push("--hot");
          if (resume) childArgs.push("--resume");
          if (c.options.force) childArgs.push("--force");

          const logFileDir = c.options.logDir ?? dirname(resolvedWorkflowPath);
          const effectiveRunId = runId ?? `run-${Date.now()}`;
          const logFile = resolve(logFileDir, `${effectiveRunId}.log`);
          if (!runId) childArgs.push("--run-id", effectiveRunId);

          const fd = openSync(logFile, "a");
          const child = spawn("bun", [cliPath, ...childArgs], {
            detached: true,
            stdio: ["ignore", fd, fd],
            env: process.env,
          });
          child.unref();

          return c.ok(
            { runId: effectiveRunId, logFile, pid: child.pid },
            {
              cta: {
                description: "Next steps:",
                commands: [
                { command: `logs ${effectiveRunId}`, description: "Tail run logs" },
                { command: `chat ${effectiveRunId} --follow`, description: "Watch agent chat" },
                { command: `ps`, description: "List all runs" },
                { command: `inspect ${effectiveRunId}`, description: "Inspect run state" },
              ],
            },
            },
          );
        }

        if (c.options.hot) {
          process.env.SMITHERS_HOT = "1";
        }

        let workflow: SmithersWorkflow<any> | null = null;
        if (!isToon) {
          workflow = await loadWorkflow(workflowPath);
          ensureSmithersTables(workflow.db as any);
          if (c.options.hot) {
            process.stderr.write(`[hot] Hot reload enabled\n`);
          }
          setupSqliteCleanup(workflow);
        }

        const adapter = workflow ? new SmithersDb(workflow.db as any) : null;

        if (!resume && adapter) {
          const staleRuns = await adapter.listRuns(10, "running");
          if (staleRuns.length > 0) {
            process.stderr.write(`⚠ Found ${staleRuns.length} run(s) still marked as 'running':\n`);
            for (const r of staleRuns as any[]) {
              process.stderr.write(`  ${r.runId} (started ${new Date(r.startedAtMs ?? r.createdAtMs).toISOString()})\n`);
            }
            process.stderr.write("  Use 'smithers cancel' to mark them as cancelled, or 'smithers up --resume' to continue.\n");
          }
        }

        if (runId && adapter) {
          const existing = await adapter.getRun(runId);
          if (resume && !existing) {
            return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${runId}`, exitCode: 4 });
          }
          if (resume && existing?.status === "running" && !c.options.force) {
            return fail({ code: "RUN_STILL_RUNNING", message: `Run is still marked running: ${runId}. Use --force to resume anyway.`, exitCode: 4 });
          }
          if (!resume && existing) {
            return fail({ code: "RUN_EXISTS", message: `Run already exists: ${runId}`, exitCode: 4 });
          }
        }

        const rootDir = c.options.root ? resolve(process.cwd(), c.options.root) : dirname(resolvedWorkflowPath);
        const logDir = c.options.log ? c.options.logDir : null;
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
                maxConcurrency: c.options.maxConcurrency,
                rootDir,
                logDir,
                allowNetwork: c.options.allowNetwork,
                maxOutputBytes: c.options.maxOutputBytes,
                toolTimeoutMs: c.options.toolTimeoutMs,
                hot: c.options.hot,
                onProgress,
                signal: abort.signal,
              })
              .pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
          );
          const status = (result as any)?.status;
          const resultRunId = (result as any)?.runId;
          process.exitCode = formatStatusExitCode(typeof status === "string" ? status : undefined);
          return c.ok(result, {
            cta: resultRunId ? {
              description: "Next steps:",
              commands: [
                { command: `inspect ${resultRunId}`, description: "Inspect run state" },
                { command: `logs ${resultRunId}`, description: "View run logs" },
                { command: `chat ${resultRunId}`, description: "View agent chat" },
              ],
            } : undefined,
          });
        }

        const result = await runWorkflow(workflow!, {
          input,
          runId,
          resume,
          workflowPath: resolvedWorkflowPath,
          maxConcurrency: c.options.maxConcurrency,
          rootDir,
          logDir,
          allowNetwork: c.options.allowNetwork,
          maxOutputBytes: c.options.maxOutputBytes,
          toolTimeoutMs: c.options.toolTimeoutMs,
          hot: c.options.hot,
          onProgress,
          signal: abort.signal,
        });

        process.exitCode = formatStatusExitCode(result.status);
        return c.ok(result, {
          cta: result.runId ? {
            description: "Next steps:",
            commands: [
              { command: `inspect ${result.runId}`, description: "Inspect run state" },
              { command: `logs ${result.runId}`, description: "View run logs" },
              { command: `chat ${result.runId}`, description: "View agent chat" },
            ],
          } : undefined,
        });
      } catch (err: any) {
        return fail({ code: "RUN_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers ps
  // =========================================================================
  .command("ps", {
    description: "List active, paused, and recently completed runs.",
    options: psOptions,
    alias: { status: "s", limit: "l", all: "a" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const runs = await adapter.listRuns(c.options.limit, c.options.status);
          const rows: any[] = [];
          for (const run of runs as any[]) {
            const nodes = await adapter.listNodes(run.runId);
            const activeNode = (nodes as any[]).find((n: any) => n.state === "in-progress");
            rows.push({
              id: run.runId,
              workflow: run.workflowName ?? (run.workflowPath ? basename(run.workflowPath) : "—"),
              status: run.status,
              step: activeNode?.label ?? activeNode?.nodeId ?? "—",
              started: run.startedAtMs ? formatAge(run.startedAtMs) : run.createdAtMs ? formatAge(run.createdAtMs) : "—",
            });
          }

          // Build CTAs based on what's available
          const ctaCommands: any[] = [];
          const firstActive = rows.find((r) => r.status === "running");
          const firstWaiting = rows.find((r) => r.status === "waiting-approval");
          if (firstActive) {
            ctaCommands.push({ command: `logs ${firstActive.id}`, description: "Tail active run" });
            ctaCommands.push({ command: `chat ${firstActive.id} --follow`, description: "Watch agent chat" });
          }
          if (firstWaiting) {
            ctaCommands.push({ command: `approve ${firstWaiting.id}`, description: "Approve waiting run" });
          }
          if (rows.length > 0) {
            ctaCommands.push({ command: `inspect ${rows[0].id}`, description: "Inspect most recent run" });
          }

          return c.ok(
            { runs: rows },
            ctaCommands.length > 0 ? { cta: { commands: ctaCommands } } : undefined,
          );
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "PS_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers logs <run_id>
  // =========================================================================
  .command("logs", {
    description: "Tail the event log of a specific run.",
    args: z.object({ runId: z.string().describe("Run ID to tail") }),
    options: logsOptions,
    alias: { follow: "f", tail: "n" },
    async *run(c) {
      let adapter: SmithersDb | undefined;
      let cleanup: (() => void) | undefined;
      try {
        const db = await findAndOpenDb();
        adapter = db.adapter;
        cleanup = db.cleanup;

        const run = await adapter.getRun(c.args.runId);
        if (!run) {
          yield `Error: Run not found: ${c.args.runId}`;
          return;
        }

        const baseMs = (run as any).startedAtMs ?? (run as any).createdAtMs ?? Date.now();
        let lastSeq = c.options.since ?? -1;

        // If --since not specified, get recent events to show tail
        if (c.options.since === undefined) {
          const lastEventSeq = await adapter.getLastEventSeq(c.args.runId);
          if (lastEventSeq !== undefined) {
            lastSeq = Math.max(-1, lastEventSeq - c.options.tail);
          }
        }

        // Dump existing events
        const initialEvents = await adapter.listEvents(c.args.runId, lastSeq, 1000);
        for (const event of initialEvents as any[]) {
          yield formatEventLine(event, baseMs);
          lastSeq = event.seq;
        }

        // If not following, or run already done, stop
        const isActive = (run as any).status === "running" || (run as any).status === "waiting-approval";
        if (!c.options.follow || !isActive) {
          return c.ok(undefined, {
            cta: {
              commands: [
                { command: `inspect ${c.args.runId}`, description: "Inspect run state" },
              ],
            },
          });
        }

        // Poll for new events
        while (true) {
          await new Promise((r) => setTimeout(r, 500));

          const newEvents = await adapter.listEvents(c.args.runId, lastSeq, 200);
          for (const event of newEvents as any[]) {
            yield formatEventLine(event, baseMs);
            lastSeq = event.seq;
          }

          // Check if run is still active
          const currentRun = await adapter.getRun(c.args.runId);
          const currentStatus = (currentRun as any)?.status;
          if (currentStatus !== "running" && currentStatus !== "waiting-approval") {
            // Drain remaining events
            const finalEvents = await adapter.listEvents(c.args.runId, lastSeq, 1000);
            for (const event of finalEvents as any[]) {
              yield formatEventLine(event, baseMs);
              lastSeq = event.seq;
            }

            const ctaCommands: any[] = [
              { command: `inspect ${c.args.runId}`, description: "Inspect run state" },
            ];
            if (currentStatus === "waiting-approval") {
              ctaCommands.push({ command: `approve ${c.args.runId}`, description: "Approve run" });
            }
            return c.ok(undefined, { cta: { commands: ctaCommands } });
          }
        }
      } finally {
        cleanup?.();
      }
    },
  })

  // =========================================================================
  // smithers chat [run_id]
  // =========================================================================
  .command("chat", {
    description: "Show agent chat output for the latest run or a specific run.",
    args: chatArgs,
    options: chatOptions,
    alias: { follow: "f", tail: "n", all: "a" },
    async *run(c) {
      let cleanup: (() => void) | undefined;
      try {
        const db = await findAndOpenDb();
        const adapter = db.adapter;
        cleanup = db.cleanup;

        let run: any | undefined;
        if (c.args.runId) {
          run = await adapter.getRun(c.args.runId);
        } else {
          const latestRuns = await adapter.listRuns(1);
          run = (latestRuns as any[])[0];
        }

        if (!run) {
          yield c.args.runId
            ? `Error: Run not found: ${c.args.runId}`
            : "Error: No runs found.";
          return;
        }

        const runId = run.runId;
        const baseMs = (run as any).startedAtMs ?? (run as any).createdAtMs ?? Date.now();
        const printedHeaders = new Set<string>();
        const emittedBlockIds = new Set<string>();
        const stdoutSeenAttempts = new Set<string>();
        const selectedAttemptKeys = new Set<string>();

        const attemptByKey = new Map<string, any>();
        const knownOutputAttemptKeys = new Set<string>();

        const renderLines = (blocks: Array<{ attemptKey: string; blockId: string; timestampMs: number; text: string }>) => {
          const lines: string[] = [];
          for (const block of blocks) {
            if (emittedBlockIds.has(block.blockId)) continue;
            emittedBlockIds.add(block.blockId);
            const attempt = attemptByKey.get(block.attemptKey);
            if (!attempt) continue;
            if (!printedHeaders.has(block.attemptKey)) {
              if (lines.length > 0) lines.push("");
              lines.push(formatChatAttemptHeader(attempt));
              printedHeaders.add(block.attemptKey);
            }
            lines.push(block.text);
          }
          return lines;
        };

        const buildPromptBlock = (attempt: any) => {
          const attemptKey = chatAttemptKey(attempt);
          const meta = parseChatAttemptMeta(attempt.metaJson);
          const prompt = typeof meta.prompt === "string" ? meta.prompt.trim() : "";
          if (!prompt) return null;
          return {
            attemptKey,
            blockId: `prompt:${attemptKey}`,
            timestampMs: attempt.startedAtMs ?? baseMs,
            text: formatChatBlock({
              baseMs,
              timestampMs: attempt.startedAtMs ?? baseMs,
              role: "user",
              attempt,
              text: prompt,
            }),
          };
        };

        const buildOutputBlock = (event: ReturnType<typeof parseNodeOutputEvent>) => {
          if (!event) return null;
          const attemptKey = chatAttemptKey(event);
          if (!selectedAttemptKeys.has(attemptKey)) return null;
          if (event.stream === "stderr" && !c.options.stderr) return null;
          if (event.stream === "stdout") {
            stdoutSeenAttempts.add(attemptKey);
          }
          return {
            attemptKey,
            blockId: `event:${event.seq}`,
            timestampMs: event.timestampMs,
            text: formatChatBlock({
              baseMs,
              timestampMs: event.timestampMs,
              role: event.stream === "stderr" ? "stderr" : "assistant",
              attempt: event,
              text: event.text,
            }),
          };
        };

        const buildFallbackBlock = (attempt: any) => {
          const attemptKey = chatAttemptKey(attempt);
          const responseText = typeof attempt.responseText === "string"
            ? attempt.responseText.trim()
            : "";
          if (!responseText || stdoutSeenAttempts.has(attemptKey)) return null;
          return {
            attemptKey,
            blockId: `response:${attemptKey}`,
            timestampMs: attempt.finishedAtMs ?? attempt.startedAtMs ?? baseMs,
            text: formatChatBlock({
              baseMs,
              timestampMs: attempt.finishedAtMs ?? attempt.startedAtMs ?? baseMs,
              role: "assistant",
              attempt,
              text: responseText,
            }),
          };
        };

        const syncAttempts = (attempts: any[]) => {
          for (const attempt of attempts) {
            attemptByKey.set(chatAttemptKey(attempt), attempt);
          }
          const selected = selectChatAttempts(
            attempts,
            knownOutputAttemptKeys,
            c.options.all,
          );
          if (c.options.all || selectedAttemptKeys.size === 0) {
            for (const attempt of selected) {
              selectedAttemptKeys.add(chatAttemptKey(attempt));
            }
          }
          return selected;
        };

        const initialAttempts = await adapter.listAttemptsForRun(runId);
        syncAttempts(initialAttempts as any[]);

        const initialEvents = await listAllEvents(adapter, runId);
        const parsedInitialOutputs = (initialEvents as any[])
          .map((event) => parseNodeOutputEvent(event))
          .filter(Boolean) as Array<NonNullable<ReturnType<typeof parseNodeOutputEvent>>>;

        for (const event of parsedInitialOutputs) {
          knownOutputAttemptKeys.add(chatAttemptKey(event));
        }

        const selectedInitialAttempts = syncAttempts(initialAttempts as any[]);
        const initialBlocks: Array<{ attemptKey: string; blockId: string; timestampMs: number; text: string }> = [];

        for (const attempt of selectedInitialAttempts) {
          const promptBlock = buildPromptBlock(attempt);
          if (promptBlock) initialBlocks.push(promptBlock);
        }

        for (const event of parsedInitialOutputs) {
          const block = buildOutputBlock(event);
          if (block) initialBlocks.push(block);
        }

        for (const attempt of selectedInitialAttempts) {
          const fallbackBlock = buildFallbackBlock(attempt);
          if (fallbackBlock) initialBlocks.push(fallbackBlock);
        }

        initialBlocks.sort((a, b) => {
          if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
          return a.blockId.localeCompare(b.blockId);
        });

        const visibleInitialBlocks = c.options.tail
          ? initialBlocks.slice(-c.options.tail)
          : initialBlocks;

        const initialLines = renderLines(visibleInitialBlocks);
        for (const line of initialLines) {
          yield line;
        }

        if (selectedAttemptKeys.size === 0 && !c.options.follow) {
          yield `No agent chat logs found for run: ${runId}`;
          return;
        }

        let lastSeq = (initialEvents as any[]).length > 0
          ? (initialEvents as any[])[(initialEvents as any[]).length - 1]!.seq
          : -1;

        if (!c.options.follow) {
          return c.ok(undefined, {
            cta: {
              commands: [
                { command: `inspect ${runId}`, description: "Inspect run state" },
                { command: `logs ${runId}`, description: "Tail lifecycle events" },
              ],
            },
          });
        }

        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 500));

          const attempts = await adapter.listAttemptsForRun(runId);
          syncAttempts(attempts as any[]);

          const newRows = await adapter.listEvents(runId, lastSeq, 200);
          const newBlocks: Array<{ attemptKey: string; blockId: string; timestampMs: number; text: string }> = [];

          for (const eventRow of newRows as any[]) {
            lastSeq = eventRow.seq;
            const parsed = parseNodeOutputEvent(eventRow);
            if (!parsed) continue;
            knownOutputAttemptKeys.add(chatAttemptKey(parsed));
            if (c.options.all || selectedAttemptKeys.size === 0) {
              syncAttempts(attempts as any[]);
            }
            const block = buildOutputBlock(parsed);
            if (block) newBlocks.push(block);
          }

          for (const attempt of (attempts as any[]).filter((entry) => selectedAttemptKeys.has(chatAttemptKey(entry)))) {
            const promptBlock = buildPromptBlock(attempt);
            if (promptBlock && !emittedBlockIds.has(promptBlock.blockId)) {
              newBlocks.push(promptBlock);
            }
            const fallbackBlock = buildFallbackBlock(attempt);
            if (fallbackBlock && !emittedBlockIds.has(fallbackBlock.blockId)) {
              newBlocks.push(fallbackBlock);
            }
          }

          newBlocks.sort((a, b) => {
            if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
            return a.blockId.localeCompare(b.blockId);
          });

          const newLines = renderLines(newBlocks);
          for (const line of newLines) {
            yield line;
          }

          const currentRun = await adapter.getRun(runId);
          const currentStatus = (currentRun as any)?.status;
          if (currentStatus !== "running" && currentStatus !== "waiting-approval") {
            const finalAttempts = await adapter.listAttemptsForRun(runId);
            syncAttempts(finalAttempts as any[]);
            const finalBlocks = (finalAttempts as any[])
              .filter((attempt) => selectedAttemptKeys.has(chatAttemptKey(attempt)))
              .map((attempt) => buildFallbackBlock(attempt))
              .filter(Boolean) as Array<{ attemptKey: string; blockId: string; timestampMs: number; text: string }>;

            const finalLines = renderLines(finalBlocks);
            for (const line of finalLines) {
              yield line;
            }

            return c.ok(undefined, {
              cta: {
                commands: [
                  { command: `inspect ${runId}`, description: "Inspect run state" },
                  { command: `logs ${runId}`, description: "Tail lifecycle events" },
                ],
              },
            });
          }
        }
      } finally {
        cleanup?.();
      }
    },
  })

  // =========================================================================
  // smithers inspect <run_id>
  // =========================================================================
  .command("inspect", {
    description: "Output detailed state of a run: steps, agents, approvals, and outputs.",
    args: inspectArgs,
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const run = await adapter.getRun(c.args.runId);
          if (!run) {
            return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${c.args.runId}`, exitCode: 4 });
          }

          const r = run as any;
          const nodes = await adapter.listNodes(c.args.runId);
          const approvals = await adapter.listPendingApprovals(c.args.runId);
          const loops = await adapter.listRalph(c.args.runId);

          const steps = (nodes as any[]).map((n: any) => ({
            id: n.nodeId,
            state: n.state,
            attempt: n.lastAttempt ?? 0,
            label: n.label ?? n.nodeId,
          }));

          const pendingApprovals = (approvals as any[]).map((a: any) => ({
            nodeId: a.nodeId,
            status: a.status,
            requestedAt: a.requestedAtMs ? new Date(a.requestedAtMs).toISOString() : "—",
          }));

          const loopState = (loops as any[]).map((l: any) => ({
            loopId: l.ralphId,
            iteration: l.iteration,
            maxIterations: l.maxIterations,
          }));

          let config: any = undefined;
          if (r.configJson) {
            try { config = JSON.parse(r.configJson); } catch {}
          }

          let error: any = undefined;
          if (r.errorJson) {
            try { error = JSON.parse(r.errorJson); } catch {}
          }

          const result: Record<string, any> = {
            run: {
              id: r.runId,
              workflow: r.workflowName ?? (r.workflowPath ? basename(r.workflowPath) : "—"),
              status: r.status,
              started: r.startedAtMs ? new Date(r.startedAtMs).toISOString() : "—",
              elapsed: r.startedAtMs ? formatElapsedCompact(r.startedAtMs, r.finishedAtMs ?? undefined) : "—",
              ...(r.finishedAtMs ? { finished: new Date(r.finishedAtMs).toISOString() } : {}),
              ...(error ? { error } : {}),
            },
            steps,
          };

          if (pendingApprovals.length > 0) {
            result.approvals = pendingApprovals;
          }
          if (loopState.length > 0) {
            result.loops = loopState;
          }
          if (config) {
            result.config = config;
          }

          const ctaCommands: any[] = [
            { command: `logs ${c.args.runId}`, description: "Tail run logs" },
            { command: `chat ${c.args.runId}`, description: "View agent chat" },
          ];
          if (r.status === "running" || r.status === "waiting-approval") {
            ctaCommands.push({ command: `cancel ${c.args.runId}`, description: "Cancel run" });
          }
          if (pendingApprovals.length > 0) {
            ctaCommands.push({ command: `approve ${c.args.runId}`, description: "Approve pending gate" });
          }

          return c.ok(result, { cta: { commands: ctaCommands } });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "INSPECT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers approve <run_id>
  // =========================================================================
  .command("approve", {
    description: "Approve a paused approval gate. Auto-detects the pending node if only one exists.",
    args: approveArgs,
    options: approveOptions,
    alias: { node: "n" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const pending = await adapter.listPendingApprovals(c.args.runId);
          if ((pending as any[]).length === 0) {
            return fail({ code: "NO_PENDING_APPROVALS", message: `No pending approvals for run: ${c.args.runId}`, exitCode: 4 });
          }

          let nodeId = c.options.node;
          if (!nodeId) {
            if ((pending as any[]).length > 1) {
              const nodeList = (pending as any[]).map((a: any) => `  ${a.nodeId} (iteration ${a.iteration})`).join("\n");
              return fail({
                code: "AMBIGUOUS_APPROVAL",
                message: `Multiple pending approvals. Specify --node:\n${nodeList}`,
                exitCode: 4,
              });
            }
            nodeId = (pending as any[])[0].nodeId;
          }

          await approveNode(adapter, c.args.runId, nodeId!, c.options.iteration, c.options.note, c.options.by);

          return c.ok(
            { runId: c.args.runId, nodeId, status: "approved" },
            {
              cta: {
                commands: [
                  { command: `logs ${c.args.runId}`, description: "Tail run logs" },
                  { command: `ps`, description: "List all runs" },
                ],
              },
            },
          );
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "APPROVE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers deny <run_id>
  // =========================================================================
  .command("deny", {
    description: "Deny a paused approval gate.",
    args: approveArgs,
    options: approveOptions,
    alias: { node: "n" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const pending = await adapter.listPendingApprovals(c.args.runId);
          if ((pending as any[]).length === 0) {
            return fail({ code: "NO_PENDING_APPROVALS", message: `No pending approvals for run: ${c.args.runId}`, exitCode: 4 });
          }

          let nodeId = c.options.node;
          if (!nodeId) {
            if ((pending as any[]).length > 1) {
              const nodeList = (pending as any[]).map((a: any) => `  ${a.nodeId} (iteration ${a.iteration})`).join("\n");
              return fail({
                code: "AMBIGUOUS_APPROVAL",
                message: `Multiple pending approvals. Specify --node:\n${nodeList}`,
                exitCode: 4,
              });
            }
            nodeId = (pending as any[])[0].nodeId;
          }

          await denyNode(adapter, c.args.runId, nodeId!, c.options.iteration, c.options.note, c.options.by);

          return c.ok(
            { runId: c.args.runId, nodeId, status: "denied" },
            {
              cta: {
                commands: [
                  { command: `logs ${c.args.runId}`, description: "Tail run logs" },
                  { command: `ps`, description: "List all runs" },
                ],
              },
            },
          );
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "DENY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers cancel <run_id>
  // =========================================================================
  .command("cancel", {
    description: "Safely halt agents and terminate a run.",
    args: cancelArgs,
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const run = await adapter.getRun(c.args.runId);
          if (!run) {
            return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${c.args.runId}`, exitCode: 4 });
          }
          if ((run as any).status !== "running" && (run as any).status !== "waiting-approval") {
            return fail({ code: "RUN_NOT_ACTIVE", message: `Run is not active (status: ${(run as any).status})`, exitCode: 4 });
          }

          const inProgress = await adapter.listInProgressAttempts(c.args.runId);
          const now = Date.now();
          for (const attempt of inProgress as any[]) {
            await adapter.updateAttempt(c.args.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
              state: "cancelled",
              finishedAtMs: now,
            });
          }
          await adapter.updateRun(c.args.runId, { status: "cancelled", finishedAtMs: now });

          process.exitCode = 2;
          return c.ok(
            { runId: c.args.runId, status: "cancelled", cancelledAttempts: (inProgress as any[]).length },
            {
              cta: {
                commands: [
                  { command: `ps`, description: "List all runs" },
                ],
              },
            },
          );
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "CANCEL_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers down
  // =========================================================================
  .command("down", {
    description: "Cancel all active runs. Like 'docker compose down' for workflows.",
    options: z.object({
      force: z.boolean().default(false).describe("Cancel runs even if they appear stale"),
    }),
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const activeRuns = await adapter.listRuns(100, "running");
          const waitingRuns = await adapter.listRuns(100, "waiting-approval");
          const allActive = [...(activeRuns as any[]), ...(waitingRuns as any[])];

          if (allActive.length === 0) {
            return c.ok({ cancelled: 0, message: "No active runs to cancel." });
          }

          const now = Date.now();
          let cancelled = 0;

          for (const run of allActive) {
            const inProgress = await adapter.listInProgressAttempts(run.runId);
            for (const attempt of inProgress as any[]) {
              await adapter.updateAttempt(run.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                state: "cancelled",
                finishedAtMs: now,
              });
            }
            await adapter.updateRun(run.runId, { status: "cancelled", finishedAtMs: now });
            process.stderr.write(`⊘ Cancelled: ${run.runId}\n`);
            cancelled++;
          }

          return c.ok(
            { cancelled, runs: allActive.map((r: any) => r.runId) },
            { cta: { commands: [{ command: `ps`, description: "Verify all runs stopped" }] } },
          );
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "DOWN_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers graph <workflow>
  // =========================================================================
  .command("graph", {
    description: "Render the workflow graph without executing it.",
    args: workflowArgs,
    options: graphOptions,
    alias: { runId: "r" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const resolvedWorkflowPath = resolve(process.cwd(), c.args.workflow);
        if (extname(resolvedWorkflowPath) === ".toon") {
          return fail({
            code: "GRAPH_UNSUPPORTED",
            message: "The graph command is not yet supported for .toon workflows. Use a .tsx workflow instead.",
            exitCode: 1,
          });
        }
        const workflow = await loadWorkflow(c.args.workflow);
        ensureSmithersTables(workflow.db as any);
        const schema = resolveSchema(workflow.db);
        const inputTable = schema.input;
        const inputRow = c.options.input
          ? parseJsonInput(c.options.input, "input", fail)
          : inputTable
            ? ((await loadInput(workflow.db as any, inputTable, c.options.runId)) ?? {})
            : {};
        const outputs = await loadOutputs(workflow.db as any, schema, c.options.runId);
        const ctx = buildContext({
          runId: c.options.runId,
          iteration: 0,
          input: inputRow ?? {},
          outputs,
        });
        const baseRootDir = dirname(resolvedWorkflowPath);
        const snap = await renderFrame(workflow, ctx, { baseRootDir });
        const seen = new WeakSet<object>();
        return c.ok(
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
        return fail({ code: "GRAPH_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers revert <workflow>
  // =========================================================================
  .command("revert", {
    description: "Revert the workspace to a previous task attempt's filesystem state.",
    args: workflowArgs,
    options: revertOptions,
    alias: { runId: "r", nodeId: "n" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const result = await revertToAttempt(adapter, {
            runId: c.options.runId,
            nodeId: c.options.nodeId,
            iteration: c.options.iteration,
            attempt: c.options.attempt,
            onProgress: (e) => console.log(JSON.stringify(e)),
          });
          process.exitCode = result.success ? 0 : 1;
          return c.ok(result);
        } finally {
          cleanup?.();
        }
      } catch (err: any) {
        return fail({ code: "REVERT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers observability
  // =========================================================================
  .command("observability", {
    description: "Start the local observability stack (Grafana, Prometheus, Tempo, OTLP Collector) via Docker Compose.",
    options: z.object({
      detach: z.boolean().default(false).describe("Run containers in the background"),
      down: z.boolean().default(false).describe("Stop and remove the observability stack"),
    }),
    alias: { detach: "d" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };

      const composeDir = resolve(dirname(new URL(import.meta.url).pathname), "../../observability");
      const composeFile = resolve(composeDir, "docker-compose.otel.yml");

      if (!existsSync(composeFile)) {
        return fail({
          code: "COMPOSE_NOT_FOUND",
          message: `Docker Compose file not found at ${composeFile}. Ensure the smithers-orchestrator package includes the observability/ directory.`,
          exitCode: 1,
        });
      }

      const composeArgs = [
        "compose", "-f", composeFile,
        ...(c.options.down ? ["down"] : ["up", ...(c.options.detach ? ["-d"] : [])]),
      ];

      process.stderr.write(
        c.options.down
          ? `[smithers] Stopping observability stack...\n`
          : `[smithers] Starting observability stack...\n` +
            `  Grafana:    http://localhost:3001\n` +
            `  Prometheus: http://localhost:9090\n` +
            `  Tempo:      http://localhost:3200\n`,
      );

      const child = spawn("docker", composeArgs, { stdio: "inherit", cwd: composeDir });

      const result = await new Promise<{ exitCode: number }>((resolve) => {
        child.on("close", (code) => resolve({ exitCode: code ?? 0 }));
        child.on("error", (err) => {
          process.stderr.write(`Failed to run docker compose: ${err.message}\n`);
          process.stderr.write(`Make sure Docker is installed and running.\n`);
          resolve({ exitCode: 1 });
        });
      });

      process.exitCode = result.exitCode;
      return c.ok({ action: c.options.down ? "down" : "up", exitCode: result.exitCode });
    },
  })

  // =========================================================================
  // smithers ask <question>
  // =========================================================================
  .command("ask", {
    description: "Ask a question about Smithers using your installed agent and the Smithers MCP server.",
    args: z.object({
      question: z.string().describe("The question to ask"),
    }),
    async run(c) {
      try {
        await ask(c.args.question, process.cwd());
        return c.ok({ answered: true });
      } catch (err: any) {
        commandExitOverride = 1;
        return c.error({
          code: "ASK_FAILED",
          message: err?.message ?? String(err),
        });
      }
    },
  })

  .command(workflowCli);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS = new Set([
  "init", "up", "down", "ps", "logs", "chat", "inspect", "approve", "deny",
  "cancel", "graph", "revert", "observability", "workflow", "ask",
]);

const BUILTIN_FLAGS_WITH_VALUES = new Set([
  "--format",
  "--filter-output",
  "--token-limit",
  "--token-offset",
]);

const WORKFLOW_UTILITY_COMMANDS = new Set([
  "list",
  "path",
  "create",
  "doctor",
]);

function findFirstPositionalIndex(argv: string[], startIndex = 0): number {
  for (let index = startIndex; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      return index;
    }
    if (BUILTIN_FLAGS_WITH_VALUES.has(arg)) {
      index++;
    }
  }
  return -1;
}

function hasHelpFlag(argv: string[], startIndex = 0) {
  for (let index = startIndex; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      return true;
    }
  }
  return false;
}

function hasInputArgument(argv: string[]) {
  return argv.includes("--input") || argv.includes("-i");
}

function hasRootArgument(argv: string[]) {
  return argv.includes("--root");
}

function extractPromptArgument(argv: string[]) {
  let prompt: string | undefined;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--prompt") {
      prompt = argv[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      continue;
    }
    rest.push(arg);
  }

  return { prompt, rest };
}

function rewriteWorkflowRunArgs(prefix: string[], entryFile: string, argv: string[]) {
  const { prompt, rest } = extractPromptArgument(argv);
  const rewritten = [...prefix, "up", entryFile, ...rest];
  if (prompt !== undefined && !hasInputArgument(rest)) {
    rewritten.push("--input", JSON.stringify({ prompt }));
  }
  if (!hasRootArgument(rest)) {
    rewritten.push("--root", ".");
  }
  return rewritten;
}

function rewriteWorkflowCommandArgv(argv: string[]) {
  const workflowIndex = findFirstPositionalIndex(argv);
  if (workflowIndex < 0 || argv[workflowIndex] !== "workflow") {
    return argv;
  }

  if (hasHelpFlag(argv, workflowIndex + 1)) {
    return argv;
  }

  const subcommandIndex = findFirstPositionalIndex(argv, workflowIndex + 1);
  if (subcommandIndex < 0) {
    return [
      ...argv.slice(0, workflowIndex + 1),
      "list",
      ...argv.slice(workflowIndex + 1),
    ];
  }

  const subcommand = argv[subcommandIndex]!;
  if (WORKFLOW_UTILITY_COMMANDS.has(subcommand)) {
    return argv;
  }

  const prefix = argv.slice(0, workflowIndex);

  if (subcommand === "run") {
    const workflowNameIndex = findFirstPositionalIndex(argv, subcommandIndex + 1);
    if (workflowNameIndex < 0) {
      return argv;
    }
    try {
      const workflow = resolveWorkflow(argv[workflowNameIndex]!, process.cwd());
      return rewriteWorkflowRunArgs(prefix, workflow.entryFile, argv.slice(workflowNameIndex + 1));
    } catch {
      return argv;
    }
  }

  try {
    const workflow = resolveWorkflow(subcommand, process.cwd());
    return rewriteWorkflowRunArgs(prefix, workflow.entryFile, argv.slice(subcommandIndex + 1));
  } catch {
    return argv;
  }
}

async function main() {
  const rawArgv = process.argv.slice(2);
  let argv = rawArgv.map((arg) => (arg === "-v" ? "--version" : arg));
  argv = rewriteWorkflowCommandArgv(argv);

  // Allow running workflow files directly: `smithers workflow.toon` → `smithers up workflow.toon`
  const firstPositionalIndex = findFirstPositionalIndex(argv);
  const firstPositional = firstPositionalIndex >= 0 ? argv[firstPositionalIndex] : undefined;
  if (
    firstPositional &&
    !KNOWN_COMMANDS.has(firstPositional) &&
    (firstPositional.endsWith(".toon") || firstPositional.endsWith(".tsx"))
  ) {
    argv = [
      ...argv.slice(0, firstPositionalIndex),
      "up",
      ...argv.slice(firstPositionalIndex),
    ];
  }

  // --mcp mode: the MCP server needs to stay alive listening on stdin.
  if (argv.includes("--mcp")) {
    try {
      await cli.serve(argv);
    } catch (err: any) {
      console.error(err?.message ?? String(err));
      process.exit(1);
    }
    return;
  }

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
