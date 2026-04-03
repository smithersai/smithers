/** @jsxImportSource smithers */
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sleep } from "./helpers";
import { createServeApp, type ServeOptions } from "../src/server/serve";
import { SmithersDb } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import { runWorkflow } from "../src/engine";
import type { SmithersWorkflow } from "../src/SmithersWorkflow";
import { renderPrometheusMetrics } from "../src/observability";

// ---------------------------------------------------------------------------
// Prometheus helpers
// ---------------------------------------------------------------------------

/** Parse prometheus text format into a map of metric line key → numeric value */
function parsePrometheusText(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/,
    );
    if (match) {
      const key = match[2] ? `${match[1]}${match[2]}` : match[1];
      const value = Number(match[3]);
      if (!isNaN(value)) metrics.set(key, value);
    }
  }
  return metrics;
}

/** Return the difference for a metric between two snapshots (0 if absent). */
function metricDelta(
  before: Map<string, number>,
  after: Map<string, number>,
  name: string,
): number {
  return (after.get(name) ?? 0) - (before.get(name) ?? 0);
}

type BunServer = ReturnType<typeof Bun.serve>;

function getPort(server: BunServer): number {
  if (server.port === undefined) {
    throw new Error("Bun server did not expose a port");
  }
  return server.port;
}

function makeRequest(port: number) {
  return async function request(
    path: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; data: any; headers: Headers }> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const contentType = res.headers.get("content-type") ?? "";
    let data: any;
    if (contentType.includes("text/event-stream")) {
      data = await res.text();
    } else if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status: res.status, data, headers: res.headers };
  };
}

