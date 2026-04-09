#!/usr/bin/env bun
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, openSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, Fiber } from "effect";
import { Cli, Mcp as IncurMcp, z } from "incur";
import { runWorkflow, renderFrame, resolveSchema } from "../engine";
import { mdxPlugin } from "../mdx-plugin";
import { approveNode, denyNode } from "../engine/approvals";
import { signalRun } from "../engine/signals";
import { loadInput, loadOutputs } from "../db/snapshot";
import { ensureSmithersTables } from "../db/ensure";
import { SmithersDb } from "../db/adapter";
import { buildContext } from "../context";
import { fromPromise } from "../effect/interop";
import { runFork, runPromise } from "../effect/runtime";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import { trackEvent } from "../effect/metrics";
import {
  buildUrl,
  ensureServerRunning,
  openInBrowser,
  resolveUiHost,
  resolveUiPort,
  shouldSuppressAutoOpen,
} from "./ui";
import type { UiTarget } from "./ui";

import { revertToAttempt } from "../revert";
import { retryTask } from "../retry-task";
import { timeTravel } from "../timetravel";
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
import {
  buildHijackLaunchSpec,
  isNativeHijackCandidate,
  launchHijackSession,
  resolveHijackCandidate,
  waitForHijackCandidate,
} from "./hijack";
import {
  launchConversationHijackSession,
  persistConversationHijackHandoff,
} from "./hijack-session";
import {
  colorizeEventText,
  formatAge,
  formatElapsedCompact,
  formatEventLine,
  formatRelativeOffset,
} from "./format";
import {
  EVENT_CATEGORY_VALUES,
  eventTypesForCategory,
  normalizeEventCategory,
} from "./event-categories";
import {
  aggregateNodeDetailEffect,
  renderNodeDetailHuman,
} from "./node-detail";
import {
  diagnoseRunEffect,
  diagnosisCtaCommands,
  renderWhyDiagnosisHuman,
} from "./why-diagnosis";
import { detectAvailableAgents } from "./agent-detection";
import { initWorkflowPack, getWorkflowFollowUpCtas } from "./workflow-pack";
import { discoverWorkflows, resolveWorkflow, createWorkflowFile } from "./workflows";
import { ask } from "./ask";
import { runScheduler } from "./scheduler";
import { resumeRunDetached } from "./resume-detached";
import {
  parseDurationMs,
  supervisorLoopEffect,
} from "./supervisor";
import {
  WATCH_MIN_INTERVAL_MS,
  runWatchLoop,
  watchIntervalSecondsToMs,
} from "./watch";
import { createSemanticMcpServer } from "../mcp/semantic-server";
import pc from "picocolors";
import crypto from "node:crypto";

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
  if (
    status === "waiting-approval" ||
    status === "waiting-event" ||
    status === "waiting-timer"
  ) {
    return 3;
  }
  if (status === "cancelled") return 2;
  return 1;
}

