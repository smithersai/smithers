import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAgent } from "../src/OpenCodeAgent.js";

/**
 * E2E tests against the real OpenCode CLI.
 * Skipped entirely if `opencode` is not installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require valid API credentials configured in opencode
 *   - may take 30–60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isOpenCodeInstalled = false;
let supportsOpenCodeE2EFlags = false;
try {
  execSync("which opencode", { stdio: "pipe" });
  isOpenCodeInstalled = true;
  const helpText = execSync("opencode run --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsOpenCodeE2EFlags =
    helpText.includes("--dir") &&
    helpText.includes("--format") &&
    /\B-f\b/.test(helpText);
} catch {
  isOpenCodeInstalled = false;
  supportsOpenCodeE2EFlags = false;
}

describe.skipIf(!isOpenCodeInstalled || !supportsOpenCodeE2EFlags)(
  "OpenCodeAgent E2E (real CLI)",
  () => {
  /** @type {string} */
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "smithers-opencode-e2e-"));
    // Create a minimal project so --dir has something to work with
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends a simple prompt and gets a text response", async () => {
    const agent = new OpenCodeAgent({
      model: "github-copilot/claude-sonnet-4.6",
      yolo: true,
    });

    const result = await agent.generate({
      prompt: "What is 2+2? Reply with ONLY the number, nothing else.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
    // The response should contain "4" somewhere
    expect(result.text).toContain("4");
  }, 120_000);

  it("emits events with correct structure", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    const agent = new OpenCodeAgent({
      model: "github-copilot/claude-sonnet-4.6",
      yolo: true,
    });

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      rootDir: tmpDir,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    // Should have emitted a "started" event
    const started = events.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started.engine).toBe("opencode");

    // Should have emitted a "completed" event
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed.engine).toBe("opencode");
    expect(completed.ok).toBe(true);
  }, 120_000);

  it("respects --dir for working directory", async () => {
    const agent = new OpenCodeAgent({
      model: "github-copilot/claude-sonnet-4.6",
      yolo: true,
    });

    const result = await agent.generate({
      prompt:
        "List the files in the current directory. Just output the filenames, one per line.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    // Should see our hello.js file
    expect(result.text).toContain("hello.js");
  }, 120_000);

  it("passes OPENCODE_PERMISSION env var correctly (yolo mode)", async () => {
    // yolo=true should set OPENCODE_PERMISSION='"allow"' which auto-approves
    // tool calls. We verify indirectly: if permission is set correctly, the
    // agent can execute tools without prompting and return a result.
    const agent = new OpenCodeAgent({
      model: "github-copilot/claude-sonnet-4.6",
      yolo: true,
    });

    const result = await agent.generate({
      prompt:
        "Read the file hello.js and tell me what it prints. Reply with ONLY the output string, nothing else.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text).toContain("hello world");
  }, 120_000);

  it("handles file attachments via -f flag", async () => {
    const testFile = join(tmpDir, "data.txt");
    await writeFile(testFile, "The secret number is 42.\n");

    const agent = new OpenCodeAgent({
      model: "github-copilot/claude-sonnet-4.6",
      yolo: true,
      attachFiles: [testFile],
    });

    const result = await agent.generate({
      prompt:
        "What is the secret number in the attached file? Reply with ONLY the number.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text).toContain("42");
  }, 120_000);
  }
);
