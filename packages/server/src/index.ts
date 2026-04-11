import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve, dirname, sep, basename } from "node:path";
import { Effect } from "effect";
import { isRunHeartbeatFresh, runWorkflow } from "@smithers/engine";
import { newRunId } from "@smithers/driver/newRunId";
import type { SmithersWorkflow } from "@smithers/react/SmithersWorkflow";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { Metric } from "effect";
import { fromPromise } from "@smithers/driver/interop";
import { logError, logInfo, logWarning } from "@smithers/observability/logging";
import { runPromise, runSync } from "./smithersRuntime";
import { httpRequests, httpRequestDuration, trackEvent } from "@smithers/observability/metrics";
import { approveNode, denyNode } from "@smithers/engine/approvals";
import { signalRun } from "@smithers/engine/signals";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { nowMs } from "@smithers/scheduler/nowMs";
import { errorToJson } from "@smithers/errors/errorToJson";
import { SmithersError } from "@smithers/errors/SmithersError";
import { assertMaxBytes, assertMaxJsonDepth } from "@smithers/db/input-bounds";
import {
  prometheusContentType,
  renderPrometheusMetrics,
} from "@smithers/observability";

type RunRecord = {
  workflow: SmithersWorkflow<any>;
  abort: AbortController;
  workflowPath: string;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

const runs = new Map<string, RunRecord>();
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_BODY_JSON_DEPTH = 32;
const DEFAULT_SSE_HEARTBEAT_MS = 10_000;
const COMPLETED_RUN_RETENTION_MS = 60_000;

type HttpErrorCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "SERVER_ERROR"
  | "UNAUTHORIZED"
  | "WORKFLOW_PATH_OUTSIDE_ROOT"
  | "RUN_ID_REQUIRED"
  | "RUN_ALREADY_EXISTS"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_ACTIVE"
  | "NOT_FOUND"
  | "DB_NOT_CONFIGURED";

class HttpError extends Error {
  status: number;
  code: HttpErrorCode;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: HttpErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Expected a positive integer, got "${value}"`,
    );
  }
  return Math.floor(num);
}

function parseOptionalInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Expected a number, got "${value}"`,
    );
  }
  return Math.floor(num);
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
  maxDepth: number,
): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  const lengthHeader = req.headers["content-length"];
  if (lengthHeader) {
    const len = Array.isArray(lengthHeader)
      ? Number(lengthHeader[0])
      : Number(lengthHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds ${maxBytes} bytes`,
        { maxBytes },
      );
    }
  }
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds ${maxBytes} bytes`,
        { maxBytes },
      );
    }
    chunks.push(buf);
  }
  const bodyBuffer = Buffer.concat(chunks);
  try {
    assertMaxBytes("request body", bodyBuffer, maxBytes);
  } catch (error) {
    if (error instanceof SmithersError) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", error.message, {
        maxBytes,
      });
    }
    throw error;
  }
  const body = bodyBuffer.toString("utf8");
  if (!body) return {};
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (err: any) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      err?.message ?? "Request body must be valid JSON",
    );
  }
  try {
    assertMaxJsonDepth("request body", parsed, maxDepth);
  } catch (error) {
    if (error instanceof SmithersError) {
      throw new HttpError(400, "INVALID_REQUEST", error.message, {
        maxDepth,
      });
    }
    throw error;
  }
  return parsed;
}

