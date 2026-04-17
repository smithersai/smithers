/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { sleep } from "../../smithers/tests/helpers.js";
let createSmithers;
let Gateway;
let SmithersDb;
let WaitForEvent;
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
    return join(tmpdir(), `smithers-gateway-webhooks-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
/**
 * @param {string} payload
 * @param {string} secret
 */
function signWebhookPayload(payload, secret, prefix = "sha256=") {
    return `${prefix}${createHmac("sha256", secret).update(payload).digest("hex")}`;
}
/**
 * @param {number} port
 * @param {string} workflowKey
 * @param {Record<string, unknown>} payload
 * @param {string} secret
 */
async function postWebhook(port, workflowKey, payload, secret) {
    const body = JSON.stringify(payload);
    return fetch(`http://127.0.0.1:${port}/webhooks/${workflowKey}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signWebhookPayload(body, secret),
        },
        body,
    });
}
/**
 * @param {string} dbPath
 */
function createWebhookWaitWorkflow(dbPath) {
    const api = createSmithers({
        webhookEvent: z.object({
            body: z.string(),
        }),
    }, { dbPath });
    const workflow = api.smithers(() => (<api.Workflow name="gateway-webhook-wait">
      <WaitForEvent id="wait" event="github.comment.created" correlationId="42" output={api.outputs.webhookEvent}/>
    </api.Workflow>));
    return { workflow, db: api.db, tables: api.tables };
}
/**
 * @param {string} dbPath
 */
