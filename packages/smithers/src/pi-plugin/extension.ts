/**
 * Smithers PI Extension
 *
 * Gives the PI coding agent full smithers knowledge and workflow observability.
 *
 * MCP bridge:
 *   - Spawns `smithers --mcp` as a child process
 *   - Bridges the live Smithers semantic MCP surface as `smithers_<tool>` PI tools
 *
 * System prompt:
 *   - Injects llms-full.txt (~125k tokens) so the LLM fully understands smithers
 *   - Injects contract-generated Smithers tool guidance plus active run context
 *
 * Commands (available to the user):
 *   /smithers          – Dashboard overlay (live-updating)
 *   /smithers-runs     – List all tracked runs
 *   /smithers-watch    – Attach live event stream to a run
 *   /smithers-approve  – Interactively approve/deny a waiting node
 *
 * UI:
 *   - Header: smithers branding
 *   - Footer: live run status with node progress
 *   - Widget: event stream ticker (above editor)
 *   - Custom message renderer for smithers events
 *   - Status bar: active run count + waiting approvals
 *
 * Observability:
 *   - Auto-polls active runs every 10s for status
 *   - Event stream subscription with reconnect
 *   - Duration tracking per node
 *   - Error aggregation
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  smithersMetricCatalog,
  toPrometheusMetricName,
  type SmithersMetricDefinition,
  type SmithersMetricUnit,
} from "@smithers/observability/metrics";
import { SmithersError } from "@smithers/core/errors";
import {
  createSmithersAgentContract,
  renderSmithersAgentPromptGuidance,
  type SmithersAgentContract,
} from "@smithers/agents/agent-contract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  workflowName: string;
  status: string;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  summary: Record<string, number>;
  nodes: Map<string, NodeState>;
  events: EventEntry[];
  errors: string[];
  lastPollMs: number;
}

interface NodeState {
  nodeId: string;
  state: string;
  iteration: number;
  attempt: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  output: string[];
}

interface EventEntry {
  type: string;
  nodeId?: string;
  message: string;
  timestampMs: number;
}

export type SmithersPiRunContext = {
  runId: string;
  workflowName: string;
  status: string;
  nodeStates: Array<{ nodeId: string; state: string }>;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Docs loader
// ---------------------------------------------------------------------------

let smithersDocs: string | undefined;

function loadSmithersDocs(): string {
  if (smithersDocs) return smithersDocs;

  const thisDir = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    resolve(thisDir, "../../docs/llms-full.txt"),
    resolve(thisDir, "../../../docs/llms-full.txt"),
    resolve(process.cwd(), "docs/llms-full.txt"),
    resolve(process.cwd(), "node_modules/smithers-orchestrator/docs/llms-full.txt"),
  ];

  for (const candidate of candidates) {
    try {
      smithersDocs = readFileSync(candidate, "utf8");
      return smithersDocs;
    } catch {
      // try next
    }
  }

  // Fallback: llms.txt
  const fallbacks = [
    resolve(thisDir, "../../docs/llms.txt"),
    resolve(thisDir, "../../../docs/llms.txt"),
    resolve(process.cwd(), "docs/llms.txt"),
    resolve(process.cwd(), "node_modules/smithers-orchestrator/docs/llms.txt"),
  ];

  for (const candidate of fallbacks) {
    try {
      smithersDocs = readFileSync(candidate, "utf8");
      return smithersDocs;
    } catch {
      // try next
    }
  }

  smithersDocs = "(Smithers docs not found — check that docs/llms-full.txt exists)";
  return smithersDocs;
}

// ---------------------------------------------------------------------------
// MCP bridge
// ---------------------------------------------------------------------------

let mcpClient: Client | undefined;
let mcpTransport: StdioClientTransport | undefined;
let smithersToolContract: SmithersAgentContract | undefined;

async function ensureMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  // Resolve the smithers CLI entry point
  const thisDir = dirname(new URL(import.meta.url).pathname);
  const cliPath = resolve(thisDir, "../cli/index.ts");

  mcpTransport = new StdioClientTransport({
    command: "bun",
    args: ["run", cliPath, "--mcp"],
    cwd: process.cwd(),
    stderr: "pipe",
  });

  mcpClient = new Client({ name: "smithers-pi-extension", version: "1.0.0" });
  await mcpClient.connect(mcpTransport);
  return mcpClient;
}

async function ensureSmithersToolContract(): Promise<SmithersAgentContract> {
  if (smithersToolContract) return smithersToolContract;

  const client = await ensureMcpClient();
  const { tools } = await client.listTools();
  smithersToolContract = createSmithersAgentContract({
    serverName: "smithers",
    toolSurface: "semantic",
    tools: tools
      .filter((tool) => tool.name !== "tui")
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
  });

  return smithersToolContract;
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const client = await ensureMcpClient();
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
  return { text, isError: result.isError === true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "http://127.0.0.1:7331";

let pi_ref: ExtensionAPI | undefined;

function getBase(): string {
  return (pi_ref?.getFlag("smithers-url") as string) ?? DEFAULT_BASE;
}

function getApiKey(): string | undefined {
  return (
    (pi_ref?.getFlag("smithers-key") as string) ??
    process.env.SMITHERS_API_KEY
  );
}

async function smithersFetch(
  base: string,
  path: string,
  opts?: { method?: string; body?: unknown; apiKey?: string },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const key = opts?.apiKey ?? getApiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;

  return fetch(`${base}${path}`, {
    method: opts?.method ?? "GET",
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function jsonFetch(
  base: string,
  path: string,
  opts?: { method?: string; body?: unknown; apiKey?: string },
) {
  const res = await smithersFetch(base, path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SmithersError(
      "PI_HTTP_ERROR",
      `Smithers HTTP ${res.status}: ${text}`,
      { baseUrl: base, path, status: res.status },
    );
  }
  return res.json();
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "running": return "▶";
    case "finished": return "✓";
    case "continued": return "↻";
    case "failed": return "✗";
    case "cancelled": return "◼";
    case "waiting-approval": return "⏳";
    case "waiting-timer": return "⏱";
    case "pending": return "○";
    case "in-progress": return "▶";
    case "skipped": return "⊘";
    default: return "?";
  }
}

function statusColor(
  status: string,
): "success" | "error" | "warning" | "accent" | "dim" | "muted" {
  switch (status) {
    case "running":
    case "in-progress": return "accent";
    case "finished": return "success";
    case "continued": return "dim";
    case "failed": return "error";
    case "cancelled": return "dim";
    case "waiting-approval": return "warning";
    case "waiting-timer": return "warning";
    case "pending": return "dim";
    default: return "muted";
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

type ParsedPrometheusSample = {
  type: string;
  help?: string;
  value: number;
  labels: Record<string, string>;
};

const metricCatalogByKey = new Map(
  smithersMetricCatalog.map((metric) => [metric.key, metric] as const),
);

const OVERLAY_COUNTER_GAUGE_KEYS = [
  "runsTotal",
  "activeRuns",
  "runsFinishedTotal",
  "runsFailedTotal",
  "runsCancelledTotal",
  "runsResumedTotal",
  "nodesStarted",
  "nodesFinished",
  "nodesFailed",
  "activeNodes",
  "nodeRetriesTotal",
  "tokensInputTotal",
  "tokensOutputTotal",
  "tokensCacheReadTotal",
  "tokensCacheWriteTotal",
  "tokensReasoningTotal",
  "agentTokensTotal",
  "toolCallsTotal",
  "toolCallErrorsTotal",
  "errorsTotal",
  "cacheHits",
  "cacheMisses",
  "approvalsRequested",
  "approvalsGranted",
  "approvalsDenied",
  "approvalPending",
  "hotReloads",
  "hotReloadFailures",
  "httpRequests",
  "dbRetries",
  "schedulerQueueDepth",
  "schedulerConcurrencyUtilization",
  "eventsEmittedTotal",
  "processUptimeSeconds",
  "processMemoryRssBytes",
  "processHeapUsedBytes",
] as const;

const OVERLAY_HISTOGRAM_KEYS = [
  "runDuration",
  "nodeDuration",
  "attemptDuration",
  "toolDuration",
  "agentDurationMs",
  "tokensInputPerCall",
  "tokensOutputPerCall",
  "tokensContextWindowPerCall",
  "promptSizeBytes",
  "responseSizeBytes",
  "approvalWaitDuration",
  "schedulerWaitDuration",
  "dbQueryDuration",
  "httpRequestDuration",
  "hotReloadDuration",
  "vcsDuration",
] as const;

function overlayMetricDefinitions(
  keys: readonly string[],
): SmithersMetricDefinition[] {
  return keys
    .map((key) => metricCatalogByKey.get(key))
    .filter((metric): metric is SmithersMetricDefinition => Boolean(metric));
}

function canonicalPrometheusMetricName(name: string): string {
  const suffixMatch = name.match(/(_bucket|_sum|_count)$/);
  if (!suffixMatch) return toPrometheusMetricName(name);
  const suffix = suffixMatch[1];
  return `${toPrometheusMetricName(name.slice(0, -suffix.length))}${suffix}`;
}

function parsePrometheusLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    labels[match[1]] = match[2]
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n");
  }
  return labels;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    return Math.round(value).toString();
  }
  return value.toFixed(2);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unitIndex = 0;
  while (Math.abs(current) >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${formatCompactNumber(current)}${units[unitIndex]}`;
}

function formatMetricValue(value: number, unit: SmithersMetricUnit | undefined): string {
  switch (unit) {
    case "bytes":
      return formatBytes(value);
    case "milliseconds":
      return `${formatCompactNumber(value)}ms`;
    case "seconds":
      return value >= 60 ? elapsed(value * 1000) : `${formatCompactNumber(value)}s`;
    case "ratio":
      return `${formatCompactNumber(value * 100)}%`;
    case "tokens":
      return formatCompactNumber(value);
    case "depth":
      return formatCompactNumber(value);
    case "count":
    default:
      return formatCompactNumber(value);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface MetricsSnapshot {
  raw: string;
  parsed: Map<string, ParsedPrometheusSample[]>;
  fetchedAtMs: number;
}

const runs = new Map<string, RunState>();
let activeRunId: string | undefined;
let pollInterval: ReturnType<typeof setInterval> | undefined;
let latestMetrics: MetricsSnapshot | undefined;

function parsePrometheusText(raw: string): MetricsSnapshot["parsed"] {
  const result = new Map<string, ParsedPrometheusSample[]>();
  const metricTypes = new Map<string, string>();
  const metricHelp = new Map<string, string>();

  for (const line of raw.split("\n")) {
    if (line.startsWith("# TYPE ")) {
      const match = line.match(/^# TYPE (\S+) (\S+)$/);
      if (match) {
        metricTypes.set(canonicalPrometheusMetricName(match[1]), match[2]);
      }
      continue;
    }
    if (line.startsWith("# HELP ")) {
      const match = line.match(/^# HELP (\S+) (.*)$/);
      if (match) {
        metricHelp.set(canonicalPrometheusMetricName(match[1]), match[2]);
      }
      continue;
    }
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([^{\s]+)(?:\{([^}]*)\})?\s+(.+)$/);
    if (!match) continue;

    const name = canonicalPrometheusMetricName(match[1]);
    const labels = parsePrometheusLabels(match[2]);
    const value = Number(match[3]);

    if (!result.has(name)) result.set(name, []);
    result.get(name)!.push({
      type: metricTypes.get(name) ?? "unknown",
      help: metricHelp.get(name),
      value,
      labels,
    });
  }
  return result;
}

async function fetchMetrics(): Promise<MetricsSnapshot | undefined> {
  const base = getBase();
  try {
    const res = await smithersFetch(base, "/metrics");
    if (!res.ok) return undefined;
    const raw = await res.text();
    latestMetrics = { raw, parsed: parsePrometheusText(raw), fetchedAtMs: Date.now() };
    return latestMetrics;
  } catch {
    return undefined;
  }
}

function trackRun(runId: string, workflowName = "unknown"): RunState {
  if (runs.has(runId)) return runs.get(runId)!;
  const state: RunState = {
    runId,
    workflowName,
    status: "running",
    startedAtMs: Date.now(),
    finishedAtMs: null,
    summary: {},
    nodes: new Map(),
    events: [],
    errors: [],
    lastPollMs: 0,
  };
  runs.set(runId, state);
  if (!activeRunId) activeRunId = runId;
  return state;
}

function pushEvent(run: RunState, entry: EventEntry) {
  run.events.push(entry);
  if (run.events.length > 200) run.events.splice(0, run.events.length - 200);
}

function getOrCreateNode(run: RunState, nodeId: string): NodeState {
  if (!run.nodes.has(nodeId)) {
    run.nodes.set(nodeId, {
      nodeId,
      state: "pending",
      iteration: 0,
      attempt: 0,
      startedAtMs: null,
      finishedAtMs: null,
      output: [],
    });
  }
  return run.nodes.get(nodeId)!;
}

function processEvent(run: RunState, event: { type: string; [k: string]: unknown }) {
  const ts = (event.timestampMs as number) ?? Date.now();
  const nodeId = event.nodeId as string | undefined;

  switch (event.type) {
    case "RunStarted":
      run.status = "running";
      run.startedAtMs = ts;
      pushEvent(run, { type: event.type, message: "Run started", timestampMs: ts });
      break;
    case "RunStatusChanged":
      run.status = event.status as string;
      pushEvent(run, { type: event.type, message: `Status → ${event.status}`, timestampMs: ts });
      break;
    case "RunFinished":
      run.status = "finished";
      run.finishedAtMs = ts;
      pushEvent(run, { type: event.type, message: "Run finished", timestampMs: ts });
      break;
    case "RunFailed":
      run.status = "failed";
      run.finishedAtMs = ts;
      run.errors.push(String(event.error ?? "unknown error"));
      pushEvent(run, { type: event.type, message: `Run failed: ${event.error}`, timestampMs: ts });
      break;
    case "RunCancelled":
      run.status = "cancelled";
      run.finishedAtMs = ts;
      pushEvent(run, { type: event.type, message: "Run cancelled", timestampMs: ts });
      break;
    case "RunContinuedAsNew":
      run.status = "continued";
      run.finishedAtMs = ts;
      pushEvent(
        run,
        {
          type: event.type,
          message: `Run continued as ${(event.newRunId as string | undefined) ?? "new run"}`,
          timestampMs: ts,
        },
      );
      break;
    case "NodeStarted":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "in-progress";
        node.iteration = (event.iteration as number) ?? 0;
        node.attempt = (event.attempt as number) ?? 0;
        node.startedAtMs = ts;
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} started (attempt ${node.attempt})`, timestampMs: ts });
      }
      break;
    case "NodeFinished":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "finished";
        node.finishedAtMs = ts;
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} finished`, timestampMs: ts });
      }
      break;
    case "NodeFailed":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "failed";
        node.finishedAtMs = ts;
        run.errors.push(`${nodeId}: ${event.error}`);
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} failed: ${event.error}`, timestampMs: ts });
      }
      break;
    case "NodeCancelled":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "cancelled";
        node.finishedAtMs = ts;
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} cancelled`, timestampMs: ts });
      }
      break;
    case "NodeSkipped":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "skipped";
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} skipped`, timestampMs: ts });
      }
      break;
    case "NodeRetrying":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "in-progress";
        node.attempt = (event.attempt as number) ?? node.attempt + 1;
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} retrying (attempt ${node.attempt})`, timestampMs: ts });
      }
      break;
    case "NodeWaitingApproval":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "waiting-approval";
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} waiting for approval`, timestampMs: ts });
      }
      break;
    case "NodeWaitingTimer":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        node.state = "waiting-timer";
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} waiting for timer`, timestampMs: ts });
      }
      break;
    case "ApprovalGranted":
      if (nodeId) pushEvent(run, { type: event.type, nodeId, message: `${nodeId} approved`, timestampMs: ts });
      break;
    case "ApprovalDenied":
      if (nodeId) pushEvent(run, { type: event.type, nodeId, message: `${nodeId} denied`, timestampMs: ts });
      break;
    case "ToolCallStarted":
      if (nodeId) pushEvent(run, { type: event.type, nodeId, message: `${nodeId} → ${event.toolName}()`, timestampMs: ts });
      break;
    case "ToolCallFinished":
      if (nodeId) {
        const icon = event.status === "success" ? "✓" : "✗";
        pushEvent(run, { type: event.type, nodeId, message: `${nodeId} → ${event.toolName}() ${icon}`, timestampMs: ts });
      }
      break;
    case "NodeOutput":
      if (nodeId) {
        const node = getOrCreateNode(run, nodeId);
        const text = (event.text as string) ?? "";
        node.output.push(text);
        if (node.output.length > 100) node.output.splice(0, node.output.length - 100);
      }
      break;
    case "FrameCommitted":
      pushEvent(run, { type: event.type, message: `Frame #${event.frameNo} committed`, timestampMs: ts });
      break;
    default:
      pushEvent(run, { type: event.type, nodeId, message: event.type, timestampMs: ts });
  }
}

// ---------------------------------------------------------------------------
// Background poller
// ---------------------------------------------------------------------------

async function pollActiveRuns(ctx: ExtensionContext) {
  const base = getBase();
  for (const run of runs.values()) {
    if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") continue;
    if (Date.now() - run.lastPollMs < 8000) continue;
    run.lastPollMs = Date.now();

    try {
      const data = await jsonFetch(base, `/v1/runs/${run.runId}`);
      run.status = data.status ?? run.status;
      run.workflowName = data.workflowName ?? run.workflowName;
      if (data.summary) run.summary = data.summary;
      if (data.startedAtMs) run.startedAtMs = data.startedAtMs;
      if (data.finishedAtMs) run.finishedAtMs = data.finishedAtMs;
    } catch {
      // Server unreachable
    }
  }

  // Also poll prometheus metrics
  await fetchMetrics();

  updateStatusBar(ctx);
}

function updateStatusBar(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  const activeRuns = [...runs.values()].filter(
    (r) => r.status === "running" || r.status === "waiting-approval" || r.status === "waiting-timer",
  );
  const waitingApproval = [...runs.values()].filter(
    (r) => r.status === "waiting-approval",
  );

  if (activeRuns.length === 0 && runs.size === 0) {
    ctx.ui.setStatus("smithers", undefined);
    return;
  }

  const parts: string[] = [];
  if (activeRuns.length > 0) parts.push(`${activeRuns.length} active`);
  if (waitingApproval.length > 0) parts.push(`${waitingApproval.length} awaiting approval`);
  const finished = [...runs.values()].filter((r) => r.status === "finished").length;
  const failed = [...runs.values()].filter((r) => r.status === "failed").length;
  if (finished > 0) parts.push(`${finished} done`);
  if (failed > 0) parts.push(`${failed} failed`);

  ctx.ui.setStatus("smithers", `smithers: ${parts.join(" · ")}`);
}

// ---------------------------------------------------------------------------
// Event stream subscriber
// ---------------------------------------------------------------------------

async function subscribeToEvents(runId: string, ctx: ExtensionContext, signal?: AbortSignal) {
  const base = getBase();
  const run = trackRun(runId);

  try {
    const res = await smithersFetch(base, `/v1/runs/${runId}/events`);
    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          try {
            processEvent(run, JSON.parse(line.slice(6)));
          } catch { /* malformed */ }
        }
      }

      updateStatusBar(ctx);
      updateEventTicker(ctx);
    }
  } catch {
    // Connection failed
  }
}

