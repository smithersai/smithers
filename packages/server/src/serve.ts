import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Effect, Metric } from "effect";
import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import { SmithersDb } from "@smithers/db/adapter";
import { approveNode, denyNode } from "@smithers/engine/approvals";
import { isRunHeartbeatFresh } from "@smithers/engine";
import { nowMs } from "@smithers/scheduler/nowMs";
import {
  prometheusContentType,
  renderPrometheusMetrics,
} from "@smithers/observability";
import { logWarning } from "@smithers/observability/logging";
import { runPromise } from "./smithersRuntime";
import { httpRequests, httpRequestDuration, trackEvent } from "@smithers/observability/metrics";

export type ServeOptions = {
  workflow: SmithersWorkflow<any>;
  adapter: SmithersDb;
  runId: string;
  abort: AbortController;
  authToken?: string;
  metrics?: boolean;
};

type HttpErrorCode =
  | "UNAUTHORIZED"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_ACTIVE"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "INVALID_REQUEST";

class HttpError extends Error {
  status: number;
  code: HttpErrorCode;
  constructor(status: number, code: HttpErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
  if (
    pathname === "/"
    || pathname === "/health"
    || pathname === "/events"
    || pathname === "/frames"
    || pathname === "/cancel"
    || pathname === "/metrics"
  ) {
    return pathname;
  }
  if (/^\/approve\/[^/]+$/.test(pathname)) return "/approve/:nodeId";
  if (/^\/deny\/[^/]+$/.test(pathname)) return "/deny/:nodeId";
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
    logWarning("failed to record serve http metrics", {
      method: method.toUpperCase(),
      pathname,
      statusCode,
      error: error instanceof Error ? error.message : String(error),
    }, "serve:metrics");
  }
}

export function createServeApp(opts: ServeOptions) {
  const { adapter, runId, abort, authToken, metrics: metricsEnabled = true } = opts;
  const app = new Hono();

  // Health — no auth
  app.get("/health", (c) => c.json({ ok: true }));

  // Auth middleware — applied after /health
  if (authToken) {
    app.use("*", async (c, next) => {
      // /health already matched above, so this won't fire for it
      const smithersKey = c.req.header("x-smithers-key");
      if (smithersKey === authToken) return next();

      const authHeader = c.req.header("authorization");
      if (authHeader) {
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : authHeader;
        if (token === authToken) return next();
      }

      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization token" } },
        401,
      );
    });
  }

  // Timing middleware
  app.use("*", async (c, next) => {
    const start = performance.now();
    let statusCode = 500;
    try {
      await next();
      statusCode = c.res.status;
    } catch (error) {
      statusCode = error instanceof HttpError ? error.status : 500;
      throw error;
    } finally {
      await recordHttpRequestMetricsSafely(
        c.req.method,
        c.req.path,
        statusCode,
        performance.now() - start,
      );
    }
  });

  // GET / — run status
  app.get("/", async (c) => {
    const run = await adapter.getRun(runId);
    if (!run) {
      throw new HttpError(404, "RUN_NOT_FOUND", "Run not found");
    }
    const summary = await adapter.countNodesByState(runId);
    return c.json({
      runId,
      workflowName: run.workflowName ?? "workflow",
      status: run.status ?? "unknown",
      startedAtMs: run.startedAtMs ?? null,
      finishedAtMs: run.finishedAtMs ?? null,
      summary: (summary as any[]).reduce((acc: any, row: any) => {
        acc[row.state] = row.count;
        return acc;
      }, {}),
    });
  });

  // GET /events — SSE stream
  app.get("/events", (c) => {
    const afterSeqParam = c.req.query("afterSeq");
    let lastSeq = afterSeqParam ? parseInt(afterSeqParam, 10) : -1;
    if (!Number.isFinite(lastSeq)) lastSeq = -1;

    return streamSSE(c, async (stream) => {
      let closed = false;

      // Use the abort signal from the request to detect disconnects
      c.req.raw.signal.addEventListener("abort", () => {
        closed = true;
      });

      while (!closed) {
        const events = await adapter.listEvents(runId, lastSeq, 200);
        for (const ev of events as any[]) {
          lastSeq = ev.seq;
          await stream.writeSSE({
            event: "smithers",
            data: ev.payloadJson,
            id: String(ev.seq),
          });
        }

        // Check if run is terminal
        const runRow = await adapter.getRun(runId);
        if (
          runRow &&
          ["finished", "failed", "cancelled", "continued"].includes(runRow.status) &&
          (events as any[]).length === 0
        ) {
          break;
        }

        await new Promise((r) => setTimeout(r, 500));
      }
    });
  });

  // GET /frames
  app.get("/frames", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 50) : 50;
    const afterParam = c.req.query("afterFrameNo");
    const afterFrameNo =
      afterParam !== null && afterParam !== undefined
        ? parseInt(afterParam, 10)
        : undefined;

    const frames = await adapter.listFrames(
      runId,
      limit,
      afterFrameNo !== undefined && Number.isFinite(afterFrameNo) && afterFrameNo >= 0
        ? afterFrameNo
        : undefined,
    );
    return c.json(frames);
  });

  // POST /approve/:nodeId
  app.post("/approve/:nodeId", async (c) => {
    const nodeId = c.req.param("nodeId");
    const body = await c.req.json().catch(() => ({}));
    await Effect.runPromise(approveNode(
      adapter,
      runId,
      nodeId,
      body.iteration ?? 0,
      body.note,
      body.decidedBy,
    ));
    return c.json({ runId });
  });

  // POST /deny/:nodeId
  app.post("/deny/:nodeId", async (c) => {
    const nodeId = c.req.param("nodeId");
    const body = await c.req.json().catch(() => ({}));
    await Effect.runPromise(denyNode(
      adapter,
      runId,
      nodeId,
      body.iteration ?? 0,
      body.note,
      body.decidedBy,
    ));
    return c.json({ runId });
  });

  // POST /cancel
  app.post("/cancel", async (c) => {
    const run = await adapter.getRun(runId);
    if (!run) {
      throw new HttpError(404, "RUN_NOT_FOUND", "Run not found");
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
          const attempts = await runPromise(adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0));
          const waitingAttempt = (attempts as any[]).find((attempt) => attempt.state === "waiting-timer");
          if (!waitingAttempt) continue;
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
      return c.json({ runId });
    }

    if (run.status !== "running" || !isRunHeartbeatFresh(run)) {
      throw new HttpError(409, "RUN_NOT_ACTIVE", "Run is not currently active");
    }

    await adapter.requestRunCancel(runId, nowMs());
    abort.abort();
    return c.json({ runId });
  });

  // GET /metrics
  if (metricsEnabled) {
    app.get("/metrics", (c) => {
      return c.text(renderPrometheusMetrics(), 200, {
        "Content-Type": prometheusContentType,
      });
    });
  }

  // 404 catch-all
  app.notFound((c) => {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Route not found" } },
      404,
    );
  });

  // Error handler
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code, message: err.message } },
        err.status as any,
      );
    }
    return c.json(
      { error: { code: "SERVER_ERROR", message: err.message ?? "Unknown error" } },
      500,
    );
  });

  return app;
}
