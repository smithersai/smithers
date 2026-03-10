import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve, dirname, sep, basename } from "node:path";
import { isRunHeartbeatFresh, runWorkflow } from "../engine";
import { newRunId } from "../utils/ids";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { SmithersEvent } from "../SmithersEvent";
import { SmithersDb } from "../db/adapter";
import { ensureSmithersTables } from "../db/ensure";
import { approveNode, denyNode } from "../engine/approvals";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { nowMs } from "../utils/time";
import { errorToJson } from "../utils/errors";

type RunRecord = {
  workflow: SmithersWorkflow<any>;
  abort: AbortController;
  workflowPath: string;
};

const runs = new Map<string, RunRecord>();
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_SSE_HEARTBEAT_MS = 10_000;

class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
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

async function readBody(req: IncomingMessage, maxBytes: number): Promise<any> {
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
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (err: any) {
    throw new HttpError(
      400,
      "INVALID_JSON",
      err?.message ?? "Request body must be valid JSON",
    );
  }
}

async function loadWorkflow(absPath: string): Promise<SmithersWorkflow<any>> {
  const mod = await import(pathToFileURL(absPath).href);
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function sendJson(res: ServerResponse, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
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

  return (event: SmithersEvent) => {
    void (async () => {
      await ensureRun();
      await adapter.insertEventWithNextSeq({
        runId,
        timestampMs: event.timestampMs,
        type: event.type,
        payloadJson: JSON.stringify(event),
      });
      switch (event.type) {
        case "RunStarted":
          await adapter.updateRun(runId, {
            status: "running",
            startedAtMs: event.timestampMs,
            heartbeatAtMs: event.timestampMs,
            cancelRequestedAtMs: null,
          });
          break;
        case "RunStatusChanged":
          await adapter.updateRun(runId, { status: event.status });
          break;
        case "RunFinished":
          await adapter.updateRun(runId, {
            status: "finished",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          break;
        case "RunFailed":
          await adapter.updateRun(runId, {
            status: "failed",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            errorJson: JSON.stringify(errorToJson(event.error)),
          });
          break;
        case "RunCancelled":
          await adapter.updateRun(runId, {
            status: "cancelled",
            finishedAtMs: event.timestampMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
          });
          break;
        case "NodePending":
          await adapter.insertNode({
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
          await adapter.insertNode({
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
        case "NodeStarted":
          await adapter.insertNode({
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
          await adapter.insertNode({
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
          await adapter.insertNode({
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
          await adapter.insertNode({
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
          await adapter.insertNode({
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
          await adapter.insertNode({
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
    })().catch((err) => {
      console.error("[smithers] mirror event error:", err);
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

export function startServer(opts: ServerOptions = {}) {
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
  const server = createServer(async (req, res) => {
    try {
      assertAuth(req, authToken);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const method = req.method ?? "GET";

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
        const body = await readBody(req, maxBodyBytes);
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
        const workflow = await loadWorkflow(workflowPath);
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
        const record: RunRecord = { workflow, abort, workflowPath };
        runs.set(runId, record);

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
            const id = result.runId;
            if (serverDb || result.status !== "waiting-approval") {
              runs.delete(id);
            }
          })
          .catch((err) => {
            console.error("[smithers] server run error:", err);
            runs.delete(runId);
          });

        sendJson(res, 200, { runId });
        return;
      }

      const resumeMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch) {
        const runId = resumeMatch[1]!;
        const body = await readBody(req, maxBodyBytes);
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
        const workflow = await loadWorkflow(workflowPath);
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
        const record: RunRecord = { workflow, abort, workflowPath };
        runs.set(runId, record);
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
            if (serverDb || result.status !== "waiting-approval") {
              runs.delete(runId);
            }
          })
          .catch((err) => {
            console.error("[smithers] server resume error:", err);
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
        if (run.status !== "running" || !isRunHeartbeatFresh(run)) {
          return sendJson(res, 409, {
            error: { code: "RUN_NOT_ACTIVE", message: "Run is not currently active" },
          });
        }
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
        let lastHeartbeat = Date.now();
        const poll = async () => {
          if (closed || res.writableEnded) return;
          const events = await adapter.listEvents(runId, lastSeq, 200);
          for (const ev of events) {
            lastSeq = ev.seq;
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
            ["finished", "failed", "cancelled"].includes(runRow.status) &&
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
              await new Promise((resolve) => setTimeout(resolve, 500));
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
        const body = await readBody(req, maxBodyBytes);
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
        const body = await readBody(req, maxBodyBytes);
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
    }
  });

  server.on("close", () => {
    for (const [runId, record] of runs) {
      try {
        record.abort.abort();
      } catch {}
      runs.delete(runId);
    }
  });

  server.listen(port);
  return server;
}
