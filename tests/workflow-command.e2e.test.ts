import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeCodexBinary,
  writeTestWorkflow,
} from "./e2e-helpers";

function buildWorkflowEnv(homeDir: string) {
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);
  return {
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    OPENAI_API_KEY: "test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}

test("direct workflow path execution still works in a temp repo", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo);

  const result = runSmithers(["workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });
  expect(repo.exists("smithers.db")).toBe(true);
});

test("workflow list discovers flat workflows under .smithers/workflows", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/implement.tsx");

  const result = runSmithers(["workflow", "list"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    workflows: [
      {
        id: "implement",
        entryFile: repo.path(".smithers", "workflows", "implement.tsx"),
        sourceType: "user",
      },
    ],
  });
});

test("workflow path resolves a flat workflow entrypoint by id", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/implement.tsx");

  const result = runSmithers(["workflow", "path", "implement"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    id: "implement",
    path: repo.path(".smithers", "workflows", "implement.tsx"),
    sourceType: "user",
  });
});

test("workflow <name> resolves and runs a flat workflow by id", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/implement.tsx");

  const result = runSmithers(["workflow", "implement", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });

  const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
  try {
    const row = sqlite
      .query('select prompt from "result" order by rowid desc limit 1')
      .get() as { prompt: string | null } | null;
    expect(row?.prompt).toBe("hello");
  } finally {
    sqlite.close();
  }
});

test("workflow run <name> is a synonym for direct workflow invocation", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/implement.tsx");

  const result = runSmithers(["workflow", "run", "implement", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });
});

test("workflow help exposes run as a declared subcommand", () => {
  const repo = createTempRepo();

  const result = runSmithers(["workflow", "--help"], {
    cwd: repo.dir,
    format: null,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("run     Run a discovered workflow by ID.");
});

test("workflow run help exposes prompt and execution options", () => {
  const repo = createTempRepo();

  const result = runSmithers(["workflow", "run", "--help"], {
    cwd: repo.dir,
    format: null,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: smithers workflow run <name> [options]");
  expect(result.stdout).toContain("--prompt, -p <string>");
  expect(result.stdout).toContain("--serve <boolean>");
});

test("supervise help exposes polling controls", () => {
  const repo = createTempRepo();

  const result = runSmithers(["supervise", "--help"], {
    cwd: repo.dir,
    format: null,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: smithers supervise [options]");
  expect(result.stdout).toContain("--interval, -i <string>");
  expect(result.stdout).toContain("--stale-threshold, -t <string>");
  expect(result.stdout).toContain("--max-concurrent, -c <number>");
  expect(result.stdout).toContain("--dry-run, -n <boolean>");
});

test("workflow with no args lists discovered workflows", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/implement.tsx");

  const result = runSmithers(["workflow"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    workflows: [
      {
        id: "implement",
      },
    ],
  });
});

test("workflow create writes a new flat workflow file", () => {
  const repo = createTempRepo();
  const env = buildWorkflowEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const result = runSmithers(["workflow", "create", "foo"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(repo.exists(".smithers/workflows/foo.tsx")).toBe(true);
});

test("workflow create scaffolds a workflow that runs immediately", () => {
  const repo = createTempRepo();
  const env = buildWorkflowEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const createResult = runSmithers(["workflow", "create", "foo"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(createResult.exitCode).toBe(0);

  const runResult = runSmithers(["workflow", "foo", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(runResult.exitCode).toBe(0);
  expect(runResult.json).toMatchObject({
    status: "finished",
  });
}, 15_000);

test("workflow path can pause on WaitForEvent, accept a signal, and resume", () => {
  const repo = createTempRepo();
  repo.write(
    "workflow.tsx",
    [
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers, WaitForEvent, Workflow } from "smithers-orchestrator";',
      'import { z } from "zod";',
      "",
      "const { smithers, outputs } = createSmithers({",
      "  eventOut: z.object({ ok: z.boolean() }),",
      "});",
      "",
      "export default smithers(() => (",
      '  <Workflow name="wait-for-event-fixture">',
      '    <WaitForEvent id="wait" event="deploy.ready" output={outputs.eventOut} />',
      "  </Workflow>",
      "));",
      "",
    ].join("\n"),
  );

  const first = runSmithers(["workflow.tsx"], {
    cwd: repo.dir,
    format: "json",
  });

  expect(first.exitCode).toBe(3);
  expect(first.json).toMatchObject({
    status: "waiting-event",
  });

  const runId = (first.json as any)?.runId;
  expect(typeof runId).toBe("string");

  const signal = runSmithers(
    [
      "signal",
      runId,
      "deploy.ready",
      "--data",
      '{"ok":true}',
    ],
    {
      cwd: repo.dir,
      format: "json",
    },
  );

  expect(signal.exitCode).toBe(0);
  expect(signal.json).toMatchObject({
    runId,
    signalName: "deploy.ready",
    status: "signalled",
  });

  const resumed = runSmithers(
    ["workflow.tsx", "--resume", "--run-id", runId],
    {
      cwd: repo.dir,
      format: "json",
    },
  );

  expect(resumed.exitCode).toBe(0);
  expect(resumed.json).toMatchObject({
    runId,
    status: "finished",
  });

  const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
  try {
    const row = sqlite
      .query('select ok from "event_out" order by rowid desc limit 1')
      .get() as { ok: number | boolean } | null;
    expect(Boolean(row?.ok)).toBe(true);
  } finally {
    sqlite.close();
  }
}, 20_000);

test("workflow create rejects invalid workflow names", () => {
  const repo = createTempRepo();
  const env = buildWorkflowEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const result = runSmithers(["workflow", "create", "bad/name"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(4);
  expect(result.json).toMatchObject({
    code: "INVALID_WORKFLOW_NAME",
  });
});

test("workflow doctor reports discovered workflows, preload files, and agent detection", () => {
  const repo = createTempRepo();
  const env = buildWorkflowEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const result = runSmithers(["workflow", "doctor", "implement"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    preload: {
      exists: true,
    },
    bunfig: {
      exists: true,
    },
    workflows: [
      {
        id: "implement",
        sourceType: "seeded",
      },
    ],
  });
  expect(JSON.stringify(result.json)).toContain('"id":"codex"');
});
