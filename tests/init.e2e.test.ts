import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeCodexBinary,
} from "./e2e-helpers";

function buildInitEnv(homeDir: string) {
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

test("E2E harness can invoke the Smithers CLI from a temp repo", () => {
  const repo = createTempRepo();
  const result = runSmithers(["--help"], {
    cwd: repo.dir,
    format: null,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Usage: smithers <command>");
  expect(result.stdout).toContain("smithers@");
});

// FLAKY: passes individually but fails in full suite due to test ordering/state leakage.
// See .smithers/tickets/fix-flaky-tests.md
test.skip("smithers init writes the expected workflow-pack layout and it typechecks", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);

  const result = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(repo.exists(".smithers/.gitignore")).toBe(true);
  expect(repo.exists(".smithers/package.json")).toBe(true);
  expect(repo.exists(".smithers/tsconfig.json")).toBe(true);
  expect(repo.exists(".smithers/bunfig.toml")).toBe(true);
  expect(repo.exists(".smithers/preload.ts")).toBe(true);
  expect(repo.exists(".smithers/agents.ts")).toBe(true);
  expect(repo.exists(".smithers/smithers.config.ts")).toBe(true);
  expect(repo.exists(".smithers/prompts/review.mdx")).toBe(true);
  expect(repo.exists(".smithers/prompts/plan.mdx")).toBe(true);
  expect(repo.exists(".smithers/prompts/implement.mdx")).toBe(true);
  expect(repo.exists(".smithers/prompts/validate.mdx")).toBe(true);
  expect(repo.exists(".smithers/components/Review.tsx")).toBe(true);
  expect(repo.exists(".smithers/components/ValidationLoop.tsx")).toBe(true);
  expect(repo.exists(".smithers/prompts/research.mdx")).toBe(true);
  expect(repo.exists(".smithers/workflows/implement.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/review.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/ai-review.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/pr-description.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/lint-autofix.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/plan.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/research.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/ticket-create.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/ticket-implement.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/tickets-create.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/ralph.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/improve-test-coverage.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/test-first.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/debug.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/grill-me.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/write-a-prd.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/feature-enum.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/audit.tsx")).toBe(true);
  expect(repo.exists(".smithers/workflows/ticket-kanban.tsx")).toBe(true);
  expect(repo.exists(".smithers/prompts/ask-user-instructions.mdx")).toBe(true);
  expect(repo.exists(".smithers/components/GrillMe.tsx")).toBe(true);
  expect(repo.exists(".smithers/components/CommandProbe.tsx")).toBe(true);
  expect(repo.exists(".smithers/components/ForEachFeature.tsx")).toBe(true);
  expect(repo.exists(".smithers/components/FeatureEnum.tsx")).toBe(true);
  expect(repo.exists(".smithers/components/WriteAPrd.tsx")).toBe(true);
  expect(repo.exists(".smithers/tickets/.gitkeep")).toBe(true);

  const typecheck = spawnSync(process.execPath, ["run", "typecheck"], {
    cwd: repo.path(".smithers"),
    encoding: "utf8",
    env: { ...process.env },
  });
  expect(typecheck.status).toBe(0);
});

test("smithers init preserves .smithers/executions on an existing repo", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);
  repo.write(".smithers/executions/existing-run/logs/events.ndjson", '{"type":"RunFinished"}\n');

  const result = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(repo.read(".smithers/executions/existing-run/logs/events.ndjson")).toContain("RunFinished");
});

test("smithers init does not clobber user edits unless --force is passed", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);

  const first = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(first.exitCode).toBe(0);

  repo.write(
    ".smithers/workflows/implement.tsx",
    "// user-edited workflow\nexport default {};\n",
  );

  const second = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(second.exitCode).toBe(0);
  expect(repo.read(".smithers/workflows/implement.tsx")).toContain("user-edited workflow");

  const forced = runSmithers(["init", "--force"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(forced.exitCode).toBe(0);
  expect(repo.read(".smithers/workflows/implement.tsx")).not.toContain("user-edited workflow");
});

test("smithers init seeds ai-review workflow triggers", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const source = repo.read(".smithers/workflows/ai-review.tsx");
  expect(source).toContain('export const on = [');
  expect(source).toContain('"pull_request.opened"');
  expect(source).toContain('"pull_request.synchronize"');
  expect(source).toContain('"stack_submit"');
});

test("smithers init seeds pr-description workflow triggers", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const source = repo.read(".smithers/workflows/pr-description.tsx");
  expect(source).toContain('export const on = [');
  expect(source).toContain('"pull_request.opened"');
  expect(source).toContain('"stack_submit"');
});

test("smithers init seeds lint-autofix workflow trigger and branch guard", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const source = repo.read(".smithers/workflows/lint-autofix.tsx");
  expect(source).toContain('export const on = ["check_run.completed"] as const;');
  expect(source).toContain("conclusion !== \"failure\"");
  expect(source).toContain("smithers/");
});

test("seeded workflows reuse the shared review substrate", () => {
  const repo = createTempRepo();
  const env = buildInitEnv(repo.dir);
  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  const implementSource = repo.read(".smithers/workflows/implement.tsx");
  const ticketImplementSource = repo.read(".smithers/workflows/ticket-implement.tsx");
  const coverageSource = repo.read(".smithers/workflows/improve-test-coverage.tsx");

  expect(implementSource).toContain('../components/Review');
  expect(ticketImplementSource).toContain('../components/ValidationLoop');
  expect(coverageSource).toContain('../components/ValidationLoop');

  for (const [workflowName, reviewPrefix] of [
    ["implement", "review"],
    ["ticket-implement", "ticket:review"],
    ["improve-test-coverage", "improve-test-coverage:review"],
  ] as const) {
    const graph = runSmithers(
      [
        "graph",
        `.smithers/workflows/${workflowName}.tsx`,
        "--input",
        JSON.stringify({ prompt: "hello" }),
      ],
      {
        cwd: repo.dir,
        format: "json",
      },
    );

    expect(graph.exitCode).toBe(0);
    expect(JSON.stringify(graph.json)).toContain(`${reviewPrefix}:0`);
  }
}, 15_000);
