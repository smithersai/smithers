/** @jsxImportSource smithers-orchestrator */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { canonicalizeXml } from "@smithers/graph/utils/xml";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { Gateway } from "../src/gateway.js";
import { getDevToolsSnapshotRoute } from "../src/gatewayRoutes/getDevToolsSnapshot.js";
import { sleep } from "../../smithers/tests/helpers.js";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function xmlFrame(name = "workflow", value = "ok"): string {
  return canonicalizeXml({
    kind: "element",
    tag: "smithers:workflow",
    props: { name },
    children: [
      {
        kind: "element",
        tag: "smithers:task",
        props: { id: "task-a::0", value },
        children: [],
      },
    ],
  });
}

function deepXml(depth: number): string {
  let cursor: any = {
    kind: "element",
    tag: "smithers:task",
    props: { id: "leaf::0" },
    children: [],
  };
  for (let index = depth - 1; index >= 0; index -= 1) {
    cursor = {
      kind: "element",
      tag: "smithers:task",
      props: { id: `node-${index}::0` },
      children: [cursor],
    };
  }
  return canonicalizeXml({
    kind: "element",
    tag: "smithers:workflow",
    props: { name: "deep" },
    children: [cursor],
  });
}

function now() {
  return Date.now();
}

class GatewayClient {
  ws: WebSocket;
  messages: any[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await sleep(10);
    }
    throw new Error("timed out waiting for gateway message");
  }

  async request(method: string, params?: unknown) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const client = new GatewayClient(ws);
      await client.waitFor(
        (message) => message.type === "event" && message.event === "connect.challenge",
      );
      const hello = await client.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "devtools-test", version: "1.0.0", platform: "bun-test" },
        auth: { token },
      });
      expect(hello.ok).toBe(true);
      return client;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await sleep(50);
    }
  }
  throw new Error("unreachable");
}