// ---------------------------------------------------------------------------
// Event ticker widget
// ---------------------------------------------------------------------------

function updateEventTicker(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  const run = activeRunId ? runs.get(activeRunId) : undefined;
  if (!run || run.events.length === 0) {
    ctx.ui.setWidget("smithers-ticker", undefined);
    return;
  }

  const recent = run.events.slice(-5);
  const lines = recent.map((e) => {
    const ts = new Date(e.timestampMs).toLocaleTimeString("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    return `  ${ts}  ${e.message}`;
  });

  ctx.ui.setWidget("smithers-ticker", lines, { placement: "aboveEditor" });
}

// ---------------------------------------------------------------------------
// Dashboard overlay
// ---------------------------------------------------------------------------

class SmithersDashboard {
  private theme: Theme;
  private onClose: () => void;
  private selectedRun: string | undefined;
  private selectedIndex = 0;
  private tab: "overview" | "nodes" | "events" | "errors" = "overview";
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, onClose: () => void) {
    this.theme = theme;
    this.onClose = onClose;
    this.selectedRun = activeRunId;
  }

  handleInput(data: string): void {
    this.cachedLines = undefined;
    if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.onClose(); return; }
    if (matchesKey(data, "1")) this.tab = "overview";
    if (matchesKey(data, "2")) this.tab = "nodes";
    if (matchesKey(data, "3")) this.tab = "events";
    if (matchesKey(data, "4")) this.tab = "errors";

    const runIds = [...runs.keys()];
    if (matchesKey(data, "j") || data === "\x1b[B") {
      this.selectedIndex = Math.min(this.selectedIndex + 1, runIds.length - 1);
      this.selectedRun = runIds[this.selectedIndex];
    }
    if (matchesKey(data, "k") || data === "\x1b[A") {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.selectedRun = runIds[this.selectedIndex];
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [];
    const W = Math.max(width, 40);

    lines.push("");
    const title = th.fg("accent", th.bold(" SMITHERS DASHBOARD "));
    lines.push(truncateToWidth(th.fg("border", "─".repeat(3)) + title + th.fg("border", "─".repeat(Math.max(0, W - 24))), W));
    lines.push("");

    const tabs = ["1:Overview", "2:Nodes", "3:Events", "4:Errors"];
    const tabLine = tabs.map((t) => {
      const [key, label] = t.split(":");
      const tabId = label.toLowerCase() as typeof this.tab;
      return tabId === this.tab ? th.fg("accent", th.bold(`[${key}] ${label}`)) : th.fg("dim", `[${key}] ${label}`);
    }).join("  ");
    lines.push(truncateToWidth(`  ${tabLine}`, W));
    lines.push(truncateToWidth(`  ${th.fg("border", "─".repeat(W - 4))}`, W));
    lines.push("");

    const run = this.selectedRun ? runs.get(this.selectedRun) : undefined;

    if (runs.size === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No runs tracked yet. Use /smithers-watch or the smithers_run tool.")}`, W));
    } else if (this.tab === "overview") {
      for (const [i, r] of [...runs.values()].entries()) {
        const sel = r.runId === this.selectedRun ? th.fg("accent", "▸ ") : "  ";
        const st = th.fg(statusColor(r.status), `${statusIcon(r.status)} ${r.status}`);
        const dur = r.startedAtMs ? th.fg("dim", elapsed((r.finishedAtMs ?? Date.now()) - r.startedAtMs)) : "";
        lines.push(truncateToWidth(`${sel}${st}  ${th.bold(r.workflowName)}  ${th.fg("dim", r.runId.slice(0, 8))}  ${dur}`, W));
        if (r.nodes.size > 0) {
          const byState = new Map<string, number>();
          for (const n of r.nodes.values()) byState.set(n.state, (byState.get(n.state) ?? 0) + 1);
          const nodeSummary = [...byState.entries()].map(([s, c]) => th.fg(statusColor(s), `${statusIcon(s)} ${c} ${s}`)).join("  ");
          lines.push(truncateToWidth(`    ${nodeSummary}`, W));
        }
        if (i < runs.size - 1) lines.push("");
      }
    } else if (run && this.tab === "nodes") {
      lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(run.workflowName))} ${th.fg("dim", run.runId.slice(0, 8))}`, W));
      lines.push("");
      if (run.nodes.size === 0) { lines.push(truncateToWidth(`  ${th.fg("dim", "No nodes yet")}`, W)); }
      else for (const node of run.nodes.values()) {
        const st = th.fg(statusColor(node.state), `${statusIcon(node.state)} ${node.state}`);
        const dur = node.startedAtMs ? th.fg("dim", elapsed((node.finishedAtMs ?? Date.now()) - node.startedAtMs)) : "";
        lines.push(truncateToWidth(`  ${st}  ${th.bold(node.nodeId)}  ${dur}`, W));
        for (const line of node.output.slice(-2)) lines.push(truncateToWidth(`    ${th.fg("dim", line.trimEnd())}`, W));
      }
    } else if (run && this.tab === "events") {
      lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(run.workflowName))} ${th.fg("dim", `${run.events.length} events`)}`, W));
      lines.push("");
      for (const e of run.events.slice(-20)) {
        const ts = new Date(e.timestampMs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const color = statusColor(
          e.type.includes("Fail")
            ? "failed"
            : e.type.includes("Finish")
              ? "finished"
              : e.type.includes("Start")
                ? "running"
                : e.type.includes("Approval")
                  ? "waiting-approval"
                  : e.type.includes("Timer")
                    ? "waiting-timer"
                    : "pending",
        );
        lines.push(truncateToWidth(`  ${th.fg("dim", ts)}  ${th.fg(color, e.message)}`, W));
      }
    } else if (run && this.tab === "errors") {
      lines.push(truncateToWidth(`  ${th.fg("accent", th.bold(run.workflowName))} ${th.fg("error", `${run.errors.length} errors`)}`, W));
      lines.push("");
      if (run.errors.length === 0) lines.push(truncateToWidth(`  ${th.fg("success", "No errors")}`, W));
      else for (const err of run.errors.slice(-15)) lines.push(truncateToWidth(`  ${th.fg("error", err)}`, W));
    } else {
      lines.push(truncateToWidth(`  ${th.fg("dim", "Select a run with j/k")}`, W));
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "j/k: select run  1-4: tabs  q/esc: close")}`, W));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
  dispose(): void {}
}

// ---------------------------------------------------------------------------
// MCP tool schema → TypeBox schema conversion
// ---------------------------------------------------------------------------

function jsonSchemaToTypebox(schema: Record<string, unknown>): Record<string, any> {
  const properties = (schema.properties ?? {}) as Record<string, any>;
  const required = new Set((schema.required ?? []) as string[]);
  const result: Record<string, any> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const desc = prop.description as string | undefined;
    const opts = desc ? { description: desc } : {};

    let field: any;
    switch (prop.type) {
      case "number":
      case "integer":
        field = Type.Number(opts);
        break;
      case "boolean":
        field = Type.Boolean(opts);
        break;
      case "array":
        field = Type.Array(Type.String(), opts);
        break;
      default:
        field = Type.String(opts);
    }

    result[key] = required.has(key) ? field : Type.Optional(field);
  }

  return result;
}

function toolRef(
  contract: SmithersAgentContract,
  name: string,
  prefix = "smithers_",
) {
  return contract.tools.some((tool) => tool.name === name)
    ? `\`${prefix}${name}\``
    : undefined;
}

