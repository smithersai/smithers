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
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import { renderPrometheusMetrics } from "@smithers-orchestrator/observability";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway } from "../src/gateway.js";
import { streamDevToolsRoute } from "../src/gatewayRoutes/streamDevTools.js";
import { diffSnapshots } from "@smithers-orchestrator/devtools";
import { sleep } from "../../smithers/tests/helpers.js";

function now() {
  return Date.now();
}

function parsePrometheusText(text: string) {
  const metrics = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$/);
    if (!match) continue;
    const key = match[2] ? `${match[1]}${match[2]}` : match[1];
    const value = Number(match[3]);
    if (!Number.isNaN(value)) {
      metrics.set(key, value);
    }
  }
  return metrics;
}

function metricValue(snapshot: Map<string, number>, name: string) {
  let total = 0;
  for (const [key, value] of snapshot.entries()) {
    if (key === name || key.startsWith(`${name}{`)) {
      total += value;
    }
  }
  return total;
}

function frameXml(frameNo: number): string {
  return canonicalizeXml({
    kind: "element",
    tag: "smithers:workflow",
    props: { name: "stream-wf" },
    children: [
      {
        kind: "element",
        tag: "smithers:task",
        props: { id: `task-${frameNo}::0`, frameNo: String(frameNo) },
        children: [],
      },
    ],
  });
}

async function seedFrames(
  adapter: SmithersDb,
  runId: string,
  count: number,
  startFrameNo = 0,
) {
  await adapter.insertRun({
    runId,
    workflowName: "wf",
    status: "running",
    createdAtMs: now(),
  });
  for (let offset = 0; offset < count; offset += 1) {
    const frameNo = startFrameNo + offset;
    await adapter.insertFrame({
      runId,
      frameNo,
      createdAtMs: now(),
      xmlJson: frameXml(frameNo),
      xmlHash: `hash-${frameNo}`,
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: `frame-${frameNo}`,
    });
  }
}