describe("Hono Serve Mode", () => {
  let server: BunServer | null = null;
  let testDir: string;
  let port: number;
  let request: ReturnType<typeof makeRequest>;
  let abort: AbortController;
  let runPromiseHandle: Promise<any> | null = null;

  beforeEach(() => {
    testDir = resolve(
      process.cwd(),
      "tests",
      ".test-serve-" + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
    abort = new AbortController();
    runPromiseHandle = null;
  });

  afterEach(async () => {
    abort.abort();
    if (server) {
      server.stop(true);
      server = null;
    }
    // Don't await runPromiseHandle — slow agents may take too long to cancel.
    // Just let them fail in the background after abort.
    runPromiseHandle = null;
    await sleep(50);
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  function writeTestWorkflow(
    name: string,
    dbPath: string,
    options: { needsApproval?: boolean; slow?: boolean } = {},
  ) {
    const workflowPath = resolve(testDir, `${name}.tsx`);
    const slowAgent = options.slow
      ? `
const fakeAgent = {
  id: "fake",
  tools: {},
  generate: async () => {
    await new Promise(r => setTimeout(r, 60000));
    return { output: { value: 1 } };
  },
};`
      : "";
    const agentProp = options.slow ? " agent={fakeAgent}" : "";
    const approvalProp = options.needsApproval ? " needsApproval" : "";

    writeFileSync(
      workflowPath,
      `/** @jsxImportSource smithers */
import { createSmithers } from "smithers";
import { z } from "zod/v4";
${slowAgent}

const { smithers, Workflow, Task, outputs } = createSmithers(
  { outputA: z.object({ value: z.number() }) },
  { dbPath: "${dbPath}" },
);

export default smithers((ctx) => (
  <Workflow name="${name}">
    <Task id="task1" output={outputs.outputA}${agentProp}${approvalProp}>
      ${options.slow ? "run task" : "{{ value: 42 }}"}
    </Task>
  </Workflow>
));
`,
    );
    return workflowPath;
  }

  async function loadWorkflow(
    workflowPath: string,
  ): Promise<SmithersWorkflow<any>> {
    const abs = resolve(process.cwd(), workflowPath);
    const mod = await import(pathToFileURL(abs).href);
    return mod.default as SmithersWorkflow<any>;
  }

  async function startServeApp(
    workflowPath: string,
    opts: {
      needsApproval?: boolean;
      slow?: boolean;
      authToken?: string;
      startRun?: boolean;
      metrics?: boolean;
    } = {},
  ) {
    const workflow = await loadWorkflow(workflowPath);
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const runId = `test-run-${Date.now()}`;

    const startRun = opts.startRun !== false;
    if (startRun) {
      runPromiseHandle = runWorkflow(workflow, {
        runId,
        input: {},
        workflowPath: resolve(process.cwd(), workflowPath),
        signal: abort.signal,
      }).catch(() => {});
      // Give the workflow a moment to start and persist initial state
      await sleep(200);
    }

    const app = createServeApp({
      workflow,
      adapter,
      runId,
      abort,
      authToken: opts.authToken,
      metrics: opts.metrics,
    });

    server = Bun.serve({ port: 0, fetch: app.fetch });
    port = getPort(server);
    request = makeRequest(port);

    return { workflow, adapter, runId, app };
  }

  // =========================================================================
  // Status
  // =========================================================================
  describe("GET /", () => {
    test("returns run status for a running workflow", async () => {
      const dbPath = resolve(testDir, "status.db");
      const workflowPath = writeTestWorkflow("status", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true });

      const { status, data } = await request("/");

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      expect(data.status).toBeDefined();
      expect(data.workflowName).toBeDefined();
      expect(data.summary).toBeDefined();
    });

    test("returns status after workflow completes", async () => {
      const dbPath = resolve(testDir, "finished.db");
      const workflowPath = writeTestWorkflow("finished", dbPath);
      const { runId } = await startServeApp(workflowPath);

      // Wait for fast workflow to finish
      await sleep(2000);

      const { status, data } = await request("/");

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
      expect(["finished", "running"]).toContain(data.status);
    });
  });

  // =========================================================================
  // Health
  // =========================================================================
  describe("GET /health", () => {
    test("returns ok even when auth is configured", async () => {
      const dbPath = resolve(testDir, "health.db");
      const workflowPath = writeTestWorkflow("health", dbPath, { slow: true });
      await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret-token",
      });

      const { status, data } = await request("/health");

      expect(status).toBe(200);
      expect(data.ok).toBe(true);
    });
  });

  // =========================================================================
  // Auth
  // =========================================================================
  describe("Auth", () => {
    test("rejects requests without token when auth is set", async () => {
      const dbPath = resolve(testDir, "auth-reject.db");
      const workflowPath = writeTestWorkflow("auth-reject", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret",
      });

      const { status, data } = await request("/");

      expect(status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    test("accepts Authorization: Bearer header", async () => {
      const dbPath = resolve(testDir, "auth-bearer.db");
      const workflowPath = writeTestWorkflow("auth-bearer", dbPath, {
        slow: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret",
      });

      const { status, data } = await request("/", {
        headers: { Authorization: "Bearer secret" },
      });

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });

    test("accepts x-smithers-key header", async () => {
      const dbPath = resolve(testDir, "auth-key.db");
      const workflowPath = writeTestWorkflow("auth-key", dbPath, {
        slow: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        slow: true,
        authToken: "secret",
      });

      const { status, data } = await request("/", {
        headers: { "x-smithers-key": "secret" },
      });

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });

    test("all routes accessible without auth when no token configured", async () => {
      const dbPath = resolve(testDir, "no-auth.db");
      const workflowPath = writeTestWorkflow("no-auth", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });

      const { status } = await request("/");
      expect(status).toBe(200);

      const { status: healthStatus } = await request("/health");
      expect(healthStatus).toBe(200);
    });
  });

  // =========================================================================
  // Approve / Deny
  // =========================================================================
  describe("POST /approve/:nodeId", () => {
    test("approves a waiting-approval task", async () => {
      const dbPath = resolve(testDir, "approve.db");
      const workflowPath = writeTestWorkflow("approve", dbPath, {
        needsApproval: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        needsApproval: true,
      });

      // Wait for workflow to reach waiting-approval
      await sleep(500);

      const { status, data } = await request("/approve/task1", {
        method: "POST",
        body: {
          iteration: 0,
          note: "approved by test",
          decidedBy: "test-user",
        },
      });

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
  });

  describe("POST /deny/:nodeId", () => {
    test("denies a waiting-approval task", async () => {
      const dbPath = resolve(testDir, "deny.db");
      const workflowPath = writeTestWorkflow("deny", dbPath, {
        needsApproval: true,
      });
      const { runId } = await startServeApp(workflowPath, {
        needsApproval: true,
      });

      // Wait for workflow to reach waiting-approval
      await sleep(500);

      const { status, data } = await request("/deny/task1", {
        method: "POST",
        body: {
          iteration: 0,
          note: "denied by test",
          decidedBy: "test-user",
        },
      });

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });
  });

  // =========================================================================
  // Cancel
  // =========================================================================
  describe("POST /cancel", () => {
    test("cancels a running workflow", async () => {
      const dbPath = resolve(testDir, "cancel.db");
      const workflowPath = writeTestWorkflow("cancel", dbPath, { slow: true });
      const { runId } = await startServeApp(workflowPath, { slow: true });

      const { status, data } = await request("/cancel", { method: "POST" });

      expect(status).toBe(200);
      expect(data.runId).toBe(runId);
    });

    test("returns 409 for non-running workflow", async () => {
      const dbPath = resolve(testDir, "cancel-done.db");
      const workflowPath = writeTestWorkflow("cancel-done", dbPath);
      await startServeApp(workflowPath);

      // Wait for fast workflow to finish
      await sleep(2000);

      const { status, data } = await request("/cancel", { method: "POST" });

      expect(status).toBe(409);
      expect(data.error.code).toBe("RUN_NOT_ACTIVE");
    });
  });

  // =========================================================================
  // Events (SSE)
  // =========================================================================
  describe("GET /events", () => {
    test("returns text/event-stream content type", async () => {
      const dbPath = resolve(testDir, "events.db");
      const workflowPath = writeTestWorkflow("events", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);

      try {
        const res = await fetch(`http://localhost:${port}/events`, {
          signal: controller.signal,
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
      } catch (e: any) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });

    test("streams real events", async () => {
      const dbPath = resolve(testDir, "events-stream.db");
      const workflowPath = writeTestWorkflow("events-stream", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      let receivedData = "";

      try {
        const res = await fetch(`http://localhost:${port}/events`, {
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedData += decoder.decode(value, { stream: true });
          // Once we have some events, break
          if (receivedData.includes("event: smithers")) break;
        }
      } catch (e: any) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }

      expect(receivedData).toContain("event: smithers");
      expect(receivedData).toContain("data: ");
    });

    test("supports afterSeq query param", async () => {
      const dbPath = resolve(testDir, "events-seq.db");
      const workflowPath = writeTestWorkflow("events-seq", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);

      try {
        const res = await fetch(
          `http://localhost:${port}/events?afterSeq=999999`,
          { signal: controller.signal },
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
      } catch (e: any) {
        if (e.name !== "AbortError") throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
  });

  // =========================================================================
  // Frames
  // =========================================================================
  describe("GET /frames", () => {
    test("returns array of rendered frames", async () => {
      const dbPath = resolve(testDir, "frames.db");
      const workflowPath = writeTestWorkflow("frames", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });

      const { status, data } = await request("/frames");

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });

    test("respects limit param", async () => {
      const dbPath = resolve(testDir, "frames-limit.db");
      const workflowPath = writeTestWorkflow("frames-limit", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });

      const { status, data } = await request("/frames?limit=1");

      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // Metrics
  // =========================================================================
  describe("GET /metrics", () => {
    test("returns prometheus text format", async () => {
      const dbPath = resolve(testDir, "metrics.db");
      const workflowPath = writeTestWorkflow("metrics", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });

      const res = await fetch(`http://localhost:${port}/metrics`);

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("text/plain");
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    });

    test("returns 404 when metrics disabled", async () => {
      const dbPath = resolve(testDir, "no-metrics.db");
      const workflowPath = writeTestWorkflow("no-metrics", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true, metrics: false });

      const { status, data } = await request("/metrics");

      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  // =========================================================================
  // Metrics validation — assert prometheus counters after real operations
  // =========================================================================
  describe("Metrics after operations", () => {
    test("completed workflow increments run and node counters", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());

      const dbPath = resolve(testDir, "m-complete.db");
      const workflowPath = writeTestWorkflow("m-complete", dbPath);
      await startServeApp(workflowPath);
      await sleep(2000);

      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());

      // Run lifecycle
      expect(metricDelta(before, after, "smithers_runs_total")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_runs_finished_total")).toBeGreaterThanOrEqual(1);

      // Node lifecycle (the test workflow has one task)
      expect(metricDelta(before, after, "smithers_nodes_started")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_nodes_finished")).toBeGreaterThanOrEqual(1);

      // Events emitted
      expect(metricDelta(before, after, "smithers_events_emitted_total")).toBeGreaterThanOrEqual(1);

      // Duration histograms should have at least one observation
      expect(metricDelta(before, after, "smithers_run_duration_ms_count")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_node_duration_ms_count")).toBeGreaterThanOrEqual(1);
    });

    test("http request metrics increment across multiple requests", async () => {
      const dbPath = resolve(testDir, "m-http.db");
      const workflowPath = writeTestWorkflow("m-http", dbPath, { slow: true });
      await startServeApp(workflowPath, { slow: true });

      // Take baseline after server is up (metrics are global)
      const before = parsePrometheusText(renderPrometheusMetrics());

      // Make several requests through the Hono app
      await request("/");
      await request("/health");
      await request("/frames");

      // Give fire-and-forget metric increments time to flush
      await sleep(500);

      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());

      // The timing middleware uses void runPromise() (fire-and-forget), so
      // the latest increment may not have landed yet.  We made 3 requests
      // before sleeping, so at least 2 should have been recorded.
      expect(metricDelta(before, after, "smithers_http_requests")).toBeGreaterThanOrEqual(2);
      // Duration histogram should also have observations
      expect(metricDelta(before, after, "smithers_http_request_duration_ms_count")).toBeGreaterThanOrEqual(2);
    });

    test("approved task increments approval counters", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());

      const dbPath = resolve(testDir, "m-approve.db");
      const workflowPath = writeTestWorkflow("m-approve", dbPath, {
        needsApproval: true,
      });
      await startServeApp(workflowPath, { needsApproval: true });
      await sleep(500);

      await request("/approve/task1", {
        method: "POST",
        body: { iteration: 0, note: "approved", decidedBy: "test" },
      });
      await sleep(500);

      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());

      expect(metricDelta(before, after, "smithers_approvals_requested")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_approvals_granted")).toBeGreaterThanOrEqual(1);
    });

    test("denied task increments denial counters", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());

      const dbPath = resolve(testDir, "m-deny.db");
      const workflowPath = writeTestWorkflow("m-deny", dbPath, {
        needsApproval: true,
      });
      await startServeApp(workflowPath, { needsApproval: true });
      await sleep(500);

      await request("/deny/task1", {
        method: "POST",
        body: { iteration: 0, note: "denied", decidedBy: "test" },
      });
      await sleep(500);

      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());

      expect(metricDelta(before, after, "smithers_approvals_requested")).toBeGreaterThanOrEqual(1);
      expect(metricDelta(before, after, "smithers_approvals_denied")).toBeGreaterThanOrEqual(1);
    });

    test("no run-failed or node-failed counters after clean completion", async () => {
      const before = parsePrometheusText(renderPrometheusMetrics());

      const dbPath = resolve(testDir, "m-clean.db");
      const workflowPath = writeTestWorkflow("m-clean", dbPath);
      await startServeApp(workflowPath);
      await sleep(2000);

      const res = await fetch(`http://localhost:${port}/metrics`);
      const after = parsePrometheusText(await res.text());

      // A clean run should not increment failure counters
      expect(metricDelta(before, after, "smithers_runs_failed_total")).toBe(0);
      expect(metricDelta(before, after, "smithers_nodes_failed")).toBe(0);
    });
  });

  // =========================================================================
  // 404
  // =========================================================================
  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const dbPath = resolve(testDir, "notfound.db");
      const workflowPath = writeTestWorkflow("notfound", dbPath, {
        slow: true,
      });
      await startServeApp(workflowPath, { slow: true });

      const { status, data } = await request("/v1/unknown-route");

      expect(status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });
});