function buildTypicalWorkflowGuidance(contract: SmithersAgentContract) {
  const discover = toolRef(contract, "list_workflows");
  const run = toolRef(contract, "run_workflow");
  const listRuns = toolRef(contract, "list_runs");
  const getRun = toolRef(contract, "get_run");
  const watchRun = toolRef(contract, "watch_run");
  const explainRun = toolRef(contract, "explain_run");
  const listApprovals = toolRef(contract, "list_pending_approvals");
  const resolveApproval = toolRef(contract, "resolve_approval");
  const getNodeDetail = toolRef(contract, "get_node_detail");
  const getRunEvents = toolRef(contract, "get_run_events");
  const listArtifacts = toolRef(contract, "list_artifacts");
  const getTranscript = toolRef(contract, "get_chat_transcript");
  const revertAttempt = toolRef(contract, "revert_attempt");

  const steps = [
    "**Write a workflow** -> Use your Smithers knowledge to help the user write workflow files.",
  ];

  if (discover && run) {
    steps.push(`**Run it** -> Use ${discover} to find workflow IDs, then ${run} to launch the workflow.`);
  } else if (run) {
    steps.push(`**Run it** -> Use ${run} to launch the workflow.`);
  }

  const monitorTools = [listRuns, getRun, watchRun, explainRun].filter(
    (value): value is string => Boolean(value),
  );
  if (monitorTools.length > 0) {
    steps.push(`**Monitor** -> Use ${monitorTools.join(", ")} to inspect progress, or tell the user about \`/smithers\`.`);
  }

  const approvalTools = [listApprovals, resolveApproval].filter(
    (value): value is string => Boolean(value),
  );
  if (approvalTools.length > 0) {
    steps.push(`**Approve** -> Use ${approvalTools.join(", ")} when runs are waiting for approval.`);
  }

  const debugTools = [
    getNodeDetail,
    getRunEvents,
    listArtifacts,
    getTranscript,
  ].filter((value): value is string => Boolean(value));
  if (debugTools.length > 0) {
    steps.push(`**Debug** -> Use ${debugTools.join(", ")} to gather evidence before changing anything.`);
  }

  if (revertAttempt) {
    steps.push(`**Revert** -> Use ${revertAttempt} only when the user explicitly asks to roll back or time travel.`);
  }

  return steps.map((step, index) => `${index + 1}. ${step}`);
}

