import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeXml } from "@smithers/graph/utils/xml";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { streamDevToolsRoute } from "../src/gatewayRoutes/streamDevTools.js";

const soakEnabled = process.env.SMITHERS_SOAK === "1";
const soakTest = soakEnabled ? test : test.skip;
const soakDurationMs = Number(process.env.SMITHERS_SOAK_MS ?? 10_000);

function now() {
  return Date.now();
}

describe("streamDevTools soak (opt-in)", () => {
  soakTest(
    "streams sustained events with no ordering regressions",
    async () => {
    const dbPath = join(
      tmpdir(),
      `smithers-stream-devtools-soak-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const runId = "run-soak";
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
        props: { name: "soak" },
        children: [],
      }),
      xmlHash: "hash-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "seed",
    });

    const durationMs = soakDurationMs;
    const subscribers = 5;
    const controllers = Array.from({ length: subscribers }, () => new AbortController());
    const iterators = controllers.map((controller) =>
      streamDevToolsRoute({
        adapter,
        runId,
        fromSeq: 0,
        pollIntervalMs: 10,
        signal: controller.signal,
      })[Symbol.asyncIterator](),
    );
    const receivedSeqs = Array.from({ length: subscribers }, () => [] as number[]);
    const baselineRss = process.memoryUsage().rss;

    let frameNo = 1;
    let stopped = false;
    const writer = (async () => {
      while (!stopped) {
        await adapter.insertFrame({
          runId,
          frameNo,
          createdAtMs: now(),
          xmlJson: canonicalizeXml({
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "soak" },
            children: [
              {
                kind: "element",
                tag: "smithers:task",
                props: { id: `task-${frameNo}::0` },
                children: [],
              },
            ],
          }),
          xmlHash: `hash-${frameNo}`,
          mountedTaskIdsJson: "[]",
          taskIndexJson: "[]",
          note: "soak",
        });
        frameNo += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    const readers = iterators.map((iterator, index) =>
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const seq =
            next.value.kind === "snapshot"
              ? next.value.snapshot.seq
              : next.value.delta.seq;
          receivedSeqs[index].push(seq);
        }
      })(),
    );

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    stopped = true;
    for (const controller of controllers) {
      controller.abort();
    }
    await writer;
    await Promise.allSettled(readers);

    for (const seqs of receivedSeqs) {
      expect(seqs.length).toBeGreaterThan(0);
      let monotonic = true;
      for (let i = 1; i < seqs.length; i += 1) {
        if (seqs[i] < seqs[i - 1]) {
          monotonic = false;
          break;
        }
      }
      expect(monotonic).toBe(true);
    }

    const rssGrowthMb = (process.memoryUsage().rss - baselineRss) / (1024 * 1024);
    expect(rssGrowthMb).toBeLessThan(50);
    sqlite.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    },
    soakDurationMs + 20_000,
  );
});
