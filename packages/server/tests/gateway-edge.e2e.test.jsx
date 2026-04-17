/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers/db/adapter";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Gateway server did not expose a port");
    }
    return address.port;
}
/**
 * @param {string} name
 */
function makeDbPath(name) {
    return join(tmpdir(), `smithers-gateway-edge-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * @param {string} dbPath
 */
function createValueWorkflow(dbPath) {
    const api = createSmithers({
        outputA: z.object({ value: z.number() }),
    }, { dbPath });
    return {
        db: api.db,
        workflow: api.smithers((ctx) => (<api.Workflow name="gateway-edge-basic">
        <api.Task id="task1" output={api.outputs.outputA}>
          {{ value: Number(ctx.input.value ?? 1) }}
        </api.Task>
      </api.Workflow>)),
    };
}
class GatewayClient {
    ws;
    messages = [];
    /**
   * @param {WebSocket} ws
   */
    constructor(ws) {
        this.ws = ws;
        ws.on("message", (raw) => {
            this.messages.push(JSON.parse(String(raw)));
        });
    }
    /**
   * @param {(message: GatewayMessage) => boolean} predicate
   * @returns {Promise<GatewayMessage>}
   */
    async waitFor(predicate, timeoutMs = 5_000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const index = this.messages.findIndex(predicate);
            if (index >= 0) {
                return this.messages.splice(index, 1)[0];
            }
            await sleep(10);
        }
        throw new Error(`Timed out waiting for gateway message. Saw: ${JSON.stringify(this.messages)}`);
    }
    /**
   * @param {string} method
   * @param {unknown} [params]
   */
    async request(method, params) {
        const id = `${method}-${Math.random().toString(36).slice(2)}`;
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
        return this.waitFor((message) => message.type === "res" && message.id === id);
    }
    async close() {
        if (this.ws.readyState === this.ws.CLOSED) {
            return;
        }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    this.ws.terminate();
                }
                catch { }
                resolve();
            }, 500);
            this.ws.once("close", () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.close();
        });
    }
}
/**
 * @param {number} port
 * @param {string} token
 */
async function connectGateway(port, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
    });
    const client = new GatewayClient(ws);
    await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
    const hello = await client.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
            id: "gateway-edge-client",
            version: "1.0.0",
            platform: "bun-test",
        },
        auth: { token },
    });
    expect(hello.ok).toBe(true);
    return client;
}
/**
 * @param {GatewayClient} client
 * @param {string} runId
 * @param {string[]} statuses
 */
async function waitForRunStatus(client, runId, statuses, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const response = await client.request("runs.get", { runId });
        if (response.ok && statuses.includes(response.payload.status)) {
            return response.payload;
        }
        await sleep(25);
    }
    throw new Error(`Timed out waiting for ${runId} to reach ${statuses.join(", ")}`);
}
describe("Gateway edge cases", () => {
    let gateway;
    let server;
    const dbPaths = [];
    afterEach(async () => {
        if (gateway) {
            await gateway.close();
            gateway = undefined;
            server = undefined;
        }
        else if (server) {
            await new Promise((resolve) => server.close(() => resolve()));
            server = undefined;
        }
        while (dbPaths.length > 0) {
            const dbPath = dbPaths.pop();
            rmSync(dbPath, { force: true });
            rmSync(`${dbPath}-shm`, { force: true });
            rmSync(`${dbPath}-wal`, { force: true });
        }
    });
    test("fires registered cron schedules and starts a workflow run", async () => {
        const dbPath = makeDbPath("cron-auto");
        dbPaths.push(dbPath);
        const valueWorkflow = createValueWorkflow(dbPath);
        const adapter = new SmithersDb(valueWorkflow.db);
        gateway = new Gateway({
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
            heartbeatMs: 100,
        });
        gateway.register("basic", valueWorkflow.workflow, { schedule: "* * * * *" });
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        await adapter.updateCronRunTime("gateway:basic", Date.now() - 60_000, Date.now() - 1, null);
        await gateway.processDueCrons();
        let runId = null;
        let runStatus = null;
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && !runId) {
            const [run] = await adapter.listRuns(10);
            if (run?.runId) {
                runId = run.runId;
                runStatus = run.status;
                break;
            }
            await sleep(25);
        }
        expect(typeof runId).toBe("string");
        const statusDeadline = Date.now() + 5_000;
        while (Date.now() < statusDeadline && runStatus !== "finished") {
            runStatus = (await adapter.getRun(runId))?.status ?? null;
            if (runStatus === "finished") {
                break;
            }
            await sleep(25);
        }
        expect(runStatus).toBe("finished");
        const [cron] = await adapter.listCrons(true);
        expect(cron?.lastRunAtMs).toBeGreaterThan(0);
    }, 10_000);
    test("returns RUN_NOT_ACTIVE when cancelling an already-finished run", async () => {
        const dbPath = makeDbPath("cancel-finished");
        dbPaths.push(dbPath);
        const valueWorkflow = createValueWorkflow(dbPath);
        const adapter = new SmithersDb(valueWorkflow.db);
        gateway = new Gateway({
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
            heartbeatMs: 100,
        });
        gateway.register("basic", valueWorkflow.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const started = await gateway.startRun("basic", { value: 3 }, { triggeredBy: "tester", scopes: ["*"], role: "operator" });
        const runId = started.runId;
        let status = null;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && status !== "finished") {
            status = (await adapter.getRun(runId))?.status ?? null;
            if (status === "finished") {
                break;
            }
            await sleep(25);
        }
        expect(status).toBe("finished");
        let cancelled = await gateway.routeRequest({
            userId: "tester",
            role: "operator",
            scopes: ["*"],
            subscribedRuns: null,
        }, {
            type: "req",
            id: "cancel-finished",
            method: "runs.cancel",
            params: { runId },
        });
        for (let attempt = 0; attempt < 40 && cancelled.ok; attempt += 1) {
            await sleep(25);
            cancelled = await gateway.routeRequest({
                userId: "tester",
                role: "operator",
                scopes: ["*"],
                subscribedRuns: null,
            }, {
                type: "req",
                id: "cancel-finished",
                method: "runs.cancel",
                params: { runId },
            });
        }
        expect(cancelled.ok).toBe(false);
        expect(cancelled.error.code).toBe("RUN_NOT_ACTIVE");
    });
});