export function buildSmithersPiSystemPrompt(
  baseSystemPrompt: string,
  docs: string,
  contract: SmithersAgentContract,
  activeRun?: SmithersPiRunContext,
) {
  const sections: string[] = [
    "\n\n# Smithers Documentation\n",
    "You are a Smithers workflow expert. Prefer the live Smithers tools over shelling out when they can answer the request.\n",
    "## Smithers PI Extension — User Guide\n",
    "The user is running PI with the Smithers extension. When they ask about capabilities, slash commands, or how to use this environment, refer to this section.\n",
    "### Tools (available to you, the agent)",
    renderSmithersAgentPromptGuidance(contract, { toolNamePrefix: "smithers_" }),
    "",
    "### Slash Commands (available to the user)",
    "Tell the user about these when they ask what they can do:",
    "- `/smithers` — Opens a full-screen dashboard overlay with 4 tabs (Overview, Nodes, Events, Errors). Navigate with j/k to select runs, 1-4 to switch tabs, q/Esc to close.",
    "- `/smithers-run <workflow>` — Quick-start a workflow. Prompts for workflow path and optional input JSON, then auto-attaches event stream.",
    "- `/smithers-resume <workflow>` — Resume a paused or crashed run. Prompts for workflow path and run ID.",
    "- `/smithers-runs` — Shows a selection list of all tracked runs. Selecting one makes it the active run for the event ticker.",
    "- `/smithers-status [runId]` — Show detailed status for a run. Defaults to active run if no ID given.",
    "- `/smithers-watch <runId>` — Attaches a live SSE event stream to a run by ID. Events appear in the ticker widget above the editor and update the dashboard in real-time.",
    "- `/smithers-logs [nodeId]` — Opens a scrollable log viewer for a node's stdout/stderr output. Supports j/k scrolling and g/G for top/bottom.",
    "- `/smithers-frames [runId]` — Browse render frames (DAG snapshots) for a run. Navigate frames with j/k, see task states, mounted IDs, and XML structure.",
    "- `/smithers-graph <workflow>` — Preview the execution graph for a workflow file without running it.",
    "- `/smithers-approve` — Interactive approval flow: shows all nodes waiting for approval, lets the user pick one, choose Approve/Deny, and add an optional note.",
    "- `/smithers-cancel [runId]` — Cancel a running workflow with confirmation. Shows a selection list if no ID given.",
    "- `/smithers-revert <workflow>` — Interactive revert: prompts for run ID, node ID, and attempt number, then reverts the workspace with confirmation.",
    "- `/smithers-list <workflow>` — List all runs from the database for a workflow file.",
    "- `/smithers-metrics` — Opens a Prometheus metrics overlay showing counters (runs, nodes, tool calls, cache hits, approvals, DB retries) and histogram percentiles (node duration, tool duration, DB query latency, HTTP latency). Press r to toggle raw Prometheus text output.",
    "",
    "### UI Features (always active)",
    "- **Header**: Shows \"smithers · workflow orchestrator\" branding at the top.",
    "- **Footer**: Shows live run count (active, awaiting approval, done, failed) and git branch.",
    "- **Event Ticker**: When a run is being watched, the 5 most recent events appear above the editor input, updating in real-time.",
    "- **Status Bar**: Shows count of active runs and pending approvals. A separate approval indicator appears when nodes need attention.",
    "- **Background Polling**: Active runs are polled every 10 seconds for status updates, even without an event stream attached. Prometheus metrics are also fetched on each poll cycle.",
    "- **Prometheus Metrics**: The extension fetches metrics from the smithers server's `/metrics` endpoint. View them with `/smithers-metrics`. Includes counters (runs, nodes, cache, approvals), gauges (active runs/nodes, queue depth), and histograms (node/tool/DB/HTTP durations with p50/p99).",
    "",
    "### Flags (passed via CLI)",
    "- `--smithers-url` / `-u` — Smithers server URL (default: http://127.0.0.1:7331)",
    "- `--smithers-key` / `-k` — Smithers API key (also reads SMITHERS_API_KEY env var)",
    "",
    "### Typical Workflows",
    ...buildTypicalWorkflowGuidance(contract),
    "",
    "---\n",
    docs,
  ];

  if (activeRun) {
    sections.push(`\n## Active Run Context`);
    sections.push(`Run: ${activeRun.runId} (${activeRun.workflowName})`);
    sections.push(`Status: ${activeRun.status}`);

    const waitingNodes = activeRun.nodeStates.filter((node) =>
      node.state === "waiting-approval" || node.state === "waiting-timer",
    );
    if (waitingNodes.length > 0) {
      sections.push(
        `Nodes waiting approval: ${waitingNodes.map((node) => node.nodeId).join(", ")}`,
      );
    }

    const recentErrors = activeRun.errors.slice(-3);
    if (recentErrors.length > 0) {
      sections.push(`Recent errors: ${recentErrors.join("; ")}`);
    }
  }

  return baseSystemPrompt + sections.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi_ref = pi;

  // -- Flags ----------------------------------------------------------------
  pi.registerFlag("smithers-url", {
    description: "Smithers server base URL (default: http://127.0.0.1:7331)",
    type: "string",
    default: DEFAULT_BASE,
  });

  pi.registerFlag("smithers-key", {
    description: "Smithers API key",
    type: "string",
    default: "",
  });

  // -- Session lifecycle ----------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    pollInterval = setInterval(() => pollActiveRuns(ctx), 10_000);

    // Connect to smithers MCP server and register tools
    try {
      const client = await ensureMcpClient();
      const { tools } = await client.listTools();
      smithersToolContract = createSmithersAgentContract({
        serverName: "smithers",
        toolSurface: "semantic",
        tools: tools
          .filter((tool) => tool.name !== "tui")
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
      });

      for (const tool of tools) {
        // Skip the tui command — that's us
        if (tool.name === "tui") continue;

        const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
        const typeboxProps = jsonSchemaToTypebox(inputSchema);

        pi.registerTool({
          name: `smithers_${tool.name}`,
          label: `Smithers ${tool.name}`,
          description: tool.description ?? `Run smithers ${tool.name.replace(/_/g, " ")}`,
          parameters: Type.Object(typeboxProps),

          async execute(_id, params, _signal, _onUpdate, _ctx) {
            // Filter out undefined optional params
            const cleanParams: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(params)) {
              if (v !== undefined) cleanParams[k] = v;
            }

            const result = await callMcpTool(tool.name, cleanParams);

            return {
              content: [{ type: "text", text: result.text }],
              details: { tool: tool.name, isError: result.isError },
            };
          },

          renderCall(args, theme) {
            const name = tool.name.replace(/_/g, " ");
            const argStr = Object.entries(args)
              .filter(([_, v]) => v !== undefined)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ");
            return new Text(
              theme.fg("toolTitle", theme.bold(`smithers ${name} `)) +
                theme.fg("muted", argStr),
              0, 0,
            );
          },

          renderResult(result, _opts, theme) {
            const details = result.details as { tool: string; isError: boolean } | undefined;
            if (details?.isError) {
              const text = result.content[0];
              return new Text(theme.fg("error", `✗ ${text?.type === "text" ? text.text : "error"}`), 0, 0);
            }
            return new Text("", 0, 0);
          },
        });
      }
    } catch (err) {
      // MCP connection failed — tools won't be available but UI still works
      if (ctx.hasUI) {
        ctx.ui.notify(`Smithers MCP: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    }

    if (ctx.hasUI) {
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number): string[] {
          const logo = theme.fg("accent", theme.bold("smithers"));
          const sep = theme.fg("dim", " · ");
          const sub = theme.fg("muted", "workflow orchestrator");
          return [truncateToWidth(` ${logo}${sep}${sub}`, width)];
        },
        invalidate() {},
      }));

      ctx.ui.setFooter((_tui, theme, footerData) => ({
        render(width: number): string[] {
          const statuses = footerData.getExtensionStatuses();
          const smithersStatus = statuses.get("smithers") ?? "";
          const branch = footerData.getGitBranch();
          const branchText = branch ? theme.fg("dim", ` ${branch}`) : "";
          const left = smithersStatus
            ? ` ${theme.fg("accent", "◆")} ${theme.fg("muted", smithersStatus)}`
            : ` ${theme.fg("dim", "smithers: idle")}`;
          const right = branchText;
          const padding = Math.max(0, width - stripAnsi(left).length - stripAnsi(right).length);
          return [truncateToWidth(left + " ".repeat(padding) + right, width)];
        },
        invalidate() {},
      }));
    }

    updateStatusBar(ctx);
  });

  pi.on("session_shutdown", async () => {
    if (pollInterval) clearInterval(pollInterval);
    // Clean up MCP connection
    if (mcpTransport) {
      try { await mcpTransport.close(); } catch {}
      mcpClient = undefined;
      mcpTransport = undefined;
    }
    smithersToolContract = undefined;
  });

  // -- System prompt: inject full smithers docs -----------------------------

  pi.on("before_agent_start", async (event) => {
    const docs = loadSmithersDocs();
    const contract = await ensureSmithersToolContract();
    const activeRun = activeRunId ? runs.get(activeRunId) : undefined;
    return {
      systemPrompt: buildSmithersPiSystemPrompt(
        event.systemPrompt,
        docs,
        contract,
        activeRun
          ? {
              runId: activeRun.runId,
              workflowName: activeRun.workflowName,
              status: activeRun.status,
              nodeStates: [...activeRun.nodes.values()],
              errors: activeRun.errors,
            }
          : undefined,
      ),
    };
  });

  // -- Approval notifications -----------------------------------------------

  pi.on("turn_start", async (_event, ctx) => {
    const waiting: string[] = [];
    for (const run of runs.values()) {
      for (const node of run.nodes.values()) {
        if (node.state === "waiting-approval" || node.state === "waiting-timer") waiting.push(`${run.workflowName}/${node.nodeId}`);
      }
    }
    if (waiting.length > 0 && ctx.hasUI) {
      ctx.ui.setStatus("smithers-approval", `⏳ ${waiting.length} node(s) awaiting approval`);
    } else {
      ctx.ui.setStatus("smithers-approval", undefined);
    }
  });

  // -- Commands -------------------------------------------------------------

  pi.registerCommand("smithers", {
    description: "Open the Smithers workflow dashboard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/smithers requires interactive mode", "error"); return; }
      await pollActiveRuns(ctx);
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => new SmithersDashboard(theme, () => done()));
    },
  });

  pi.registerCommand("smithers-runs", {
    description: "List all tracked Smithers runs",
    handler: async (_args, ctx) => {
      if (runs.size === 0) { ctx.ui.notify("No runs tracked", "info"); return; }
      const runList = [...runs.values()];
      const options = runList.map((r) => `${statusIcon(r.status)} ${r.workflowName} (${r.runId.slice(0, 8)}) — ${r.status}`);
      const selected = await ctx.ui.select("Smithers Runs", options);
      if (selected !== undefined) {
        const idx = options.indexOf(selected);
        if (idx >= 0) {
          activeRunId = runList[idx].runId;
          updateEventTicker(ctx);
          ctx.ui.notify(`Active run: ${runList[idx].workflowName} (${activeRunId!.slice(0, 8)})`, "info");
        }
      }
    },
  });

  pi.registerCommand("smithers-watch", {
    description: "Attach to a Smithers run event stream by run ID",
    getArgumentCompletions(prefix: string) {
      return [...runs.keys()]
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: `${runs.get(id)!.workflowName} (${id.slice(0, 8)})` }));
    },
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        const id = await ctx.ui.input("Run ID", "Enter the Smithers run ID to watch");
        if (!id) return;
        activeRunId = id;
        trackRun(id);
        subscribeToEvents(id, ctx);
        ctx.ui.notify(`Watching run ${id.slice(0, 8)}`, "info");
        return;
      }
      activeRunId = runId;
      trackRun(runId);
      subscribeToEvents(runId, ctx);
      ctx.ui.notify(`Watching run ${runId.slice(0, 8)}`, "info");
    },
  });

  pi.registerCommand("smithers-approve", {
    description: "Interactively approve or deny a waiting node",
    handler: async (_args, ctx) => {
      const waiting: Array<{ runId: string; nodeId: string; workflowName: string }> = [];
      for (const run of runs.values()) {
        for (const node of run.nodes.values()) {
          if (node.state === "waiting-approval") waiting.push({ runId: run.runId, nodeId: node.nodeId, workflowName: run.workflowName });
        }
      }
      if (waiting.length === 0) { ctx.ui.notify("No nodes waiting for approval", "info"); return; }

      const options = waiting.map((w) => `${w.workflowName} → ${w.nodeId} (${w.runId.slice(0, 8)})`);
      const selected = await ctx.ui.select("Select node to review", options);
      if (selected === undefined) return;
      const target = waiting[options.indexOf(selected)];

      const action = await ctx.ui.select("Action", ["Approve", "Deny", "Cancel"]);
      if (!action || action === "Cancel") return;

      const note = await ctx.ui.input("Note (optional)");
      const base = getBase();

      if (action === "Approve") {
        await jsonFetch(base, `/v1/runs/${target.runId}/nodes/${target.nodeId}/approve`, { method: "POST", body: { iteration: 0, note: note ?? undefined } });
        ctx.ui.notify(`Approved ${target.nodeId}`, "info");
      } else {
        await jsonFetch(base, `/v1/runs/${target.runId}/nodes/${target.nodeId}/deny`, { method: "POST", body: { iteration: 0, note: note ?? undefined } });
        ctx.ui.notify(`Denied ${target.nodeId}`, "warning");
      }
      updateStatusBar(ctx);
    },
  });

  // /smithers-metrics — prometheus metrics overlay
  pi.registerCommand("smithers-metrics", {
    description: "Show live Prometheus metrics from the Smithers server",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/smithers-metrics requires interactive mode", "error"); return; }

      const snapshot = await fetchMetrics();
      if (!snapshot) { ctx.ui.notify("Could not fetch metrics — is the smithers server running?", "warning"); return; }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        const keyMetrics = overlayMetricDefinitions(OVERLAY_COUNTER_GAUGE_KEYS);
        const histogramMetrics = overlayMetricDefinitions(OVERLAY_HISTOGRAM_KEYS);

        let showRaw = false;
        let cachedLines: string[] | undefined;
        let cachedWidth: number | undefined;

        return {
          handleInput(data: string): void {
            cachedLines = undefined;
            if (matchesKey(data, "escape") || matchesKey(data, "q")) { done(); return; }
            if (matchesKey(data, "r")) showRaw = !showRaw;
          },

          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const th = theme;
            const lines: string[] = [];
            const W = Math.max(width, 40);

            lines.push("");
            const title = th.fg("accent", th.bold(" SMITHERS METRICS "));
            lines.push(truncateToWidth(th.fg("border", "─".repeat(3)) + title + th.fg("border", "─".repeat(Math.max(0, W - 22))), W));
            lines.push("");

            const age = snapshot ? elapsed(Date.now() - snapshot.fetchedAtMs) : "N/A";
            lines.push(truncateToWidth(`  ${th.fg("dim", `Last fetched: ${age} ago`)}`, W));
            lines.push("");

            if (showRaw) {
              lines.push(truncateToWidth(`  ${th.fg("accent", "Raw Prometheus output")}  ${th.fg("dim", "(r to toggle)")}`, W));
              lines.push("");
              for (const line of (snapshot?.raw ?? "").split("\n").slice(0, 50)) {
                lines.push(truncateToWidth(`  ${th.fg("muted", line)}`, W));
              }
            } else {
              // Key counters/gauges
              lines.push(truncateToWidth(`  ${th.fg("accent", th.bold("Counters & Gauges"))}  ${th.fg("dim", "(r for raw)")}`, W));
              lines.push("");

              for (const metric of keyMetrics) {
                const entries = snapshot?.parsed.get(metric.prometheusName);
                if (!entries || entries.length === 0) continue;
                const total = entries.reduce((sum, entry) => sum + (entry.value || 0), 0);
                const val = formatMetricValue(total, metric.unit);
                const color = metric.key.includes("failed")
                  || metric.key.includes("failures")
                  || metric.key.includes("errors")
                  || metric.key.includes("denied")
                  ? (total > 0 ? "error" : "dim")
                  : total > 0 ? "success" : "dim";
                lines.push(truncateToWidth(`  ${th.fg(color, val.padStart(8))}  ${th.fg("muted", metric.label)}`, W));
              }

              lines.push("");
              lines.push(truncateToWidth(`  ${th.fg("accent", th.bold("Histograms (p50 / p99 / count)"))}`, W));
              lines.push("");

              for (const metric of histogramMetrics) {
                const sumEntries = snapshot?.parsed.get(`${metric.prometheusName}_sum`);
                const countEntries = snapshot?.parsed.get(`${metric.prometheusName}_count`);
                const bucketEntries = snapshot?.parsed.get(`${metric.prometheusName}_bucket`);

                if (!countEntries) continue;
                const count = countEntries.reduce((sum, entry) => sum + (entry.value || 0), 0);
                if (count === 0) continue;

                const sum = sumEntries?.reduce((total, entry) => total + (entry.value || 0), 0) ?? 0;
                const avg = count > 0 ? sum / count : 0;

                let p50: number | undefined;
                let p99: number | undefined;
                if (bucketEntries && bucketEntries.length > 0) {
                  const bucketTotals = new Map<number, number>();
                  for (const entry of bucketEntries) {
                    const boundary = Number(entry.labels.le ?? "NaN");
                    if (!Number.isFinite(boundary)) continue;
                    bucketTotals.set(boundary, (bucketTotals.get(boundary) ?? 0) + entry.value);
                  }
                  const sorted = [...bucketTotals.entries()]
                    .map(([boundary, bucketCount]) => ({ boundary, count: bucketCount }))
                    .sort((a, b) => a.boundary - b.boundary);

                  const target50 = count * 0.5;
                  const target99 = count * 0.99;
                  for (const bucket of sorted) {
                    if (bucket.count >= target50 && p50 === undefined) p50 = bucket.boundary;
                    if (bucket.count >= target99 && p99 === undefined) p99 = bucket.boundary;
                  }
                }

                lines.push(truncateToWidth(
                  `  ${th.fg("muted", metric.label.padEnd(28))} ` +
                  `${th.fg("accent", `p50=${p50 === undefined ? "?" : formatMetricValue(p50, metric.unit)}`.padEnd(16))} ` +
                  `${th.fg("warning", `p99=${p99 === undefined ? "?" : formatMetricValue(p99, metric.unit)}`.padEnd(16))} ` +
                  `${th.fg("dim", `avg=${formatMetricValue(avg, metric.unit)}  n=${formatCompactNumber(count)}`)}`,
                  W,
                ));
              }
            }

            lines.push("");
            lines.push(truncateToWidth(`  ${th.fg("dim", "r: toggle raw  q/esc: close")}`, W));
            lines.push("");

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          },

          invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
          dispose(): void {},
        };
      });
    },
  });

  // /smithers-status — show run status
  pi.registerCommand("smithers-status", {
    description: "Show detailed status for a run",
    getArgumentCompletions(prefix: string) {
      return [...runs.keys()]
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: `${runs.get(id)!.workflowName} (${id.slice(0, 8)})` }));
    },
    handler: async (args, ctx) => {
      let runId = args.trim();
      if (!runId) {
        if (activeRunId) { runId = activeRunId; }
        else {
          const id = await ctx.ui.input("Run ID", "Enter run ID to inspect");
          if (!id) return;
          runId = id;
        }
      }
      try {
        const result = await callMcpTool("status", { workflow: ".", runId });
        ctx.ui.notify(result.isError ? `Error: ${result.text}` : `Status for ${runId.slice(0, 8)}`, result.isError ? "error" : "info");
        if (!result.isError) ctx.ui.pasteToEditor(`smithers status: ${result.text}`);
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // /smithers-frames — browse render frames
  pi.registerCommand("smithers-frames", {
    description: "Browse render frames (DAG snapshots) for a run",
    getArgumentCompletions(prefix: string) {
      return [...runs.keys()]
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: `${runs.get(id)!.workflowName} (${id.slice(0, 8)})` }));
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/smithers-frames requires interactive mode", "error"); return; }

      let runId = args.trim();
      if (!runId) {
        if (activeRunId) { runId = activeRunId; }
        else {
          const id = await ctx.ui.input("Run ID", "Enter run ID");
          if (!id) return;
          runId = id;
        }
      }

      const base = getBase();
      let framesData: any[];
      try {
        const res = await jsonFetch(base, `/v1/runs/${runId}/frames?limit=50`);
        framesData = Array.isArray(res) ? res : [];
      } catch (err: any) {
        ctx.ui.notify(`Failed to fetch frames: ${err.message}`, "error");
        return;
      }

      if (framesData.length === 0) { ctx.ui.notify("No frames for this run", "info"); return; }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        let selectedIdx = framesData.length - 1; // Start at latest
        let cachedLines: string[] | undefined;
        let cachedWidth: number | undefined;

        return {
          handleInput(data: string): void {
            cachedLines = undefined;
            if (matchesKey(data, "escape") || matchesKey(data, "q")) { done(); return; }
            if (matchesKey(data, "j") || data === "\x1b[B") selectedIdx = Math.min(selectedIdx + 1, framesData.length - 1);
            if (matchesKey(data, "k") || data === "\x1b[A") selectedIdx = Math.max(selectedIdx - 1, 0);
          },
          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const th = theme;
            const lines: string[] = [];
            const W = Math.max(width, 40);

            lines.push("");
            const title = th.fg("accent", th.bold(` FRAMES — ${runId.slice(0, 8)} `));
            lines.push(truncateToWidth(th.fg("border", "─".repeat(3)) + title + th.fg("border", "─".repeat(Math.max(0, W - 20))), W));
            lines.push("");

            // Frame list
            for (let i = 0; i < framesData.length; i++) {
              const f = framesData[i];
              const sel = i === selectedIdx ? th.fg("accent", "▸ ") : "  ";
              const ts = new Date(f.createdAtMs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
              lines.push(truncateToWidth(`${sel}${th.fg("muted", `#${f.frameNo}`)}  ${th.fg("dim", ts)}  ${th.fg("dim", `hash: ${(f.xmlHash ?? "").slice(0, 12)}`)}`, W));
            }

            lines.push("");
            lines.push(truncateToWidth(`  ${th.fg("accent", th.bold("Frame Detail"))}`, W));
            lines.push("");

            // Show selected frame content
            const frame = framesData[selectedIdx];
            if (frame) {
              // Task index
              if (frame.taskIndexJson) {
                try {
                  const tasks = JSON.parse(frame.taskIndexJson);
                  if (Array.isArray(tasks)) {
                    for (const task of tasks) {
                      const st = task.state ?? "unknown";
                      const color = statusColor(st);
                      lines.push(truncateToWidth(`  ${th.fg(color, statusIcon(st))} ${th.fg("muted", task.nodeId ?? task.id ?? "?")} ${th.fg("dim", st)}`, W));
                    }
                  }
                } catch {}
              }
              // Mounted task IDs
              if (frame.mountedTaskIdsJson) {
                try {
                  const ids = JSON.parse(frame.mountedTaskIdsJson);
                  if (Array.isArray(ids) && ids.length > 0) {
                    lines.push("");
                    lines.push(truncateToWidth(`  ${th.fg("dim", `Mounted: ${ids.join(", ")}`)}`, W));
                  }
                } catch {}
              }
              // Note
              if (frame.note) {
                lines.push(truncateToWidth(`  ${th.fg("dim", `Note: ${frame.note}`)}`, W));
              }
              // XML snippet
              if (frame.xmlJson) {
                lines.push("");
                const xmlStr = typeof frame.xmlJson === "string" ? frame.xmlJson : JSON.stringify(frame.xmlJson);
                for (const line of xmlStr.split("\n").slice(0, 15)) {
                  lines.push(truncateToWidth(`  ${th.fg("dim", line)}`, W));
                }
                if (xmlStr.split("\n").length > 15) {
                  lines.push(truncateToWidth(`  ${th.fg("dim", `... (${xmlStr.split("\n").length - 15} more lines)`)}`, W));
                }
              }
            }

            lines.push("");
            lines.push(truncateToWidth(`  ${th.fg("dim", "j/k: navigate frames  q/esc: close")}`, W));
            lines.push("");

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          },
          invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
          dispose(): void {},
        };
      });
    },
  });

  // /smithers-graph — preview workflow DAG
  pi.registerCommand("smithers-graph", {
    description: "Preview the execution graph for a workflow file",
    handler: async (args, ctx) => {
      let workflow = args.trim();
      if (!workflow) {
        workflow = await ctx.ui.input("Workflow path", "e.g. ./workflows/deploy.tsx") ?? "";
        if (!workflow) return;
      }
      try {
        const result = await callMcpTool("graph", { workflow });
        if (result.isError) { ctx.ui.notify(`Error: ${result.text}`, "error"); return; }
        ctx.ui.pasteToEditor(`Workflow graph for ${workflow}:\n\`\`\`json\n${result.text}\n\`\`\``);
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // /smithers-cancel — cancel a run with confirmation
  pi.registerCommand("smithers-cancel", {
    description: "Cancel a running workflow",
    getArgumentCompletions(prefix: string) {
      return [...runs.values()]
        .filter((r) => r.status === "running" || r.status === "waiting-approval" || r.status === "waiting-timer")
        .filter((r) => r.runId.startsWith(prefix))
        .map((r) => ({ value: r.runId, label: `${r.workflowName} (${r.runId.slice(0, 8)})` }));
    },
    handler: async (args, ctx) => {
      let runId = args.trim();
      if (!runId) {
        const active = [...runs.values()].filter((r) => r.status === "running" || r.status === "waiting-approval" || r.status === "waiting-timer");
        if (active.length === 0) { ctx.ui.notify("No active runs to cancel", "info"); return; }
        const options = active.map((r) => `${statusIcon(r.status)} ${r.workflowName} (${r.runId.slice(0, 8)})`);
        const selected = await ctx.ui.select("Cancel which run?", options);
        if (selected === undefined) return;
        runId = active[options.indexOf(selected)].runId;
      }

      const confirmed = await ctx.ui.confirm("Cancel run?", `Cancel run ${runId.slice(0, 8)}? This cannot be undone.`);
      if (!confirmed) return;

      try {
        const base = getBase();
        await jsonFetch(base, `/v1/runs/${runId}/cancel`, { method: "POST", body: {} });
        const run = runs.get(runId);
        if (run) { run.status = "cancelled"; run.finishedAtMs = Date.now(); }
        updateStatusBar(ctx);
        ctx.ui.notify(`Cancelled run ${runId.slice(0, 8)}`, "warning");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // /smithers-logs — show node output logs
  pi.registerCommand("smithers-logs", {
    description: "Show output logs for a node in the active run",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("/smithers-logs requires interactive mode", "error"); return; }

      const runId = activeRunId;
      if (!runId) { ctx.ui.notify("No active run — use /smithers-watch first", "info"); return; }
      const run = runs.get(runId);
      if (!run || run.nodes.size === 0) { ctx.ui.notify("No nodes tracked yet", "info"); return; }

      let nodeId = args.trim();
      if (!nodeId) {
        const nodeOptions = [...run.nodes.values()].map(
          (n) => `${statusIcon(n.state)} ${n.nodeId} (${n.output.length} lines)`,
        );
        const selected = await ctx.ui.select("Select node", nodeOptions);
        if (selected === undefined) return;
        nodeId = [...run.nodes.values()][nodeOptions.indexOf(selected)].nodeId;
      }

      const node = run.nodes.get(nodeId);
      if (!node) { ctx.ui.notify(`Node ${nodeId} not found`, "error"); return; }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        let scrollOffset = Math.max(0, node.output.length - 30);
        let cachedLines: string[] | undefined;
        let cachedWidth: number | undefined;

        return {
          handleInput(data: string): void {
            cachedLines = undefined;
            if (matchesKey(data, "escape") || matchesKey(data, "q")) { done(); return; }
            if (matchesKey(data, "j") || data === "\x1b[B") scrollOffset = Math.min(scrollOffset + 1, Math.max(0, node.output.length - 10));
            if (matchesKey(data, "k") || data === "\x1b[A") scrollOffset = Math.max(scrollOffset - 1, 0);
            if (matchesKey(data, "g")) scrollOffset = 0;
            if (matchesKey(data, "shift+g")) scrollOffset = Math.max(0, node.output.length - 30);
          },
          render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const th = theme;
            const lines: string[] = [];
            const W = Math.max(width, 40);

            lines.push("");
            const st = th.fg(statusColor(node.state), `${statusIcon(node.state)} ${node.state}`);
            const title = th.fg("accent", th.bold(` LOGS — ${nodeId} `));
            lines.push(truncateToWidth(th.fg("border", "─".repeat(3)) + title + st + th.fg("border", "─".repeat(Math.max(0, W - 20 - nodeId.length))), W));
            lines.push(truncateToWidth(`  ${th.fg("dim", `${node.output.length} lines  offset: ${scrollOffset}`)}`, W));
            lines.push("");

            if (node.output.length === 0) {
              lines.push(truncateToWidth(`  ${th.fg("dim", "(no output captured)")}`, W));
            } else {
              const visible = node.output.slice(scrollOffset, scrollOffset + 30);
              for (const line of visible) {
                lines.push(truncateToWidth(`  ${th.fg("muted", line.trimEnd())}`, W));
              }
            }

            lines.push("");
            lines.push(truncateToWidth(`  ${th.fg("dim", "j/k: scroll  g/G: top/bottom  q/esc: close")}`, W));
            lines.push("");

            cachedWidth = width;
            cachedLines = lines;
            return lines;
          },
          invalidate(): void { cachedLines = undefined; cachedWidth = undefined; },
          dispose(): void {},
        };
      });
    },
  });

  // /smithers-run — quick-start a workflow
  pi.registerCommand("smithers-run", {
    description: "Start a smithers workflow",
    handler: async (args, ctx) => {
      let workflow = args.trim();
      if (!workflow) {
        workflow = await ctx.ui.input("Workflow path", "e.g. ./workflows/deploy.tsx") ?? "";
        if (!workflow) return;
      }
      const inputStr = await ctx.ui.input("Input JSON (optional)", '{}');
      try {
        const params: Record<string, unknown> = { workflow };
        if (inputStr && inputStr !== "{}") params.input = inputStr;
        const result = await callMcpTool("run", params);
        if (result.isError) { ctx.ui.notify(`Error: ${result.text}`, "error"); return; }
        // Parse runId from result and start watching
        try {
          const data = JSON.parse(result.text);
          if (data.runId) {
            const run = trackRun(data.runId, workflow.split("/").pop());
            activeRunId = data.runId;
            subscribeToEvents(data.runId, ctx);
            updateStatusBar(ctx);
            ctx.ui.notify(`Started ${workflow} — run ${data.runId.slice(0, 8)}`, "info");
            return;
          }
        } catch {}
        ctx.ui.notify(`Started: ${result.text}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // /smithers-resume — resume a paused/crashed run
  pi.registerCommand("smithers-resume", {
    description: "Resume a paused or crashed workflow run",
    handler: async (args, ctx) => {
      let workflow = args.trim();
      if (!workflow) {
        workflow = await ctx.ui.input("Workflow path", "e.g. ./workflows/deploy.tsx") ?? "";
        if (!workflow) return;
      }
      const runId = await ctx.ui.input("Run ID to resume");
      if (!runId) return;

      try {
        const result = await callMcpTool("resume", { workflow, runId });
        if (result.isError) { ctx.ui.notify(`Error: ${result.text}`, "error"); return; }
        const run = trackRun(runId, workflow.split("/").pop());
        activeRunId = runId;
        subscribeToEvents(runId, ctx);
        updateStatusBar(ctx);
        ctx.ui.notify(`Resumed run ${runId.slice(0, 8)}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // /smithers-revert — interactive revert
  pi.registerCommand("smithers-revert", {
    description: "Revert workspace to a previous task attempt's state",
    handler: async (args, ctx) => {
      let workflow = args.trim();
      if (!workflow) {
        workflow = await ctx.ui.input("Workflow path", "e.g. ./workflows/deploy.tsx") ?? "";
        if (!workflow) return;
      }
      const runId = await ctx.ui.input("Run ID");
      if (!runId) return;
      const nodeId = await ctx.ui.input("Node ID to revert to");
      if (!nodeId) return;
      const attemptStr = await ctx.ui.input("Attempt number", "1");
      const attempt = parseInt(attemptStr ?? "1", 10) || 1;

      const confirmed = await ctx.ui.confirm("Revert workspace?", `Revert to ${nodeId} attempt ${attempt} in run ${runId.slice(0, 8)}? This modifies the working directory.`);
      if (!confirmed) return;

      try {
        const result = await callMcpTool("revert", { workflow, runId, nodeId, attempt });
        if (result.isError) { ctx.ui.notify(`Error: ${result.text}`, "error"); return; }
        ctx.ui.notify(`Reverted to ${nodeId} attempt ${attempt}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // /smithers-list — list runs from the database
  pi.registerCommand("smithers-list", {
    description: "List workflow runs from the database",
    handler: async (args, ctx) => {
      let workflow = args.trim();
      if (!workflow) {
        workflow = await ctx.ui.input("Workflow path", "e.g. ./workflows/deploy.tsx") ?? "";
        if (!workflow) return;
      }
      try {
        const result = await callMcpTool("list", { workflow });
        if (result.isError) { ctx.ui.notify(`Error: ${result.text}`, "error"); return; }
        ctx.ui.pasteToEditor(`Smithers runs for ${workflow}:\n\`\`\`json\n${result.text}\n\`\`\``);
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });

  // -- Message renderer -----------------------------------------------------

  pi.registerMessageRenderer("smithers-event", (message, { expanded }, theme) => {
    const details = message.details as { runId?: string; status?: string } | undefined;
    if (!details) return undefined;
    const color = statusColor(details.status ?? "running");
    const icon = statusIcon(details.status ?? "running");
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : "[image]"))
            .join(" ");
    let text = `${theme.fg(color, icon)} ${theme.fg("muted", content)}`;
    if (expanded && details.runId) text += `\n${theme.fg("dim", `  run: ${details.runId}`)}`;
    return new Text(text, 0, 0);
  });
}
