/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { startServer } from "../src/index.js";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTestDb, sleep } from "../../smithers/tests/helpers.js";
import { ddl, schema } from "../../smithers/tests/schema.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
function buildDb() {
    return createTestDb(schema, ddl);
}
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
    const addr = server.address();
    return addr.port;
}
/**
 * @param {number} port
 */
function makeRequest(port) {
    return async function request(path, options = {}) {
        const headers = { ...options.headers };
        if (options.body && !headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
        }
        const res = await fetch(`http://localhost:${port}${path}`, {
            method: options.method ?? "GET",
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const data = await res.json();
        return { status: res.status, data };
    };
}
describe("HTTP Server", () => {
    let server;
    let testDir;
    let port;
    let request;
    beforeEach(() => {
        testDir = resolve(process.cwd(), "tests", ".test-workflows-" + Math.random().toString(36).slice(2));
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(async () => {
        if (server) {
            server.close();
        }
        await sleep(500);
        try {
            rmSync(testDir, { recursive: true, force: true });
        }
        catch { }
    });
    /**
   * @param {ServerOptions} [opts]
   */
    function startTestServer(opts = {}) {
        server = startServer({ port: 0, ...opts });
        port = getPort(server);
        request = makeRequest(port);
    }
    /**
   * @param {string} runId
   * @param {string[]} statuses
   */
    async function waitForRunStatus(runId, statuses, timeoutMs = 5_000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const { status, data } = await request(`/v1/runs/${runId}`);
            if (status === 200 && statuses.includes(data.status)) {
                return data;
            }
            await sleep(50);
        }
        throw new Error(`Timed out waiting for run ${runId} to reach one of: ${statuses.join(", ")}`);
    }
    /**
   * @param {string} dbPath
   * @param {string} runId
   */
    async function waitForPersistedRun(dbPath, runId, timeoutMs = 5_000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            let db = null;
            try {
                db = new Database(dbPath, { readonly: true });
                const row = db
                    .query("SELECT run_id AS runId FROM _smithers_runs WHERE run_id = ? LIMIT 1")
                    .get(runId);
                if (row) {
                    return row;
                }
            }
            catch {
            }
            finally {
                db?.close();
            }
            await sleep(50);
        }
        throw new Error(`Timed out waiting for run ${runId} to be persisted`);
    }
    /**
   * @param {string} dbPath
   * @param {string} runId
   */
    function readOutputValue(dbPath, runId) {
        const db = new Database(dbPath, { readonly: true });
        try {
            const row = db
                .query("SELECT value FROM output_a WHERE run_id = ? AND node_id = 'task1' LIMIT 1")
                .get(runId);
            return row?.value;
        }
        finally {
            db.close();
        }
    }
    /**
   * @param {string} name
   * @param {string} dbPath
   * @param {{ needsApproval?: boolean; slow?: boolean; value?: number }} [options]
   */
    function writeTestWorkflow(name, dbPath, options = {}) {
        const workflowPath = resolve(testDir, `${name}.tsx`);
        const slowAgent = options.slow ? `
const fakeAgent = {
  id: "fake",
  tools: {},
  generate: async (args) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60000);
      const abort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (args.abortSignal?.aborted) {
        abort();
        return;
      }
      args.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    return { output: { value: 1 } };
  },
};` : "";
        const agentProp = options.slow ? " agent={fakeAgent}" : "";
        const approvalProp = options.needsApproval ? " needsApproval" : "";
        const outputValue = options.value ?? 42;
        writeFileSync(workflowPath, `/** @jsxImportSource smithers-orchestrator */
	import { createSmithers } from "smithers-orchestrator";
	import { z } from "zod";
	${slowAgent}
	
	const { smithers, Workflow, Task, outputs } = createSmithers(
	  { outputA: z.object({ value: z.number() }) },
	  { dbPath: "${dbPath}" },
	);
	
	export default smithers((ctx) => (
	  <Workflow name="${name}">
	    <Task id="task1" output={outputs.outputA}${agentProp}${approvalProp}>
	      ${options.slow ? "run task" : `{{ value: ${outputValue} }}`}
	    </Task>
	  </Workflow>
	));
	`);
        return workflowPath;
    }
    describe("POST /v1/runs", () => {
        test("starts a new run and returns runId", async () => {
            const dbPath = resolve(testDir, "test1.db");
            const workflowPath = writeTestWorkflow("test1", dbPath);
            startTestServer();
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            expect(status).toBe(200);
            expect(data.runId).toBeDefined();
            expect(typeof data.runId).toBe("string");
        });
        test("accepts custom runId", async () => {
            const dbPath = resolve(testDir, "test2.db");
            const workflowPath = writeTestWorkflow("test2", dbPath);
            startTestServer();
            const customRunId = "custom-run-id-123";
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath, runId: customRunId },
            });
            expect(status).toBe(200);
            expect(data.runId).toBe(customRunId);
        });
        test("returns 500 for invalid workflow path", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath: "/nonexistent/workflow.ts" },
            });
            expect(status).toBe(500);
            expect(data.error).toBeDefined();
            expect(data.error.code).toBe("SERVER_ERROR");
        });
        test("reloads a workflow file after it changes on disk", async () => {
            const dbPath = resolve(testDir, "reload.db");
            const workflowPath = writeTestWorkflow("reload", dbPath, { value: 42 });
            startTestServer();
            const firstRun = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            expect(firstRun.status).toBe(200);
            await waitForRunStatus(firstRun.data.runId, ["finished"]);
            expect(readOutputValue(dbPath, firstRun.data.runId)).toBe(42);
            await sleep(25);
            writeTestWorkflow("reload", dbPath, { value: 7 });
            const secondRun = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            expect(secondRun.status).toBe(200);
            await waitForRunStatus(secondRun.data.runId, ["finished"]);
            expect(readOutputValue(dbPath, secondRun.data.runId)).toBe(7);
        }, 15_000);
        test("returns 400 for invalid JSON body", async () => {
            const dbPath = resolve(testDir, "test-invalid-json.db");
            const workflowPath = writeTestWorkflow("test-invalid-json", dbPath);
            startTestServer();
            const res = await fetch(`http://localhost:${port}/v1/runs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{",
            });
            const data = (await res.json());
            expect(res.status).toBe(400);
            expect(data.error.code).toBe("INVALID_JSON");
        });
        test("returns 413 when body exceeds limit", async () => {
            const dbPath = resolve(testDir, "test-large-body.db");
            const workflowPath = writeTestWorkflow("test-large-body", dbPath);
            startTestServer({ maxBodyBytes: 100 });
            const largeInput = { workflowPath, input: { payload: "x".repeat(1000) } };
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: largeInput,
            });
            expect(status).toBe(413);
            expect(data.error.code).toBe("PAYLOAD_TOO_LARGE");
        });
    });
    describe("GET /v1/runs/:runId", () => {
        test("returns run status after starting", async () => {
            const dbPath = resolve(testDir, "test3.db");
            const workflowPath = writeTestWorkflow("test3", dbPath, { slow: true });
            startTestServer();
            const { status: startStatus, data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            expect(startStatus).toBe(200);
            await waitForPersistedRun(dbPath, startData.runId);
            const { status, data } = await request(`/v1/runs/${startData.runId}`);
            expect(status).toBe(200);
            expect(data.runId).toBe(startData.runId);
            expect(data.workflowName).toBeDefined();
            expect(data.status).toBeDefined();
            expect(["running", "finished", "failed", "waiting-approval"]).toContain(data.status);
        });
        test("returns 404 for non-existent run", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs/non-existent-run-id");
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
        });
    });
    describe("Auth", () => {
        test("rejects requests without token when auth is enabled", async () => {
            const dbPath = resolve(testDir, "test-auth.db");
            const workflowPath = writeTestWorkflow("test-auth", dbPath);
            startTestServer({ authToken: "secret" });
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            expect(status).toBe(401);
            expect(data.error.code).toBe("UNAUTHORIZED");
        });
        test("accepts requests with valid token", async () => {
            const dbPath = resolve(testDir, "test-auth-ok.db");
            const workflowPath = writeTestWorkflow("test-auth-ok", dbPath);
            startTestServer({ authToken: "secret" });
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
                headers: { Authorization: "Bearer secret" },
            });
            expect(status).toBe(200);
            expect(data.runId).toBeDefined();
        });
    });
    describe("POST /v1/runs/:runId/cancel", () => {
        test("cancels an active run", async () => {
            const dbPath = resolve(testDir, "slow.db");
            const workflowPath = writeTestWorkflow("slow", dbPath, { slow: true });
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForPersistedRun(dbPath, startData.runId);
            const { status, data } = await request(`/v1/runs/${startData.runId}/cancel`, {
                method: "POST",
            });
            expect(status).toBe(200);
            expect(data.runId).toBe(startData.runId);
        });
        test("returns 404 for non-existent run", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs/non-existent-run-id/cancel", {
                method: "POST",
            });
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
        });
    });
    describe("POST /v1/runs/:runId/resume", () => {
        test("resumes a run with given runId", async () => {
            const dbPath = resolve(testDir, "resume.db");
            const workflowPath = writeTestWorkflow("resume", dbPath);
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForPersistedRun(dbPath, startData.runId);
            const { status, data } = await request(`/v1/runs/${startData.runId}/resume`, {
                method: "POST",
                body: { workflowPath },
            });
            expect(status).toBe(200);
            expect(data.runId).toBe(startData.runId);
        });
    });
    describe("GET /v1/runs/:runId/frames", () => {
        test("returns frames for a run", async () => {
            const dbPath = resolve(testDir, "frames.db");
            const workflowPath = writeTestWorkflow("frames", dbPath, { slow: true });
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForPersistedRun(dbPath, startData.runId);
            const { status, data } = await request(`/v1/runs/${startData.runId}/frames`);
            expect(status).toBe(200);
            expect(Array.isArray(data)).toBe(true);
        });
        test("returns 404 for non-existent run", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs/non-existent-run-id/frames");
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
        });
        test("respects limit and afterFrameNo params", async () => {
            const dbPath = resolve(testDir, "frames2.db");
            const workflowPath = writeTestWorkflow("frames2", dbPath, { slow: true });
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForPersistedRun(dbPath, startData.runId);
            const { status, data } = await request(`/v1/runs/${startData.runId}/frames?limit=10&afterFrameNo=0`);
            expect(status).toBe(200);
            expect(Array.isArray(data)).toBe(true);
        });
    });
    describe("POST /v1/runs/:runId/nodes/:nodeId/approve", () => {
        test("approves a node", async () => {
            const dbPath = resolve(testDir, "approval.db");
            const workflowPath = writeTestWorkflow("approval", dbPath, { needsApproval: true });
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForRunStatus(startData.runId, ["waiting-approval"]);
            const { status, data } = await request(`/v1/runs/${startData.runId}/nodes/task1/approve`, {
                method: "POST",
                body: { iteration: 0, note: "approved by test", decidedBy: "test-user" },
            });
            expect(status).toBe(200);
            expect(data.runId).toBe(startData.runId);
        });
        test("returns 404 for non-existent run", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/approve", {
                method: "POST",
                body: { iteration: 0 },
            });
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
        });
        test("returns 404 for non-existent run when server DB is configured", async () => {
            const { db, cleanup } = buildDb();
            ensureSmithersTables(db);
            startTestServer({ db: db });
            const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/approve", {
                method: "POST",
                body: { iteration: 0 },
            });
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
            cleanup();
        });
    });
    describe("POST /v1/runs/:runId/nodes/:nodeId/deny", () => {
        test("denies a node", async () => {
            const dbPath = resolve(testDir, "deny.db");
            const workflowPath = writeTestWorkflow("deny", dbPath, { needsApproval: true });
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForRunStatus(startData.runId, ["waiting-approval"]);
            const { status, data } = await request(`/v1/runs/${startData.runId}/nodes/task1/deny`, {
                method: "POST",
                body: { iteration: 0, note: "denied by test", decidedBy: "test-user" },
            });
            expect(status).toBe(200);
            expect(data.runId).toBe(startData.runId);
        });
        test("returns 404 for non-existent run", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/deny", {
                method: "POST",
                body: { iteration: 0 },
            });
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
        });
        test("returns 404 for non-existent run when server DB is configured", async () => {
            const { db, cleanup } = buildDb();
            ensureSmithersTables(db);
            startTestServer({ db: db });
            const { status, data } = await request("/v1/runs/non-existent-run-id/nodes/some-node/deny", {
                method: "POST",
                body: { iteration: 0 },
            });
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
            cleanup();
        });
    });
    describe("GET /v1/runs/:runId/events (SSE)", () => {
        test("returns SSE stream for valid run", async () => {
            const dbPath = resolve(testDir, "events.db");
            const workflowPath = writeTestWorkflow("events", dbPath, { slow: true });
            startTestServer();
            const { data: startData } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath },
            });
            await waitForPersistedRun(dbPath, startData.runId);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1000);
            try {
                const res = await fetch(`http://localhost:${port}/v1/runs/${startData.runId}/events`, { signal: controller.signal });
                expect(res.status).toBe(200);
                expect(res.headers.get("content-type")).toBe("text/event-stream");
            }
            catch (e) {
                if (e.name !== "AbortError")
                    throw e;
            }
            finally {
                clearTimeout(timeout);
                controller.abort();
            }
        });
        test("returns 404 for non-existent run", async () => {
            startTestServer();
            const res = await fetch(`http://localhost:${port}/v1/runs/non-existent-run-id/events`);
            expect(res.status).toBe(404);
            const data = await res.json();
            expect(data.error.code).toBe("NOT_FOUND");
        });
    });
    describe("GET /v1/runs (list runs)", () => {
        test("returns 400 when server DB not configured", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs");
            expect(status).toBe(400);
            expect(data.error.code).toBe("DB_NOT_CONFIGURED");
        });
        test("returns runs list when server DB is configured", async () => {
            const { db, cleanup } = buildDb();
            ensureSmithersTables(db);
            startTestServer({ db: db });
            const { status, data } = await request("/v1/runs");
            expect(status).toBe(200);
            expect(Array.isArray(data)).toBe(true);
            cleanup();
        });
        test("respects limit and status params", async () => {
            const { db, cleanup } = buildDb();
            ensureSmithersTables(db);
            startTestServer({ db: db });
            const { status, data } = await request("/v1/runs?limit=10&status=running");
            expect(status).toBe(200);
            expect(Array.isArray(data)).toBe(true);
            cleanup();
        });
        test("keeps stale persisted status and exposes derived runState in the runs API", async () => {
            const { db, cleanup } = buildDb();
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            await adapter.insertRun({
                runId: "stale-running",
                workflowName: "stale-flow",
                status: "running",
                createdAtMs: Date.now() - 60_000,
                startedAtMs: Date.now() - 60_000,
                heartbeatAtMs: Date.now() - 60_000,
                runtimeOwnerId: "worker-1",
            });
            startTestServer({ db: db });
            const { status, data } = await request("/v1/runs?limit=10");
            expect(status).toBe(200);
            expect(Array.isArray(data)).toBe(true);
            expect(data[0]?.runId).toBe("stale-running");
            expect(data[0]?.status).toBe("running");
            expect(data[0]?.runState?.state).toBe("stale");
            expect(data[0]?.runState?.unhealthy?.kind).toBe("engine-heartbeat-stale");
            cleanup();
        });
    });
    describe("GET /v1/approval/list", () => {
        test("returns 400 when server DB is not configured", async () => {
            startTestServer();
            const { status, data } = await request("/v1/approval/list");
            expect(status).toBe(400);
            expect(data.error.code).toBe("DB_NOT_CONFIGURED");
        });
        test("returns pending approvals sorted by wait time", async () => {
            const { db, cleanup } = buildDb();
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            await adapter.insertRun({
                runId: "run-older",
                workflowName: "release-flow",
                status: "waiting-approval",
                createdAtMs: Date.now() - 10_000,
            });
            await adapter.insertRun({
                runId: "run-newer",
                workflowName: "qa-flow",
                status: "waiting-approval",
                createdAtMs: Date.now() - 9_000,
            });
            await adapter.insertNode({
                runId: "run-older",
                nodeId: "deploy",
                iteration: 0,
                state: "waiting-approval",
                lastAttempt: null,
                updatedAtMs: Date.now(),
                outputTable: "",
                label: "Deploy gate",
            });
            await adapter.insertNode({
                runId: "run-newer",
                nodeId: "review",
                iteration: 0,
                state: "waiting-approval",
                lastAttempt: null,
                updatedAtMs: Date.now(),
                outputTable: "",
                label: "Review gate",
            });
            await adapter.insertOrUpdateApproval({
                runId: "run-newer",
                nodeId: "review",
                iteration: 0,
                status: "requested",
                requestedAtMs: Date.now() - 2_000,
            });
            await adapter.insertOrUpdateApproval({
                runId: "run-older",
                nodeId: "deploy",
                iteration: 0,
                status: "requested",
                requestedAtMs: Date.now() - 8_000,
            });
            await adapter.insertOrUpdateApproval({
                runId: "run-older",
                nodeId: "cleanup",
                iteration: 0,
                status: "approved",
                decidedAtMs: Date.now(),
            });
            startTestServer({ db: db });
            const { status, data } = await request("/v1/approval/list");
            expect(status).toBe(200);
            expect(Array.isArray(data.approvals)).toBe(true);
            expect(data.approvals).toHaveLength(2);
            expect(data.approvals[0]).toMatchObject({
                runId: "run-older",
                nodeId: "deploy",
                workflowName: "release-flow",
                label: "Deploy gate",
            });
            expect(data.approvals[1]).toMatchObject({
                runId: "run-newer",
                nodeId: "review",
                workflowName: "qa-flow",
                label: "Review gate",
            });
            expect(typeof data.approvals[0].waitingMs).toBe("number");
            cleanup();
        });
    });
    describe("404 handling", () => {
        test("returns 404 for unknown routes", async () => {
            startTestServer();
            const { status, data } = await request("/v1/unknown-route");
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
            expect(data.error.message).toBe("Route not found");
        });
        test("returns 404 for root path", async () => {
            startTestServer();
            const { status, data } = await request("/");
            expect(status).toBe(404);
            expect(data.error.code).toBe("NOT_FOUND");
        });
    });
    describe("Error handling", () => {
        test("returns 500 with error details on server error", async () => {
            startTestServer();
            const { status, data } = await request("/v1/runs", {
                method: "POST",
                body: { workflowPath: "/this/path/does/not/exist.ts" },
            });
            expect(status).toBe(500);
            expect(data.error.code).toBe("SERVER_ERROR");
            expect(data.error.message).toBeDefined();
        });
    });
});
