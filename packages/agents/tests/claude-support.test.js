import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAgent } from "../src/index.js";
const originalPath = process.env.PATH ?? "";
/**
 * @param {string} stdoutScript
 */
async function makeFakeClaude(stdoutScript) {
    const dir = await mkdtemp(join(tmpdir(), "smithers-claude-test-"));
    const binPath = join(dir, "claude");
    const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
    await writeFile(binPath, script, "utf8");
    await chmod(binPath, 0o755);
    return { dir, binPath };
}
afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.CLAUDE_ARGS_FILE;
});
describe("Claude Code CLI agent", () => {
    test("adds --verbose when using stream-json output", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-claude-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CLAUDE_ARGS_FILE) fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write(JSON.stringify({
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] }
}) + "\\n");
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.CLAUDE_ARGS_FILE = argsFile;
            const agent = new ClaudeCodeAgent({
                model: "claude-opus-4-6",
                env: { PATH: process.env.PATH },
            });
            const result = await agent.generate({
                messages: [{ role: "user", content: "Ping?" }],
            });
            expect(result.text).toBe("done");
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs).toContain("--print");
            expect(capturedArgs).toContain("--output-format");
            expect(capturedArgs).toContain("stream-json");
            expect(capturedArgs).toContain("--verbose");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("does not add --verbose for text output by default", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-claude-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CLAUDE_ARGS_FILE) fs.writeFileSync(process.env.CLAUDE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("done\\n");
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.CLAUDE_ARGS_FILE = argsFile;
            const agent = new ClaudeCodeAgent({
                model: "claude-opus-4-6",
                outputFormat: "text",
                env: { PATH: process.env.PATH },
            });
            const result = await agent.generate({
                messages: [{ role: "user", content: "Ping?" }],
            });
            expect(result.text).toBe("done");
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs).toContain("--output-format");
            expect(capturedArgs).toContain("text");
            expect(capturedArgs).not.toContain("--verbose");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
});