class GatewayClient {
  ws: WebSocket;
  messages: any[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    suppressWebSocketErrors(ws);
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
    if (this.ws.readyState === this.ws.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function suppressWebSocketErrors(ws: WebSocket) {
  // Tests intentionally trigger disconnect/error paths. Bun's WebSocket
  // compatibility layer can surface those as EventTarget ErrorEvents unless a
  // persistent handler is installed in addition to Node-style listeners.
  ws.on("error", () => {});
  (ws as any).addEventListener?.("error", () => {});
  (ws as any).onerror = () => {};
}

async function connectGateway(port: number, token: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      suppressWebSocketErrors(ws);
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
        client: { id: "stream-test", version: "1.0.0", platform: "bun-test" },
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

describe("streamDevTools RPC", () => {
  let gateway: Gateway | null = null;
  let server: any = null;
  let dbPath = "";
  let adapter: SmithersDb | null = null;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smithers-stream-devtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    adapter = new SmithersDb(db);
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

  async function bootGateway() {
    const { smithers, Workflow, Task } = createSmithers(
      { out: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = smithers(() => (
      <Workflow name="stream-devtools">
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
    return (server.address() as any).port as number;
  }

  test("initial emit is always a snapshot", async () => {
    const port = await bootGateway();
    await seedFrames(adapter!, "run-stream-1", 4);
    const client = await connectGateway(port, "op-token");
    const subscribed = await client.request("streamDevTools", {
      runId: "run-stream-1",
      fromSeq: 0,
    });
    expect(subscribed.ok).toBe(true);
    const streamId = subscribed.payload.streamId;
    const event = await client.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "devtools.event" &&
        message.payload.streamId === streamId,
    );
    expect(event.payload.event.kind).toBe("snapshot");
    await client.close();
  });

  test("fromSeq>0 on a zero-frame run returns SeqOutOfRange", async () => {
    const port = await bootGateway();
    await adapter!.insertRun({
      runId: "run-no-frames-future",
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const client = await connectGateway(port, "op-token");
    const res = await client.request("streamDevTools", {
      runId: "run-no-frames-future",
      fromSeq: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("SeqOutOfRange");
    await client.close();
  });

  test("getDevToolsSnapshot(frameNo=1) on zero-frame run returns FrameOutOfRange", async () => {
    const port = await bootGateway();
    await adapter!.insertRun({
      runId: "run-no-frames-frame1",
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const client = await connectGateway(port, "op-token");
    const res = await client.request("getDevToolsSnapshot", {
      runId: "run-no-frames-frame1",
      frameNo: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("FrameOutOfRange");
    // frameNo 0 still returns the empty snapshot.
    const okRes = await client.request("getDevToolsSnapshot", {
      runId: "run-no-frames-frame1",
      frameNo: 0,
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.payload.frameNo).toBe(0);
    await client.close();
  });

  test("fromSeq=0 with no frames emits empty snapshot", async () => {
    const port = await bootGateway();
    await adapter!.insertRun({
      runId: "run-no-frames",
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    const client = await connectGateway(port, "op-token");
    const subscribed = await client.request("streamDevTools", {
      runId: "run-no-frames",
      fromSeq: 0,
    });
    expect(subscribed.ok).toBe(true);
    const event = await client.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "devtools.event" &&
        message.payload.streamId === subscribed.payload.streamId,
    );
    expect(event.payload.event.kind).toBe("snapshot");
    expect(event.payload.event.snapshot.frameNo).toBe(0);
    expect(event.payload.event.snapshot.root.name).toBe("(empty)");
    await client.close();
  });

  test("returns typed errors for invalid inputs", async () => {
    const port = await bootGateway();
    await seedFrames(adapter!, "run-stream-2", 2);
    const client = await connectGateway(port, "op-token");
    for (const bad of ["", "x".repeat(65), "../etc/passwd", "run-😀"]) {
      const res = await client.request("streamDevTools", { runId: bad });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("InvalidRunId");
    }
    const missing = await client.request("streamDevTools", {
      runId: "missing-run",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe("RunNotFound");
    const seqNegative = await client.request("streamDevTools", {
      runId: "run-stream-2",
      fromSeq: -1,
    });
    expect(seqNegative.ok).toBe(false);
    expect(seqNegative.error.code).toBe("SeqOutOfRange");
    const seqFuture = await client.request("streamDevTools", {
      runId: "run-stream-2",
      fromSeq: 99,
    });
    expect(seqFuture.ok).toBe(false);
    expect(seqFuture.error.code).toBe("SeqOutOfRange");
    await client.close();
  });

  test("cleans up subscriber map on client cancellation", async () => {
    const port = await bootGateway();
    await seedFrames(adapter!, "run-stream-3", 3);
    const client = await connectGateway(port, "op-token");
    const subscribed = await client.request("streamDevTools", {
      runId: "run-stream-3",
      fromSeq: 0,
    });
    expect(subscribed.ok).toBe(true);
    await client.close();
    await sleep(100);
    expect(gateway!.getDevToolsSubscriberCount("run-stream-3")).toBe(0);
  });

  test("rejects cross-run requests with Unauthorized when connection limits runs", async () => {
    const port = await bootGateway();
    await seedFrames(adapter!, "run-allowed", 2);
    await seedFrames(adapter!, "run-denied", 2);
    // Connect with a subscribe filter that explicitly excludes run-denied.
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
      client: { id: "stream-cross-run", version: "1.0.0", platform: "bun-test" },
      auth: { token: "op-token" },
      subscribe: ["run-allowed"],
    });
    expect(hello.ok).toBe(true);
    // Allowed run still works.
    const okRes = await client.request("streamDevTools", { runId: "run-allowed", fromSeq: 0 });
    expect(okRes.ok).toBe(true);
    // Denied run returns Unauthorized before any DB lookup.
    const denied = await client.request("streamDevTools", { runId: "run-denied", fromSeq: 0 });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("Unauthorized");
    const deniedSnap = await client.request("getDevToolsSnapshot", { runId: "run-denied" });
    expect(deniedSnap.ok).toBe(false);
    expect(deniedSnap.error.code).toBe("Unauthorized");
    await client.close();
  });

  test("requires auth before delivering devtools events", async () => {
    const port = await bootGateway();
    await seedFrames(adapter!, "run-stream-auth", 2);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const client = new GatewayClient(ws);
    await client.waitFor(
      (message) => message.type === "event" && message.event === "connect.challenge",
    );
    const res = await client.request("streamDevTools", {
      runId: "run-stream-auth",
      fromSeq: 0,
    });
    expect(res.ok).toBe(false);
    // Gateway middleware rejects with an auth-related error before dispatch
    expect(typeof res.error.code).toBe("string");
    await client.close();
  });
  test("increments devtools metrics when streaming events", async () => {
    const before = parsePrometheusText(renderPrometheusMetrics());
    const port = await bootGateway();
    await seedFrames(adapter!, "run-stream-4", 10);
    const client = await connectGateway(port, "op-token");
    const subscribed = await client.request("streamDevTools", {
      runId: "run-stream-4",
      fromSeq: 0,
    });
    expect(subscribed.ok).toBe(true);
    await client.waitFor(
      (message) =>
        message.type === "event" &&
        message.event === "devtools.event" &&
        message.payload.streamId === subscribed.payload.streamId,
    );
    await sleep(100);
    const after = parsePrometheusText(renderPrometheusMetrics());
    expect(metricValue(after, "smithers_devtools_subscribe_total")).toBeGreaterThanOrEqual(
      metricValue(before, "smithers_devtools_subscribe_total") + 1,
    );
    expect(metricValue(after, "smithers_devtools_event_total")).toBeGreaterThanOrEqual(
      metricValue(before, "smithers_devtools_event_total") + 1,
    );
    await client.close();
  });

  test("jumpToFrame through gateway rebaselines all active streamDevTools subscribers", async () => {
    const port = await bootGateway();
    const runId = "run-stream-rewind";
    // Owner userId (via configJson.auth.triggeredBy) must match the
    // "user:test" associated with "op-token".
    await adapter!.insertRun({
      runId,
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
      configJson: JSON.stringify({ auth: { triggeredBy: "user:test" } }),
    });
    for (let index = 0; index < 6; index += 1) {
      await adapter!.insertFrame({
        runId,
        frameNo: index,
        createdAtMs: now() + index,
        xmlJson: frameXml(index),
        xmlHash: `hash-${index}`,
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: `seed-${index}`,
      });
    }

    const subscribers = await Promise.all(
      Array.from({ length: 3 }, () => connectGateway(port, "op-token")),
    );
    const streamIds: string[] = [];
    for (const client of subscribers) {
      const subscribed = await client.request("streamDevTools", {
        runId,
        fromSeq: 0,
      });
      expect(subscribed.ok).toBe(true);
      streamIds.push(subscribed.payload.streamId);
      // drain initial snapshot so we have a clean baseline for rebaseline check
      await client.waitFor(
        (message) =>
          message.type === "event" &&
          message.event === "devtools.event" &&
          message.payload.streamId === subscribed.payload.streamId &&
          message.payload.event.kind === "snapshot",
      );
    }

    // Trigger a rewind via the gateway RPC so the durable `TimeTravelJumped`
    // event is persisted and the in-memory broadcast fans out to all streams.
    const admin = subscribers[0];
    const res = await admin.request("jumpToFrame", {
      runId,
      frameNo: 2,
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.newFrameNo).toBe(2);

    // Every subscriber must receive a rebaseline snapshot at or before frame 2.
    for (let index = 0; index < subscribers.length; index += 1) {
      const client = subscribers[index];
      const streamId = streamIds[index];
      const rebaseline = await client.waitFor(
        (message) =>
          message.type === "event" &&
          message.event === "devtools.event" &&
          message.payload.streamId === streamId &&
          message.payload.event.kind === "snapshot" &&
          message.payload.event.snapshot.seq <= 2,
        5_000,
      );
      expect(rebaseline.payload.event.kind).toBe("snapshot");
      expect(rebaseline.payload.event.snapshot.seq).toBeLessThanOrEqual(2);
    }

    for (const client of subscribers) {
      await client.close();
    }
  });
});

describe("streamDevToolsRoute concurrency + performance", () => {
  test("fromSeq keyframe gaps rebaseline to a full snapshot and log a warning", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await seedFrames(adapter, "run-gap", 25, 75);
    const warnings: Record<string, unknown>[] = [];
    const stream = streamDevToolsRoute({
      adapter,
      runId: "run-gap",
      fromSeq: 90,
      onLog: (level, message, fields) => {
        if (level === "warn" && message === "devtools fromSeq gap forced re-baseline") {
          warnings.push(fields);
        }
      },
    })[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.kind).toBe("snapshot");
    expect(first.value?.snapshot.seq).toBe(99);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({
      runId: "run-gap",
      fromSeq: 90,
      requestedBaseSeq: 50,
      latestSeq: 99,
    });
    await stream.return?.();
    sqlite.close();
  });

  test("10 concurrent subscribers receive identical event sequence", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await seedFrames(adapter, "run-concurrent", 6);
    const readers = Array.from({ length: 10 }, () =>
      streamDevToolsRoute({ adapter, runId: "run-concurrent", fromSeq: 0 })[
        Symbol.asyncIterator
      ](),
    );
    const readFirstThree = async (iterator: AsyncIterator<any>) => {
      const out: Array<{ kind: string; seq: number }> = [];
      while (out.length < 3) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.kind === "snapshot") {
          out.push({ kind: "snapshot", seq: next.value.snapshot.seq });
        } else {
          out.push({ kind: "delta", seq: next.value.delta.seq });
        }
      }
      await iterator.return?.();
      return out;
    };
    const sequences = await Promise.all(readers.map((reader) => readFirstThree(reader)));
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toEqual(sequences[0]);
    }
    sqlite.close();
  });

  test("disconnects slow consumers with BackpressureDisconnect", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await seedFrames(adapter, "run-backpressure", 300);
    const stream = streamDevToolsRoute({
      adapter,
      runId: "run-backpressure",
      fromSeq: 0,
      maxBufferedEvents: 2,
      pollIntervalMs: 1,
    })[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.done).toBe(false);
    await sleep(100);
    await expect(stream.next()).rejects.toMatchObject({ code: "BackpressureDisconnect" });
    sqlite.close();
  });

  test("rewind gap (latest seq drops) forces a re-baseline snapshot", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await seedFrames(adapter, "run-rewind-gap", 6);

    const stream = streamDevToolsRoute({
      adapter,
      runId: "run-rewind-gap",
      fromSeq: 0,
      pollIntervalMs: 5,
    })[Symbol.asyncIterator]();

    let currentSeq = -1;
    for (let index = 0; index < 8 && currentSeq < 5; index += 1) {
      const event = await stream.next();
      expect(event.done).toBe(false);
      if (event.value?.kind === "snapshot") {
        currentSeq = event.value.snapshot.seq;
      } else {
        currentSeq = event.value?.delta.seq ?? currentSeq;
      }
    }
    expect(currentSeq).toBe(5);

    await adapter.deleteFramesAfter("run-rewind-gap", 2);

    const rewindEvent = await stream.next();
    expect(rewindEvent.done).toBe(false);
    expect(rewindEvent.value?.kind).toBe("snapshot");
    expect(rewindEvent.value?.snapshot.seq).toBe(2);

    await stream.return?.();
    sqlite.close();
  });

  test("does not log prop values at any level", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const secret = "SUPER_SECRET_PROMPT_VALUE_DO_NOT_LOG";
    const runId = "run-no-prop-log";
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
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "log-safety" },
        children: [
          {
            kind: "element",
            tag: "smithers:task",
            props: { id: "task-secret::0", prompt: secret },
            children: [],
          },
        ],
      }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "seed",
    });
    const logs: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
    const stream = streamDevToolsRoute({
      adapter,
      runId,
      fromSeq: 0,
      onLog: (level, message, fields) => {
        logs.push({ level, message, fields });
      },
    })[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.done).toBe(false);
    await stream.return?.();
    const blob = JSON.stringify(logs);
    expect(blob).not.toContain(secret);
    sqlite.close();
  });

  test("cancellation via signal during delta computation is clean", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await seedFrames(adapter, "run-cancel", 200);
    const controller = new AbortController();
    const stream = streamDevToolsRoute({
      adapter,
      runId: "run-cancel",
      fromSeq: 0,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const first = await stream.next();
    expect(first.done).toBe(false);
    controller.abort();
    // Draining after abort should terminate without throwing
    let drained = 0;
    try {
      while (drained < 500) {
        const next = await stream.next();
        if (next.done) break;
        drained += 1;
      }
    } catch {
      // tolerate race where cancellation surfaces as error
    }
    sqlite.close();
  });

  test("reconnect storm: 100 subscribers complete without error", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await seedFrames(adapter, "run-storm", 10);
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const stream = streamDevToolsRoute({
          adapter,
          runId: "run-storm",
          fromSeq: 0,
        })[Symbol.asyncIterator]();
        const first = await stream.next();
        await stream.return?.();
        return first.value?.kind;
      }),
    );
    expect(results.every((kind) => kind === "snapshot")).toBe(true);
    sqlite.close();
  });

  test("streams initial snapshot of a 1000-node tree within budget", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = "run-large-tree";
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
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "big" },
        children: Array.from({ length: 1000 }, (_, index) => ({
          kind: "element" as const,
          tag: "smithers:task",
          props: { id: `task-${index}::0` },
          children: [] as any,
        })),
      }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "big",
    });
    const stream = streamDevToolsRoute({
      adapter,
      runId,
      fromSeq: 0,
    })[Symbol.asyncIterator]();
    const started = performance.now();
    const first = await stream.next();
    const elapsed = performance.now() - started;
    expect(first.done).toBe(false);
    expect(first.value?.kind).toBe("snapshot");
    expect(elapsed).toBeLessThan(500);
    await stream.return?.();
    sqlite.close();
  });

  test("meets local perf budgets for diff and stream first byte", async () => {
    const rootA = {
      id: 1,
      type: "workflow",
      name: "wf",
      props: {},
      children: Array.from({ length: 500 }, (_, index) => ({
        id: index + 2,
        type: "task",
        name: `task-${index}`,
        props: { index },
        task: { nodeId: `task-${index}`, kind: "static", iteration: 0 },
        children: [],
        depth: 1,
      })),
      depth: 0,
    } as any;
    const rootB = structuredClone(rootA);
    for (let index = 0; index < 10; index += 1) {
      rootB.children[index].props.index = `changed-${index}`;
    }
    const diffSamples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      diffSnapshots(
        { version: 1, runId: "perf", frameNo: 1, seq: 1, root: rootA },
        { version: 1, runId: "perf", frameNo: 2, seq: 2, root: rootB },
      );
      diffSamples.push(performance.now() - started);
    }
    diffSamples.sort((a, b) => a - b);
    const diffP95 = diffSamples[Math.floor(diffSamples.length * 0.95)] ?? 0;
    expect(diffP95).toBeLessThan(10);

    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    await adapter.insertRun({
      runId: "run-perf-stream",
      workflowName: "wf",
      status: "running",
      createdAtMs: now(),
    });
    await adapter.insertFrame({
      runId: "run-perf-stream",
      frameNo: 0,
      createdAtMs: now(),
      xmlJson: canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "perf" },
        children: Array.from({ length: 500 }, (_, index) => ({
          kind: "element",
          tag: "smithers:task",
          props: { id: `task-${index}::0` },
          children: [],
        })),
      }),
      xmlHash: "hash-perf",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "perf",
    });
    const stream = streamDevToolsRoute({
      adapter,
      runId: "run-perf-stream",
      fromSeq: 0,
    })[Symbol.asyncIterator]();
    const started = performance.now();
    const first = await stream.next();
    const firstByteMs = performance.now() - started;
    expect(first.done).toBe(false);
    expect(firstByteMs).toBeLessThan(100);
    await stream.return?.();
    sqlite.close();
  });
});
