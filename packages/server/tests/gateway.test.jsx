/** @jsxImportSource smithers */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers";
import { Gateway } from "../src/gateway.js";
import { SmithersDb } from "@smithers/db/adapter";
import { sleep } from "../../smithers/tests/helpers.js";
/**
 * @param {Record<string, unknown>} value
 */
function base64UrlJson(value) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}
/**
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 * @param {Record<string, unknown>} [header]
 */
function createJwtToken(payload, secret, header = { alg: "HS256", typ: "JWT" }) {
    const encodedHeader = base64UrlJson(header);
    const encodedPayload = base64UrlJson(payload);
    const signature = createHmac("sha256", secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest("base64url");
    return `${encodedHeader}.${encodedPayload}.${signature}`;
}
/**
 * @param {Server} server
 * @returns {number}
 */
function getPort(server) {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
        throw new Error("Gateway server did not expose a port");
    }
    return addr.port;
}
/**
 * @param {string} name
 */
function makeDbPath(name) {
    return join(tmpdir(), `smithers-gateway-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * @param {string} dbPath
 */
function createValueWorkflow(dbPath) {
    const { smithers, Workflow, Task, outputs } = createSmithers({
        outputA: z.object({ value: z.number() }),
    }, { dbPath });
    return smithers((ctx) => (<Workflow name="gateway-basic">
      <Task id="task1" output={outputs.outputA}>
        {{ value: Number(ctx.input.value ?? 1) }}
      </Task>
    </Workflow>));
}
/**
 * @param {string} dbPath
 */
function createApprovalWorkflow(dbPath) {
    const api = createSmithers({
        selection: z.object({
            selected: z.string(),
            notes: z.string().nullable(),
        }),
        result: z.object({
            selected: z.string(),
        }),
    }, { dbPath });
    const workflow = api.smithers((ctx) => {
        const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });
        return (<api.Workflow name="gateway-approval">
        <api.Sequence>
          <api.Approval id="pick-plan" mode="select" output={api.outputs.selection} request={{
                title: "Pick a plan",
                summary: "Choose the best option.",
            }} options={[
                { key: "light", label: "Light" },
                { key: "balanced", label: "Balanced" },
            ]} allowedScopes={["approve"]} allowedUsers={["user:will"]}/>
          {selection ? (<api.Task id="record" output={api.outputs.result}>
              {{ selected: selection.selected }}
            </api.Task>) : null}
        </api.Sequence>
      </api.Workflow>);
    });
    return { workflow, db: api.db, tables: api.tables };
}
/**
 * @param {string} dbPath
 */
function createAuthWorkflow(dbPath) {
    const api = createSmithers({
        authOutput: z.object({
            triggeredBy: z.string(),
            role: z.string(),
            scopes: z.array(z.string()),
        }),
    }, { dbPath });
    const workflow = api.smithers((ctx) => (<api.Workflow name="gateway-auth">
      <api.Task id="auth-task" output={api.outputs.authOutput}>
        {{
            triggeredBy: ctx.auth?.triggeredBy ?? "unknown",
            role: ctx.auth?.role ?? "unknown",
            scopes: ctx.auth?.scopes ?? [],
        }}
      </api.Task>
    </api.Workflow>));
    return { workflow, db: api.db, tables: api.tables };
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
        throw new Error(`Timed out waiting for gateway message. Saw: ${JSON.stringify(this.messages.map((message) => ({
            type: message.type,
            event: message.event,
            id: message.id,
            payload: message.payload,
        })))}`);
    }
    /**
   * @param {string} method
   * @param {unknown} [params]
   */
    async request(method, params) {
        const id = `${method}-${Math.random().toString(36).slice(2)}`;
        this.ws.send(JSON.stringify({
            type: "req",
            id,
            method,
            params,
        }));
        return this.waitFor((message) => message.type === "res" && message.id === id);
    }
    async close() {
        if (this.ws.readyState === this.ws.CLOSED) {
            return;
        }
        await new Promise((resolve) => {
            this.ws.once("close", () => resolve());
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
    const challenge = await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
    expect(challenge.payload.nonce).toBeDefined();
    const hello = await client.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
            id: "test-client",
            version: "1.0.0",
            platform: "bun-test",
        },
        auth: { token },
    });
    expect(hello.ok).toBe(true);
    return { client, hello };
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
    throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join(", ")}`);
}
describe("Gateway", () => {
    let gateway;
    let server;
    let dbPaths = [];
    beforeEach(() => {
        dbPaths = [];
    });
    afterEach(async () => {
        if (gateway) {
            await gateway.close();
        }
        for (const dbPath of dbPaths) {
            try {
                rmSync(dbPath, { force: true });
                rmSync(`${dbPath}-shm`, { force: true });
                rmSync(`${dbPath}-wal`, { force: true });
            }
            catch { }
        }
        gateway = undefined;
        server = undefined;
        dbPaths = [];
    });
    test("performs the connect handshake, enforces scopes, and exposes health", async () => {
        const dbPath = makeDbPath("token");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                    "viewer-token": {
                        role: "viewer",
                        scopes: ["health", "runs.list", "runs.get"],
                        userId: "user:viewer",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client: operator, hello } = await connectGateway(port, "op-token");
        expect(hello.payload.protocol).toBe(1);
        expect(hello.payload.snapshot.runs).toEqual([]);
        expect(hello.payload.snapshot.approvals).toEqual([]);
        expect(hello.payload.auth.userId).toBe("user:will");
        const { client: viewer } = await connectGateway(port, "viewer-token");
        const health = await viewer.request("health");
        expect(health.ok).toBe(true);
        expect(health.payload.protocol).toBe(1);
        expect(health.payload.features).toEqual(["approvals", "streaming", "runs"]);
        const forbidden = await viewer.request("runs.create", {
            workflow: "basic",
            input: { value: 2 },
        });
        expect(forbidden.ok).toBe(false);
        expect(forbidden.error.code).toBe("FORBIDDEN");
        await operator.close();
        await viewer.close();
    });
    test("validates JWT connect tokens and extracts auth claims", async () => {
        const dbPath = makeDbPath("jwt");
        dbPaths.push(dbPath);
        const secret = "super-secret";
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "jwt",
                issuer: "https://auth.example.com",
                audience: "smithers",
                secret,
                scopesClaim: "permissions",
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const validToken = createJwtToken({
            iss: "https://auth.example.com",
            aud: "smithers",
            sub: "user:jwt",
            role: "operator",
            permissions: ["runs.create", "runs.get"],
            exp: Math.floor(Date.now() / 1_000) + 300,
        }, secret);
        const { client, hello } = await connectGateway(port, validToken);
        expect(hello.payload.auth.userId).toBe("user:jwt");
        expect(hello.payload.auth.role).toBe("operator");
        expect(hello.payload.auth.scopes).toEqual(["runs.create", "runs.get"]);
        const created = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 4 },
        });
        expect(created.ok).toBe(true);
        await waitForRunStatus(client, created.payload.runId, ["finished"]);
        const invalidAudienceToken = createJwtToken({
            iss: "https://auth.example.com",
            aud: "other-service",
            sub: "user:jwt",
            permissions: ["runs.create"],
            exp: Math.floor(Date.now() / 1_000) + 300,
        }, secret);
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
        });
        const rejected = new GatewayClient(ws);
        await rejected.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
        const helloRejected = await rejected.request("connect", {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
                id: "jwt-client",
                version: "1.0.0",
                platform: "bun-test",
            },
            auth: { token: invalidAudienceToken },
        });
        expect(helloRejected.ok).toBe(false);
        expect(helloRejected.error.code).toBe("UNAUTHORIZED");
        await client.close();
        await rejected.close();
    });
    test("supports HTTP /rpc fallback for stateless callers", async () => {
        const dbPath = makeDbPath("http-rpc");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "op-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:http",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const createRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer op-token",
            },
            body: JSON.stringify({
                method: "runs.create",
                params: {
                    workflow: "basic",
                    input: { value: 12 },
                },
            }),
        });
        expect(createRes.status).toBe(200);
        const created = await createRes.json();
        expect(created.ok).toBe(true);
        const runId = created.payload.runId;
        let run = null;
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const runRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-smithers-key": "op-token",
                },
                body: JSON.stringify({
                    method: "runs.get",
                    params: { runId },
                }),
            });
            const payload = await runRes.json();
            if (runRes.status === 404) {
                await sleep(25);
                continue;
            }
            expect(runRes.status).toBe(200);
            expect(payload.ok).toBe(true);
            run = payload.payload;
            if (run?.status === "finished") {
                break;
            }
            await sleep(25);
        }
        expect(run?.status).toBe("finished");
        expect(run?.workflowKey).toBe("basic");
    });
    test("creates runs, streams gateway events, and exposes frames, attempts, and diffs", async () => {
        const dbPath = makeDbPath("basic");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs"],
            heartbeatMs: 100,
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
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "op-token");
        const first = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 2 },
        });
        expect(first.ok).toBe(true);
        const runId = first.payload.runId;
        expect(typeof runId).toBe("string");
        const nodeEvent = await client.waitFor((message) => message.type === "event" &&
            (message.event === "node.started" || message.event === "node.finished") &&
            message.payload.runId === runId);
        const runCompleted = await client.waitFor((message) => message.type === "event" &&
            message.event === "run.completed" &&
            message.payload.runId === runId);
        expect(nodeEvent.seq).toBeLessThan(runCompleted.seq);
        expect(nodeEvent.stateVersion).toBeLessThan(runCompleted.stateVersion);
        const run = await client.request("runs.get", { runId });
        expect(run.ok).toBe(true);
        expect(run.payload.runId).toBe(runId);
        expect(run.payload.status).toBe("finished");
        const runs = await client.request("runs.list", { limit: 10 });
        expect(runs.ok).toBe(true);
        expect(runs.payload.some((entry) => entry.runId === runId)).toBe(true);
        const frames = await client.request("frames.list", { runId, limit: 10 });
        expect(frames.ok).toBe(true);
        expect(frames.payload.length).toBeGreaterThan(0);
        const frame = await client.request("frames.get", { runId });
        expect(frame.ok).toBe(true);
        expect(frame.payload.runId).toBe(runId);
        expect(frame.payload.frameNo).toBeGreaterThan(0);
        const attempts = await client.request("attempts.list", { runId });
        expect(attempts.ok).toBe(true);
        expect(attempts.payload.length).toBeGreaterThan(0);
        const attempt = await client.request("attempts.get", {
            runId,
            nodeId: "task1",
            iteration: 0,
            attempt: 1,
        });
        expect(attempt.ok).toBe(true);
        expect(attempt.payload.runId).toBe(runId);
        expect(attempt.payload.nodeId).toBe("task1");
        const second = await client.request("runs.create", {
            workflow: "basic",
            input: { value: 7 },
        });
        const secondRunId = second.payload.runId;
        await waitForRunStatus(client, secondRunId, ["finished"]);
        const diff = await client.request("runs.diff", {
            leftRunId: runId,
            rightRunId: secondRunId,
        });
        expect(diff.ok).toBe(true);
        expect(diff.payload.outputsChanged.length).toBeGreaterThan(0);
        await client.close();
    });
    test("enforces approval-level scopes/users and returns rich pending approval metadata", async () => {
        const dbPath = makeDbPath("approval");
        dbPaths.push(dbPath);
        const approval = createApprovalWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs", "cron"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:operator",
                    },
                    "approver-token": {
                        role: "approver",
                        scopes: ["approve", "approvals.list", "runs.get"],
                        userId: "user:will",
                    },
                    "blocked-token": {
                        role: "approver",
                        scopes: ["approve", "approvals.list", "runs.get"],
                        userId: "user:blocked",
                    },
                },
            },
        });
        gateway.register("approval", approval.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client: operator } = await connectGateway(port, "operator-token");
        const create = await operator.request("runs.create", {
            workflow: "approval",
            input: {},
        });
        expect(create.ok).toBe(true);
        const runId = create.payload.runId;
        await operator.waitFor((message) => message.type === "event" &&
            message.event === "approval.requested" &&
            message.payload.runId === runId);
        const approvals = await operator.request("approvals.list");
        expect(approvals.ok).toBe(true);
        expect(approvals.payload).toEqual([
            expect.objectContaining({
                runId,
                nodeId: "pick-plan",
                requestTitle: "Pick a plan",
                requestSummary: "Choose the best option.",
                approvalMode: "select",
                allowedScopes: ["approve"],
                allowedUsers: ["user:will"],
                options: [
                    { key: "light", label: "Light" },
                    { key: "balanced", label: "Balanced" },
                ],
            }),
        ]);
        const { client: blocked } = await connectGateway(port, "blocked-token");
        const forbidden = await blocked.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: true,
            decision: {
                selected: "balanced",
                notes: "best fit",
            },
        });
        expect(forbidden.ok).toBe(false);
        expect(forbidden.error.code).toBe("FORBIDDEN");
        const { client: approver } = await connectGateway(port, "approver-token");
        const decided = await approver.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: true,
            decision: {
                selected: "balanced",
                notes: "best fit",
            },
        });
        expect(decided.ok).toBe(true);
        const completed = await operator.waitFor((message) => message.type === "event" &&
            message.event === "run.completed" &&
            message.payload.runId === runId);
        expect(completed.payload.status).toBe("finished");
        const adapter = new SmithersDb(approval.db);
        const approvalRow = await adapter.getApproval(runId, "pick-plan", 0);
        expect(approvalRow?.decisionJson).toEqual(JSON.stringify({ selected: "balanced", notes: "best fit" }));
        await operator.close();
        await blocked.close();
        await approver.close();
    });
    test("rejects non-boolean approvals.decide approved values", async () => {
        const dbPath = makeDbPath("approval-invalid-approved");
        dbPaths.push(dbPath);
        const approval = createApprovalWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:operator",
                    },
                    "approver-token": {
                        role: "approver",
                        scopes: ["approve", "approvals.list", "runs.get"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("approval", approval.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client: operator } = await connectGateway(port, "operator-token");
        const create = await operator.request("runs.create", {
            workflow: "approval",
            input: {},
        });
        expect(create.ok).toBe(true);
        const runId = create.payload.runId;
        await operator.waitFor((message) => message.type === "event" &&
            message.event === "approval.requested" &&
            message.payload.runId === runId);
        const { client: approver } = await connectGateway(port, "approver-token");
        const decided = await approver.request("approvals.decide", {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: "false",
            decision: {
                selected: "balanced",
            },
        });
        expect(decided.ok).toBe(false);
        expect(decided.error.code).toBe("INVALID_REQUEST");
        const adapter = new SmithersDb(approval.db);
        const approvalRow = await adapter.getApproval(runId, "pick-plan", 0);
        expect(approvalRow?.status).toBe("requested");
        await operator.close();
        await approver.close();
    });
    test("manages cron schedules through gateway methods", async () => {
        const dbPath = makeDbPath("cron");
        dbPaths.push(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["approvals", "streaming", "runs", "cron"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["*"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("basic", createValueWorkflow(dbPath));
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "operator-token");
        const added = await client.request("cron.add", {
            workflow: "basic",
            pattern: "0 8 * * 5",
        });
        expect(added.ok).toBe(true);
        expect(added.payload.workflow).toBe("basic");
        expect(typeof added.payload.cronId).toBe("string");
        const listed = await client.request("cron.list");
        expect(listed.ok).toBe(true);
        expect(listed.payload).toEqual([
            expect.objectContaining({
                cronId: added.payload.cronId,
                workflow: "basic",
                pattern: "0 8 * * 5",
            }),
        ]);
        const triggered = await client.request("cron.trigger", {
            cronId: added.payload.cronId,
            input: { value: 9 },
        });
        expect(triggered.ok).toBe(true);
        expect(typeof triggered.payload.runId).toBe("string");
        await waitForRunStatus(client, triggered.payload.runId, ["finished"]);
        const removed = await client.request("cron.remove", {
            cronId: added.payload.cronId,
        });
        expect(removed.ok).toBe(true);
        const empty = await client.request("cron.list");
        expect(empty.ok).toBe(true);
        expect(empty.payload).toEqual([]);
        await client.close();
    });
    test("propagates gateway auth context into workflow tasks", async () => {
        const dbPath = makeDbPath("auth");
        dbPaths.push(dbPath);
        const authWorkflow = createAuthWorkflow(dbPath);
        gateway = new Gateway({
            protocol: 1,
            features: ["runs"],
            heartbeatMs: 100,
            auth: {
                mode: "token",
                tokens: {
                    "operator-token": {
                        role: "operator",
                        scopes: ["runs.create", "runs.get"],
                        userId: "user:will",
                    },
                },
            },
        });
        gateway.register("auth", authWorkflow.workflow);
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const { client } = await connectGateway(port, "operator-token");
        const created = await client.request("runs.create", {
            workflow: "auth",
            input: {},
        });
        expect(created.ok).toBe(true);
        const runId = created.payload.runId;
        await waitForRunStatus(client, runId, ["finished"]);
        const rows = await authWorkflow.db
            .select()
            .from(authWorkflow.tables.authOutput);
        expect(rows).toEqual([
            {
                runId,
                nodeId: "auth-task",
                iteration: 0,
                triggeredBy: "user:will",
                role: "operator",
                scopes: ["runs.create", "runs.get"],
            },
        ]);
        await client.close();
    });
});
