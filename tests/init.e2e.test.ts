import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  type TempRepo,
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

function writeWorkflowPackTypecheckHarness(repo: TempRepo) {
  repo.write(
    ".smithers/types/e2e-shims.d.ts",
    [
      'declare module "*.mdx" {',
      "  const Component: any;",
      "  export default Component;",
      "}",
      "",
    ].join("\n"),
  );

  repo.write(
    ".smithers/types/smithers-orchestrator.d.ts",
    [
      'declare module "smithers-orchestrator" {',
      "  export type AgentLike = any;",
      "  export type OutputTarget = any;",
      "  export type SmithersCtx<T = any> = any;",
      "  export const Workflow: any;",
      "  export const Task: any;",
      "  export const Sequence: any;",
      "  export const Parallel: any;",
      "  export const Ralph: any;",
      "  export const Branch: any;",
      "  export const Loop: any;",
      "  export const Approval: any;",
      "  export const ContinueAsNew: any;",
      "  export const Sandbox: any;",
      "  export const Signal: any;",
      "  export const Timer: any;",
      "  export const WaitForEvent: any;",
      "  export const Worktree: any;",
      "  export const CodexAgent: any;",
      "  export const tools: any;",
      "  export const read: any;",
      "  export const write: any;",
      "  export const edit: any;",
      "  export const grep: any;",
      "  export const bash: any;",
      "  export function createSmithers(...args: any[]): any;",
      "  export function defineTool(...args: any[]): any;",
      "  export function mdxPlugin(...args: any[]): any;",
      "}",
      "",
    ].join("\n"),
  );

  repo.write(
    ".smithers/types/smithers-orchestrator-jsx-runtime.d.ts",
    [
      'declare module "smithers-orchestrator/jsx-runtime" {',
      "  export const Fragment: any;",
      "  export function jsx(type: any, props: any, key?: any): any;",
      "  export function jsxs(type: any, props: any, key?: any): any;",
      "  export function jsxDEV(type: any, props: any, key?: any): any;",
      "}",
      "",
    ].join("\n"),
  );

  repo.write(
    ".smithers/tsconfig.e2e.json",
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          strict: false,
          noImplicitAny: false,
          paths: {
            "~/*": ["./*"],
            "smithers-orchestrator": ["./types/smithers-orchestrator.d.ts"],
            "smithers-orchestrator/jsx-runtime": ["./types/smithers-orchestrator-jsx-runtime.d.ts"],
          },
        },
        include: [
          "./agents.ts",
          "./components/**/*.ts",
          "./components/**/*.tsx",
          "./preload.ts",
          "./smithers.config.ts",
          "./types/**/*.d.ts",
          "./workflows/**/*.ts",
          "./workflows/**/*.tsx",
        ],
        exclude: [
          "./executions/**/*",
        ],
      },
      null,
      2,
    ) + "\n",
  );
}

function runWorkflowPackTypecheck(repo: TempRepo) {
  writeWorkflowPackTypecheckHarness(repo);
  const typecheck = spawnSync(
    "tsc",
    ["--noEmit", "--project", "tsconfig.e2e.json"],
    {
      cwd: repo.path(".smithers"),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${repo.path("node_modules", ".bin")}:${process.env.PATH ?? ""}`,
      },
    },
  );

  if (typecheck.status !== 0) {
    throw new Error(
      [
        "workflow-pack smoke typecheck failed",
        typecheck.stdout,
        typecheck.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
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
test("smithers init writes the expected workflow-pack layout and it typechecks", () => {
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
  runWorkflowPackTypecheck(repo);
}, 20_000);

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
