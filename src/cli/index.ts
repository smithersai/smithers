#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runWorkflow, renderFrame } from "../engine";
import { approveNode, denyNode } from "../engine/approvals";
import { SmithersDb } from "../db/adapter";
import { ensureSmithersTables } from "../db/ensure";
import { loadInput, loadOutputs } from "../db/snapshot";
import { buildContext } from "../context";
import type { SmithersWorkflow } from "../types";

async function loadWorkflow(path: string): Promise<SmithersWorkflow<any>> {
  const abs = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(abs).href);
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function parseArgs(argv: string[]) {
  const args: Record<string, any> = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i] : true;
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
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const input = args.input ? JSON.parse(args.input) : {};
    const runId = args["run-id"]; 
    const resume = cmd === "resume" || Boolean(args.resume);
    const result = await runWorkflow(workflow, { input, runId, resume, maxConcurrency: args["max-concurrency"] ? Number(args["max-concurrency"]) : undefined });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === "finished" ? 0 : result.status === "waiting-approval" ? 3 : result.status === "cancelled" ? 2 : 1);
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
    if (cmd === "approve") {
      await approveNode(adapter, runId, nodeId, Number(args.iteration ?? 0), args.note, args["decided-by"]);
    } else {
      await denyNode(adapter, runId, nodeId, Number(args.iteration ?? 0), args.note, args["decided-by"]);
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
    const frames = await adapter.listFrames(runId, Number(args.tail ?? 20));
    console.log(JSON.stringify(frames, null, 2));
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
    const schema = (workflow.db as any)?._?.schema ?? (workflow.db as any)?.schema ?? {};
    const inputTable = schema.input;
    const inputRow = inputTable ? await loadInput(workflow.db as any, inputTable, runId) : {};
    const outputs = await loadOutputs(workflow.db as any, schema, runId);
    const ctx = buildContext({ runId, iteration: 0, input: inputRow, outputs });
    const snap = await renderFrame(workflow, ctx);
    console.log(JSON.stringify(snap, null, 2));
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
