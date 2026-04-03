import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/db/adapter";
import { ensureSmithersTables } from "../src/db/ensure";
import {
  createExecutableDir,
  createTempRepo,
  prependPath,
  runSmithers,
  writeExecutable,
} from "./e2e-helpers";

function openRepoDb(repo: ReturnType<typeof createTempRepo>) {
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db as any);
  return {
    sqlite,
    adapter: new SmithersDb(db as any),
  };
}

test("hijack reopens the latest Claude Code session for a finished run", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);
  const argsFile = repo.path("claude-hijack.json");
  const binDir = createExecutableDir();

  writeExecutable(
    binDir,
    "claude",
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const target = process.env.CLAUDE_HIJACK_FILE;',
      'if (target) fs.writeFileSync(target, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }), "utf8");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );

  try {
    await adapter.insertRun({
      runId: "run-hijack",
      workflowName: "hijack-fixture",
      workflowPath: repo.path("workflow.tsx"),
      status: "finished",
      createdAtMs: 1_000,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
    });

    await adapter.insertAttempt({
      runId: "run-hijack",
      nodeId: "plan",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 1_100,
      finishedAtMs: 1_800,
      errorJson: null,
      jjPointer: null,
      jjCwd: repo.dir,
      cached: false,
      metaJson: JSON.stringify({
        kind: "agent",
        agentEngine: "claude-code",
        agentResume: "session_123",
      }),
      responseText: "done",
    });

    const result = runSmithers(["hijack", "run-hijack"], {
      cwd: repo.dir,
      format: null,
      env: {
        ...prependPath(binDir),
        CLAUDE_HIJACK_FILE: argsFile,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("return control to Smithers");

    const launched = JSON.parse(repo.read("claude-hijack.json")) as {
      cwd: string;
      args: string[];
    };
    expect(launched.cwd).toBe(repo.dir);
    expect(launched.args).toEqual(["--resume", "session_123"]);
  } finally {
    sqlite.close();
  }
});

test("hijack exposes conversation-mode handoff details for SDK-backed runs", async () => {
  const repo = createTempRepo();
  const { sqlite, adapter } = openRepoDb(repo);

  try {
    await adapter.insertRun({
      runId: "run-conversation-hijack",
      workflowName: "conversation-hijack-fixture",
      workflowPath: repo.path("workflow.tsx"),
      status: "finished",
      createdAtMs: 1_000,
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
    });

    await adapter.insertAttempt({
      runId: "run-conversation-hijack",
      nodeId: "plan",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 1_100,
      finishedAtMs: 1_800,
      errorJson: null,
      jjPointer: null,
      jjCwd: repo.dir,
      cached: false,
      metaJson: JSON.stringify({
        kind: "agent",
        agentEngine: "openai-sdk",
        agentConversation: [
          { role: "user", content: "Continue the work" },
          { role: "assistant", content: "I already inspected the repo." },
        ],
      }),
      responseText: "done",
    });

    const result = runSmithers(
      ["hijack", "run-conversation-hijack", "--launch=false"],
      {
        cwd: repo.dir,
        format: "json",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      runId: "run-conversation-hijack",
      engine: "openai-sdk",
      mode: "conversation",
      nodeId: "plan",
      attempt: 1,
      iteration: 0,
      resume: null,
      messageCount: 2,
      cwd: repo.dir,
      launch: null,
      resumeCommand: `smithers up ${repo.path("workflow.tsx")} --resume --run-id run-conversation-hijack`,
    });
  } finally {
    sqlite.close();
  }
});