describe("getDevToolsSnapshotRoute", () => {
  test("returns requested snapshot and defaults to latest frame", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-devtools";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("first", "one"),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: now(),
      xmlJson: xmlFrame("second", "two"),
      xmlHash: "hash-1",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-1",
    });
    const first = await getDevToolsSnapshotRoute({
      adapter,
      runId,
      frameNo: 0,
    });
    expect(first.frameNo).toBe(0);
    expect(first.root.name).toBe("first");
    const latest = await getDevToolsSnapshotRoute({
      adapter,
      runId,
    });
    expect(latest.frameNo).toBe(1);
    expect(latest.root.name).toBe("second");
    sqlite.close();
  });

  test("validates runId boundary cases and missing runs", async () => {
    const { adapter, sqlite } = createAdapter();
    for (const runId of ["", "x".repeat(65), "../etc/passwd", "run-😀"]) {
      await expect(
        getDevToolsSnapshotRoute({
          adapter,
          runId,
        }),
      ).rejects.toMatchObject({ code: "InvalidRunId" });
    }
    await expect(
      getDevToolsSnapshotRoute({
        adapter,
        runId: "missing-run",
      }),
    ).rejects.toMatchObject({ code: "RunNotFound" });
    sqlite.close();
  });

  test("validates frameNo boundaries", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-bounds";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("zero", "zero"),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "frame-0",
    });
    await expect(
      getDevToolsSnapshotRoute({ adapter, runId, frameNo: -1 as any }),
    ).rejects.toMatchObject({ code: "FrameOutOfRange" });
    await expect(
      getDevToolsSnapshotRoute({ adapter, runId, frameNo: Number.MAX_SAFE_INTEGER }),
    ).rejects.toMatchObject({ code: "FrameOutOfRange" });
    await expect(
      getDevToolsSnapshotRoute({ adapter, runId, frameNo: 1 }),
    ).rejects.toMatchObject({ code: "FrameOutOfRange" });
    const first = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect(first.frameNo).toBe(0);
    sqlite.close();
  });

  test("returns empty root for runs with zero frames", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-no-frames";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const snapshot = await getDevToolsSnapshotRoute({ adapter, runId });
    expect(snapshot.frameNo).toBe(0);
    expect(snapshot.root.name).toBe("(empty)");
    sqlite.close();
  });

  test("assigns stable node IDs across sibling reorder", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-stable-ids";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const frameWithOrder = (order: string[]) =>
      canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "stable" },
        children: order.map((id) => ({
          kind: "element" as const,
          tag: "smithers:task",
          props: { id: `${id}::0` },
          children: [] as any,
        })),
      });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: frameWithOrder(["a", "b"]),
      xmlHash: "hash-ab",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "ab",
    });
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: now(),
      xmlJson: frameWithOrder(["b", "a"]),
      xmlHash: "hash-ba",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "ba",
    });
    const firstSnapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    const secondSnapshot = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 1 });
    const idOf = (snap: any, taskId: string) =>
      (snap.root.children as any[]).find(
        (child) => (child.task?.nodeId ?? "") === taskId,
      )?.id;
    const aFirst = idOf(firstSnapshot, "a");
    const bFirst = idOf(firstSnapshot, "b");
    const aSecond = idOf(secondSnapshot, "a");
    const bSecond = idOf(secondSnapshot, "b");
    // Stable identity: the id for task "a" must match across frames even
    // though the sibling order changed. Same for "b".
    expect(aFirst).toBe(aSecond);
    expect(bFirst).toBe(bSecond);
    // And the two tasks never collide in the same frame.
    expect(aFirst).not.toBe(bFirst);
    sqlite.close();
  });

  test("handles 10MB prop strings and deep trees", async () => {
    const { adapter, sqlite } = createAdapter();
    const runId = "run-large";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const largeString = "x".repeat(10 * 1024 * 1024);
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "ユニコード" },
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "task-unicode::0", payload: largeString },
            children: [],
          },
        ],
      }),
      xmlHash: "hash-large",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "large",
    });
    const large = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 0 });
    expect((large.root.children[0]?.props.payload as string).length).toBe(10 * 1024 * 1024);
    await adapter.insertFrame({
      runId,
      frameNo: 1,
      createdAtMs: now(),
      xmlJson: deepXml(1000),
      xmlHash: "hash-deep",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "deep",
    });
    const deep = await getDevToolsSnapshotRoute({ adapter, runId, frameNo: 1 });
    const stack = [deep.root];
    let hasMaxDepthMarker = false;
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.name === "[MaxDepth]") {
        hasMaxDepthMarker = true;
        break;
      }
      for (const child of current.children) {
        stack.push(child);
      }
    }
    expect(hasMaxDepthMarker).toBe(true);
    sqlite.close();
  });
});

describe("Gateway getDevToolsSnapshot RPC", () => {
  let gateway: Gateway | null = null;
  let server: any = null;
  let dbPath = "";

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smithers-get-devtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = null;
    }
    server = null;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  test("returns snapshots over websocket RPC", async () => {
    const { smithers, Workflow, Task } = createSmithers(
      { out: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = smithers(() => (
      <Workflow name="gateway-devtools">
        <Task id="task-a">{{ value: 1 }}</Task>
      </Workflow>
    ));
    gateway = new Gateway({
      protocol: 1,
      auth: {
        mode: "token",
        tokens: {
          "op-token": {
            role: "operator",
            scopes: ["*"],
            userId: "user:test",
          },
        },
      },
    });
    gateway.register("wf", workflow);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.address() as any).port as number;
    const adapter = new SmithersDb(workflow.db);
    const runId = "run-rpc-devtools";
    await adapter.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: xmlFrame("rpc-workflow", "rpc"),
      xmlHash: "hash-rpc",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "rpc",
    });
    const client = await connectGateway(port, "op-token");
    const response = await client.request("getDevToolsSnapshot", {
      runId,
      frameNo: 0,
    });
    expect(response.ok).toBe(true);
    expect(response.payload.version).toBe(1);
    expect(response.payload.runId).toBe(runId);
    expect(response.payload.root.name).toBe("rpc-workflow");
    await client.close();
  });
});
