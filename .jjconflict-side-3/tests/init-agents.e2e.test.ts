import { expect, test } from "bun:test";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
  writeFakeGeminiBinary,
} from "./e2e-helpers";

function buildEnv(homeDir: string, binDir: string, extra: Record<string, string> = {}) {
  return {
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    ...extra,
  };
}

test("smithers init prefers Claude when only a Claude CLI signal is available", () => {
  const repo = createTempRepo();
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  repo.write(".claude/settings.json", "{}\n");

  const result = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env: buildEnv(repo.dir, binDir),
  });

  expect(result.exitCode).toBe(0);
  const agentsSource = repo.read(".smithers/agents.ts");
  expect(agentsSource).toContain('claude: new ClaudeCodeAgent');
  expect(agentsSource).toContain("review: [providers.claude]");
  expect(agentsSource).not.toContain("providers.codex");
});

test("smithers init includes Codex implementation roles when Codex plus OPENAI_API_KEY are available", () => {
  const repo = createTempRepo();
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);

  const result = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env: buildEnv(repo.dir, binDir, {
      OPENAI_API_KEY: "test-openai-key",
    }),
  });

  expect(result.exitCode).toBe(0);
  const agentsSource = repo.read(".smithers/agents.ts");
  expect(agentsSource).toContain('codex: new CodexAgent');
  expect(agentsSource).toContain("implement: [providers.codex]");
});

test("smithers init orders role chains correctly when multiple local agent CLIs are available", () => {
  const repo = createTempRepo();
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeGeminiBinary(binDir);
  repo.write(".claude/settings.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/oauth_creds.json", "{}\n");

  const result = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env: buildEnv(repo.dir, binDir),
  });

  expect(result.exitCode).toBe(0);
  const agentsSource = repo.read(".smithers/agents.ts");
  expect(agentsSource).toContain("plan: [providers.gemini, providers.codex, providers.claude]");
  expect(agentsSource).toContain("implement: [providers.codex, providers.gemini, providers.claude]");
  expect(agentsSource).toContain("review: [providers.claude, providers.codex]");
});

test("smithers init exits with a typed error when no usable agents are detected", () => {
  const repo = createTempRepo();
  const binDir = createExecutableDir();

  const result = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env: buildEnv(repo.dir, binDir),
  });

  expect(result.exitCode).toBe(4);
  expect(result.json).toMatchObject({
    code: "NO_USABLE_AGENTS",
  });
  expect(JSON.stringify(result.json)).toContain("claude");
  expect(JSON.stringify(result.json)).toContain("codex");
  expect(JSON.stringify(result.json)).toContain("gemini");
});
