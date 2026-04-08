/** @jsxImportSource smithers */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "../src/index";
import { Gateway } from "../src/gateway";
import { SmithersDb } from "../src/db/adapter";
import { sleep } from "./helpers";

type GatewayMessage = Record<string, any>;

function base64UrlJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwtToken(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
) {
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function getPort(server: Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

function makeDbPath(name: string) {
  return join(
    tmpdir(),
    `smithers-gateway-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createValueWorkflow(dbPath: string) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    {
      outputA: z.object({ value: z.number() }),
    },
    { dbPath },
  );

  return smithers((ctx) => (
    <Workflow name="gateway-basic">
      <Task id="task1" output={outputs.outputA}>
        {{ value: Number((ctx.input as any).value ?? 1) }}
      </Task>
    </Workflow>
  ));
}

function createApprovalWorkflow(dbPath: string) {
  const api = createSmithers(
    {
      selection: z.object({
        selected: z.string(),
        notes: z.string().nullable(),
      }),
      result: z.object({
        selected: z.string(),
      }),
    },
    { dbPath },
  );

  const workflow = api.smithers((ctx) => {
    const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });

    return (
      <api.Workflow name="gateway-approval">
        <api.Sequence>
          <api.Approval
            id="pick-plan"
            mode="select"
            output={api.outputs.selection}
            request={{
              title: "Pick a plan",
              summary: "Choose the best option.",
            }}
            options={[
              { key: "light", label: "Light" },
              { key: "balanced", label: "Balanced" },
            ]}
            allowedScopes={["approve"]}
            allowedUsers={["user:will"]}
          />
          {selection ? (
            <api.Task id="record" output={api.outputs.result}>
              {{ selected: selection.selected }}
            </api.Task>
          ) : null}
        </api.Sequence>
      </api.Workflow>
    );
  });

  return { workflow, db: api.db, tables: api.tables };
}

function createAuthWorkflow(dbPath: string) {
  const api = createSmithers(
    {
      authOutput: z.object({
        triggeredBy: z.string(),
        role: z.string(),
        scopes: z.array(z.string()),
      }),
    },
    { dbPath },
  );

  const workflow = api.smithers((ctx) => (
    <api.Workflow name="gateway-auth">
      <api.Task id="auth-task" output={api.outputs.authOutput}>
        {{
          triggeredBy: ctx.auth?.triggeredBy ?? "unknown",
          role: ctx.auth?.role ?? "unknown",
          scopes: ctx.auth?.scopes ?? [],
        }}
      </api.Task>
    </api.Workflow>
  ));

  return { workflow, db: api.db, tables: api.tables };
}

class GatewayClient {
  readonly ws: WebSocket;
  private readonly messages: GatewayMessage[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }

  async waitFor(
    predicate: (message: GatewayMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<GatewayMessage> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0]!;
      }
      await sleep(10);
    }
    throw new Error(
      `Timed out waiting for gateway message. Saw: ${JSON.stringify(
        this.messages.map((message) => ({
          type: message.type,
          event: message.event,
          id: message.id,
          payload: message.payload,
        })),
      )}`,
    );
  }

  async request(method: string, params?: unknown) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(
      JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }),
    );
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }

  async close() {
    if (this.ws.readyState === this.ws.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function connectGateway(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const client = new GatewayClient(ws);
  const challenge = await client.waitFor(
    (message) => message.type === "event" && message.event === "connect.challenge",
  );
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

async function waitForRunStatus(
  client: GatewayClient,
  runId: string,
  statuses: string[],
  timeoutMs = 5_000,
) {
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
  let gateway: Gateway;
  let server: Server;
  let dbPaths: string[] = [];

  beforeEach(() => {
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
    server = await gateway.listen({ port: 0 });
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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const validToken = createJwtToken(
      {
        iss: "https://auth.example.com",
        aud: "smithers",
        sub: "user:jwt",
        role: "operator",
        permissions: ["runs.create", "runs.get"],
        exp: Math.floor(Date.now() / 1_000) + 300,
      },
      secret,
    );

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

    const invalidAudienceToken = createJwtToken(
      {
        iss: "https://auth.example.com",
        aud: "other-service",
        sub: "user:jwt",
        permissions: ["runs.create"],
        exp: Math.floor(Date.now() / 1_000) + 300,
      },
      secret,
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const rejected = new GatewayClient(ws);
    await rejected.waitFor(
      (message) => message.type === "event" && message.event === "connect.challenge",
    );
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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const { client } = await connectGateway(port, "op-token");

    const first = await client.request("runs.create", {
      workflow: "basic",
      input: { value: 2 },
    });
    expect(first.ok).toBe(true);
    const runId = first.payload.runId as string;
    expect(typeof runId).toBe("string");

    const nodeEvent = await client.waitFor(
      (message) =>
        message.type === "event" &&
        (message.event === "node.started" || message.event === "node.finished") &&
        message.payload.runId === runId,
    );
    const runCompleted = await client.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "run.completed" &&
        message.payload.runId === runId,
    );
    expect(nodeEvent.seq).toBeLessThan(runCompleted.seq);
    expect(nodeEvent.stateVersion).toBeLessThan(runCompleted.stateVersion);

    const run = await client.request("runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(run.payload.runId).toBe(runId);
    expect(run.payload.status).toBe("finished");

    const runs = await client.request("runs.list", { limit: 10 });
    expect(runs.ok).toBe(true);
    expect(runs.payload.some((entry: any) => entry.runId === runId)).toBe(true);

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
    const secondRunId = second.payload.runId as string;
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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const { client: operator } = await connectGateway(port, "operator-token");
    const create = await operator.request("runs.create", {
      workflow: "approval",
      input: {},
    });
    expect(create.ok).toBe(true);
    const runId = create.payload.runId as string;
    await operator.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "approval.requested" &&
        message.payload.runId === runId,
    );

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

    const completed = await operator.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "run.completed" &&
        message.payload.runId === runId,
    );
    expect(completed.payload.status).toBe("finished");

    const adapter = new SmithersDb(approval.db as any);
    const approvalRow = await adapter.getApproval(runId, "pick-plan", 0);
    expect(approvalRow?.decisionJson).toEqual(
      JSON.stringify({ selected: "balanced", notes: "best fit" }),
    );

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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const { client: operator } = await connectGateway(port, "operator-token");
    const create = await operator.request("runs.create", {
      workflow: "approval",
      input: {},
    });
    expect(create.ok).toBe(true);
    const runId = create.payload.runId as string;
    await operator.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "approval.requested" &&
        message.payload.runId === runId,
    );

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

    const adapter = new SmithersDb(approval.db as any);
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
    server = await gateway.listen({ port: 0 });
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
    server = await gateway.listen({ port: 0 });
    const port = getPort(server);

    const { client } = await connectGateway(port, "operator-token");
    const created = await client.request("runs.create", {
      workflow: "auth",
      input: {},
    });
    expect(created.ok).toBe(true);
    const runId = created.payload.runId as string;

    await waitForRunStatus(client, runId, ["finished"]);

    const rows = await (authWorkflow.db as any)
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
