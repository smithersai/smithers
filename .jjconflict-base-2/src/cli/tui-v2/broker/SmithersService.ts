import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAvailableAgents } from "../../cli/agent-detection.js";
import { findSmithersDb, openSmithersDb } from "../../cli/find-db.js";
import { discoverWorkflows, type DiscoveredWorkflow } from "../../cli/workflows.js";
import { approveNode, denyNode } from "../../engine/approvals.js";
import type { SmithersDb } from "../../db/adapter.js";
import type { ApprovalSummary } from "../shared/types.js";

type DbHandle = {
  adapter: SmithersDb;
  cleanup: () => void;
  dbPath: string;
};

function parseTrailingJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [trimmed];
  const lastObjectStart = trimmed.lastIndexOf("\n{");
  const lastArrayStart = trimmed.lastIndexOf("\n[");
  if (lastObjectStart >= 0) candidates.push(trimmed.slice(lastObjectStart + 1));
  if (lastArrayStart >= 0) candidates.push(trimmed.slice(lastArrayStart + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore parse misses
    }
  }

  return undefined;
}

export class SmithersService {
  private dbHandle: DbHandle | null = null;
  private readonly cliPath = fileURLToPath(new URL("../../index.ts", import.meta.url));

  constructor(
    private readonly rootDir: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  close() {
    this.dbHandle?.cleanup();
    this.dbHandle = null;
  }

  discoverWorkflows(): DiscoveredWorkflow[] {
    return discoverWorkflows(this.rootDir);
  }

  async getDb(): Promise<DbHandle | null> {
    const path = this.resolveDbPath();
    if (!path) {
      this.close();
      return null;
    }
    if (this.dbHandle?.dbPath === path) {
      return this.dbHandle;
    }
    this.close();
    const { adapter, cleanup } = await openSmithersDb(path);
    this.dbHandle = { adapter, cleanup, dbPath: path };
    return this.dbHandle;
  }

  async listRuns(limit = 100) {
    const handle = await this.getDb();
    if (!handle) return [];
    return handle.adapter.listRuns(limit);
  }

  async getRun(runId: string) {
    const handle = await this.getDb();
    if (!handle) return null;
    return handle.adapter.getRun(runId);
  }

  async listNodes(runId: string) {
    const handle = await this.getDb();
    if (!handle) return [];
    return handle.adapter.listNodes(runId);
  }

  async listEvents(runId: string, afterSeq: number, limit = 200) {
    const handle = await this.getDb();
    if (!handle) return [];
    return handle.adapter.listEvents(runId, afterSeq, limit);
  }

  async listPendingApprovals(runId: string) {
    const handle = await this.getDb();
    if (!handle) return [];
    return handle.adapter.listPendingApprovals(runId);
  }

  async approve(approval: ApprovalSummary) {
    const handle = await this.getDb();
    if (!handle) return;
    await approveNode(
      handle.adapter,
      approval.runId,
      approval.nodeId,
      approval.iteration,
      "approved from Smithers TUI v2",
      "smithers-tui-v2",
    );
  }

  async deny(approval: ApprovalSummary) {
    const handle = await this.getDb();
    if (!handle) return;
    await denyNode(
      handle.adapter,
      approval.runId,
      approval.nodeId,
      approval.iteration,
      "denied from Smithers TUI v2",
      "smithers-tui-v2",
    );
  }

  availableAgents() {
    return detectAvailableAgents().filter((agent) => agent.usable);
  }

  async launchWorkflow(workflow: DiscoveredWorkflow, prompt: string | null) {
    const args = ["run", this.cliPath, "up", workflow.entryFile, "-d", "--format", "json"];
    if (prompt && prompt.trim().length > 0) {
      args.push("--input", JSON.stringify({ prompt: prompt.trim() }));
    }

    const proc = Bun.spawn(["bun", ...args], {
      cwd: this.rootDir,
      env: this.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const parsed = parseTrailingJson(stdout) as
      | { data?: { runId?: string } }
      | undefined;

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || "Workflow launch failed");
    }

    return {
      runId: parsed?.data?.runId ?? `run-${Date.now()}`,
      stdout,
      stderr,
    };
  }

  async startAssistantTurn(prompt: string) {
    const proc = Bun.spawn(["bun", "run", this.cliPath, "ask", prompt], {
      cwd: this.rootDir,
      env: this.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc;
  }

  private resolveDbPath(): string | null {
    try {
      return findSmithersDb(this.rootDir);
    } catch {
      const fallback = resolve(this.rootDir, "smithers.db");
      return existsSync(fallback) ? fallback : null;
    }
  }
}
