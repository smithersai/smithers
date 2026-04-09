/** @jsxImportSource smithers */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createSmithers,
  Gateway,
  SmithersDb,
  WaitForEvent,
} from "../src/index";
import { ensureSmithersTables } from "../src/db/ensure";
import { resolveDeferredTaskStateBridge } from "../src/effect/workflow-bridge";
import { EventBus } from "../src/events";
import type { TaskDescriptor } from "../src/TaskDescriptor";
import { sleep } from "./helpers";

function getPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return address.port;
}

function makeDbPath(name: string) {
  return join(
    tmpdir(),
    `smithers-gateway-webhooks-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function signWebhookPayload(payload: string, secret: string, prefix = "sha256=") {
  return `${prefix}${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

async function postWebhook(
  port: number,
  workflowKey: string,
  payload: Record<string, unknown>,
  secret: string,
) {
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

function makeWebhookWaitDescriptor(outputTable: any): TaskDescriptor {
  return {
    nodeId: "wait",
    ordinal: 0,
    iteration: 0,
    outputTable,
    outputTableName: outputTable._?.name ?? "webhook_event",
    outputSchema: z.object({ body: z.string() }),
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    meta: {
      __waitForEvent: true,
      __eventName: "github.comment.created",
      __correlationId: "42",
      __onTimeout: "fail",
    },
  };
}

function createWebhookWaitWorkflow(dbPath: string) {
  const api = createSmithers(
    {
      webhookEvent: z.object({
        body: z.string(),
      }),
    },
    { dbPath },
  );

  const workflow = api.smithers(() => (
    <api.Workflow name="gateway-webhook-wait">
      <WaitForEvent
        id="wait"
        event="github.comment.created"
        correlationId="42"
        output={api.outputs.webhookEvent}
      />
    </api.Workflow>
  ));

  return { workflow, db: api.db, tables: api.tables };
}

function createWebhookTriggerWorkflow(dbPath: string) {
  const api = createSmithers(
    {
      result: z.object({
        issueId: z.number(),
        body: z.string(),
      }),
    },
    { dbPath },
  );

  const workflow = api.smithers((ctx) => (
    <api.Workflow name="gateway-webhook-trigger">
      <api.Task id="record" output={api.outputs.result}>
        {{
          issueId: Number((ctx.input as any).issue?.id ?? 0),
          body: String((ctx.input as any).comment?.body ?? ""),
        }}
      </api.Task>
    </api.Workflow>
  ));

  return { workflow, db: api.db, tables: api.tables };
}

describe("Gateway webhook ingestion", () => {
  let gateway: Gateway;
  let server: Server;
  let dbPaths: string[] = [];

  beforeEach(() => {
    gateway = undefined as any;
    server = undefined as any;
    dbPaths = [];
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (gateway) {
      await gateway.close();
    }
    for (const dbPath of dbPaths) {
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
      } catch {}
    }
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
    server = await gateway.listen({ port: 0 });
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
    expect(metrics).toMatch(
      /smithers_gateway_webhooks_received_total\{[^}]*workflow="github"[^}]*\}\s+1\b/,
    );
    expect(metrics).toMatch(
      /smithers_gateway_webhooks_rejected_total\{[^}]*reason="invalid_signature"[^}]*workflow="github"[^}]*\}\s+1\b/,
    );
  });

  test("delivers matching webhooks as signals to waiting runs", async () => {
    const dbPath = makeDbPath("signal");
    dbPaths.push(dbPath);
    const { workflow, db, tables } = createWebhookWaitWorkflow(dbPath);
    ensureSmithersTables(db as any);
    gateway = new Gateway();
    (gateway as any).resumeRunIfNeeded = async () => {};
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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const adapter = new SmithersDb(db as any);
    const runId = "webhook-signal-run";
    await adapter.insertRun({
      runId,
      workflowName: "gateway-webhook-wait",
      workflowHash: "workflow-hash",
      status: "running",
      createdAtMs: Date.now(),
    });
    const descriptor = makeWebhookWaitDescriptor(tables.webhookEvent);
    const waiting = await resolveDeferredTaskStateBridge(
      adapter,
      db as any,
      runId,
      descriptor,
      new EventBus({ db: adapter }),
    );
    expect(waiting).toEqual({
      handled: true,
      state: "waiting-event",
    });
    await adapter.updateRun(runId, { status: "waiting-event" });

    const response = await postWebhook(
      port,
      "github",
      {
        issue: { id: 42 },
        comment: { body: "ship it" },
      },
      "signal-secret",
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.ok).toBe(true);
    expect(payload.matchedRunIds).toEqual([runId]);
    expect(payload.delivered).toHaveLength(1);
    expect(payload.started).toBeNull();
    expect(await adapter.listSignals(runId, {
      signalName: "github.comment.created",
      correlationId: "42",
    })).toHaveLength(1);

    const resolved = await resolveDeferredTaskStateBridge(
      adapter,
      db as any,
      runId,
      descriptor,
      new EventBus({ db: adapter }),
    );
    expect(resolved).toEqual({
      handled: true,
      state: "finished",
    });

    const rows = await (db as any).select().from(tables.webhookEvent);
    expect(rows).toEqual([
      expect.objectContaining({
        runId,
        nodeId: "wait",
        iteration: 0,
        body: "ship it",
      }),
    ]);
  });

  test("starts a new run when a webhook has no matching waiting run", async () => {
    const dbPath = makeDbPath("run");
    dbPaths.push(dbPath);
    const { workflow } = createWebhookTriggerWorkflow(dbPath);
    gateway = new Gateway();
    const startedRuns: Array<{
      workflowKey: string;
      input: Record<string, unknown>;
      auth: Record<string, unknown>;
    }> = [];
    (gateway as any).startRun = async (
      workflowKey: string,
      input: Record<string, unknown>,
      auth: Record<string, unknown>,
    ) => {
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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const response = await postWebhook(
      port,
      "github",
      {
        issue: { id: 99 },
        comment: { body: "open a run" },
      },
      "run-secret",
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.ok).toBe(true);
    expect(payload.delivered).toEqual([]);
    expect(payload.started).toEqual(
      {
        workflow: "github",
        runId: "webhook-started-run",
      },
    );
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
