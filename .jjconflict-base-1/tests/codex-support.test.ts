import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent } from "../src/agents";

const originalPath = process.env.PATH ?? "";

async function makeFakeCodex(stdoutScript: string) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-codex-test-"));
  const binPath = join(dir, "codex");
  const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.CODEX_ARGS_FILE;
});

describe("Codex CLI agent", () => {
  test("resumes an existing session when resumeSession is provided", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-codex-args-"));
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeCodex(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CODEX_ARGS_FILE) fs.writeFileSync(process.env.CODEX_ARGS_FILE, JSON.stringify(args), "utf8");
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0 && args[outputIndex + 1]) {
  fs.writeFileSync(args[outputIndex + 1], "done", "utf8");
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { id: "assistant-1", type: "agent_message", text: "done" }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.CODEX_ARGS_FILE = argsFile;

      const agent = new CodexAgent({
        env: { PATH: process.env.PATH! },
      });

      const result = await agent.generate({
        prompt: "continue the work",
        resumeSession: "thread-1",
      });

      expect(result.text).toBe("done");

      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(capturedArgs.slice(0, 3)).toEqual(["exec", "resume", "thread-1"]);
      expect(capturedArgs).toContain("--json");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });
});
