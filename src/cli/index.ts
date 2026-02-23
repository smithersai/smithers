#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { runWorkflow, renderFrame, resolveSchema } from "../engine";
import { approveNode, denyNode } from "../engine/approvals";
import { loadInput, loadOutputs } from "../db/snapshot";
import { ensureSmithersTables } from "../db/ensure";
import { SmithersDb } from "../db/adapter";
import { buildContext } from "../context";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import { revertToAttempt } from "../revert";

async function loadWorkflow(path: string): Promise<SmithersWorkflow<any>> {
  const abs = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(abs).href);
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function parseJsonOrExit(raw: string, label: string) {
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    console.error(`Invalid JSON for ${label}: ${err?.message ?? String(err)}`);
    process.exit(4);
  }
}

function parseIntegerOrExit(
  value: unknown,
  label: string,
  min: number,
): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < min) {
    console.error(`Invalid ${label}: expected integer >= ${min}`);
    process.exit(4);
  }
  return Math.floor(num);
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

function parseArgs(argv: string[]) {
  const args: Record<string, any> = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value =
        argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i] : true;
      args[key] = value;
    } else {
      args._.push(arg);
    }
    i++;
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (
    args.version ||
    args.v ||
    cmd === "version" ||
    cmd === "--version" ||
    cmd === "-v"
  ) {
    console.log(readPackageVersion());
    process.exit(0);
  }

  if (
    args.help ||
    args.h ||
    cmd === "help" ||
    cmd === "--help" ||
    cmd === "-h"
  ) {
    console.log(`Usage: smithers <command> [options]

Commands:
  run <workflow.tsx> [--input JSON] [--run-id ID] [--max-concurrency N]
  resume <workflow.tsx> --run-id ID [--force]
  approve <workflow.tsx> --run-id ID --node-id ID [--iteration N] [--note TEXT] [--decided-by TEXT]
  deny <workflow.tsx> --run-id ID --node-id ID [--iteration N] [--note TEXT] [--decided-by TEXT]
  status <workflow.tsx> --run-id ID
  frames <workflow.tsx> --run-id ID [--tail N] [--compact]
  list <workflow.tsx> [--limit N] [--status STATUS]
  graph <workflow.tsx> [--run-id ID] [--input JSON]
  revert <workflow.tsx> --run-id ID --node-id ID [--attempt N] [--iteration N]
  cancel <workflow.tsx> --run-id ID

Run options:
  --root PATH            Root directory for tool sandbox (default: workflow dir)
  --log-dir PATH         Relative log directory (default: .smithers/executions/<runId>/logs)
  --no-log               Disable event log file output
  --allow-network        Allow network access for bash tool
  --max-output-bytes N   Max tool output bytes (default: 200000)
  --tool-timeout-ms N    Tool timeout in ms (default: 60000)
  --version, -v          Print version
`);
    process.exit(0);
  }

  if (!cmd) {
    console.error("Usage: smithers <command> [...]");
    process.exit(4);
  }

  if (cmd === "run" || cmd === "resume") {
    const workflowPath = args._[0];
    if (!workflowPath) {
      console.error("Missing workflow path");
      process.exit(4);
    }
    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const input = args.input ? parseJsonOrExit(args.input, "input") : {};
    const runId = args["run-id"];
    const resume = cmd === "resume" || Boolean(args.resume);
    if (resume && !runId) {
      console.error("Missing --run-id for resume");
      process.exit(4);
    }
    const adapter = new SmithersDb(workflow.db as any);
    // Warn about stale runs when starting a new run
    if (!resume) {
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
          `  Use 'smithers cancel' to mark them as cancelled, or 'smithers resume' to continue.\n`,
        );
      }
    }
    if (runId) {
      const existing = await adapter.getRun(runId);
      if (resume && !existing) {
        console.error(`Run not found: ${runId}`);
        process.exit(4);
      }
      if (resume && existing?.status === "running" && !args.force) {
        console.error(
          `Run is still marked running: ${runId}. Use --force to resume anyway.`,
        );
        process.exit(4);
      }
      if (!resume && existing) {
        console.error(`Run already exists: ${runId}`);
        process.exit(4);
      }
    }
    const rootDir = args.root
      ? resolve(process.cwd(), String(args.root))
      : dirname(resolvedWorkflowPath);
    const logDir = args["no-log"] ? null : args["log-dir"];
    const maxConcurrency =
      args["max-concurrency"] !== undefined
        ? parseIntegerOrExit(args["max-concurrency"], "max-concurrency", 1)
        : undefined;
    const maxOutputBytes =
      args["max-output-bytes"] !== undefined
        ? parseIntegerOrExit(args["max-output-bytes"], "max-output-bytes", 1)
        : undefined;
    const toolTimeoutMs =
      args["tool-timeout-ms"] !== undefined
        ? parseIntegerOrExit(args["tool-timeout-ms"], "tool-timeout-ms", 1)
        : undefined;
    const startTime = Date.now();
    const formatElapsed = () => {
      const elapsed = Date.now() - startTime;
      const secs = Math.floor(elapsed / 1000);
      const mins = Math.floor(secs / 60);
      const hrs = Math.floor(mins / 60);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${pad(hrs)}:${pad(mins % 60)}:${pad(secs % 60)}`;
    };
    const onProgress = (event: any) => {
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
      }
    };
    const abort = new AbortController();
    let signalHandled = false;
    const handleSignal = (signal: string) => {
      if (signalHandled) return;
      signalHandled = true;
      process.stderr.write(`
[smithers] received ${signal}, cancelling run...
`);
      abort.abort();
    };
    process.once("SIGINT", () => handleSignal("SIGINT"));
    process.once("SIGTERM", () => handleSignal("SIGTERM"));

    const result = await runWorkflow(workflow, {
      input,
      runId,
      resume,
      workflowPath: resolvedWorkflowPath,
      maxConcurrency,
      rootDir,
      logDir,
      allowNetwork: Boolean(args["allow-network"]),
      maxOutputBytes,
      toolTimeoutMs,
      onProgress,
      signal: abort.signal,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(
      result.status === "finished"
        ? 0
        : result.status === "waiting-approval"
          ? 3
          : result.status === "cancelled"
            ? 2
            : 1,
    );
  }

  if (cmd === "approve" || cmd === "deny") {
    const workflowPath = args._[0];
    if (!workflowPath) {
      console.error("Missing workflow path");
      process.exit(4);
    }
    const runId = args["run-id"];
    const nodeId = args["node-id"];
    if (!runId || !nodeId) {
      console.error("Missing --run-id or --node-id");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const iteration =
      args.iteration !== undefined
        ? parseIntegerOrExit(args.iteration, "iteration", 0)
        : 0;
    if (cmd === "approve") {
      await approveNode(
        adapter,
        runId,
        nodeId,
        iteration,
        args.note,
        args["decided-by"],
      );
    } else {
      await denyNode(
        adapter,
        runId,
        nodeId,
        iteration,
        args.note,
        args["decided-by"],
      );
    }
    console.log(JSON.stringify({ runId, nodeId, status: cmd }, null, 2));
    process.exit(0);
  }

  if (cmd === "status") {
    const workflowPath = args._[0];
    const runId = args["run-id"];
    if (!workflowPath || !runId) {
      console.error("Missing workflow path or --run-id");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const run = await adapter.getRun(runId);
    console.log(JSON.stringify(run, null, 2));
    process.exit(0);
  }

  if (cmd === "frames") {
    const workflowPath = args._[0];
    const runId = args["run-id"];
    if (!workflowPath || !runId) {
      console.error("Missing workflow path or --run-id");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const tail =
      args.tail !== undefined ? parseIntegerOrExit(args.tail, "tail", 1) : 20;
    const frames = await adapter.listFrames(runId, tail);
    if (args.compact) {
      const compact = frames.map((frame: any) => {
        const result: Record<string, any> = {
          frameNo: frame.frameNo,
          createdAtMs: frame.createdAtMs,
        };
        // Parse taskIndex for node statuses
        if (frame.taskIndexJson) {
          try {
            result.tasks = JSON.parse(frame.taskIndexJson);
          } catch {}
        }
        // Include mounted task IDs
        if (frame.mountedTaskIdsJson) {
          try {
            result.mountedTaskIds = JSON.parse(frame.mountedTaskIdsJson);
          } catch {}
        }
        return result;
      });
      console.log(JSON.stringify(compact, null, 2));
    } else {
      console.log(JSON.stringify(frames, null, 2));
    }
    process.exit(0);
  }

  if (cmd === "list") {
    const workflowPath = args._[0];
    if (!workflowPath) {
      console.error("Missing workflow path");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const limit =
      args.limit !== undefined
        ? parseIntegerOrExit(args.limit, "limit", 1)
        : 50;
    const status = args.status as string | undefined;
    const runs = await adapter.listRuns(limit, status);
    console.log(JSON.stringify(runs, null, 2));
    process.exit(0);
  }

  if (cmd === "graph") {
    const workflowPath = args._[0];
    if (!workflowPath) {
      console.error("Missing workflow path");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const runId = args["run-id"] ?? "graph";
    const schema = resolveSchema(workflow.db);
    const inputTable = schema.input;
    const inputRow = args.input
      ? parseJsonOrExit(args.input, "input")
      : inputTable
        ? ((await loadInput(workflow.db as any, inputTable, runId)) ?? {})
        : {};
    const outputs = await loadOutputs(workflow.db as any, schema, runId);
    const ctx = buildContext({ runId, iteration: 0, input: inputRow, outputs });
    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const baseRootDir = dirname(resolvedWorkflowPath);
    const snap = await renderFrame(workflow, ctx, { baseRootDir });
    console.log(JSON.stringify(snap, null, 2));
    process.exit(0);
  }

  if (cmd === "revert") {
    const workflowPath = args._[0];
    if (!workflowPath) {
      console.error("Missing workflow path");
      process.exit(4);
    }
    const runId = args["run-id"];
    const nodeId = args["node-id"];
    const attempt =
      args.attempt !== undefined
        ? parseIntegerOrExit(args.attempt, "attempt", 1)
        : 1;
    const iteration =
      args.iteration !== undefined
        ? parseIntegerOrExit(args.iteration, "iteration", 0)
        : 0;
    if (!runId || !nodeId) {
      console.error("Missing --run-id or --node-id");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const result = await revertToAttempt(adapter, {
      runId,
      nodeId,
      iteration,
      attempt,
      onProgress: (e) => console.log(JSON.stringify(e)),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  }

  if (cmd === "cancel") {
    const workflowPath = args._[0];
    const runId = args["run-id"];
    if (!workflowPath || !runId) {
      console.error("Missing workflow path or --run-id");
      process.exit(4);
    }
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const run = await adapter.getRun(runId);
    if (!run) {
      console.error(`Run not found: ${runId}`);
      process.exit(4);
    }
    if (run.status !== "running" && run.status !== "waiting-approval") {
      console.error(`Run is not active (status: ${run.status})`);
      process.exit(4);
    }
    // Cancel all in-progress attempts
    const inProgress = await adapter.listInProgressAttempts(runId);
    const now = Date.now();
    for (const attempt of inProgress) {
      await adapter.updateAttempt(
        runId,
        attempt.nodeId,
        attempt.iteration,
        attempt.attempt,
        {
          state: "cancelled",
          finishedAtMs: now,
        },
      );
    }
    // Mark run as cancelled
    await adapter.updateRun(runId, { status: "cancelled", finishedAtMs: now });
    console.log(
      JSON.stringify(
        { runId, status: "cancelled", cancelledAttempts: inProgress.length },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