function parseUiTarget(
  targetRaw: string | undefined,
  valueRaw: string | undefined,
): { ok: true; target: UiTarget } | { ok: false; error: string } {
  const target = targetRaw?.trim().toLowerCase();
  const value = valueRaw?.trim();

  if (!target) {
    if (value) {
      return {
        ok: false,
        error: `Unexpected argument: ${value}`,
      };
    }

    return {
      ok: true,
      target: { kind: "dashboard" },
    };
  }

  if (target === "approvals") {
    if (value) {
      return {
        ok: false,
        error: `Unexpected argument for smithers ui approvals: ${value}`,
      };
    }

    return {
      ok: true,
      target: { kind: "approvals" },
    };
  }

  if (target === "run") {
    if (!value) {
      return {
        ok: false,
        error: "Missing run ID for smithers ui run <run-id>",
      };
    }

    return {
      ok: true,
      target: { kind: "run", runId: value },
    };
  }

  if (target === "node") {
    if (!value) {
      return {
        ok: false,
        error: "Missing run/node target for smithers ui node <run-id>/<node-id>",
      };
    }

    const separatorIndex = value.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
      return {
        ok: false,
        error: "Invalid node target. Expected <run-id>/<node-id>",
      };
    }

    return {
      ok: true,
      target: {
        kind: "node",
        runId: value.slice(0, separatorIndex),
        nodeId: value.slice(separatorIndex + 1),
      },
    };
  }

  return {
    ok: false,
    error: `Unknown UI target: ${target}`,
  };
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
      case "NodeWaitingTimer":
        process.stderr.write(
          `[${ts}] ⏱ ${event.nodeId} waiting for timer (fires ${new Date(event.firesAtMs).toISOString()})\n`,
        );
        break;
      case "TimerCreated":
        process.stderr.write(
          `[${ts}] ⏱ Timer created: ${event.timerId} (fires ${new Date(event.firesAtMs).toISOString()})\n`,
        );
        break;
      case "TimerFired":
        process.stderr.write(
          `[${ts}] 🔔 Timer fired: ${event.timerId} (delay ${event.delayMs}ms)\n`,
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
      case "RetryTaskStarted":
        process.stderr.write(
          `[${ts}] ↻ retrying ${event.nodeId} (reset: ${(event.resetNodes ?? []).join(", ") || event.nodeId})\n`,
        );
        break;
      case "RetryTaskFinished":
        process.stderr.write(
          `[${ts}] ${event.success ? "✓" : "✗"} retry reset ${event.success ? "finished" : "failed"} for ${event.nodeId}${event.error ? `: ${event.error}` : ""}\n`,
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

type WaitingTimerInfo = {
  nodeId: string;
  iteration: number;
  firesAtMs: number;
  timerType: "duration" | "absolute";
};

function parseWaitingTimerInfo(metaJson?: string | null): WaitingTimerInfo | null {
  if (!metaJson) return null;
  try {
    const parsed = JSON.parse(metaJson);
    const timer = parsed?.timer;
    if (!timer || typeof timer !== "object") return null;
    const nodeId = typeof timer.timerId === "string" ? timer.timerId : null;
    const firesAtMs = Number(timer.firesAtMs);
    if (!nodeId || !Number.isFinite(firesAtMs)) return null;
    return {
      nodeId,
      iteration: 0,
      firesAtMs: Math.floor(firesAtMs),
      timerType: timer.timerType === "absolute" ? "absolute" : "duration",
    };
  } catch {
    return null;
  }
}

function formatRemainingTimer(ms: number): string {
  if (ms <= 0) return "due now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

async function listWaitingTimers(adapter: SmithersDb, runId: string) {
  const nodes = await adapter.listNodes(runId);
  const waits: Array<WaitingTimerInfo & { iteration: number }> = [];

  for (const node of nodes as any[]) {
    if (node.state !== "waiting-timer") continue;
    const attempts = await adapter.listAttempts(
      runId,
      node.nodeId,
      node.iteration ?? 0,
    );
    const waitingAttempt =
      (attempts as any[]).find((attempt) => attempt.state === "waiting-timer") ??
      (attempts as any[])[0];
    const parsed = parseWaitingTimerInfo(waitingAttempt?.metaJson);
    if (!parsed) continue;
    waits.push({
      ...parsed,
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
    });
  }

  waits.sort((left, right) => left.firesAtMs - right.firesAtMs);
  return waits;
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

function isRunStatusTerminal(status: string | null | undefined) {
  return (
    status !== "running" &&
    status !== "waiting-approval" &&
    status !== "waiting-timer" &&
    status !== "waiting-event"
  );
}

function writeWatchOutput(
  format: string | undefined,
  payload: unknown,
  human?: string,
) {
  if (format === "jsonl") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (human !== undefined) {
    process.stdout.write(`${human}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function resolveWatchIntervalMsOrFail(
  command: string,
  intervalSeconds: number,
  fail: FailFn,
) {
  try {
    const intervalMs = watchIntervalSecondsToMs(intervalSeconds);
    if (intervalMs !== intervalSeconds * 1_000) {
      process.stderr.write(
        `[smithers] --interval clamped to ${WATCH_MIN_INTERVAL_MS}ms for ${command} watch mode\n`,
      );
    }
    return intervalMs;
  } catch (error: any) {
    return fail({
      code: "INVALID_WATCH_INTERVAL",
      message: error?.message ?? String(error),
      exitCode: 4,
    });
  }
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

async function listAncestryRunIds(
  adapter: SmithersDb,
  runId: string,
): Promise<string[]> {
  const ancestry = await adapter.listRunAncestry(runId, 10_000);
  if (!ancestry || ancestry.length === 0) return [runId];
  // listRunAncestry returns [current, parent, grandparent, ...]
  return (ancestry as any[]).map((row) => row.runId);
}

async function* streamRunEventsCommand(c: any) {
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

    const includeAncestry = Boolean(c.options.followAncestry);
    const lineageCurrentToRoot = includeAncestry
      ? await listAncestryRunIds(adapter, c.args.runId)
      : [c.args.runId];
    const lineageRootToCurrent = [...lineageCurrentToRoot].reverse();
    const runOrder = new Map(
      lineageRootToCurrent.map((runId: string, index: number) => [runId, index]),
    );

    const lineageRuns = await Promise.all(
      lineageRootToCurrent.map((lineageRunId: string) =>
        adapter!.getRun(lineageRunId),
      ),
    );
    const firstLineageRun = lineageRuns.find((entry) => Boolean(entry));
    const baseMs =
      (firstLineageRun as any)?.startedAtMs ??
      (firstLineageRun as any)?.createdAtMs ??
      (run as any).startedAtMs ??
      (run as any).createdAtMs ??
      Date.now();

    const formatLine = (event: any) => {
      const line = formatEventLine(event, baseMs);
      if (!includeAncestry) return line;
      const runPrefix = String(event.runId ?? "").slice(0, 12);
      return `${runPrefix} ${line}`;
    };

    let lastSeq = c.options.since ?? -1;

    if (!includeAncestry && c.options.since === undefined) {
      const lastEventSeq = await adapter.getLastEventSeq(c.args.runId);
      if (lastEventSeq !== undefined) {
        lastSeq = Math.max(-1, lastEventSeq - c.options.tail);
      }
    }

    let initialEvents: any[] = [];
    if (includeAncestry) {
      const merged: any[] = [];
      for (const lineageRunId of lineageRootToCurrent) {
        const events = await listAllEvents(adapter, lineageRunId);
        for (const event of events as any[]) {
          merged.push({ ...event, runId: lineageRunId });
        }
      }
      merged.sort((left, right) => {
        if (left.timestampMs !== right.timestampMs) {
          return left.timestampMs - right.timestampMs;
        }
        const leftOrder = runOrder.get(left.runId) ?? 0;
        const rightOrder = runOrder.get(right.runId) ?? 0;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return (left.seq ?? 0) - (right.seq ?? 0);
      });
      initialEvents =
        c.options.since !== undefined
          ? merged.filter((event) => (event.seq ?? -1) > c.options.since)
          : merged.slice(-c.options.tail);
      const lastCurrentEvent = [...initialEvents]
        .reverse()
        .find((event) => event.runId === c.args.runId);
      lastSeq = lastCurrentEvent?.seq ?? -1;
    } else {
      initialEvents = await adapter.listEvents(c.args.runId, lastSeq, 1000);
      for (const event of initialEvents as any[]) {
        lastSeq = event.seq;
      }
    }

    for (const event of initialEvents as any[]) {
      yield formatLine(event);
      if (!includeAncestry) {
        lastSeq = event.seq;
      } else if (event.runId === c.args.runId) {
        lastSeq = event.seq;
      }
    }

    const isActive =
      (run as any).status === "running" ||
      (run as any).status === "waiting-approval" ||
      (run as any).status === "waiting-event" ||
      (run as any).status === "waiting-timer";
    if (!c.options.follow || !isActive) {
      return c.ok(undefined, {
        cta: {
          commands: [{ command: `inspect ${c.args.runId}`, description: "Inspect run state" }],
        },
      });
    }

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      const newEvents = await adapter.listEvents(c.args.runId, lastSeq, 200);
      for (const event of newEvents as any[]) {
        yield formatLine(event);
        lastSeq = event.seq;
      }

      const currentRun = await adapter.getRun(c.args.runId);
      const currentStatus = (currentRun as any)?.status;
      if (
        currentStatus !== "running" &&
        currentStatus !== "waiting-approval" &&
        currentStatus !== "waiting-event" &&
        currentStatus !== "waiting-timer"
      ) {
        const finalEvents = await adapter.listEvents(c.args.runId, lastSeq, 1000);
        for (const event of finalEvents as any[]) {
          yield formatLine(event);
          lastSeq = event.seq;
        }

        const ctaCommands: any[] = [
          { command: `inspect ${c.args.runId}`, description: "Inspect run state" },
        ];
        if (currentStatus === "waiting-approval") {
          ctaCommands.push({ command: `approve ${c.args.runId}`, description: "Approve run" });
        }
        if (currentStatus === "waiting-event") {
          ctaCommands.push({ command: `why ${c.args.runId}`, description: "Explain signal wait" });
        }
        if (currentStatus === "waiting-timer") {
          ctaCommands.push({ command: `why ${c.args.runId}`, description: "Explain timer wait" });
        }
        return c.ok(undefined, { cta: { commands: ctaCommands } });
      }
    }
  } finally {
    cleanup?.();
  }
}

const DEFAULT_EVENTS_LIMIT = 1_000;
const MAX_EVENTS_LIMIT = 100_000;
const EVENTS_PAGE_SIZE = 1_000;

type EventHistoryRow = {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payloadJson: string;
};

type EventGroupBy = "node" | "attempt";

type NormalizedEventsQuery = {
  nodeId?: string;
  typeName?: string;
  eventTypes?: readonly string[];
  sinceTimestampMs?: number;
  groupBy?: EventGroupBy;
  json: boolean;
  limit: number;
  defaultLimitUsed: boolean;
  limitCapped: boolean;
};

function parseEventPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed payloads
  }
  return {};
}

function parseEventNumber(value: unknown): number | null {
  const asNumber =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(asNumber)) return null;
  return Math.floor(asNumber);
}

function normalizeEventGroupBy(
  groupByRaw: string | undefined,
): EventGroupBy | undefined {
  if (!groupByRaw) return undefined;
  const normalized = groupByRaw.trim().toLowerCase();
  if (normalized === "node" || normalized === "attempt") {
    return normalized;
  }
  throw new SmithersError(
    "INVALID_GROUP_BY",
    `Invalid --group-by value "${groupByRaw}". Use "node" or "attempt".`,
  );
}

function normalizeEventsLimit(limit: number | undefined): {
  value: number;
  defaultLimitUsed: boolean;
  limitCapped: boolean;
} {
  if (limit === undefined) {
    return {
      value: DEFAULT_EVENTS_LIMIT,
      defaultLimitUsed: true,
      limitCapped: false,
    };
  }
  if (limit > MAX_EVENTS_LIMIT) {
    return {
      value: MAX_EVENTS_LIMIT,
      defaultLimitUsed: false,
      limitCapped: true,
    };
  }
  return {
    value: limit,
    defaultLimitUsed: false,
    limitCapped: false,
  };
}

function buildEventHistoryLine(event: EventHistoryRow, baseMs: number): string {
  const seqLabel = `#${event.seq + 1}`;
  const offset = formatRelativeOffset(baseMs, event.timestampMs);
  const typeText = event.type.padEnd(20, " ");
  const coloredType = colorizeEventText(event.type, typeText);
  const summary = formatEventLine(event, baseMs, {
    includeTimestamp: false,
    truncatePayloadAt: 220,
  });
  return `${seqLabel}  ${offset}  ${coloredType}  ${summary}`;
}

function buildEventNdjsonLine(event: EventHistoryRow): string {
  const payload = parseEventPayload(event.payloadJson);
  return JSON.stringify({
    runId: event.runId,
    seq: event.seq,
    timestampMs: event.timestampMs,
    type: event.type,
    payload,
  });
}

function eventNodeGroupLabel(event: EventHistoryRow): string {
  const payload = parseEventPayload(event.payloadJson);
  const nodeId = payload.nodeId;
  if (typeof nodeId === "string" && nodeId.length > 0) return nodeId;
  return "(run)";
}

function eventAttemptGroupLabel(event: EventHistoryRow): {
  nodeLabel: string;
  attemptLabel: string;
} {
  const payload = parseEventPayload(event.payloadJson);
  const nodeLabel = eventNodeGroupLabel(event);
  const attempt = parseEventNumber(payload.attempt);
  const iteration = parseEventNumber(payload.iteration);
  if (attempt === null && iteration === null) {
    return {
      nodeLabel,
      attemptLabel: "Attempt ?",
    };
  }
  if (iteration === null) {
    return {
      nodeLabel,
      attemptLabel: `Attempt ${attempt ?? "?"}`,
    };
  }
  return {
    nodeLabel,
    attemptLabel: `Attempt ${attempt ?? "?"} (iteration ${iteration})`,
  };
}

function renderGroupedEvents(
  events: EventHistoryRow[],
  baseMs: number,
  groupBy: EventGroupBy,
): string[] {
  const lines: string[] = [];

  if (groupBy === "node") {
    const order: string[] = [];
    const grouped = new Map<string, EventHistoryRow[]>();
    for (const event of events) {
      const key = eventNodeGroupLabel(event);
      if (!grouped.has(key)) {
        grouped.set(key, []);
        order.push(key);
      }
      grouped.get(key)!.push(event);
    }
    for (const key of order) {
      if (lines.length > 0) lines.push("");
      lines.push(pc.bold(`node: ${key}`));
      const bucket = grouped.get(key) ?? [];
      for (const event of bucket) {
        lines.push(`  ${buildEventHistoryLine(event, baseMs)}`);
      }
    }
    return lines;
  }

  const nodeOrder: string[] = [];
  const nodeBuckets = new Map<
    string,
    { attemptOrder: string[]; attempts: Map<string, EventHistoryRow[]> }
  >();

  for (const event of events) {
    const { nodeLabel, attemptLabel } = eventAttemptGroupLabel(event);
    if (!nodeBuckets.has(nodeLabel)) {
      nodeBuckets.set(nodeLabel, { attemptOrder: [], attempts: new Map() });
      nodeOrder.push(nodeLabel);
    }
    const entry = nodeBuckets.get(nodeLabel)!;
    if (!entry.attempts.has(attemptLabel)) {
      entry.attempts.set(attemptLabel, []);
      entry.attemptOrder.push(attemptLabel);
    }
    entry.attempts.get(attemptLabel)!.push(event);
  }

  for (const nodeLabel of nodeOrder) {
    const nodeEntry = nodeBuckets.get(nodeLabel);
    if (!nodeEntry) continue;
    if (lines.length > 0) lines.push("");
    lines.push(pc.bold(`node: ${nodeLabel}`));
    for (const attemptLabel of nodeEntry.attemptOrder) {
      lines.push(pc.bold(`  ${attemptLabel}`));
      const bucket = nodeEntry.attempts.get(attemptLabel) ?? [];
      for (const event of bucket) {
        lines.push(`    ${buildEventHistoryLine(event, baseMs)}`);
      }
    }
  }

  return lines;
}

async function queryEventHistoryPage(
  adapter: SmithersDb,
  runId: string,
  query: {
    afterSeq: number;
    nodeId?: string;
    eventTypes?: readonly string[];
    sinceTimestampMs?: number;
    limit: number;
  },
) {
  return runPromise(
    adapter.listEventHistoryEffect(runId, {
      afterSeq: query.afterSeq,
      nodeId: query.nodeId,
      sinceTimestampMs: query.sinceTimestampMs,
      types: query.eventTypes,
      limit: query.limit,
    }).pipe(
      Effect.annotateLogs({
        runId,
        filters: {
          nodeId: query.nodeId,
          sinceTimestampMs: query.sinceTimestampMs,
          eventTypes: query.eventTypes,
          afterSeq: query.afterSeq,
          limit: query.limit,
        },
      }),
      Effect.withLogSpan("cli:events"),
    ),
  ) as Promise<EventHistoryRow[]>;
}

async function countEventHistory(
  adapter: SmithersDb,
  runId: string,
  query: {
    nodeId?: string;
    eventTypes?: readonly string[];
    sinceTimestampMs?: number;
  },
) {
  return runPromise(
    adapter.countEventHistoryEffect(runId, {
      nodeId: query.nodeId,
      sinceTimestampMs: query.sinceTimestampMs,
      types: query.eventTypes,
    }).pipe(
      Effect.annotateLogs({
        runId,
        filters: {
          nodeId: query.nodeId,
          sinceTimestampMs: query.sinceTimestampMs,
          eventTypes: query.eventTypes,
        },
      }),
      Effect.withLogSpan("cli:events"),
    ),
  );
}

type PsRow = {
  id: string;
  workflow: string;
  status: string;
  step: string;
  timer?: {
    id: string;
    iteration: number;
    firesAt: string;
    remaining: string;
  };
  started: string;
};

async function buildPsRows(
  adapter: SmithersDb,
  limit: number,
  status: string | undefined,
): Promise<PsRow[]> {
  const runs = await adapter.listRuns(limit, status);
  const rows: PsRow[] = [];

  for (const run of runs as any[]) {
    const nodes = await adapter.listNodes(run.runId);
    const activeNode = (nodes as any[]).find((n: any) => n.state === "in-progress");
    const waitingTimers =
      run.status === "waiting-timer"
        ? await listWaitingTimers(adapter, run.runId)
        : [];
    const nextTimer = waitingTimers[0];

    rows.push({
      id: run.runId,
      workflow: run.workflowName ?? (run.workflowPath ? basename(run.workflowPath) : "—"),
      status: run.status,
      step:
        nextTimer
          ? `timer:${nextTimer.nodeId}`
          : activeNode?.label ?? activeNode?.nodeId ?? "—",
      ...(nextTimer
        ? {
            timer: {
              id: nextTimer.nodeId,
              iteration: nextTimer.iteration,
              firesAt: new Date(nextTimer.firesAtMs).toISOString(),
              remaining: formatRemainingTimer(nextTimer.firesAtMs - Date.now()),
            },
          }
        : {}),
      started: run.startedAtMs
        ? formatAge(run.startedAtMs)
        : run.createdAtMs
          ? formatAge(run.createdAtMs)
          : "—",
    });
  }

  return rows;
}

function buildPsCtaCommands(rows: PsRow[]) {
  const ctaCommands: any[] = [];
  const firstActive = rows.find((r) => r.status === "running");
  const firstWaitingApproval = rows.find((r) => r.status === "waiting-approval");
  const firstWaitingTimer = rows.find((r) => r.status === "waiting-timer");
  if (firstActive) {
    ctaCommands.push({ command: `logs ${firstActive.id}`, description: "Tail active run" });
    ctaCommands.push({ command: `chat ${firstActive.id} --follow`, description: "Watch agent chat" });
  }
  if (firstWaitingApproval) {
    ctaCommands.push({ command: `approve ${firstWaitingApproval.id}`, description: "Approve waiting run" });
  }
  if (firstWaitingTimer) {
    ctaCommands.push({ command: `why ${firstWaitingTimer.id}`, description: "Explain timer wait" });
  }
  if (rows.length > 0) {
    ctaCommands.push({ command: `inspect ${rows[0].id}`, description: "Inspect most recent run" });
  }
  return ctaCommands;
}

type InspectSnapshot = {
  result: Record<string, any>;
  ctaCommands: any[];
  status: string | undefined;
};

async function buildInspectSnapshot(
  adapter: SmithersDb,
  runId: string,
): Promise<InspectSnapshot> {
  const run = await adapter.getRun(runId);
  if (!run) {
    throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`);
  }

  const r = run as any;
  const nodes = await adapter.listNodes(runId);
  const approvals = await adapter.listPendingApprovals(runId);
  const waitingTimers = await listWaitingTimers(adapter, runId);
  const loops = await adapter.listRalph(runId);
  const ancestry = await adapter.listRunAncestry(runId, 1_000);
  const continuedFromRunIds = (ancestry as any[]).slice(1).map((row: any) => row.runId);
  const lineagePageSize = 100;
  const continuedFromVisible = continuedFromRunIds.slice(0, lineagePageSize);
  const continuedFromRemaining =
    continuedFromRunIds.length > lineagePageSize
      ? continuedFromRunIds.length - lineagePageSize
      : 0;

  let activeDescendantRunId: string | undefined;
  {
    const seen = new Set<string>([runId]);
    let cursor = runId;
    while (true) {
      const child = await adapter.getLatestChildRun(cursor);
      if (!child || !child.runId || seen.has(child.runId)) break;
      activeDescendantRunId = child.runId;
      seen.add(child.runId);
      cursor = child.runId;
    }
  }

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
    try {
      config = JSON.parse(r.configJson);
    } catch {}
  }

  let error: any = undefined;
  if (r.errorJson) {
    try {
      error = JSON.parse(r.errorJson);
    } catch {}
  }

  const result: Record<string, any> = {
    run: {
      id: r.runId,
      workflow: r.workflowName ?? (r.workflowPath ? basename(r.workflowPath) : "—"),
      status: r.status,
      ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}),
      started: r.startedAtMs ? new Date(r.startedAtMs).toISOString() : "—",
      elapsed: r.startedAtMs ? formatElapsedCompact(r.startedAtMs, r.finishedAtMs ?? undefined) : "—",
      ...(r.finishedAtMs ? { finished: new Date(r.finishedAtMs).toISOString() } : {}),
      ...(activeDescendantRunId && activeDescendantRunId !== r.runId
        ? { activeDescendantRunId }
        : {}),
      ...(error ? { error } : {}),
    },
    steps,
  };

  if (continuedFromVisible.length > 0) {
    result.run.continuedFrom = continuedFromVisible;
    result.run.continuedFromDisplay = [
      ...continuedFromVisible,
      ...(continuedFromRemaining > 0
        ? [`... (${continuedFromRemaining} more)`]
        : []),
    ].join(" -> ");
  }

  if (pendingApprovals.length > 0) {
    result.approvals = pendingApprovals;
  }
  if (waitingTimers.length > 0) {
    result.timers = waitingTimers.map((timer) => ({
      timerId: timer.nodeId,
      iteration: timer.iteration,
      firesAt: new Date(timer.firesAtMs).toISOString(),
      remaining: formatRemainingTimer(timer.firesAtMs - Date.now()),
    }));
  }
  if (loopState.length > 0) {
    result.loops = loopState;
  }
  if (config) {
    result.config = config;
  }

  const ctaCommands: any[] = [
    { command: `logs ${runId}`, description: "Tail run logs" },
    { command: `chat ${runId}`, description: "View agent chat" },
  ];
  if (
    r.status === "running" ||
    r.status === "waiting-approval" ||
    r.status === "waiting-timer" ||
    r.status === "waiting-event"
  ) {
    ctaCommands.push({ command: `cancel ${runId}`, description: "Cancel run" });
  }
  if (pendingApprovals.length > 0) {
    ctaCommands.push({ command: `approve ${runId}`, description: "Approve pending gate" });
  }
  if (waitingTimers.length > 0) {
    ctaCommands.push({ command: `why ${runId}`, description: "Explain timer wait" });
  }

  return {
    result,
    ctaCommands,
    status: r.status,
  };
}

type NodeSnapshot = {
  detail: any;
  status: string | undefined;
};

async function buildNodeSnapshot(
  adapter: SmithersDb,
  options: {
    runId: string;
    nodeId: string;
    iteration: number | undefined;
  },
): Promise<NodeSnapshot> {
  const detail = await runPromise(
    aggregateNodeDetailEffect(adapter, {
      runId: options.runId,
      nodeId: options.nodeId,
      iteration: options.iteration,
    }),
  );
  const run = await adapter.getRun(options.runId);
  return {
    detail,
    status: (run as any)?.status,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const workflowArgs = z.object({
  workflow: z.string().describe("Path to a .tsx workflow file"),
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
  serve: z.boolean().default(false).describe("Start an HTTP server alongside the workflow"),
  supervise: z.boolean().default(false).describe("Run the stale-run supervisor loop (with --serve)"),
  superviseDryRun: z.boolean().default(false).describe("With --supervise, detect stale runs without resuming"),
  superviseInterval: z.string().default("10s").describe("With --supervise, poll interval (e.g. 10s, 30s)"),
  superviseStaleThreshold: z.string().default("30s").describe("With --supervise, stale heartbeat threshold"),
  superviseMaxConcurrent: z.number().int().min(1).default(3).describe("With --supervise, max runs resumed per poll"),
  port: z.number().int().min(1).default(7331).describe("HTTP server port (with --serve)"),
  host: z.string().default("127.0.0.1").describe("HTTP server bind address (with --serve)"),
  authToken: z.string().optional().describe("Bearer token for HTTP auth (or set SMITHERS_API_KEY)"),
  metrics: z.boolean().default(true).describe("Expose /metrics endpoint (with --serve)"),
});

const superviseOptions = z.object({
  dryRun: z.boolean().default(false).describe("Show which stale runs would be resumed, without acting"),
  interval: z.string().default("10s").describe("Poll interval (e.g. 10s, 30s, 1m)"),
  staleThreshold: z.string().default("30s").describe("Heartbeat staleness threshold before resume"),
  maxConcurrent: z.number().int().min(1).default(3).describe("Max runs resumed per poll"),
});

const psOptions = z.object({
  status: z.string().optional().describe("Filter by status: running, waiting-approval, waiting-event, waiting-timer, continued, finished, failed, cancelled"),
  limit: z.number().int().min(1).default(20).describe("Maximum runs to return"),
  all: z.boolean().default(false).describe("Include all statuses"),
  watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
  interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
});

const logsOptions = z.object({
  follow: z.boolean().default(true).describe("Keep tailing (default true for active runs)"),
  since: z.number().int().optional().describe("Start from event sequence number"),
  tail: z.number().int().min(1).default(50).describe("Show last N events first"),
  followAncestry: z.boolean().default(false).describe("Include events from ancestor runs (continuation lineage)"),
});

const eventsOptions = z.object({
  node: z.string().optional().describe("Filter events by node ID"),
  type: z.string().optional().describe(`Filter by event category (${[...EVENT_CATEGORY_VALUES].sort().join(", ")})`),
  since: z.string().optional().describe("Filter to a recent duration window (e.g. 5m, 2h)"),
  limit: z.number().int().min(1).optional().describe("Maximum events to display (default 1000, max 100000)"),
  json: z.boolean().default(false).describe("Output NDJSON for piping"),
  groupBy: z.string().optional().describe("Group output by \"node\" or \"attempt\""),
  watch: z.boolean().default(false).describe("Watch mode: append new events as they arrive"),
  interval: z.number().positive().default(2).describe("Watch poll interval in seconds"),
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

const inspectOptions = z.object({
  watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
  interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
});

const nodeArgs = z.object({
  nodeId: z.string().describe("Node ID to inspect"),
});

const nodeOptions = z.object({
  runId: z.string().describe("Run ID containing the node"),
  iteration: z.number().int().min(0).optional().describe("Loop iteration number (default: latest iteration)"),
  attempts: z.boolean().default(false).describe("Expand all attempts in human output"),
  tools: z.boolean().default(false).describe("Expand tool input/output payloads in human output"),
  watch: z.boolean().default(false).describe("Watch mode: refresh output continuously"),
  interval: z.number().positive().default(2).describe("Watch refresh interval in seconds"),
});

const whyArgs = z.object({
  runId: z.string().describe("Run ID to explain"),
});

const whyOptions = z.object({
  json: z.boolean().default(false).describe("Output structured JSON diagnosis"),
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

const signalArgs = z.object({
  runId: z.string().describe("Run ID containing the waiting signal"),
  signalName: z.string().describe("Signal name to deliver"),
});

const signalOptions = z.object({
  data: z.string().optional().describe("Signal payload as JSON (default: {})"),
  correlation: z.string().optional().describe("Correlation ID to match a specific waiter"),
  by: z.string().optional().describe("Name or identifier of the signal sender"),
});

const cancelArgs = z.object({
  runId: z.string().describe("Run ID to cancel"),
});

const hijackArgs = z.object({
  runId: z.string().describe("Run ID whose latest agent session should be hijacked"),
});

const hijackOptions = z.object({
  target: z.string().optional().describe("Expected agent engine (claude-code or codex)"),
  timeoutMs: z.number().int().min(1).default(30_000).describe("How long to wait for a live run to hand off"),
  launch: z.boolean().default(true).describe("Open the hijacked session immediately"),
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

const uiArgs = z.object({
  target: z.string().optional().describe("Deep-link target: run, node, or approvals"),
  value: z.string().optional().describe("run-id or run-id/node-id"),
});

const uiOptions = z.object({
  open: z.boolean().default(true).describe("Open the browser automatically (default: true)"),
  host: z.string().optional().describe("Override the Smithers UI bind host when auto-starting"),
  port: z.number().int().min(1).optional().describe("Override Smithers web port"),
});

const workflowPathArgs = z.object({
  name: z.string().describe("Workflow ID"),
});

const workflowDoctorArgs = z.object({
  name: z.string().optional().describe("Workflow ID"),
});

const workflowRunOptions = upOptions.extend({
  prompt: z.string().optional().describe("Prompt text mapped to input.prompt when --input is omitted"),
});

type UpCommandOptions = z.infer<typeof upOptions>;
type WorkflowRunCommandOptions = z.infer<typeof workflowRunOptions>;
type EventsCommandOptions = z.infer<typeof eventsOptions>;
type InspectCommandOptions = z.infer<typeof inspectOptions>;

type ResolvedSupervisorOptions = {
  dryRun: boolean;
  pollIntervalMs: number;
  staleThresholdMs: number;
  maxConcurrent: number;
};

function normalizeWorkflowRunOptions(
  options: WorkflowRunCommandOptions,
): UpCommandOptions {
  return {
    ...options,
    input:
      options.input ??
      (options.prompt !== undefined
        ? JSON.stringify({ prompt: options.prompt })
        : undefined),
    root: options.root ?? ".",
  };
}

function resolveSupervisorOptions(
  intervalRaw: string,
  staleThresholdRaw: string,
  maxConcurrent: number,
  dryRun: boolean,
) {
  const pollIntervalMs = parseDurationMs(intervalRaw, "interval");
  const staleThresholdMs = parseDurationMs(
    staleThresholdRaw,
    "stale-threshold",
  );
  return {
    dryRun,
    pollIntervalMs,
    staleThresholdMs,
    maxConcurrent,
  } satisfies ResolvedSupervisorOptions;
}

function normalizeEventsQuery(
  options: EventsCommandOptions,
): NormalizedEventsQuery {
  const jsonRequested =
    Boolean(options.json) || process.argv.includes("--json");
  const groupBy = normalizeEventGroupBy(options.groupBy);

  let typeName: string | undefined;
  let eventTypes: readonly string[] | undefined;
  if (options.type) {
    const category = normalizeEventCategory(options.type);
    if (!category) {
      throw new SmithersError(
        "INVALID_EVENT_TYPE_FILTER",
        `Invalid --type value "${options.type}". Allowed categories: ${[...EVENT_CATEGORY_VALUES].sort().join(", ")}`,
      );
    }
    typeName = category;
    eventTypes = eventTypesForCategory(category);
  }

  let sinceTimestampMs: number | undefined;
  if (options.since) {
    const sinceDurationMs = parseDurationMs(options.since, "since");
    sinceTimestampMs = Date.now() - sinceDurationMs;
  }

  const limitInfo = normalizeEventsLimit(options.limit);
  return {
    nodeId: options.node,
    typeName,
    eventTypes,
    sinceTimestampMs,
    groupBy,
    json: jsonRequested,
    limit: limitInfo.value,
    defaultLimitUsed: limitInfo.defaultLimitUsed,
    limitCapped: limitInfo.limitCapped,
  };
}

async function executeUpCommand(
  c: { ok: (...args: any[]) => any },
  workflowPath: string,
  options: UpCommandOptions,
  fail: FailFn,
) {
  try {
    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const input = parseJsonInput(options.input, "input", fail) ?? {};
    const runId = options.runId;
    const resume = Boolean(options.resume);

    // Detached mode: spawn ourselves as a background process
    if (options.detach) {
      const cliPath = new URL(import.meta.url).pathname;
      const childArgs = ["up", workflowPath];
      if (runId) childArgs.push("--run-id", runId);
      if (options.input) childArgs.push("--input", options.input);
      if (options.maxConcurrency) childArgs.push("--max-concurrency", String(options.maxConcurrency));
      if (options.root) childArgs.push("--root", options.root);
      if (!options.log) childArgs.push("--no-log");
      if (options.logDir) childArgs.push("--log-dir", options.logDir);
      if (options.allowNetwork) childArgs.push("--allow-network");
      if (options.maxOutputBytes) childArgs.push("--max-output-bytes", String(options.maxOutputBytes));
      if (options.toolTimeoutMs) childArgs.push("--tool-timeout-ms", String(options.toolTimeoutMs));
      if (options.hot) childArgs.push("--hot");
      if (resume) childArgs.push("--resume");
      if (options.force) childArgs.push("--force");
      if (options.serve) childArgs.push("--serve");
      if (options.supervise) childArgs.push("--supervise");
      if (options.superviseDryRun) childArgs.push("--supervise-dry-run");
      if (options.superviseInterval !== "10s") childArgs.push("--supervise-interval", options.superviseInterval);
      if (options.superviseStaleThreshold !== "30s") childArgs.push("--supervise-stale-threshold", options.superviseStaleThreshold);
      if (options.superviseMaxConcurrent !== 3) childArgs.push("--supervise-max-concurrent", String(options.superviseMaxConcurrent));
      if (options.serve && options.port !== 7331) childArgs.push("--port", String(options.port));
      if (options.serve && options.host !== "127.0.0.1") childArgs.push("--host", options.host);
      if (options.authToken) childArgs.push("--auth-token", options.authToken);
      if (options.serve && !options.metrics) childArgs.push("--metrics", "false");

      const logFileDir = options.logDir ?? dirname(resolvedWorkflowPath);
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

    if (options.hot) {
      process.env.SMITHERS_HOT = "1";
    }

    if (options.supervise && !options.serve) {
      return fail({
        code: "SUPERVISE_REQUIRES_SERVE",
        message:
          "--supervise on `smithers up` requires --serve. Use `smithers supervise` for standalone mode.",
        exitCode: 4,
      });
    }

    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    if (options.hot) {
      process.stderr.write(`[hot] Hot reload enabled\n`);
    }
    setupSqliteCleanup(workflow);

    const adapter = new SmithersDb(workflow.db as any);

    if (!resume) {
      const staleRuns = await adapter.listRuns(10, "running");
      if (staleRuns.length > 0) {
        process.stderr.write(`⚠ Found ${staleRuns.length} run(s) still marked as 'running':\n`);
        for (const r of staleRuns as any[]) {
          process.stderr.write(`  ${r.runId} (started ${new Date(r.startedAtMs ?? r.createdAtMs).toISOString()})\n`);
        }
        process.stderr.write("  Use 'smithers cancel' to mark them as cancelled, or 'smithers up --resume' to continue.\n");
      }
    }

    if (runId) {
      const existing = await adapter.getRun(runId);
      if (resume && !existing) {
        return fail({ code: "RUN_NOT_FOUND", message: `Run not found: ${runId}`, exitCode: 4 });
      }
      if (resume && existing?.status === "running" && !options.force) {
        return fail({ code: "RUN_STILL_RUNNING", message: `Run is still marked running: ${runId}. Use --force to resume anyway.`, exitCode: 4 });
      }
      if (!resume && existing) {
        return fail({ code: "RUN_EXISTS", message: `Run already exists: ${runId}`, exitCode: 4 });
      }
    }

    const rootDir = options.root ? resolve(process.cwd(), options.root) : dirname(resolvedWorkflowPath);
    const logDir = options.log ? options.logDir : null;
    const onProgress = buildProgressReporter();
    const abort = setupAbortSignal();

    if (options.serve) {
      let hostedSupervisor: ResolvedSupervisorOptions | null = null;
      if (options.supervise) {
        try {
          hostedSupervisor = resolveSupervisorOptions(
            options.superviseInterval,
            options.superviseStaleThreshold,
            options.superviseMaxConcurrent,
            options.superviseDryRun,
          );
        } catch (error: any) {
          return fail({
            code:
              error instanceof SmithersError
                ? error.code
                : "INVALID_SUPERVISOR_OPTIONS",
            message: error?.message ?? String(error),
            exitCode: 4,
          });
        }
      }

      const { createServeApp } = await import("../server/serve");
      const effectiveRunId = runId ?? `run-${Date.now()}`;
      const serveApp = createServeApp({
        workflow: workflow!,
        adapter: adapter!,
        runId: effectiveRunId,
        abort,
        authToken: options.authToken ?? process.env.SMITHERS_API_KEY,
        metrics: options.metrics,
      });

      const bunServer = Bun.serve({
        port: options.port,
        hostname: options.host,
        fetch: serveApp.fetch,
      });

      process.stderr.write(
        `[smithers] HTTP server listening on http://${options.host}:${bunServer.port}\n`,
      );

      const supervisorFiber = hostedSupervisor
        ? runFork(
            supervisorLoopEffect({
              adapter,
              dryRun: hostedSupervisor.dryRun,
              pollIntervalMs: hostedSupervisor.pollIntervalMs,
              staleThresholdMs: hostedSupervisor.staleThresholdMs,
              maxConcurrent: hostedSupervisor.maxConcurrent,
            }),
          )
        : null;

      if (hostedSupervisor) {
        process.stderr.write(
          `[smithers] Supervisor enabled (interval=${hostedSupervisor.pollIntervalMs}ms, staleThreshold=${hostedSupervisor.staleThresholdMs}ms, maxConcurrent=${hostedSupervisor.maxConcurrent}, dryRun=${hostedSupervisor.dryRun})\n`,
        );
      }

      const workflowPromise = runWorkflow(workflow!, {
        input,
        runId: effectiveRunId,
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

      workflowPromise.then((result) => {
        process.stderr.write(
          `[smithers] Workflow ${result.status}. Server still running — press Ctrl+C to stop.\n`,
        );
      }).catch((err) => {
        process.stderr.write(
          `[smithers] Workflow error: ${err?.message ?? String(err)}. Server still running.\n`,
        );
      });

      const result = await new Promise<any>((resolvePromise) => {
        const shutdown = async () => {
          abort.abort();
          bunServer.stop(true);
          if (supervisorFiber) {
            await runPromise(Fiber.interrupt(supervisorFiber)).catch(
              () => undefined,
            );
          }
          try {
            const r = await workflowPromise;
            resolvePromise(r);
          } catch {
            resolvePromise({ runId: effectiveRunId, status: "cancelled" });
          }
        };
        process.once("SIGINT", () => shutdown());
        process.once("SIGTERM", () => shutdown());
      });

      process.exitCode = formatStatusExitCode(result.status);
      return c.ok(result, {
        cta: result.runId ? {
          description: "Next steps:",
          commands: [
            ...getWorkflowFollowUpCtas(workflowPath),
            { command: `inspect ${result.runId}`, description: "Inspect run state" },
            { command: `logs ${result.runId}`, description: "View run logs" },
            { command: `chat ${result.runId}`, description: "View agent chat" },
          ],
        } : undefined,
      });
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
    return c.ok(result, {
      cta: result.runId ? {
        description: "Next steps:",
        commands: [
          ...getWorkflowFollowUpCtas(workflowPath),
          { command: `inspect ${result.runId}`, description: "Inspect run state" },
          { command: `logs ${result.runId}`, description: "View run logs" },
          { command: `chat ${result.runId}`, description: "View agent chat" },
        ],
      } : undefined,
    });
  } catch (err: any) {
    return fail({ code: "RUN_FAILED", message: err?.message ?? String(err), exitCode: 1 });
  }
}

const workflowCli = Cli.create({
  name: "workflow",
  description: "Discover local workflows from .smithers/workflows.",
})
  .command("run", {
    description: "Run a discovered workflow by ID.",
    args: workflowPathArgs,
    options: workflowRunOptions,
    alias: { detach: "d", runId: "r", input: "i", maxConcurrency: "c", prompt: "p" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const workflow = resolveWorkflow(c.args.name, process.cwd());
        return executeUpCommand(
          c,
          workflow.entryFile,
          normalizeWorkflowRunOptions(c.options),
          fail,
        );
      } catch (err: any) {
        if (err instanceof SmithersError) {
          return fail({
            code: err.code,
            message: err.message,
            exitCode: 4,
          });
        }
        return fail({
          code: "WORKFLOW_RUN_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
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

const cronPathArgs = z.object({
  pattern: z.string().describe("Cron execution pattern (e.g. '0 * * * *')"),
  workflowPath: z.string().describe("Path or ID of the workflow to schedule"),
});

// ---------------------------------------------------------------------------
// smithers memory ...
// ---------------------------------------------------------------------------

const memoryListArgs = z.object({
  namespace: z.string().describe("Namespace to list facts for (e.g. 'workflow:my-flow')"),
});
const memoryRecallArgs = z.object({
  query: z.string().describe("Search query for semantic recall"),
});
const memoryRecallOptions = z.object({
  namespace: z.string().default("global:default").describe("Namespace for recall"),
  workflow: z.string().describe("Path to a .tsx workflow file"),
  topK: z.number().int().min(1).default(5).describe("Number of results to return"),
});
const memoryListOptions = z.object({
  workflow: z.string().describe("Path to a .tsx workflow file"),
});

const memoryCli = Cli.create({
  name: "memory",
  description: "View and query cross-run memory facts and semantic recall.",
})
  .command("list", {
    description: "List all memory facts in a namespace.",
    args: memoryListArgs,
    options: memoryListOptions,
    alias: { workflow: "w" },
    async run(c) {
      try {
        const { createMemoryStore } = await import("../memory/store");
        const { parseNamespace } = await import("../memory/types");
        const workflow = await loadWorkflowAsync(c.options.workflow);
        ensureSmithersTables(workflow.db as any);
        setupSqliteCleanup(workflow);

        const store = createMemoryStore(workflow.db as any);
        const ns = parseNamespace(c.args.namespace);
        const facts = await store.listFacts(ns);
        if (facts.length === 0) {
          console.log(`No facts found in namespace "${c.args.namespace}".`);
          return c.ok({ facts: [], namespace: c.args.namespace });
        }
        for (const f of facts) {
          const value = f.valueJson.length > 100 ? f.valueJson.slice(0, 100) + "..." : f.valueJson;
          const age = formatAge(f.updatedAtMs);
          console.log(`  ${pc.bold(f.key)} = ${value}  ${pc.dim(`(${age})`)}`);
        }
        return c.ok({ facts, namespace: c.args.namespace });
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        return c.error({ code: "MEMORY_LIST_FAILED", message: err?.message ?? String(err) });
      }
    },
  })
  .command("recall", {
    description: "Search semantic memory by similarity.",
    args: memoryRecallArgs,
    options: memoryRecallOptions,
    alias: { workflow: "w", namespace: "n", topK: "k" },
    async run(c) {
      try {
        const { createSemanticMemory } = await import("../memory/semantic");
        const { parseNamespace } = await import("../memory/types");
        const { createSqliteVectorStore } = await import("../rag/vector-store");
        const { openai } = await import("@ai-sdk/openai");

        const workflow = await loadWorkflowAsync(c.options.workflow);
        ensureSmithersTables(workflow.db as any);
        setupSqliteCleanup(workflow);

        const vectorStore = createSqliteVectorStore(workflow.db);
        const semantic = createSemanticMemory(
          vectorStore,
          openai.embedding("text-embedding-3-small"),
        );

        const ns = parseNamespace(c.options.namespace);
        const results = await semantic.recall(ns, c.args.query, { topK: c.options.topK });
        if (results.length === 0) {
          console.log("No results found.");
          return c.ok({ query: c.args.query, namespace: c.options.namespace, results: [] });
        }
        for (const r of results) {
          const preview = r.chunk.content.replace(/\n/g, " ").slice(0, 120);
          console.log(`[${r.score.toFixed(4)}] ${preview}${r.chunk.content.length > 120 ? "..." : ""}`);
        }
        return c.ok({
          query: c.args.query,
          namespace: c.options.namespace,
          results: results.map((r) => ({
            score: r.score,
            content: r.chunk.content,
            metadata: r.metadata,
          })),
        });
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        return c.error({ code: "MEMORY_RECALL_FAILED", message: err?.message ?? String(err) });
      }
    },
  });

const ragIngestArgs = z.object({
  file: z.string().describe("Path to the file to ingest"),
});
const ragIngestOptions = z.object({
  workflow: z.string().describe("Path to a .tsx workflow file"),
  namespace: z.string().default("default").describe("Vector namespace"),
  strategy: z.string().default("recursive").describe("Chunking strategy: recursive, character, sentence, markdown, token"),
  size: z.number().int().min(1).default(1000).describe("Chunk size"),
  overlap: z.number().int().min(0).default(200).describe("Chunk overlap"),
});
const ragQueryArgs = z.object({
  query: z.string().describe("Search query"),
});
const ragQueryOptions = z.object({
  workflow: z.string().describe("Path to a .tsx workflow file"),
  namespace: z.string().default("default").describe("Vector namespace"),
  topK: z.number().int().min(1).default(5).describe("Number of results to return"),
});

const ragCli = Cli.create({
  name: "rag",
  description: "Ingest documents and query the RAG knowledge base.",
})
  .command("ingest", {
    description: "Chunk and embed a file into the vector store.",
    args: ragIngestArgs,
    options: ragIngestOptions,
    alias: { workflow: "w", namespace: "n" },
    async run(c) {
      try {
        const { createSqliteVectorStore } = await import("../rag/vector-store");
        const { createRagPipeline } = await import("../rag/pipeline");
        const { loadDocument } = await import("../rag/document");
        const { openai } = await import("@ai-sdk/openai");

        const workflow = await loadWorkflowAsync(c.options.workflow);
        ensureSmithersTables(workflow.db as any);
        setupSqliteCleanup(workflow);

        const store = createSqliteVectorStore(workflow.db);
        const pipeline = createRagPipeline({
          vectorStore: store,
          embeddingModel: openai.embedding("text-embedding-3-small"),
          chunkOptions: {
            strategy: c.options.strategy as any,
            size: c.options.size,
            overlap: c.options.overlap,
          },
          namespace: c.options.namespace,
        });

        const doc = loadDocument(c.args.file);
        await pipeline.ingest([doc]);
        const count = await store.count(c.options.namespace);
        console.log(`[+] Ingested ${c.args.file} into namespace "${c.options.namespace}" (${count} total chunks)`);
        return c.ok({ file: c.args.file, namespace: c.options.namespace, totalChunks: count });
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        return c.error({ code: "RAG_INGEST_FAILED", message: err?.message ?? String(err) });
      }
    },
  })
  .command("query", {
    description: "Search the vector store for relevant chunks.",
    args: ragQueryArgs,
    options: ragQueryOptions,
    alias: { workflow: "w", namespace: "n", topK: "k" },
    async run(c) {
      try {
        const { createSqliteVectorStore } = await import("../rag/vector-store");
        const { createRagPipeline } = await import("../rag/pipeline");
        const { openai } = await import("@ai-sdk/openai");

        const workflow = await loadWorkflowAsync(c.options.workflow);
        ensureSmithersTables(workflow.db as any);
        setupSqliteCleanup(workflow);

        const store = createSqliteVectorStore(workflow.db);
        const pipeline = createRagPipeline({
          vectorStore: store,
          embeddingModel: openai.embedding("text-embedding-3-small"),
          namespace: c.options.namespace,
        });

        const results = await pipeline.retrieve(c.args.query, { topK: c.options.topK });
        for (const r of results) {
          const preview = r.chunk.content.replace(/\n/g, " ").slice(0, 120);
          console.log(`[${r.score.toFixed(4)}] ${preview}${r.chunk.content.length > 120 ? "..." : ""}`);
        }
        return c.ok({
          query: c.args.query,
          namespace: c.options.namespace,
          results: results.map((r) => ({
            score: r.score,
            content: r.chunk.content,
            metadata: r.metadata,
          })),
        });
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        return c.error({ code: "RAG_QUERY_FAILED", message: err?.message ?? String(err) });
      }
    },
  });

const cronCli = Cli.create({
  name: "cron",
  description: "Manage and run background schedule triggers.",
})
  .command("start", {
    description: "Start the background scheduler loop in the current terminal.",
    async run(c) {
      await runScheduler();
      return c.ok({ status: "running" });
    },
  })
  .command("add", {
    description: "Register a new workflow cron schedule.",
    args: cronPathArgs,
    async run(c) {
      const { adapter, cleanup } = await findAndOpenDb();
      try {
        const cronId = crypto.randomUUID();
        await adapter.upsertCron({
          cronId,
          pattern: c.args.pattern,
          workflowPath: c.args.workflowPath,
          enabled: true,
          createdAtMs: Date.now(),
          lastRunAtMs: null,
          nextRunAtMs: null,
          errorJson: null,
        });
        console.log(`[+] Scheduled ${c.args.workflowPath} with pattern '${c.args.pattern}'`);
        return c.ok({ cronId, pattern: c.args.pattern, workflowPath: c.args.workflowPath });
      } finally {
        cleanup();
      }
    },
  })
  .command("list", {
    description: "List all registered background cron schedules.",
    async run(c) {
      const { adapter, cleanup } = await findAndOpenDb();
      try {
        const crons = await adapter.listCrons(false);
        return c.ok({ crons });
      } finally {
        cleanup();
      }
    },
  })
  .command("rm", {
    description: "Delete an existing cron schedule by ID.",
    args: z.object({ cronId: z.string().describe("Cron ID to delete") }),
    async run(c) {
      const { adapter, cleanup } = await findAndOpenDb();
      try {
        await adapter.deleteCron(c.args.cronId);
        console.log(`[-] Deleted cron ${c.args.cronId}`);
        return c.ok({ deleted: c.args.cronId });
      } finally {
        cleanup();
      }
    },
  });


// ---------------------------------------------------------------------------
// OpenAPI subcommand
// ---------------------------------------------------------------------------

const openapiListArgs = z.object({
  specPath: z.string().describe("Path or URL to an OpenAPI spec"),
});

const openapiCli = Cli.create({
  name: "openapi",
  description: "Generate AI SDK tools from OpenAPI specs.",
})
  .command("list", {
    description: "Preview tools that would be generated from an OpenAPI spec.",
    args: openapiListArgs,
    async run(c) {
      try {
        const { listOperations } = await import("../openapi/tool-factory");
        const ops = listOperations(c.args.specPath);

        if (ops.length === 0) {
          console.log("  No operations found in spec.");
          return c.ok({ operations: [] });
        }

        for (const op of ops) {
          console.log(`  ${pc.bold(op.operationId)} — ${op.summary || `${op.method} ${op.path}`}`);
        }
        console.log(`\n  ${ops.length} tool(s) from spec`);

        return c.ok({ operations: ops });
      } catch (err: any) {
        console.error(`Error: ${err?.message ?? String(err)}`);
        return c.error({ code: "OPENAPI_LIST_FAILED", message: err?.message ?? String(err) });
      }
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
        const result = initWorkflowPack({ force: c.options.force });
        return c.ok(result, {
          cta: {
            description: "Next steps:",
            commands: c.agent
              ? [
                  { command: "workflow list", description: "View all available workflows" },
                  { command: "bun install -g smithers", description: "Install smithers globally" },
                ]
              : [
                  { command: "tui", description: "Open the interactive dashboard" },
                  { command: "bun install -g smithers", description: "Install smithers globally" },
                ],
          },
        });
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
      return executeUpCommand(c, c.args.workflow, c.options, fail);
    },
  })

  // =========================================================================
  // smithers supervise
  // =========================================================================
  .command("supervise", {
    description: "Watch for stale running runs and auto-resume them.",
    options: superviseOptions,
    alias: { dryRun: "n", interval: "i", staleThreshold: "t", maxConcurrent: "c" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };

      let parsed: ResolvedSupervisorOptions;
      try {
        parsed = resolveSupervisorOptions(
          c.options.interval,
          c.options.staleThreshold,
          c.options.maxConcurrent,
          c.options.dryRun,
        );
      } catch (error: any) {
        return fail({
          code:
            error instanceof SmithersError
              ? error.code
              : "INVALID_SUPERVISOR_OPTIONS",
          message: error?.message ?? String(error),
          exitCode: 4,
        });
      }

      const { adapter, cleanup } = await findAndOpenDb();
      const abort = setupAbortSignal();

      process.stderr.write(
        `[smithers] Supervisor started (interval=${parsed.pollIntervalMs}ms, staleThreshold=${parsed.staleThresholdMs}ms, maxConcurrent=${parsed.maxConcurrent}, dryRun=${parsed.dryRun})\n`,
      );

      try {
        await runPromise(
          supervisorLoopEffect({
            adapter,
            dryRun: parsed.dryRun,
            pollIntervalMs: parsed.pollIntervalMs,
            staleThresholdMs: parsed.staleThresholdMs,
            maxConcurrent: parsed.maxConcurrent,
          }),
          { signal: abort.signal },
        );
        return c.ok({ status: "stopped" });
      } catch (error: any) {
        if (abort.signal.aborted) {
          return c.ok({ status: "stopped" });
        }
        return fail({
          code: "SUPERVISOR_FAILED",
          message: error?.message ?? String(error),
          exitCode: 1,
        });
      } finally {
        cleanup();
      }
    },
  })

  // =========================================================================
  // smithers tui
  // =========================================================================
  .command("tui", {
    description: "Open the interactive Smithers observability dashboard",
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      let cleanup: (() => void) | undefined;
      let renderer: any;
      try {
        const db = await findAndOpenDb(undefined, {
          timeoutMs: 5000,
          intervalMs: 100,
        });
        const adapter = db.adapter;
        cleanup = db.cleanup;

        const { createCliRenderer } = await import("@opentui/core");
        const { createRoot } = await import("@opentui/react");
        const { TuiApp } = await import("./tui/app.js");
        const React = await import("react");

        renderer = await createCliRenderer({ exitOnCtrlC: false });
        const root = createRoot(renderer);
        
        await new Promise((resolve) => {
          root.render(
            React.createElement(TuiApp, {
              adapter,
              onExit: () => resolve(true),
            })
          );
        });

        return c.ok(undefined);
      } catch (err: any) {
        return fail({ code: "TUI_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      } finally {
        if (renderer) renderer.destroy();
        cleanup?.();
      }
    }
  })

  // =========================================================================
  // smithers ui [run <id> | node <run>/<node> | approvals]
  // =========================================================================
  .command("ui", {
    description: "Open Smithers web UI deep links for runs, nodes, or approvals.",
    args: uiArgs,
    options: uiOptions,
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };

      const parsedTarget = parseUiTarget(c.args.target, c.args.value);
      if ("error" in parsedTarget) {
        const targetError = parsedTarget.error;
        return fail({
          code: "UI_COMMAND_INVALID_ARGS",
          message: targetError,
          exitCode: 4,
        });
      }
      const uiTarget = parsedTarget.target;

      const host = c.options.host?.trim() || resolveUiHost();
      const port = c.options.port ?? resolveUiPort();

      try {
        await runPromise(
          Effect.gen(function* () {
            const ensureResult = yield* ensureServerRunning(port, { host });
            const url = buildUrl(port, uiTarget);
            yield* Effect.void.pipe(
              Effect.annotateLogs({
                target: uiTarget.kind,
                url,
                serverAutoStarted: ensureResult.serverAutoStarted,
              }),
            );

            yield* Effect.sync(() => {
              console.log(url);
            });

            if (!c.options.open || shouldSuppressAutoOpen()) {
              return;
            }

            yield* openInBrowser(url).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const openError = error?.message ?? String(error);
                  yield* Effect.logWarning(
                    "Could not open browser for Smithers UI.",
                  ).pipe(
                    Effect.annotateLogs({
                      target: uiTarget.kind,
                      url,
                      reason: openError,
                    }),
                  );
                  yield* Effect.sync(() => {
                    console.error(`Failed to open browser: ${openError}`);
                    console.error(`Open this URL manually: ${url}`);
                  });
                }),
              ),
            );
          }).pipe(Effect.withLogSpan("cli:ui")),
        );

        return c.ok(undefined);
      } catch (err: any) {
        return fail({
          code: "UI_COMMAND_FAILED",
          message: err?.message ?? String(err),
          exitCode: 1,
        });
      }
    },
  })

  // =========================================================================
  // smithers ps
  // =========================================================================
  .command("ps", {
    description: "List active, paused, and recently completed runs.",
    options: psOptions,
    alias: { status: "s", limit: "l", all: "a", watch: "w", interval: "i" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          if (c.options.watch) {
            const intervalMs = resolveWatchIntervalMsOrFail(
              "ps",
              c.options.interval,
              fail,
            );
            const watchResult = await runPromise(
              Effect.tryPromise(() =>
                runWatchLoop({
                  intervalSeconds: c.options.interval,
                  clearScreen: true,
                  fetch: async () => ({
                    runs: await buildPsRows(
                      adapter,
                      c.options.limit,
                      c.options.status,
                    ),
                  }),
                  render: async (snapshot) => {
                    writeWatchOutput(c.format, snapshot);
                  },
                }),
              ).pipe(
                Effect.tap((result) =>
                  Effect.logDebug("watch loop completed").pipe(
                    Effect.annotateLogs({
                      command: "ps",
                      intervalMs,
                      tickCount: result.tickCount,
                      stoppedBySignal: result.stoppedBySignal,
                    }),
                  ),
                ),
                Effect.annotateLogs({ command: "ps", intervalMs }),
                Effect.withLogSpan("cli:watch"),
              ),
            );
            if (watchResult.stoppedBySignal) {
              process.exitCode = 0;
            }
            return c.ok(undefined);
          }

          const rows = await buildPsRows(adapter, c.options.limit, c.options.status);
          const ctaCommands = buildPsCtaCommands(rows);
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
      return yield* streamRunEventsCommand(c);
    },
  })

  // =========================================================================
  // smithers events <run_id>
  // =========================================================================
  .command("events", {
    description: "Query run event history with filters, grouping, and NDJSON output.",
    args: z.object({ runId: z.string().describe("Run ID to query") }),
    options: eventsOptions,
    alias: { node: "n", type: "t", since: "s", limit: "l", json: "j", watch: "w", interval: "i" },
    async *run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };

      let query: NormalizedEventsQuery;
      try {
        query = normalizeEventsQuery(c.options);
      } catch (error: any) {
        return fail({
          code:
            error instanceof SmithersError ? error.code : "INVALID_EVENTS_OPTIONS",
          message: error?.message ?? String(error),
          exitCode: 4,
        });
      }

      let cleanup: (() => void) | undefined;
      try {
        const db = await findAndOpenDb();
        const adapter = db.adapter;
        cleanup = db.cleanup;

        const run = await adapter.getRun(c.args.runId);
        if (!run) {
          return fail({
            code: "RUN_NOT_FOUND",
            message: `Run not found: ${c.args.runId}`,
            exitCode: 4,
          });
        }

        if (query.limitCapped) {
          process.stderr.write(
            `[smithers] --limit capped at ${MAX_EVENTS_LIMIT} events\n`,
          );
        }

        let groupBy = query.groupBy;
        if (query.json && groupBy) {
          process.stderr.write(
            "[smithers] --group-by is ignored when --json is enabled\n",
          );
          groupBy = undefined;
        }
        if (c.options.watch && groupBy) {
          process.stderr.write(
            "[smithers] --group-by is ignored when --watch is enabled\n",
          );
          groupBy = undefined;
        }

        let watchIntervalMs: number | undefined;
        if (c.options.watch) {
          watchIntervalMs = resolveWatchIntervalMsOrFail(
            "events",
            c.options.interval,
            fail,
          );
        }

        const filters = {
          nodeId: query.nodeId,
          type: query.typeName,
          sinceTimestampMs: query.sinceTimestampMs,
          limit: query.limit,
          json: query.json,
          groupBy,
          watch: c.options.watch,
        };

        const baseMs =
          (run as any).startedAtMs ??
          (run as any).createdAtMs ??
          Date.now();

        const totalCount =
          query.defaultLimitUsed && !query.json
            ? await countEventHistory(adapter, c.args.runId, {
                nodeId: query.nodeId,
                eventTypes: query.eventTypes,
                sinceTimestampMs: query.sinceTimestampMs,
              })
            : undefined;

        const groupedEvents: EventHistoryRow[] = [];
        let emitted = 0;
        let lastSeq = -1;

        while (emitted < query.limit) {
          const pageLimit = Math.min(EVENTS_PAGE_SIZE, query.limit - emitted);
          const page = await queryEventHistoryPage(adapter, c.args.runId, {
            afterSeq: lastSeq,
            nodeId: query.nodeId,
            eventTypes: query.eventTypes,
            sinceTimestampMs: query.sinceTimestampMs,
            limit: pageLimit,
          });

          if (page.length === 0) break;

          for (const event of page) {
            lastSeq = event.seq;
            emitted += 1;
            if (groupBy) {
              groupedEvents.push(event);
            } else {
              if (query.json) {
                process.stdout.write(`${buildEventNdjsonLine(event)}\n`);
              } else {
                yield buildEventHistoryLine(event, baseMs);
              }
            }
            if (emitted >= query.limit) break;
          }

          if (page.length < pageLimit) break;
        }

        if (groupBy) {
          const groupedLines = renderGroupedEvents(
            groupedEvents,
            baseMs,
            groupBy,
          );
          for (const line of groupedLines) {
            yield line;
          }
        }

        if (
          query.defaultLimitUsed &&
          !query.json &&
          typeof totalCount === "number" &&
          totalCount > query.limit
        ) {
          yield `showing first ${query.limit} of ${totalCount} events, use --limit to see more`;
        }

        if (c.options.watch && !isRunStatusTerminal((run as any).status)) {
          const renderEvents = (events: EventHistoryRow[]) => {
            for (const event of events) {
              lastSeq = Math.max(lastSeq, event.seq);
              emitted += 1;
              if (query.json) {
                process.stdout.write(`${buildEventNdjsonLine(event)}\n`);
              } else {
                process.stdout.write(`${buildEventHistoryLine(event, baseMs)}\n`);
              }
            }
          };

          const watchResult = await runPromise(
            Effect.tryPromise(() =>
              runWatchLoop({
                intervalSeconds: c.options.interval,
                clearScreen: false,
                fetch: async () => ({
                  events: await queryEventHistoryPage(adapter, c.args.runId, {
                    afterSeq: lastSeq,
                    nodeId: query.nodeId,
                    eventTypes: query.eventTypes,
                    sinceTimestampMs: query.sinceTimestampMs,
                    limit: EVENTS_PAGE_SIZE,
                  }),
                  status: (await adapter.getRun(c.args.runId) as any)?.status as
                    | string
                    | undefined,
                }),
                render: async (snapshot) => {
                  renderEvents(snapshot.events);
                },
                isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status),
              }),
            ).pipe(
              Effect.tap((result) =>
                Effect.logDebug("watch loop completed").pipe(
                  Effect.annotateLogs({
                    command: "events",
                    intervalMs: watchIntervalMs,
                    tickCount: result.tickCount,
                    stoppedBySignal: result.stoppedBySignal,
                  }),
                ),
              ),
              Effect.annotateLogs({
                command: "events",
                runId: c.args.runId,
                intervalMs: watchIntervalMs,
              }),
              Effect.withLogSpan("cli:watch"),
            ),
          );

          if (watchResult.reachedTerminal) {
            while (true) {
              const finalPage = await queryEventHistoryPage(adapter, c.args.runId, {
                afterSeq: lastSeq,
                nodeId: query.nodeId,
                eventTypes: query.eventTypes,
                sinceTimestampMs: query.sinceTimestampMs,
                limit: EVENTS_PAGE_SIZE,
              });
              if (finalPage.length === 0) break;
              renderEvents(finalPage);
              if (finalPage.length < EVENTS_PAGE_SIZE) break;
            }
          }

          if (watchResult.stoppedBySignal) {
            process.exitCode = 0;
          }
        }

        await runPromise(
          Effect.succeed(undefined).pipe(
            Effect.annotateLogs({
              runId: c.args.runId,
              filters,
              resultCount: emitted,
            }),
            Effect.withLogSpan("cli:events"),
          ),
        );

        if (query.json) return;
        return c.ok(undefined);
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
          if (
            currentStatus !== "running" &&
            currentStatus !== "waiting-approval" &&
            currentStatus !== "waiting-event" &&
            currentStatus !== "waiting-timer"
          ) {
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
  // smithers hijack <run_id>
  // =========================================================================
  .command("hijack", {
    description: "Hand off the latest resumable agent session or conversation for a run.",
    args: hijackArgs,
    options: hijackOptions,
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };

      const { adapter, cleanup } = await findAndOpenDb();
      try {
        const run = await adapter.getRun(c.args.runId);
        if (!run) {
          return fail({
            code: "RUN_NOT_FOUND",
            message: `Run not found: ${c.args.runId}`,
            exitCode: 4,
          });
        }

        let candidate = await resolveHijackCandidate(adapter, c.args.runId, c.options.target);
        const runIsLive = (run as any).status === "running";
        const requestedAtMs = Date.now();

        if (runIsLive) {
          const event = {
            type: "RunHijackRequested" as const,
            runId: c.args.runId,
            timestampMs: requestedAtMs,
            ...(c.options.target ? { target: c.options.target } : {}),
          };
          await adapter.requestRunHijack(c.args.runId, requestedAtMs, c.options.target ?? null);
          await adapter.insertEventWithNextSeq({
            runId: c.args.runId,
            timestampMs: requestedAtMs,
            type: "RunHijackRequested",
            payloadJson: JSON.stringify(event),
          });
          runSync(trackEvent(event));
          try {
            candidate = await waitForHijackCandidate(adapter, c.args.runId, {
              target: c.options.target,
              timeoutMs: c.options.timeoutMs,
            });
          } catch (error: any) {
            await adapter.clearRunHijack(c.args.runId).catch(() => undefined);
            return fail({
              code: "HIJACK_TIMEOUT",
              message: error?.message ?? String(error),
              exitCode: 4,
            });
          }
        }

        if (!candidate) {
          return fail({
            code: "HIJACK_UNAVAILABLE",
            message: `No resumable agent session or conversation found for run ${c.args.runId}.`,
            exitCode: 4,
          });
        }

        if (c.options.target && candidate.engine !== c.options.target) {
          return fail({
            code: "HIJACK_TARGET_MISMATCH",
            message: `Run ${c.args.runId} is resumable in ${candidate.engine}, not ${c.options.target}. Cross-engine hijack is not supported.`,
            exitCode: 4,
          });
        }

        const resumeCommand =
          (run as any).workflowPath
            ? `smithers up ${(run as any).workflowPath} --resume --run-id ${c.args.runId}`
            : null;

        if (!c.options.launch) {
          const launchSpec = isNativeHijackCandidate(candidate)
            ? buildHijackLaunchSpec(candidate)
            : null;
          const launch = launchSpec
            ? {
                command: launchSpec.command,
                args: launchSpec.args,
                cwd: launchSpec.cwd,
              }
            : null;
          return c.ok({
            runId: c.args.runId,
            engine: candidate.engine,
            mode: candidate.mode,
            nodeId: candidate.nodeId,
            attempt: candidate.attempt,
            iteration: candidate.iteration,
            resume: candidate.resume ?? null,
            messageCount: candidate.messages?.length ?? 0,
            cwd: candidate.cwd,
            launch,
            resumeCommand,
          });
        }

        let exitCode = 0;
        let resumedBySmithers = false;

        if (isNativeHijackCandidate(candidate)) {
          const launchSpec = buildHijackLaunchSpec(candidate);
          process.stderr.write(
            `[smithers] hijacking ${candidate.engine} session ${candidate.resume} from ${candidate.nodeId}#${candidate.attempt}\n`,
          );
          exitCode = await launchHijackSession(launchSpec);
        } else {
          if (!candidate.messages?.length) {
            return fail({
              code: "HIJACK_CONVERSATION_MISSING",
              message: `Run ${c.args.runId} did not persist a resumable conversation for ${candidate.engine}.`,
              exitCode: 4,
            });
          }
          const result = await launchConversationHijackSession(adapter, {
            ...candidate,
            mode: "conversation",
            messages: candidate.messages,
          });
          await persistConversationHijackHandoff(adapter, candidate, result.messages);
          exitCode = result.code;
        }

        if (exitCode === 0 && runIsLive && (run as any).workflowPath) {
          const pid = resumeRunDetached((run as any).workflowPath, c.args.runId);
          resumedBySmithers = true;
          process.stderr.write(
            `[smithers] returned control to Smithers${pid ? ` (pid ${pid})` : ""}\n`,
          );
        } else if (resumeCommand) {
          process.stderr.write(`[smithers] return control to Smithers with:\n  ${resumeCommand}\n`);
        }

        if (exitCode !== 0) {
          return fail({
            code: "HIJACK_LAUNCH_FAILED",
            message: `${candidate.engine} exited with code ${exitCode}`,
            exitCode,
          });
        }

        return c.ok({
          runId: c.args.runId,
          engine: candidate.engine,
          mode: candidate.mode,
          resumedSession: candidate.resume ?? null,
          resumedBySmithers,
        });
      } finally {
        cleanup();
      }
    },
  })

  // =========================================================================
  // smithers inspect <run_id>
  // =========================================================================
  .command("inspect", {
    description: "Output detailed state of a run: steps, agents, approvals, and outputs.",
    args: inspectArgs,
    options: inspectOptions,
    alias: { watch: "w", interval: "i" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const renderInspect = (snapshot: InspectSnapshot) => {
            writeWatchOutput(c.format, snapshot.result);
          };

          if (c.options.watch) {
            const intervalMs = resolveWatchIntervalMsOrFail(
              "inspect",
              c.options.interval,
              fail,
            );
            const watchResult = await runPromise(
              Effect.tryPromise(() =>
                runWatchLoop({
                  intervalSeconds: c.options.interval,
                  clearScreen: true,
                  fetch: () => buildInspectSnapshot(adapter, c.args.runId),
                  render: async (snapshot) => {
                    renderInspect(snapshot);
                  },
                  isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status),
                }),
              ).pipe(
                Effect.tap((result) =>
                  Effect.logDebug("watch loop completed").pipe(
                    Effect.annotateLogs({
                      command: "inspect",
                      intervalMs,
                      tickCount: result.tickCount,
                      stoppedBySignal: result.stoppedBySignal,
                    }),
                  ),
                ),
                Effect.annotateLogs({ command: "inspect", intervalMs }),
                Effect.withLogSpan("cli:watch"),
              ),
            );
            if (watchResult.stoppedBySignal) {
              process.exitCode = 0;
            }
            return c.ok(undefined);
          }

          const snapshot = await buildInspectSnapshot(adapter, c.args.runId);
          return c.ok(snapshot.result, { cta: { commands: snapshot.ctaCommands } });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        if (err instanceof SmithersError && err.code === "RUN_NOT_FOUND") {
          return fail({
            code: "RUN_NOT_FOUND",
            message: err.message,
            exitCode: 4,
          });
        }
        return fail({ code: "INSPECT_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers node <node_id> -r <run_id>
  // =========================================================================
  .command("node", {
    description: "Show enriched node details for debugging retries, tool calls, and output.",
    args: nodeArgs,
    options: nodeOptions,
    alias: { runId: "r", iteration: "i", watch: "w" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const renderNode = (detail: any) => {
            const human =
              c.format === "json" || c.format === "jsonl"
                ? undefined
                : renderNodeDetailHuman(detail, {
                    expandAttempts: c.options.attempts,
                    expandTools: c.options.tools,
                  });
            writeWatchOutput(c.format, detail, human);
          };

          if (c.options.watch) {
            const intervalMs = resolveWatchIntervalMsOrFail(
              "node",
              c.options.interval,
              fail,
            );
            const watchResult = await runPromise(
              Effect.tryPromise(() =>
                runWatchLoop({
                  intervalSeconds: c.options.interval,
                  clearScreen: true,
                  fetch: () =>
                    buildNodeSnapshot(adapter, {
                      runId: c.options.runId,
                      nodeId: c.args.nodeId,
                      iteration: c.options.iteration,
                    }),
                  render: async (snapshot) => {
                    renderNode(snapshot.detail);
                  },
                  isTerminal: (snapshot) => isRunStatusTerminal(snapshot.status),
                }),
              ).pipe(
                Effect.tap((result) =>
                  Effect.logDebug("watch loop completed").pipe(
                    Effect.annotateLogs({
                      command: "node",
                      runId: c.options.runId,
                      nodeId: c.args.nodeId,
                      intervalMs,
                      tickCount: result.tickCount,
                      stoppedBySignal: result.stoppedBySignal,
                    }),
                  ),
                ),
                Effect.annotateLogs({
                  command: "node",
                  runId: c.options.runId,
                  nodeId: c.args.nodeId,
                  intervalMs,
                }),
                Effect.withLogSpan("cli:watch"),
              ),
            );
            if (watchResult.stoppedBySignal) {
              process.exitCode = 0;
            }
            return c.ok(undefined);
          }

          const detail = await runPromise(
            aggregateNodeDetailEffect(adapter, {
              runId: c.options.runId,
              nodeId: c.args.nodeId,
              iteration: c.options.iteration,
            }),
          );

          if (c.format === "json") {
            return c.ok(detail);
          }

          const rendered = renderNodeDetailHuman(detail, {
            expandAttempts: c.options.attempts,
            expandTools: c.options.tools,
          });
          return c.ok(rendered, {
            cta: {
              commands: [
                {
                  command: `inspect ${c.options.runId}`,
                  description: "Inspect overall run state",
                },
                {
                  command: `chat ${c.options.runId}`,
                  description: "View agent chat for this run",
                },
                {
                  command: `node ${c.args.nodeId} -r ${c.options.runId} --attempts`,
                  description: "Expand every attempt",
                },
                {
                  command: `node ${c.args.nodeId} -r ${c.options.runId} --tools`,
                  description: "Expand tool payloads",
                },
              ],
            },
          });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        const isMissingNode =
          err instanceof SmithersError && err.code === "NODE_NOT_FOUND";
        return fail({
          code: isMissingNode ? "NODE_NOT_FOUND" : "NODE_DETAIL_FAILED",
          message:
            err instanceof SmithersError
              ? err.summary
              : (err?.message ?? String(err)),
          exitCode: isMissingNode ? 4 : 1,
        });
      }
    },
  })

  // =========================================================================
  // smithers why <run_id>
  // =========================================================================
  .command("why", {
    description: "Explain why a run is currently blocked or paused.",
    args: whyArgs,
    options: whyOptions,
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const diagnosis = await runPromise(
            diagnoseRunEffect(adapter, c.args.runId),
          );

          if (c.options.json) {
            return c.ok(JSON.stringify(diagnosis, null, 2));
          }
          if (c.format === "json") {
            return c.ok(diagnosis);
          }
          return c.ok(renderWhyDiagnosisHuman(diagnosis), {
            cta: {
              commands: diagnosisCtaCommands(diagnosis),
            },
          });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        if (err instanceof SmithersError && err.code === "RUN_NOT_FOUND") {
          return fail({
            code: "RUN_NOT_FOUND",
            message: err.message,
            exitCode: 4,
          });
        }
        return fail({ code: "WHY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
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
  // smithers signal <run_id> <signal_name>
  // =========================================================================
  .command("signal", {
    description: "Deliver a durable signal to a run waiting on <Signal> or <WaitForEvent>.",
    args: signalArgs,
    options: signalOptions,
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const payload = parseJsonInput(c.options.data, "signal data", fail) ?? {};
          const run = await adapter.getRun(c.args.runId);
          if (!run) {
            return fail({
              code: "RUN_NOT_FOUND",
              message: `Run not found: ${c.args.runId}`,
              exitCode: 4,
            });
          }

          const delivered = await signalRun(
            adapter,
            c.args.runId,
            c.args.signalName,
            payload,
            {
              correlationId: c.options.correlation,
              receivedBy: c.options.by,
            },
          );

          const commands = [
            { command: `why ${c.args.runId}`, description: "Explain remaining blockers" },
            { command: `logs ${c.args.runId}`, description: "Tail run logs" },
          ];
          if ((run as any).workflowPath) {
            commands.unshift({
              command: `up ${(run as any).workflowPath} --resume --run-id ${c.args.runId}`,
              description: "Resume the paused run",
            });
          }

          return c.ok(
            {
              runId: c.args.runId,
              signalName: c.args.signalName,
              correlationId: c.options.correlation ?? null,
              seq: delivered.seq,
              status: "signalled",
            },
            {
              cta: {
                commands,
              },
            },
          );
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({
          code:
            err instanceof SmithersError && err.code === "RUN_NOT_FOUND"
              ? "RUN_NOT_FOUND"
              : "SIGNAL_FAILED",
          message: err?.message ?? String(err),
          exitCode:
            err instanceof SmithersError && err.code === "RUN_NOT_FOUND" ? 4 : 1,
        });
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
          if (
            (run as any).status !== "running" &&
            (run as any).status !== "waiting-approval" &&
            (run as any).status !== "waiting-event" &&
            (run as any).status !== "waiting-timer"
          ) {
            return fail({ code: "RUN_NOT_ACTIVE", message: `Run is not active (status: ${(run as any).status})`, exitCode: 4 });
          }

          const inProgress = await adapter.listInProgressAttempts(c.args.runId);
          const allAttempts = await adapter.listAttemptsForRun(c.args.runId);
          const now = Date.now();
          for (const attempt of inProgress as any[]) {
            await adapter.updateAttempt(c.args.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
              state: "cancelled",
              finishedAtMs: now,
            });
          }
          const waitingTimers = (allAttempts as any[]).filter((attempt) => attempt.state === "waiting-timer");
          for (const attempt of waitingTimers) {
            await adapter.updateAttempt(c.args.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
              state: "cancelled",
              finishedAtMs: now,
            });
          }
          const nodes = await adapter.listNodes(c.args.runId);
          for (const node of (nodes as any[]).filter((n) => n.state === "waiting-timer")) {
            await adapter.insertNode({
              runId: c.args.runId,
              nodeId: node.nodeId,
              iteration: node.iteration ?? 0,
              state: "cancelled",
              lastAttempt: node.lastAttempt ?? null,
              updatedAtMs: now,
              outputTable: node.outputTable ?? "",
              label: node.label ?? null,
            });
          }
          await adapter.updateRun(c.args.runId, { status: "cancelled", finishedAtMs: now });

          process.exitCode = 2;
          return c.ok(
            {
              runId: c.args.runId,
              status: "cancelled",
              cancelledAttempts: (inProgress as any[]).length + waitingTimers.length,
            },
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
          const waitingApprovalRuns = await adapter.listRuns(100, "waiting-approval");
          const waitingEventRuns = await adapter.listRuns(100, "waiting-event");
          const waitingTimerRuns = await adapter.listRuns(100, "waiting-timer");
          const allActive = [
            ...(activeRuns as any[]),
            ...(waitingApprovalRuns as any[]),
            ...(waitingEventRuns as any[]),
            ...(waitingTimerRuns as any[]),
          ];

          if (allActive.length === 0) {
            return c.ok({ cancelled: 0, message: "No active runs to cancel." });
          }

          const now = Date.now();
          let cancelled = 0;

          for (const run of allActive) {
            const inProgress = await adapter.listInProgressAttempts(run.runId);
            const attempts = await adapter.listAttemptsForRun(run.runId);
            for (const attempt of inProgress as any[]) {
              await adapter.updateAttempt(run.runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                state: "cancelled",
                finishedAtMs: now,
              });
            }
            for (const attempt of (attempts as any[]).filter((entry) => entry.state === "waiting-timer")) {
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
  // smithers retry-task <workflow>
  // =========================================================================
  .command("retry-task", {
    description: "Retry a specific task within a run, then resume the workflow.",
    args: workflowArgs,
    options: z.object({
      runId: z.string().describe("Run ID containing the task"),
      nodeId: z.string().describe("Task/node ID to retry"),
      iteration: z.number().int().default(0).describe("Loop iteration"),
      noDeps: z.boolean().default(false).describe("Only reset this node, not dependents"),
      force: z.boolean().default(false).describe("Allow retry even if run is still running"),
    }),
    alias: { runId: "r", nodeId: "n" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const onProgress = buildProgressReporter();
          const resetResult = await retryTask(adapter, {
            runId: c.options.runId,
            nodeId: c.options.nodeId,
            iteration: c.options.iteration,
            resetDependents: !c.options.noDeps,
            force: c.options.force,
            onProgress,
          });
          if (!resetResult.success) {
            process.exitCode = 1;
            return c.ok(resetResult);
          }

          const workflow = await loadWorkflow(c.args.workflow);
          const abort = setupAbortSignal();
          const runResult = await runWorkflow(workflow, {
            input: {},
            runId: c.options.runId,
            workflowPath: c.args.workflow,
            resume: true,
            force: c.options.force,
            onProgress,
            signal: abort.signal,
          });
          process.exitCode = formatStatusExitCode(runResult.status);
          return c.ok({
            ...resetResult,
            status: runResult.status,
            error: runResult.error,
          });
        } finally {
          cleanup?.();
        }
      } catch (err: any) {
        return fail({ code: "RETRY_TASK_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers timetravel <workflow>
  // =========================================================================
  .command("timetravel", {
    description: "Time-travel to a previous task state: revert filesystem, reset DB, and optionally resume.",
    args: workflowArgs,
    options: z.object({
      runId: z.string().describe("Run ID"),
      nodeId: z.string().describe("Task/node ID to travel back to"),
      iteration: z.number().int().default(0).describe("Loop iteration"),
      attempt: z.number().int().optional().describe("Attempt number (default: latest)"),
      noVcs: z.boolean().default(false).describe("Skip filesystem revert (DB only)"),
      noDeps: z.boolean().default(false).describe("Only reset this node, not dependents"),
      resume: z.boolean().default(false).describe("Resume the workflow after time travel"),
      force: z.boolean().default(false).describe("Force even if run is still running"),
    }),
    alias: { runId: "r", nodeId: "n", attempt: "a" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const run = await adapter.getRun(c.options.runId);
          if (run?.status === "running" && !c.options.force) {
            return fail({
              code: "RUN_STILL_RUNNING",
              message: `Run ${c.options.runId} is still marked running. Re-run with --force to time-travel it anyway.`,
              exitCode: 4,
            });
          }

          const result = await timeTravel(adapter, {
            runId: c.options.runId,
            nodeId: c.options.nodeId,
            iteration: c.options.iteration,
            attempt: c.options.attempt,
            resetDependents: !c.options.noDeps,
            restoreVcs: !c.options.noVcs,
            onProgress: (e) => console.log(JSON.stringify(e)),
          });

          if (!result.success || !c.options.resume) {
            process.exitCode = result.success ? 0 : 1;
            return c.ok(result);
          }

          process.stderr.write(
            `[smithers] Time travel reset ${result.resetNodes.join(", ")} on run ${c.options.runId}\n`,
          );
          if (result.vcsRestored && result.jjPointer) {
            process.stderr.write(`[smithers] VCS state restored to ${result.jjPointer}\n`);
          }
          process.stderr.write(`[smithers] Resuming run...\n`);

          const workflow = await loadWorkflow(c.args.workflow);
          const onProgress = buildProgressReporter();
          const abort = setupAbortSignal();
          const runResult = await runWorkflow(workflow, {
            input: {},
            runId: c.options.runId,
            workflowPath: c.args.workflow,
            resume: true,
            force: true,
            onProgress,
            signal: abort.signal,
          });
          process.exitCode = formatStatusExitCode(runResult.status);
          return c.ok({
            ...result,
            resumed: true,
            status: runResult.status,
          });
        } finally {
          cleanup?.();
        }
      } catch (err: any) {
        return fail({ code: "TIMETRAVEL_FAILED", message: err?.message ?? String(err), exitCode: 1 });
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
      question: z.string().optional().describe("The question to ask"),
    }),
    options: z.object({
      agent: z.enum(["claude", "codex", "gemini", "kimi", "pi"]).optional().describe("Explicitly select which agent CLI to use"),
      listAgents: z.boolean().default(false).describe("List detected agents plus their bootstrap mode and exit"),
      dumpPrompt: z.boolean().default(false).describe("Print the generated system prompt and exit"),
      toolSurface: z.enum(["semantic", "raw"]).default("semantic").describe("Choose which Smithers MCP tool surface to expose"),
      noMcp: z.boolean().default(false).describe("Disable MCP bootstrap and use prompt-only fallback"),
      printBootstrap: z.boolean().default(false).describe("Print the selected bootstrap configuration and exit"),
    }),
    async run(c) {
      try {
        await ask(c.args.question, process.cwd(), c.options);
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

  // =========================================================================
  // smithers scores <run_id>
  // =========================================================================
  .command("scores", {
    description: "View scorer results for a specific run.",
    args: z.object({ runId: z.string().describe("Run ID to inspect") }),
    options: z.object({
      node: z.string().optional().describe("Filter scores to a specific node ID"),
    }),
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const results = await adapter.listScorerResults(c.args.runId, c.options.node);
          if (!results || (results as any[]).length === 0) {
            return c.ok({ scores: [], message: "No scores found for this run." });
          }
          const rows = (results as any[]).map((r: any) => ({
            node: r.nodeId,
            scorer: r.scorerName,
            score: typeof r.score === "number" ? r.score.toFixed(2) : String(r.score),
            reason: r.reason ?? "—",
            source: r.source,
          }));
          return c.ok({ scores: rows });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "SCORES_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers replay <workflow>
  // =========================================================================
  .command("replay", {
    description: "Fork from a checkpoint and resume execution (time travel).",
    args: workflowArgs,
    options: z.object({
      runId: z.string().describe("Source run ID to replay from"),
      frame: z.number().int().describe("Frame number to fork from"),
      node: z.string().optional().describe("Node ID to reset to pending"),
      input: z.string().optional().describe("Input overrides as JSON string"),
      label: z.string().optional().describe("Branch label for the fork"),
      restoreVcs: z.boolean().default(false).describe("Restore jj filesystem state to the source frame's revision"),
    }),
    alias: { runId: "r", frame: "f", node: "n", input: "i", label: "l" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { replayFromCheckpoint } = await import("../time-travel/replay");
        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const inputOverrides = parseJsonInput(c.options.input, "input", fail);
          const resetNodes = c.options.node ? [c.options.node] : undefined;
          const result = await replayFromCheckpoint(adapter, {
            parentRunId: c.options.runId,
            frameNo: c.options.frame,
            inputOverrides,
            resetNodes,
            branchLabel: c.options.label,
            restoreVcs: c.options.restoreVcs,
          });
          process.stderr.write(
            `[smithers] Forked run ${result.runId} from ${c.options.runId}:${c.options.frame}\n`,
          );
          if (result.vcsRestored) {
            process.stderr.write(`[smithers] VCS state restored to ${result.vcsPointer}\n`);
          }
          // Now resume the forked run
          process.stderr.write(`[smithers] Resuming forked run...\n`);
          const workflow = await loadWorkflow(c.args.workflow);
          const onProgress = buildProgressReporter();
          const abort = setupAbortSignal();
          const { runWorkflow } = await import("../engine");
          const runResult = await runWorkflow(workflow, {
            input: {},
            runId: result.runId,
            workflowPath: c.args.workflow,
            resume: true,
            force: true,
            onProgress,
            signal: abort.signal,
          });
          process.exitCode = formatStatusExitCode(runResult.status);
          return c.ok({
            forkedRunId: result.runId,
            parentRunId: c.options.runId,
            parentFrame: c.options.frame,
            vcsRestored: result.vcsRestored,
            status: runResult.status,
          });
        } finally {
          cleanup?.();
        }
      } catch (err: any) {
        return fail({ code: "REPLAY_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers diff <snapshot_a> <snapshot_b>
  // =========================================================================
  .command("diff", {
    description: "Compare two snapshots (time travel diff).",
    args: z.object({
      a: z.string().describe("First snapshot ref: run_id:frame_no or run_id (latest)"),
      b: z.string().describe("Second snapshot ref: run_id:frame_no or run_id (latest)"),
    }),
    options: z.object({
      json: z.boolean().default(false).describe("Output as JSON"),
    }),
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { diffRawSnapshots, formatDiffForTui, formatDiffAsJson } = await import("../time-travel/diff");
        const { loadSnapshot, loadLatestSnapshot } = await import("../time-travel/snapshot");
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          const parseRef = async (ref: string) => {
            if (ref.includes(":")) {
              const [runId, frameStr] = ref.split(":");
              const frameNo = parseInt(frameStr!, 10);
              if (isNaN(frameNo)) return fail({ code: "INVALID_REF", message: `Invalid frame number in ref: ${ref}`, exitCode: 4 });
              const snap = await loadSnapshot(adapter, runId!, frameNo);
              if (!snap) return fail({ code: "SNAPSHOT_NOT_FOUND", message: `No snapshot for ${ref}`, exitCode: 4 });
              return snap;
            }
            const snap = await loadLatestSnapshot(adapter, ref);
            if (!snap) return fail({ code: "SNAPSHOT_NOT_FOUND", message: `No snapshots for run ${ref}`, exitCode: 4 });
            return snap;
          };
          const snapA = await parseRef(c.args.a);
          const snapB = await parseRef(c.args.b);
          const diff = diffRawSnapshots(snapA, snapB);
          if (c.options.json) {
            console.log(JSON.stringify(formatDiffAsJson(diff), null, 2));
          } else {
            console.log(formatDiffForTui(diff));
          }
          return c.ok({ diff: formatDiffAsJson(diff) });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "DIFF_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers fork <workflow>
  // =========================================================================
  .command("fork", {
    description: "Create a branched run from a snapshot checkpoint (time travel).",
    args: workflowArgs,
    options: z.object({
      runId: z.string().describe("Source run ID"),
      frame: z.number().int().describe("Frame number to fork from"),
      resetNode: z.string().optional().describe("Node ID to reset to pending"),
      input: z.string().optional().describe("Input overrides as JSON string"),
      label: z.string().optional().describe("Branch label"),
      run: z.boolean().default(false).describe("Immediately start the forked run"),
    }),
    alias: { runId: "r", frame: "f", resetNode: "n", input: "i", label: "l" },
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { forkRun } = await import("../time-travel/fork");
        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const inputOverrides = parseJsonInput(c.options.input, "input", fail);
          const resetNodes = c.options.resetNode ? [c.options.resetNode] : undefined;
          const result = await forkRun(adapter, {
            parentRunId: c.options.runId,
            frameNo: c.options.frame,
            inputOverrides,
            resetNodes,
            branchLabel: c.options.label,
          });
          process.stderr.write(
            `[smithers] Forked run ${result.runId} from ${c.options.runId}:${c.options.frame}\n`,
          );
          if (c.options.run) {
            process.stderr.write(`[smithers] Starting forked run...\n`);
            const workflow = await loadWorkflow(c.args.workflow);
            const onProgress = buildProgressReporter();
            const abort = setupAbortSignal();
            const { runWorkflow } = await import("../engine");
            const runResult = await runWorkflow(workflow, {
              input: {},
              runId: result.runId,
              workflowPath: c.args.workflow,
              resume: true,
              force: true,
              onProgress,
              signal: abort.signal,
            });
            process.exitCode = formatStatusExitCode(runResult.status);
            return c.ok({
              forkedRunId: result.runId,
              parentRunId: c.options.runId,
              parentFrame: c.options.frame,
              started: true,
              status: runResult.status,
            });
          }
          return c.ok({
            forkedRunId: result.runId,
            parentRunId: c.options.runId,
            parentFrame: c.options.frame,
            started: false,
          });
        } finally {
          cleanup?.();
        }
      } catch (err: any) {
        return fail({ code: "FORK_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  // =========================================================================
  // smithers timeline <run_id>
  // =========================================================================
  .command("timeline", {
    description: "View execution timeline for a run and its forks (time travel).",
    args: z.object({ runId: z.string().describe("Run ID") }),
    options: z.object({
      tree: z.boolean().default(false).describe("Include all child forks recursively"),
      json: z.boolean().default(false).describe("Output as JSON"),
    }),
    async run(c) {
      const fail: FailFn = (opts) => {
        commandExitOverride = opts.exitCode ?? 1;
        return c.error(opts);
      };
      try {
        const { buildTimeline, buildTimelineTree, formatTimelineForTui, formatTimelineAsJson } = await import("../time-travel/timeline");
        const { adapter, cleanup } = await findAndOpenDb();
        try {
          if (c.options.tree) {
            const tree = await buildTimelineTree(adapter, c.args.runId);
            if (c.options.json) {
              console.log(JSON.stringify(formatTimelineAsJson(tree), null, 2));
            } else {
              console.log(formatTimelineForTui(tree));
            }
            return c.ok({ timeline: formatTimelineAsJson(tree) });
          }
          const timeline = await buildTimeline(adapter, c.args.runId);
          const tree = { timeline, children: [] };
          if (c.options.json) {
            console.log(JSON.stringify(formatTimelineAsJson(tree), null, 2));
          } else {
            console.log(formatTimelineForTui(tree));
          }
          return c.ok({ timeline: formatTimelineAsJson(tree) });
        } finally {
          cleanup();
        }
      } catch (err: any) {
        return fail({ code: "TIMELINE_FAILED", message: err?.message ?? String(err), exitCode: 1 });
      }
    },
  })

  .command(workflowCli)
  .command(cronCli)
  .command(ragCli)

  .command(memoryCli)
  .command(openapiCli);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS = new Set([
  "init", "up", "supervise", "down", "ps", "logs", "events", "chat", "inspect", "node", "why", "approve", "deny",
  "cancel", "graph", "revert", "scores", "observability", "workflow", "ask", "cron",
  "replay", "diff", "fork", "timeline", "rag", "memory", "openapi",
]);

const BUILTIN_FLAGS_WITH_VALUES = new Set([
  "--format",
  "--filter-output",
  "--token-limit",
  "--token-offset",
]);

const WORKFLOW_UTILITY_COMMANDS = new Set([
  "run",
  "list",
  "path",
  "create",
  "doctor",
]);

type McpSurface = "semantic" | "raw" | "both";

function normalizeMcpSurface(value: string | undefined): McpSurface {
  const surface = value?.trim().toLowerCase();
  if (surface === undefined || surface.length === 0) {
    throw new Error("Missing value for --surface. Expected semantic, raw, or both.");
  }
  if (surface === "semantic" || surface === "raw" || surface === "both") {
    return surface;
  }
  throw new Error(`Invalid --surface value: ${value}. Expected semantic, raw, or both.`);
}

function parseMcpSurfaceArgv(argv: string[]) {
  let surface: McpSurface = "semantic";
  const filtered: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--surface") {
      surface = normalizeMcpSurface(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--surface=")) {
      surface = normalizeMcpSurface(arg.slice("--surface=".length));
      continue;
    }
    filtered.push(arg);
  }

  return { surface, argv: filtered };
}

function registerRawToolsOnMcpServer(
  server: ReturnType<typeof createSemanticMcpServer>,
) {
  const commands = (Cli as any).toCommands?.get(cli as any);
  if (!(commands instanceof Map)) {
    throw new Error("Could not resolve Smithers CLI commands for raw MCP surface.");
  }

  for (const tool of IncurMcp.collectTools(commands, [])) {
    const mergedShape = {
      ...(tool.command.args?.shape ?? {}),
      ...(tool.command.options?.shape ?? {}),
    };
    const hasInput = Object.keys(mergedShape).length > 0;

    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : undefined),
        ...(hasInput ? { inputSchema: mergedShape } : undefined),
      },
      async (...callArgs: any[]) => {
        const params = hasInput ? callArgs[0] : {};
        const extra = hasInput ? callArgs[1] : callArgs[0];
        return IncurMcp.callTool(tool, params, extra);
      },
    );
  }
}

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

  const prefix = argv.slice(0, workflowIndex + 1);

  try {
    const workflow = resolveWorkflow(subcommand, process.cwd());
    return [
      ...prefix,
      "run",
      workflow.id,
      ...argv.slice(subcommandIndex + 1),
    ];
  } catch {
    return argv;
  }
}

function rewriteEventsJsonFlagArgv(argv: string[]) {
  const commandIndex = findFirstPositionalIndex(argv);
  if (commandIndex < 0 || argv[commandIndex] !== "events") {
    return argv;
  }

  return argv.map((arg) => (arg === "--json" ? "-j" : arg));
}

async function main() {
  const rawArgv = process.argv.slice(2);
  let argv = rawArgv.map((arg) => (arg === "-v" ? "--version" : arg));
  argv = rewriteWorkflowCommandArgv(argv);
  argv = rewriteEventsJsonFlagArgv(argv);

  // Allow running workflow files directly: `smithers workflow.tsx` → `smithers up workflow.tsx`
  const firstPositionalIndex = findFirstPositionalIndex(argv);
  const firstPositional = firstPositionalIndex >= 0 ? argv[firstPositionalIndex] : undefined;
  if (
    firstPositional &&
    !KNOWN_COMMANDS.has(firstPositional) &&
    firstPositional.endsWith(".tsx")
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
      const mcpArgs = parseMcpSurfaceArgv(argv);
      if (mcpArgs.surface === "raw") {
        await cli.serve(mcpArgs.argv);
      } else {
        const server = createSemanticMcpServer({
          name: "smithers",
          version: readPackageVersion(),
        });
        if (mcpArgs.surface === "both") {
          registerRawToolsOnMcpServer(server);
        }
        const transport = new StdioServerTransport(process.stdin, process.stdout);
        await server.connect(transport);
      }
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
