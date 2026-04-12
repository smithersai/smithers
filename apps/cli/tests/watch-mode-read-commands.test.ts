import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { createTempRepo, type TempRepo } from "../../../packages/smithers/tests/e2e-helpers";

const BUN_BINARY = process.execPath;
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.ts");
const CLEAR_SCREEN_SEQUENCE = "\x1B[2J\x1B[0f";
const WATCH_STARTUP_TIMEOUT_MS = 20_000;

type LiveSmithersProcess = {
  child: ReturnType<typeof spawn>;
  readStdout: () => string;
  readStderr: () => string;
  exited: Promise<{ exitCode: number; signal: NodeJS.Signals | null }>;
};

function openRepoDb(repo: TempRepo) {
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db as any);
  return {
    sqlite,
    adapter: new SmithersDb(db as any),
  };
}

function spawnSmithersLive(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  },
): LiveSmithersProcess {
  const child = spawn(BUN_BINARY, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) => {
        resolveExit({
          exitCode: code ?? 1,
          signal,
        });
      });
    },
  );

  return {
    child,
    readStdout: () => stdout,
    readStderr: () => stderr,
    exited,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForExit(
  exited: Promise<{ exitCode: number; signal: NodeJS.Signals | null }>,
  timeoutMs = 7_500,
) {
  return await new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timeoutId = setTimeout(() => {
        rejectExit(
          new Error(`Timed out waiting for smithers process after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      exited.then(
        (value) => {
          clearTimeout(timeoutId);
          resolveExit(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          rejectExit(error);
        },
      );
    },
  );
}

async function stopProcess(
  processRef: LiveSmithersProcess,
  signal: NodeJS.Signals = "SIGINT",
) {
  processRef.child.kill(signal);
  return waitForExit(processRef.exited);
}

async function ensureProcessStopped(processRef: LiveSmithersProcess) {
  if (processRef.child.exitCode !== null || processRef.child.killed) {
    return;
  }
  processRef.child.kill("SIGKILL");
  await waitForExit(processRef.exited, 2_000).catch(() => undefined);
}

function countOccurrences(source: string, needle: string) {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

async function waitForMatch(
  read: () => string,
  matcher: string,
  timeoutMs = 8_000,
  pollMs = 50,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (read().includes(matcher)) return;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for output containing "${matcher}"`);
}

async function insertRun(
  adapter: SmithersDb,
  runId: string,
  status: string,
) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "watch-fixture",
    status,
    createdAtMs: now - 2_000,
    startedAtMs: now - 2_000,
    finishedAtMs: status === "finished" ? now : null,
  });
}

function createOutputTable(sqlite: Database, table = "node_output") {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      confidence REAL,
      summary TEXT
    );`,
  );
}

test(
  "ps --watch re-renders repeatedly and exits cleanly on SIGINT",
  async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    let processRef: LiveSmithersProcess | undefined;

    try {
      await insertRun(adapter, "watch-ps-run", "running");

      processRef = spawnSmithersLive(
        ["ps", "--watch", "--interval", "0.2", "--format", "json"],
        { cwd: repo.dir },
      );

      await waitForMatch(
        processRef.readStderr,
        "--interval clamped to 500ms",
        WATCH_STARTUP_TIMEOUT_MS,
      );
      await waitForMatch(processRef.readStdout, "watch-ps-run");
      await sleep(1_250);
      const exit = await stopProcess(processRef, "SIGINT");

      expect(exit.exitCode === 0 || exit.signal === "SIGINT").toBe(true);

      const stdout = processRef.readStdout();
      const stderr = processRef.readStderr();
      expect(stdout).toContain("watch-ps-run");
      expect(countOccurrences(stdout, CLEAR_SCREEN_SEQUENCE)).toBeGreaterThanOrEqual(1);
      expect(stderr).toContain("--interval clamped to 500ms");
    } finally {
      if (processRef) {
        await ensureProcessStopped(processRef);
      }
      sqlite.close();
    }
  },
  30_000,
);

test(
  "inspect --watch auto-exits when run reaches a terminal state",
  async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    let processRef: LiveSmithersProcess | undefined;

    try {
      await insertRun(adapter, "watch-inspect-run", "running");

      processRef = spawnSmithersLive(
        ["inspect", "watch-inspect-run", "--watch", "--interval", "0.2", "--format", "json"],
        { cwd: repo.dir },
      );

      await waitForMatch(
        processRef.readStderr,
        "--interval clamped to 500ms",
        WATCH_STARTUP_TIMEOUT_MS,
      );
      await waitForMatch(processRef.readStdout, "\"id\": \"watch-inspect-run\"");
      await adapter.updateRun("watch-inspect-run", {
        status: "finished",
        finishedAtMs: Date.now(),
      });

      const exit = await waitForExit(processRef.exited);
      expect(exit.exitCode).toBe(0);

      const stdout = processRef.readStdout();
      expect(stdout).toContain("\"id\": \"watch-inspect-run\"");
      expect(stdout).toContain("\"status\": \"finished\"");
      expect(countOccurrences(stdout, CLEAR_SCREEN_SEQUENCE)).toBeGreaterThanOrEqual(1);
    } finally {
      if (processRef) {
        await ensureProcessStopped(processRef);
      }
      sqlite.close();
    }
  },
  30_000,
);

test(
  "events --watch appends new events without clearing the screen",
  async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    let processRef: LiveSmithersProcess | undefined;

    try {
      await insertRun(adapter, "watch-events-run", "running");

      processRef = spawnSmithersLive(
        ["events", "watch-events-run", "--watch", "--interval", "0.2", "--json"],
        { cwd: repo.dir },
      );

      await waitForMatch(
        processRef.readStderr,
        "--interval clamped to 500ms",
        WATCH_STARTUP_TIMEOUT_MS,
      );
      await sleep(600);

      const now = Date.now();
      await adapter.insertEventWithNextSeq({
        runId: "watch-events-run",
        timestampMs: now,
        type: "RunHeartbeat",
        payloadJson: JSON.stringify({
          type: "RunHeartbeat",
          runId: "watch-events-run",
          timestampMs: now,
        }),
      });

      await adapter.insertEventWithNextSeq({
        runId: "watch-events-run",
        timestampMs: now + 10,
        type: "RunFinished",
        payloadJson: JSON.stringify({
          type: "RunFinished",
          runId: "watch-events-run",
          timestampMs: now + 10,
        }),
      });

      await adapter.updateRun("watch-events-run", {
        status: "finished",
        finishedAtMs: now + 10,
      });

      const exit = await waitForExit(processRef.exited);
      expect(exit.exitCode).toBe(0);

      const stdout = processRef.readStdout();
      expect(stdout).toContain("\"type\":\"RunHeartbeat\"");
      expect(stdout).toContain("\"type\":\"RunFinished\"");
      expect(stdout).not.toContain(CLEAR_SCREEN_SEQUENCE);
    } finally {
      if (processRef) {
        await ensureProcessStopped(processRef);
      }
      sqlite.close();
    }
  },
  30_000,
);

test(
  "node --watch re-renders and auto-exits when run becomes terminal",
  async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    let processRef: LiveSmithersProcess | undefined;

    try {
      await insertRun(adapter, "watch-node-run", "running");
      createOutputTable(sqlite);
      await adapter.insertNode({
        runId: "watch-node-run",
        nodeId: "watch-node",
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "node_output",
        label: "Watch Node",
      });

      await adapter.insertAttempt({
        runId: "watch-node-run",
        nodeId: "watch-node",
        iteration: 0,
        attempt: 1,
        state: "in-progress",
        startedAtMs: Date.now() - 100,
        finishedAtMs: null,
        errorJson: null,
        metaJson: JSON.stringify({ kind: "agent" }),
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: repo.dir,
      });

      processRef = spawnSmithersLive(
        ["node", "watch-node", "-r", "watch-node-run", "--watch", "--interval", "0.2", "--format", "json"],
        { cwd: repo.dir },
      );

      await waitForMatch(
        processRef.readStderr,
        "--interval clamped to 500ms",
        WATCH_STARTUP_TIMEOUT_MS,
      );
      await waitForMatch(processRef.readStdout, "\"nodeId\": \"watch-node\"");

      await adapter.insertNode({
        runId: "watch-node-run",
        nodeId: "watch-node",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "node_output",
        label: "Watch Node",
      });
      await adapter.updateRun("watch-node-run", {
        status: "finished",
        finishedAtMs: Date.now(),
      });

      const exit = await waitForExit(processRef.exited);
      expect(exit.exitCode).toBe(0);

      const stdout = processRef.readStdout();
      expect(stdout).toContain("\"nodeId\": \"watch-node\"");
      expect(stdout).toContain("\"status\": \"finished\"");
      expect(countOccurrences(stdout, CLEAR_SCREEN_SEQUENCE)).toBeGreaterThanOrEqual(1);
    } finally {
      if (processRef) {
        await ensureProcessStopped(processRef);
      }
      sqlite.close();
    }
  },
  30_000,
);