async function loadWorkflow(absPath: string): Promise<SmithersWorkflow<any>> {
  const source = await readFile(absPath);
  const version = createHash("sha1").update(source).digest("hex");
  const extIdx = absPath.lastIndexOf(".");
  const ext = extIdx >= 0 ? absPath.slice(extIdx) : "";
  const base = basename(absPath, ext);
  const shadowPath = resolve(dirname(absPath), `.${base}.smithers-${version}${ext}`);
  await writeFile(shadowPath, source);
  const mod = await import(pathToFileURL(shadowPath).href);
  if (!mod.default) throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function loadWorkflowEffect(absPath: string) {
  return fromPromise("load workflow module", () => loadWorkflow(absPath)).pipe(
    Effect.annotateLogs({ workflowPath: absPath }),
    Effect.withLogSpan("server:load-workflow"),
  );
}

function clearRunCleanupTimer(record: RunRecord | undefined) {
  if (!record?.cleanupTimer) return;
  clearTimeout(record.cleanupTimer);
  record.cleanupTimer = null;
}

function scheduleRunCleanup(runId: string) {
  const record = runs.get(runId);
  if (!record) return;
  clearRunCleanupTimer(record);
  record.cleanupTimer = setTimeout(() => {
    const current = runs.get(runId);
    if (current === record) {
      runs.delete(runId);
    }
  }, COMPLETED_RUN_RETENTION_MS);
}

function finalizeRunRecord(
  runId: string,
  status: string,
  hasServerDb: boolean,
) {
  if (
    hasServerDb ||
    (status !== "waiting-approval" && status !== "waiting-timer")
  ) {
    if (hasServerDb) {
      const record = runs.get(runId);
      clearRunCleanupTimer(record);
      runs.delete(runId);
      return;
    }
    scheduleRunCleanup(runId);
  }
}

function sendJson(res: ServerResponse, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

function sendText(
  res: ServerResponse,
  status: number,
  payload: string,
  contentType = "text/plain; charset=utf-8",
) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(payload);
}

function taggedMetric<A extends Metric.Metric<any, any, any>>(
  metric: A,
  tags: Record<string, string>,
): A {
  let tagged: any = metric;
  for (const [key, value] of Object.entries(tags)) {
    tagged = Metric.tagged(tagged, key, value);
  }
  return tagged as A;
}

function normalizeHttpMetricRoute(pathname: string): string {
  if (pathname === "/metrics" || pathname === "/health" || pathname === "/v1/runs") {
    return pathname;
  }
  if (
    pathname === "/v1/approval/list"
    || pathname === "/v1/approvals"
    || pathname === "/approval/list"
    || pathname === "/approvals"
  ) {
    return pathname;
  }
  if (/^\/v1\/runs\/[^/]+\/events$/.test(pathname)) return "/v1/runs/:runId/events";
  if (/^\/v1\/runs\/[^/]+\/frames$/.test(pathname)) return "/v1/runs/:runId/frames";
  if (/^\/v1\/runs\/[^/]+\/nodes\/[^/]+\/approve$/.test(pathname)) {
    return "/v1/runs/:runId/nodes/:nodeId/approve";
  }
  if (/^\/v1\/runs\/[^/]+\/nodes\/[^/]+\/deny$/.test(pathname)) {
    return "/v1/runs/:runId/nodes/:nodeId/deny";
  }
  if (/^\/v1\/runs\/[^/]+\/signals\/[^/]+$/.test(pathname)) {
    return "/v1/runs/:runId/signals/:signalName";
  }
  if (/^\/signal\/[^/]+\/[^/]+$/.test(pathname)) {
    return "/signal/:runId/:signalName";
  }
  if (/^\/v1\/runs\/[^/]+$/.test(pathname)) return "/v1/runs/:runId";
  return pathname;
}

function statusClass(statusCode: number): string {
  const normalized = Number.isFinite(statusCode) && statusCode > 0 ? statusCode : 500;
  return `${Math.floor(normalized / 100)}xx`;
}

function recordHttpRequestMetrics(
  method: string,
  pathname: string,
  statusCode: number,
  durationMs: number,
) {
  const tags = {
    method: method.toUpperCase(),
    route: normalizeHttpMetricRoute(pathname),
    status_code: String(statusCode),
    status_class: statusClass(statusCode),
  };
  return Effect.all([
    Metric.increment(taggedMetric(httpRequests, tags)),
    Metric.update(taggedMetric(httpRequestDuration, tags), durationMs),
  ], { discard: true });
}

async function recordHttpRequestMetricsSafely(
  method: string,
  pathname: string,
  statusCode: number,
  durationMs: number,
) {
  try {
    await runPromise(recordHttpRequestMetrics(method, pathname, statusCode, durationMs));
  } catch (error) {
    logWarning("failed to record server http metrics", {
      method: method.toUpperCase(),
      pathname,
      statusCode,
      error: error instanceof Error ? error.message : String(error),
    }, "server:metrics");
  }
}

function assertAuth(req: IncomingMessage, authToken?: string) {
  if (!authToken) return;
  const header =
    req.headers["authorization"] ??
    req.headers["Authorization"] ??
    req.headers["x-smithers-key"];
  const value = Array.isArray(header) ? header[0] : header;
  const token = value?.startsWith("Bearer ") ? value.slice(7) : value;
  if (!token || token !== authToken) {
    throw new HttpError(
      401,
      "UNAUTHORIZED",
      "Missing or invalid authorization token",
    );
  }
}

function resolveWorkflowPath(workflowPath: string, rootDir?: string): string {
  const base = rootDir ? resolve(rootDir) : process.cwd();
  const resolved = resolve(base, workflowPath);
  if (rootDir) {
    const root = resolve(rootDir);
    const rootPrefix = root.endsWith(sep) ? root : root + sep;
    if (resolved !== root && !resolved.startsWith(rootPrefix)) {
      throw new HttpError(
        400,
        "WORKFLOW_PATH_OUTSIDE_ROOT",
        "Workflow path must be within server root directory",
      );
    }
  }
  return resolved;
}

function getDbIdentity(db: any): string | undefined {
  const client = db?.$client;
  if (!client) return undefined;
  if (typeof client.filename === "string") return client.filename;
  if (typeof client.name === "string") return client.name;
  if (typeof client.dbname === "string") return client.dbname;
  return undefined;
}

function isSameDb(
  serverDb: BunSQLiteDatabase<any> | null,
  workflowDb: BunSQLiteDatabase<any>,
): boolean {
  if (!serverDb) return false;
  if (serverDb === workflowDb) return true;
  const serverId = getDbIdentity(serverDb);
  const workflowId = getDbIdentity(workflowDb);
  return Boolean(serverId && workflowId && serverId === workflowId);
}

function buildMirrorOnProgress(
  adapter: SmithersDb | null,
  runId: string,
  workflowName: string,
  workflowPath: string,
  configJson: string,
) {
  if (!adapter) return undefined;
  let runInserted = false;
  const ensureRun = async () => {
    if (runInserted) return;
    await adapter.insertRun({
      runId,
      workflowName,
      workflowPath,
      workflowHash: null,
      status: "running",
      createdAtMs: nowMs(),
      startedAtMs: nowMs(),
      finishedAtMs: null,
      heartbeatAtMs: eventLoopNow(),
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      vcsType: null,
      vcsRoot: null,
      vcsRevision: null,
      errorJson: null,
      configJson,
    });
    runInserted = true;
  };

  const mirrorEventEffect = (event: SmithersEvent) =>
    Effect.gen(function* () {
      yield* fromPromise("ensure mirrored run", () => ensureRun());
      yield* adapter.insertEventWithNextSeq({
        runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });
      switch (event.type) {
        case "RunStarted":
          yield* adapter.updateRun(runId, {
            status: "running",
            startedAtMs: event.timestampMs,
            heartbeatAtMs: event.timestampMs,
            cancelRequestedAtMs: null,
          });
          break;
        case "RunStatusChanged":
          yield* adapter.updateRun(runId, { status: event.status });
          break;
        case "RunContinuedAsNew":
          yield* adapter.updateRun(runId, {
            status: "continued",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          break;
        case "RunFinished":
          yield* adapter.updateRun(runId, {
            status: "finished",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          break;
        case "RunFailed":
          yield* adapter.updateRun(runId, {
            status: "failed",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            errorJson: JSON.stringify(errorToJson(event.error)),
          });
          break;
        case "RunCancelled":
          yield* adapter.updateRun(runId, {
            status: "cancelled",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          break;
        case "NodePending":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "pending",
            lastAttempt: null,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeWaitingApproval":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "waiting-approval",
            lastAttempt: null,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeWaitingTimer":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "waiting-timer",
            lastAttempt: null,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeStarted":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "in-progress",
            lastAttempt: event.attempt,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeFinished":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "finished",
            lastAttempt: event.attempt,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeFailed":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "failed",
            lastAttempt: event.attempt,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeCancelled":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "cancelled",
            lastAttempt: event.attempt ?? null,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeSkipped":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "skipped",
            lastAttempt: null,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
        case "NodeRetrying":
          yield* adapter.insertNode({
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            state: "in-progress",
            lastAttempt: event.attempt,
            updatedAtMs: event.timestampMs,
            outputTable: "",
            label: null,
          });
          break;
      }
    }).pipe(
      Effect.annotateLogs({
        runId,
        workflowName,
        workflowPath,
        eventType: event.type,
      }),
      Effect.withLogSpan("server:mirror-event"),
    );

  return (event: SmithersEvent) => {
    void runPromise(mirrorEventEffect(event)).catch((err) => {
      logError("mirror event persistence failed", {
        runId,
        workflowPath,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      }, "server:mirror-event");
    });
  };
}

function eventLoopNow() {
  return nowMs();
}

export type ServerOptions = {
  port?: number;
  db?: BunSQLiteDatabase<any>;
  authToken?: string;
  maxBodyBytes?: number;
  rootDir?: string;
  allowNetwork?: boolean;
};

function startServerInternal(opts: ServerOptions = {}) {
  const port = opts.port ?? 7331;
  const serverDb = opts.db ?? null;
  const authToken = opts.authToken ?? process.env.SMITHERS_API_KEY;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rootDir = opts.rootDir ? resolve(opts.rootDir) : undefined;
  const allowNetwork = Boolean(opts.allowNetwork);
  if (serverDb) {
    ensureSmithersTables(serverDb);
  }
  const serverAdapter = serverDb ? new SmithersDb(serverDb) : null;
  logInfo("starting smithers server", {
    port,
    rootDir: rootDir ?? null,
    allowNetwork,
    hasServerDb: Boolean(serverDb),
  }, "server:start");
  const server = createServer(async (req, res) => {
    const requestStart = performance.now();
    const requestMethod = req.method ?? "GET";
    let requestPathname = (req.url ?? "/").split("?")[0] ?? "/";
    try {
      assertAuth(req, authToken);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const method = requestMethod;
      requestPathname = url.pathname;

      if (method === "GET" && url.pathname === "/metrics") {
        return sendText(
          res,
          200,
          renderPrometheusMetrics(),
          prometheusContentType,
        );
      }

      function adapterForRun(runId: string): SmithersDb | null {
        if (serverAdapter) {
          const record = runs.get(runId);
          if (record) {
            return new SmithersDb(record.workflow.db as any);
          }
          return serverAdapter;
        }
        const record = runs.get(runId);
        if (!record) return null;
        return new SmithersDb(record.workflow.db as any);
      }

      if (method === "POST" && url.pathname === "/v1/runs") {
        const body = await readBody(
          req,
          maxBodyBytes,
          DEFAULT_MAX_BODY_JSON_DEPTH,
        );
        if (!body?.workflowPath || typeof body.workflowPath !== "string") {
          throw new HttpError(
            400,
            "INVALID_REQUEST",
            "workflowPath must be a string",
          );
        }
        if (
          body.input !== undefined &&
          (body.input === null ||
            typeof body.input !== "object" ||
            Array.isArray(body.input))
        ) {
          throw new HttpError(
            400,
            "INVALID_REQUEST",
            "input must be a JSON object",
          );
        }
        if (body.config?.maxConcurrency !== undefined) {
          const mc = Number(body.config.maxConcurrency);
          if (!Number.isFinite(mc) || mc <= 0) {
            throw new HttpError(
              400,
              "INVALID_REQUEST",
              "config.maxConcurrency must be a positive number",
            );
          }
        }
        const workflowPath = resolveWorkflowPath(body.workflowPath, rootDir);
        const workflow = await runPromise(loadWorkflowEffect(workflowPath));
        ensureSmithersTables(workflow.db as any);
        const sameDb = isSameDb(serverDb, workflow.db as any);
        const abort = new AbortController();
        if (body.resume && !body.runId) {
          throw new HttpError(
            400,
            "RUN_ID_REQUIRED",
            "runId is required when resume is true",
          );
        }
        const runId = body.runId ?? newRunId();
        const adapter = new SmithersDb(workflow.db as any);
        const existing = await adapter.getRun(runId);
        if (body.resume && existing && isRunHeartbeatFresh(existing)) {
          return sendJson(res, 200, { runId, status: "running" });
        }
        if (existing && !body.resume) {
          throw new HttpError(
            409,
            "RUN_ALREADY_EXISTS",
            "Run id already exists",
          );
        }
        if (body.resume && !existing) {
          throw new HttpError(404, "RUN_NOT_FOUND", "Run id does not exist");
        }
        const mirrorAdapter = serverAdapter && !sameDb ? serverAdapter : null;
        const effectiveRoot = rootDir ?? dirname(workflowPath);
        const workflowName = basename(workflowPath, ".tsx");
        const mirrorOnProgress = buildMirrorOnProgress(
          mirrorAdapter,
          runId,
          workflowName,
          workflowPath,
          JSON.stringify({
            maxConcurrency: body.config?.maxConcurrency ?? null,
            rootDir: effectiveRoot,
            allowNetwork,
          }),
        );
        const record: RunRecord = {
          workflow,
          abort,
          workflowPath,
          cleanupTimer: null,
        };
        runs.set(runId, record);
        logInfo("accepted run request", {
          runId,
          workflowPath,
          resume: Boolean(body.resume),
          sameDb,
        }, "server:run");

        runWorkflow(workflow, {
          runId,
          input: body.input ?? {},
          resume: body.resume ?? false,
          maxConcurrency: body.config?.maxConcurrency,
          signal: abort.signal,
          workflowPath,
          rootDir: effectiveRoot,
          allowNetwork,
          onProgress: mirrorOnProgress,
        })
          .then((result) => {
            finalizeRunRecord(result.runId, result.status, Boolean(serverDb));
          })
          .catch((err) => {
            logError("server run execution failed", {
              runId,
              workflowPath,
              error: err instanceof Error ? err.message : String(err),
            }, "server:run");
            clearRunCleanupTimer(runs.get(runId));
            runs.delete(runId);
          });

        sendJson(res, 200, { runId });
        return;
      }

      const resumeMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch) {
        const runId = resumeMatch[1]!;
        const body = await readBody(
          req,
          maxBodyBytes,
          DEFAULT_MAX_BODY_JSON_DEPTH,
        );
        if (!body?.workflowPath || typeof body.workflowPath !== "string") {
          throw new HttpError(
            400,
            "INVALID_REQUEST",
            "workflowPath must be a string",
          );
        }
        if (
          body.input !== undefined &&
          (body.input === null ||
            typeof body.input !== "object" ||
            Array.isArray(body.input))
        ) {
          throw new HttpError(
            400,
            "INVALID_REQUEST",
            "input must be a JSON object",
          );
        }
        if (body.config?.maxConcurrency !== undefined) {
          const mc = Number(body.config.maxConcurrency);
          if (!Number.isFinite(mc) || mc <= 0) {
            throw new HttpError(
              400,
              "INVALID_REQUEST",
              "config.maxConcurrency must be a positive number",
            );
          }
        }
        const workflowPath = resolveWorkflowPath(body.workflowPath, rootDir);
        const workflow = await runPromise(loadWorkflowEffect(workflowPath));
        ensureSmithersTables(workflow.db as any);
        const sameDb = isSameDb(serverDb, workflow.db as any);
        const adapter = new SmithersDb(workflow.db as any);
        const existing = await adapter.getRun(runId);
        if (!existing) {
          throw new HttpError(404, "RUN_NOT_FOUND", "Run id does not exist");
        }
        if (isRunHeartbeatFresh(existing)) {
          return sendJson(res, 200, { runId, status: "running" });
        }
        const abort = new AbortController();
        const record: RunRecord = {
          workflow,
          abort,
          workflowPath,
          cleanupTimer: null,
        };
        runs.set(runId, record);
        logInfo("accepted run resume request", {
          runId,
          workflowPath,
          sameDb,
        }, "server:resume");
        const mirrorAdapter = serverAdapter && !sameDb ? serverAdapter : null;
        const effectiveRoot = rootDir ?? dirname(workflowPath);
        const workflowName = basename(workflowPath, ".tsx");
        const mirrorOnProgress = buildMirrorOnProgress(
          mirrorAdapter,
          runId,
          workflowName,
          workflowPath,
          JSON.stringify({
            maxConcurrency: body.config?.maxConcurrency ?? null,
            rootDir: effectiveRoot,
            allowNetwork,
          }),
        );

        runWorkflow(workflow, {
          runId,
          input: body.input ?? {},
          resume: true,
          maxConcurrency: body.config?.maxConcurrency,
          signal: abort.signal,
          workflowPath,
          rootDir: effectiveRoot,
          allowNetwork,
          onProgress: mirrorOnProgress,
        })
          .then((result) => {
            finalizeRunRecord(runId, result.status, Boolean(serverDb));
          })
          .catch((err) => {
            logError("server resume execution failed", {
              runId,
              workflowPath,
              error: err instanceof Error ? err.message : String(err),
            }, "server:resume");
            clearRunCleanupTimer(runs.get(runId));
            runs.delete(runId);
          });

        sendJson(res, 200, { runId });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const runId = cancelMatch[1]!;
        const adapter = adapterForRun(runId);
        const record = runs.get(runId);
        if (!adapter) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        if (run.status === "waiting-approval" || run.status === "waiting-timer") {
          const cancelledAtMs = nowMs();
          const cancelEvent = {
            type: "RunCancelled" as const,
            runId,
            timestampMs: cancelledAtMs,
          };
          if (run.status === "waiting-timer") {
            const nodes = await adapter.listNodes(runId);
            for (const node of (nodes as any[]).filter((entry) => entry.state === "waiting-timer")) {
              const attempts = await adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0);
              const waitingAttempt = (attempts as any[]).find((attempt) => attempt.state === "waiting-timer");
              if (waitingAttempt) {
                await adapter.updateAttempt(
                  runId,
                  node.nodeId,
                  node.iteration ?? 0,
                  waitingAttempt.attempt,
                  { state: "cancelled", finishedAtMs: cancelledAtMs },
                );
                await adapter.insertNode({
                  runId,
                  nodeId: node.nodeId,
                  iteration: node.iteration ?? 0,
                  state: "cancelled",
                  lastAttempt: waitingAttempt.attempt,
                  updatedAtMs: cancelledAtMs,
                  outputTable: node.outputTable ?? "",
                  label: node.label ?? null,
                });
                const timerCancelledEvent = {
                  type: "TimerCancelled" as const,
                  runId,
                  timerId: node.nodeId,
                  timestampMs: cancelledAtMs,
                };
                await adapter.insertEventWithNextSeq({
                  runId,
                  timestampMs: cancelledAtMs,
                  type: "TimerCancelled",
                  payloadJson: JSON.stringify(timerCancelledEvent),
                });
                await runPromise(trackEvent(timerCancelledEvent));
              }
            }
          }
          logInfo("cancelling paused run", {
            runId,
            status: run.status,
          }, "server:cancel");
          await adapter.updateRun(runId, {
            status: "cancelled",
            finishedAtMs: cancelledAtMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          await adapter.insertEventWithNextSeq({
            runId,
            timestampMs: cancelledAtMs,
            type: "RunCancelled",
            payloadJson: JSON.stringify(cancelEvent),
          });
          await runPromise(trackEvent(cancelEvent));
          return sendJson(res, 200, { runId });
        }
        if (run.status !== "running" || !isRunHeartbeatFresh(run)) {
          logWarning("cancel rejected for inactive run", {
            runId,
            status: run.status,
            heartbeatAtMs: run.heartbeatAtMs ?? null,
          }, "server:cancel");
          return sendJson(res, 409, {
            error: { code: "RUN_NOT_ACTIVE", message: "Run is not currently active" },
          });
        }
        logInfo("cancelling active run", {
          runId,
          status: run.status,
        }, "server:cancel");
        await adapter.requestRunCancel(runId, nowMs());
        record?.abort.abort();
        return sendJson(res, 200, { runId });
      }

      const runEventsMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/events$/,
      );
      if (method === "GET" && runEventsMatch) {
        const runId = runEventsMatch[1]!;
        const adapter = adapterForRun(runId);
        if (!adapter) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
          "X-Accel-Buffering": "no",
        });
        res.write(`retry: 1000\n\n`);
        let closed = false;
        let lastSeq = parseOptionalInt(url.searchParams.get("afterSeq"), -1);
        logInfo("opened run event stream", {
          runId,
          afterSeq: lastSeq,
        }, "server:sse");
        let lastHeartbeat = Date.now();
        const poll = async () => {
          if (closed || res.writableEnded) return;
          const events = await adapter.listEvents(runId, lastSeq, 200);
          for (const ev of events) {
            const seq = typeof ev.seq === "number" ? ev.seq : Number(ev.seq);
            if (Number.isFinite(seq)) {
              lastSeq = seq;
            }
            if (res.writableEnded) break;
            res.write(`event: smithers\n`);
            res.write(`data: ${ev.payloadJson}\n\n`);
          }
          const now = Date.now();
          if (
            now - lastHeartbeat >= DEFAULT_SSE_HEARTBEAT_MS &&
            !res.writableEnded
          ) {
            res.write(`: keep-alive\n\n`);
            lastHeartbeat = now;
          }
          const runRow = await adapter.getRun(runId);
          if (
            runRow &&
            ["finished", "failed", "cancelled", "continued"].includes(runRow.status) &&
            events.length === 0
          ) {
            closed = true;
            res.end();
          }
        };
        req.on("close", () => {
          closed = true;
        });
        (async () => {
          try {
            while (!closed && !res.writableEnded) {
              await poll();
              await runPromise(Effect.sleep(500));
            }
          } catch {
            closed = true;
            if (!res.writableEnded) {
              res.end();
            }
          }
        })();
        return;
      }

      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const runId = runMatch[1]!;
        const adapter = adapterForRun(runId);
        if (!adapter) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        const summary = await adapter.countNodesByState(runId);
        return sendJson(res, 200, {
          runId,
          workflowName: run?.workflowName ?? "workflow",
          status: run?.status ?? "unknown",
          startedAtMs: run?.startedAtMs ?? null,
          finishedAtMs: run?.finishedAtMs ?? null,
          summary: summary.reduce((acc: any, row: any) => {
            acc[row.state] = row.count;
            return acc;
          }, {}),
        });
      }

      const framesMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/frames$/);
      if (method === "GET" && framesMatch) {
        const runId = framesMatch[1]!;
        const adapter = adapterForRun(runId);
        if (!adapter) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        }
        const limit = parsePositiveInt(url.searchParams.get("limit"), 50);
        const after = url.searchParams.get("afterFrameNo");
        const afterFrameNo = after ? parseOptionalInt(after, -1) : undefined;
        const frames = await adapter.listFrames(
          runId,
          limit,
          afterFrameNo !== undefined && afterFrameNo >= 0
            ? afterFrameNo
            : undefined,
        );
        return sendJson(res, 200, frames);
      }

      const approveMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/approve$/,
      );
      if (method === "POST" && approveMatch) {
        const runId = approveMatch[1]!;
        const nodeId = approveMatch[2]!;
        const body = await readBody(
          req,
          maxBodyBytes,
          DEFAULT_MAX_BODY_JSON_DEPTH,
        );
        const adapter = adapterForRun(runId);
        if (!adapter)
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        const run = await adapter.getRun(runId);
        if (!run)
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        await approveNode(
          adapter,
          runId,
          nodeId,
          body.iteration ?? 0,
          body.note,
          body.decidedBy,
        );
        return sendJson(res, 200, { runId });
      }

      const denyMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/deny$/,
      );
      if (method === "POST" && denyMatch) {
        const runId = denyMatch[1]!;
        const nodeId = denyMatch[2]!;
        const body = await readBody(
          req,
          maxBodyBytes,
          DEFAULT_MAX_BODY_JSON_DEPTH,
        );
        const adapter = adapterForRun(runId);
        if (!adapter)
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        const run = await adapter.getRun(runId);
        if (!run)
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        await denyNode(
          adapter,
          runId,
          nodeId,
          body.iteration ?? 0,
          body.note,
          body.decidedBy,
        );
        return sendJson(res, 200, { runId });
      }

      const signalMatch =
        url.pathname.match(/^\/v1\/runs\/([^/]+)\/signals\/([^/]+)$/) ??
        url.pathname.match(/^\/signal\/([^/]+)\/([^/]+)$/);
      if (method === "POST" && signalMatch) {
        const runId = signalMatch[1]!;
        const signalName = decodeURIComponent(signalMatch[2]!);
        const body = await readBody(
          req,
          maxBodyBytes,
          DEFAULT_MAX_BODY_JSON_DEPTH,
        );
        const adapter = adapterForRun(runId);
        if (!adapter)
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        const run = await adapter.getRun(runId);
        if (!run)
          return sendJson(res, 404, {
            error: { code: "NOT_FOUND", message: "Run not found" },
          });
        const delivered = await signalRun(
          adapter,
          runId,
          signalName,
          body.data ?? {},
          {
            correlationId:
              typeof body.correlationId === "string"
                ? body.correlationId
                : undefined,
            receivedBy:
              typeof body.receivedBy === "string" ? body.receivedBy : undefined,
          },
        );
        return sendJson(res, 200, delivered);
      }

      if (
        method === "GET" &&
        (
          url.pathname === "/v1/approval/list" ||
          url.pathname === "/v1/approvals" ||
          url.pathname === "/approval/list" ||
          url.pathname === "/approvals"
        )
      ) {
        if (!serverAdapter) {
          return sendJson(res, 400, {
            error: {
              code: "DB_NOT_CONFIGURED",
              message: "Server DB not configured",
            },
          });
        }

        const approvals = await runPromise(
          Effect.gen(function* () {
            const rows = yield* serverAdapter.listAllPendingApprovals();
            const now = nowMs();
            const mapped = rows.map((row: any) => {
              const requestedAtMs = row.requestedAtMs ?? null;
              return {
                runId: row.runId,
                nodeId: row.nodeId,
                iteration: row.iteration ?? 0,
                workflowName: row.workflowName ?? "workflow",
                runStatus: row.runStatus ?? null,
                label: row.nodeLabel ?? row.nodeId,
                requestTitle: row.nodeLabel ?? row.nodeId,
                requestSummary: row.note ?? null,
                requestedAtMs,
                waitingMs:
                  typeof requestedAtMs === "number" && Number.isFinite(requestedAtMs)
                    ? Math.max(0, now - requestedAtMs)
                    : 0,
                note: row.note ?? null,
                decidedBy: row.decidedBy ?? null,
              };
            });
            yield* Effect.logDebug("listed pending approvals").pipe(
              Effect.annotateLogs({ pendingCount: mapped.length }),
            );
            return mapped;
          }).pipe(Effect.withLogSpan("api:approvals:list")),
        );

        return sendJson(res, 200, { approvals });
      }

      if (method === "GET" && url.pathname === "/v1/runs") {
        if (!serverAdapter) {
          return sendJson(res, 400, {
            error: {
              code: "DB_NOT_CONFIGURED",
              message: "Server DB not configured",
            },
          });
        }
        const limit = parsePositiveInt(url.searchParams.get("limit"), 50);
        const status = url.searchParams.get("status") ?? undefined;
        const runs = await serverAdapter.listRuns(limit, status);
        return sendJson(res, 200, runs);
      }

      sendJson(res, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (err: any) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, {
          error: { code: err.code, message: err.message, details: err.details },
        });
        return;
      }
      sendJson(res, 500, {
        error: {
          code: "SERVER_ERROR",
          message: err?.message ?? "Unknown error",
        },
      });
    } finally {
      await recordHttpRequestMetricsSafely(
        requestMethod,
        requestPathname,
        res.statusCode || 500,
        performance.now() - requestStart,
      );
    }
  });

  server.on("close", () => {
    logInfo("stopping smithers server", {
      activeRuns: runs.size,
    }, "server:stop");
    for (const [runId, record] of runs) {
      try {
        record.abort.abort();
      } catch {}
      clearRunCleanupTimer(record);
      runs.delete(runId);
    }
  });

  server.listen(port);
  return server;
}

export function startServerEffect(opts: ServerOptions = {}) {
  return Effect.sync(() => startServerInternal(opts)).pipe(
    Effect.annotateLogs({
      port: opts.port ?? 7331,
      rootDir: opts.rootDir ?? "",
      allowNetwork: Boolean(opts.allowNetwork),
    }),
    Effect.withLogSpan("server:start"),
  );
}

export function startServer(opts: ServerOptions = {}) {
  return runSync(startServerEffect(opts));
}
