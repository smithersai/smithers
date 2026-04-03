import { expect, test } from "bun:test";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
  writeFakeGeminiBinary,
} from "./e2e-helpers";

function buildWorkflowPackEnv(homeDir: string) {
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeGeminiBinary(binDir);

  return {
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "test-openai-key",
    GEMINI_API_KEY: "test-gemini-key",
    GOOGLE_API_KEY: "",
  };
}

function initWorkflowPack(repo = createTempRepo()) {
  const env = buildWorkflowPackEnv(repo.dir);
  repo.write(".claude/settings.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/oauth_creds.json", "{}\n");

  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);

  return { repo, env };
}

test("seeded implement workflow runs end-to-end and writes logs under .smithers/executions", () => {
  const { repo, env } = initWorkflowPack();

  const result = runSmithers(["workflow", "implement", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });

  const runId = (result.json as { runId?: string } | undefined)?.runId;
  expect(typeof runId).toBe("string");
  expect(repo.exists(`.smithers/executions/${runId}/logs`)).toBe(true);
});

test("seeded review workflow runs end-to-end with fake agents", () => {
  const { repo, env } = initWorkflowPack();

  const result = runSmithers(["workflow", "review", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });
});

test("seeded plan workflow runs end-to-end with fake agents", () => {
  const { repo, env } = initWorkflowPack();

  const result = runSmithers(["workflow", "plan", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });
});

test("seeded improve-test-coverage workflow resolves and runs end-to-end", () => {
  const { repo, env } = initWorkflowPack();

  const result = runSmithers(["workflow", "improve-test-coverage", "--prompt", "hello"], {
    cwd: repo.dir,
    format: "json",
    env,
  });

  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({
    status: "finished",
  });
});
