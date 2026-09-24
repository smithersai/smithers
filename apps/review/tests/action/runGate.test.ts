import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_GATE = fileURLToPath(new URL("../../action/src/runGate.ts", import.meta.url));
// Package root so bun can resolve tsconfig paths
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface SpawnResult {
  stdout: string;
  exitCode: number;
}

function spawnGate(env: Record<string, string>): SpawnResult {
  const result = Bun.spawnSync(["bun", RUN_GATE], {
    cwd: PKG_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    exitCode: result.exitCode ?? 1,
  };
}

describe("runGate (subprocess)", () => {
  let tmp = "";
  let outputFile = "";

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = "";
      outputFile = "";
    }
  });

  async function setup() {
    tmp = await mkdtemp(join(tmpdir(), "smithers-rungate-"));
    outputFile = join(tmp, "github-output");
    await writeFile(outputFile, "");
    return { outputFile, tmp };
  }

  async function readOutput(path: string): Promise<Record<string, string>> {
    const text = await Bun.file(path).text();
    const result: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return result;
  }

  test("writes should-run=false and exits 0 when GITHUB_EVENT_PATH is empty", async () => {
    const { outputFile } = await setup();
    const result = spawnGate({
      GITHUB_EVENT_NAME: "",
      GITHUB_EVENT_PATH: "",
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
  });

  test("writes only should-run=true for a valid open PR event", async () => {
    const { outputFile, tmp } = await setup();
    const payload = {
      action: "synchronize",
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "deadbeef", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnGate({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("true");
    expect(out).toEqual({ "should-run": "true" });
  });

  test("writes should-run=false for a draft PR", async () => {
    const { outputFile, tmp } = await setup();
    const payload = {
      action: "opened",
      pull_request: {
        number: 7,
        draft: true,
        head: { sha: "aaa", repo: { full_name: "octo/widgets" } },
        base: { repo: { full_name: "octo/widgets" } },
      },
    };
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify(payload));

    const result = spawnGate({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
    expect(result.stdout).toMatch(/notice/i);
  });

  test("writes should-run=false and exits 0 when the event file contains invalid JSON", async () => {
    const { outputFile, tmp } = await setup();
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, "not-json{{{{");

    const result = spawnGate({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
    expect(result.stdout).toContain("::notice::");
  });

  test("writes should-run=false for an unsupported event type", async () => {
    const { outputFile, tmp } = await setup();
    const eventPath = join(tmp, "event.json");
    await writeFile(eventPath, JSON.stringify({ ref: "refs/heads/main" }));

    const result = spawnGate({
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputFile,
    });
    expect(result.exitCode).toBe(0);
    const out = await readOutput(outputFile);
    expect(out["should-run"]).toBe("false");
  });
});