function createWebhookTriggerWorkflow(dbPath) {
    const api = createSmithers({
        result: z.object({
            issueId: z.number(),
            body: z.string(),
        }),
    }, { dbPath });
    const workflow = api.smithers((ctx) => (<api.Workflow name="gateway-webhook-trigger">
      <api.Task id="record" output={api.outputs.result}>
        {{
            issueId: Number(ctx.input.issue?.id ?? 0),
            body: String(ctx.input.comment?.body ?? ""),
        }}
      </api.Task>
    </api.Workflow>));
    return { workflow, db: api.db, tables: api.tables };
}
describe("Gateway webhook ingestion", () => {
    let gateway;
    let server;
    let dbPaths = [];
    beforeAll(async () => {
        createSmithers = (await import("smithers-orchestrator/create")).createSmithers;
        Gateway = (await import("../src/gateway.js")).Gateway;
        SmithersDb = (await import("@smithers/db/adapter")).SmithersDb;
        WaitForEvent = (await import("@smithers/components/components/WaitForEvent")).WaitForEvent;
    });
    beforeEach(() => {
        gateway = undefined;
        server = undefined;
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
    test("rejects invalid webhook signatures and records rejection metrics", async () => {
        const dbPath = makeDbPath("signature");
        dbPaths.push(dbPath);
        const { workflow } = createWebhookTriggerWorkflow(dbPath);
        gateway = new Gateway();
        gateway.register("github", workflow, {
            webhook: {
                secret: "correct-secret",
            },
        });
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const payload = JSON.stringify({
            issue: { id: 7 },
            comment: { body: "bad signature" },
        });
        const response = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-hub-signature-256": signWebhookPayload(payload, "wrong-secret"),
            },
            body: payload,
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
            ok: false,
            error: {
                code: "UNAUTHORIZED",
                message: "Webhook signature verification failed",
            },
        });
        await sleep(50);
        const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((res) => res.text());
        expect(metrics).toMatch(/smithers_gateway_webhooks_received_total\{[^}]*workflow="github"[^}]*\}\s+1\b/);
        expect(metrics).toMatch(/smithers_gateway_webhooks_rejected_total\{[^}]*reason="invalid_signature"[^}]*workflow="github"[^}]*\}\s+1\b/);
    });
    test("delivers matching webhooks as signals to waiting runs", async () => {
        const dbPath = makeDbPath("signal");
        dbPaths.push(dbPath);
        const { workflow, db, tables } = createWebhookWaitWorkflow(dbPath);
        gateway = new Gateway();
        gateway.resumeRunIfNeeded = async () => { };
        gateway.register("github", workflow, {
            webhook: {
                secret: "signal-secret",
                signal: {
                    name: "github.comment.created",
                    correlationIdPath: "issue.id",
                    payloadPath: "comment",
                },
                run: {
                    enabled: false,
                },
            },
        });
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const adapter = new SmithersDb(db);
        const runId = "webhook-signal-run";
        await adapter.insertRun({
            runId,
            workflowName: "gateway-webhook-wait",
            workflowHash: "workflow-hash",
            status: "waiting-event",
            createdAtMs: Date.now(),
        });
        await adapter.insertNode({
            runId,
            nodeId: "wait",
            iteration: 0,
            state: "waiting-event",
            lastAttempt: 1,
            updatedAtMs: Date.now(),
            outputTable: tables.webhookEvent._?.name ?? "webhook_event",
            label: "wait",
        });
        await adapter.insertAttempt({
            runId,
            nodeId: "wait",
            iteration: 0,
            attempt: 1,
            state: "waiting-event",
            startedAtMs: Date.now(),
            finishedAtMs: null,
            errorJson: null,
            metaJson: JSON.stringify({
                waitForEvent: {
                    signalName: "github.comment.created",
                    correlationId: "42",
                    waitAsync: false,
                },
            }),
            responseText: null,
            cached: false,
            jjPointer: null,
            jjCwd: null,
        });
        const response = await postWebhook(port, "github", {
            issue: { id: 42 },
            comment: { body: "ship it" },
        }, "signal-secret");
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.ok).toBe(true);
        expect(payload.matchedRunIds).toEqual([runId]);
        expect(payload.delivered).toHaveLength(1);
        expect(payload.started).toBeNull();
        expect(await adapter.listSignals(runId, {
            signalName: "github.comment.created",
            correlationId: "42",
        })).toHaveLength(1);
        const attempts = await adapter.listAttempts(runId, "wait", 0);
        const waitForEvent = JSON.parse(attempts[0]?.metaJson ?? "{}").waitForEvent;
        expect(waitForEvent).toEqual(expect.objectContaining({
            signalName: "github.comment.created",
            correlationId: "42",
            resolvedSignalSeq: payload.delivered[0].seq,
            receivedAtMs: payload.delivered[0].receivedAtMs,
        }));
    });
    test("starts a new run when a webhook has no matching waiting run", async () => {
        const dbPath = makeDbPath("run");
        dbPaths.push(dbPath);
        const { workflow } = createWebhookTriggerWorkflow(dbPath);
        gateway = new Gateway();
        const startedRuns = [];
        gateway.startRun = async (workflowKey, input, auth) => {
            startedRuns.push({ workflowKey, input, auth });
            return {
                runId: "webhook-started-run",
                workflow: workflowKey,
            };
        };
        gateway.register("github", workflow, {
            webhook: {
                secret: "run-secret",
                signal: {
                    name: "github.comment.created",
                    correlationIdPath: "issue.id",
                },
            },
        });
        server = await gateway.listen({ port: 0, host: "127.0.0.1" });
        const port = getPort(server);
        const response = await postWebhook(port, "github", {
            issue: { id: 99 },
            comment: { body: "open a run" },
        }, "run-secret");
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.ok).toBe(true);
        expect(payload.delivered).toEqual([]);
        expect(payload.started).toEqual({
            workflow: "github",
            runId: "webhook-started-run",
        });
        expect(startedRuns).toEqual([
            {
                workflowKey: "github",
                input: {
                    issue: { id: 99 },
                    comment: { body: "open a run" },
                },
                auth: expect.objectContaining({
                    triggeredBy: "webhook:github",
                    role: "system",
                    scopes: ["*"],
                }),
            },
        ]);
    });
});
