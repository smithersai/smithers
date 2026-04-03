import { describe, expect, test } from "bun:test";
import {
  diffSnapshots,
  diffRawSnapshots,
  formatDiffForTui,
  formatDiffAsJson,
} from "../../src/time-travel/diff";
import type { ParsedSnapshot } from "../../src/time-travel/types";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "../../src/db/ensure";
import { SmithersDb } from "../../src/db/adapter";
import { captureSnapshot } from "../../src/time-travel/snapshot";
import type { SnapshotData } from "../../src/time-travel/snapshot";

function makeParsed(overrides: Partial<ParsedSnapshot> = {}): ParsedSnapshot {
  return {
    runId: "run-1",
    frameNo: 0,
    nodes: {
      "analyze::0": { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out", label: null },
      "implement::0": { nodeId: "implement", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out", label: null },
    },
    outputs: { result: "hello" },
    ralph: { "main-loop": { ralphId: "main-loop", iteration: 0, done: false } },
    input: { prompt: "test" },
    vcsPointer: null,
    workflowHash: null,
    contentHash: "abc",
    createdAtMs: 1000,
    ...overrides,
  };
}

describe("diffSnapshots", () => {
  test("no differences for identical snapshots", () => {
    const a = makeParsed();
    const b = makeParsed();
    const diff = diffSnapshots(a, b);

    expect(diff.nodesAdded).toEqual([]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.nodesChanged).toEqual([]);
    expect(diff.outputsAdded).toEqual([]);
    expect(diff.outputsRemoved).toEqual([]);
    expect(diff.outputsChanged).toEqual([]);
    expect(diff.ralphChanged).toEqual([]);
    expect(diff.inputChanged).toBe(false);
    expect(diff.vcsPointerChanged).toBe(false);
  });

  test("detects added nodes", () => {
    const a = makeParsed();
    const b = makeParsed({
      nodes: {
        ...a.nodes,
        "review::0": { nodeId: "review", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out", label: null },
      },
    });
    const diff = diffSnapshots(a, b);
    expect(diff.nodesAdded).toEqual(["review::0"]);
  });

  test("detects removed nodes", () => {
    const a = makeParsed();
    const b = makeParsed({
      nodes: {
        "analyze::0": a.nodes["analyze::0"]!,
      },
    });
    const diff = diffSnapshots(a, b);
    expect(diff.nodesRemoved).toEqual(["implement::0"]);
  });

  test("detects changed node state", () => {
    const a = makeParsed();
    const b = makeParsed({
      nodes: {
        ...a.nodes,
        "implement::0": { nodeId: "implement", iteration: 0, state: "running", lastAttempt: 1, outputTable: "out", label: null },
      },
    });
    const diff = diffSnapshots(a, b);
    expect(diff.nodesChanged.length).toBe(1);
    expect(diff.nodesChanged[0]!.nodeId).toBe("implement::0");
    expect(diff.nodesChanged[0]!.from.state).toBe("pending");
    expect(diff.nodesChanged[0]!.to.state).toBe("running");
  });

  test("detects added outputs", () => {
    const a = makeParsed();
    const b = makeParsed({ outputs: { result: "hello", extra: "world" } });
    const diff = diffSnapshots(a, b);
    expect(diff.outputsAdded).toEqual(["extra"]);
  });

  test("detects removed outputs", () => {
    const a = makeParsed();
    const b = makeParsed({ outputs: {} });
    const diff = diffSnapshots(a, b);
    expect(diff.outputsRemoved).toEqual(["result"]);
  });

  test("detects changed outputs", () => {
    const a = makeParsed();
    const b = makeParsed({ outputs: { result: "changed" } });
    const diff = diffSnapshots(a, b);
    expect(diff.outputsChanged.length).toBe(1);
    expect(diff.outputsChanged[0]!.key).toBe("result");
  });

  test("detects ralph changes", () => {
    const a = makeParsed();
    const b = makeParsed({
      ralph: { "main-loop": { ralphId: "main-loop", iteration: 1, done: false } },
    });
    const diff = diffSnapshots(a, b);
    expect(diff.ralphChanged.length).toBe(1);
    expect(diff.ralphChanged[0]!.from.iteration).toBe(0);
    expect(diff.ralphChanged[0]!.to.iteration).toBe(1);
  });

  test("detects input changes", () => {
    const a = makeParsed();
    const b = makeParsed({ input: { prompt: "different" } });
    const diff = diffSnapshots(a, b);
    expect(diff.inputChanged).toBe(true);
  });

  test("detects VCS pointer changes", () => {
    const a = makeParsed({ vcsPointer: "abc123" });
    const b = makeParsed({ vcsPointer: "def456" });
    const diff = diffSnapshots(a, b);
    expect(diff.vcsPointerChanged).toBe(true);
  });
});

describe("diffRawSnapshots", () => {
  test("compares two raw snapshot rows", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);

    const dataA: SnapshotData = {
      nodes: [{ nodeId: "a", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out", label: null }],
      outputs: {},
      ralph: [],
      input: { x: 1 },
    };
    const dataB: SnapshotData = {
      nodes: [{ nodeId: "a", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out", label: null }],
      outputs: { result: "done" },
      ralph: [],
      input: { x: 1 },
    };

    const snapA = await captureSnapshot(adapter, "run-1", 0, dataA);
    const snapB = await captureSnapshot(adapter, "run-1", 1, dataB);

    const diff = diffRawSnapshots(snapA, snapB);
    expect(diff.nodesChanged.length).toBe(1);
    expect(diff.outputsAdded).toEqual(["result"]);
    expect(diff.inputChanged).toBe(false);
  });
});

describe("formatDiffForTui", () => {
  test("returns 'No differences' for empty diff", () => {
    const a = makeParsed();
    const diff = diffSnapshots(a, a);
    const output = formatDiffForTui(diff);
    expect(output).toContain("No differences");
  });

  test("shows colorized changes", () => {
    const a = makeParsed();
    const b = makeParsed({
      nodes: {
        ...a.nodes,
        "implement::0": { nodeId: "implement", iteration: 0, state: "running", lastAttempt: 1, outputTable: "out", label: null },
      },
    });
    const diff = diffSnapshots(a, b);
    const output = formatDiffForTui(diff);
    expect(output).toContain("implement::0");
    expect(output).toContain("pending");
    expect(output).toContain("running");
  });
});

describe("formatDiffAsJson", () => {
  test("returns the diff as a plain object", () => {
    const a = makeParsed();
    const b = makeParsed({ input: { prompt: "different" } });
    const diff = diffSnapshots(a, b);
    const json = formatDiffAsJson(diff) as any;
    expect(json.inputChanged).toBe(true);
  });
});
