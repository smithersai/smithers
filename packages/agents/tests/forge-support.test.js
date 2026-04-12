import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ForgeAgent } from "../src/index.js";
const originalPath = process.env.PATH ?? "";
/**
 * @param {string} stdoutScript
 */
async function makeFakeForge(stdoutScript) {
    const dir = await mkdtemp(join(tmpdir(), "smithers-forge-test-"));
    const binPath = join(dir, "forge");
    const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
    await writeFile(binPath, script, "utf8");
    await chmod(binPath, 0o755);
    return { dir, binPath };
}
afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FORGE_ARGS_FILE;
});
describe("Forge CLI agent", () => {
    test("ForgeAgent builds expected CLI arguments", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-forge-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeForge(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FORGE_ARGS_FILE) fs.writeFileSync(process.env.FORGE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("done\\n");
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.FORGE_ARGS_FILE = argsFile;
            const agent = new ForgeAgent({
                model: "anthropic/claude-sonnet-4-20250514",
                provider: "anthropic",
                agent: "code",
                conversationId: "conv-123",
                sandbox: "my-sandbox",
                restricted: true,
                verbose: true,
                directory: "/tmp/forge-test",
                env: { PATH: process.env.PATH },
            });
            await agent.generate({
                messages: [
                    { role: "system", content: "System instructions" },
                    { role: "user", content: "Hello from user" },
                ],
            });
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs).toContain("--model");
            expect(capturedArgs).toContain("anthropic/claude-sonnet-4-20250514");
            expect(capturedArgs).toContain("--provider");
            expect(capturedArgs).toContain("anthropic");
            expect(capturedArgs).toContain("--agent");
            expect(capturedArgs).toContain("code");
            expect(capturedArgs).toContain("--conversation-id");
            expect(capturedArgs).toContain("conv-123");
            expect(capturedArgs).toContain("--sandbox");
            expect(capturedArgs).toContain("my-sandbox");
            expect(capturedArgs).toContain("--restricted");
            expect(capturedArgs).toContain("--verbose");
            expect(capturedArgs).toContain("-C");
            expect(capturedArgs).toContain("/tmp/forge-test");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("ForgeAgent surfaces stderr on non-zero exit", async () => {
        const fake = await makeFakeForge(`
process.stderr.write("forge failed for test\\n");
process.exit(23);
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            const agent = new ForgeAgent({
                env: { PATH: process.env.PATH },
            });
            await expect(agent.generate({
                messages: [{ role: "user", content: "trigger failure" }],
            })).rejects.toThrow(/forge failed for test/);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("ForgeAgent returns text output correctly", async () => {
        const fake = await makeFakeForge(`
process.stdout.write("Here is the generated code\\n");
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            const agent = new ForgeAgent({
                env: { PATH: process.env.PATH },
            });
            const result = await agent.generate({
                messages: [{ role: "user", content: "Generate some code" }],
            });
            expect(result.text).toBe("Here is the generated code");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    });
    test("ForgeAgent prepends system prompt to --prompt value", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-forge-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeForge(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FORGE_ARGS_FILE) fs.writeFileSync(process.env.FORGE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("ok\\n");
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.FORGE_ARGS_FILE = argsFile;
            const agent = new ForgeAgent({
                systemPrompt: "You are a helpful assistant.",
                env: { PATH: process.env.PATH },
            });
            await agent.generate({
                messages: [{ role: "user", content: "Do the thing" }],
            });
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            const promptIdx = capturedArgs.indexOf("--prompt");
            expect(promptIdx).toBeGreaterThan(-1);
            const promptValue = capturedArgs[promptIdx + 1];
            expect(promptValue).toContain("You are a helpful assistant.");
            expect(promptValue).toContain("USER: Do the thing");
            // System prompt should come before user prompt
            const sysPos = promptValue.indexOf("You are a helpful assistant.");
            const userPos = promptValue.indexOf("USER: Do the thing");
            expect(sysPos).toBeLessThan(userPos);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
    test("ForgeAgent passes extraArgs", async () => {
        const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-forge-args-"));
        const argsFile = join(argsFileDir, "args.json");
        const fake = await makeFakeForge(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FORGE_ARGS_FILE) fs.writeFileSync(process.env.FORGE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("ok\\n");
`);
        try {
            process.env.PATH = `${fake.dir}:${originalPath}`;
            process.env.FORGE_ARGS_FILE = argsFile;
            const agent = new ForgeAgent({
                extraArgs: ["--custom-flag", "custom-value"],
                env: { PATH: process.env.PATH },
            });
            await agent.generate({
                messages: [{ role: "user", content: "Hello" }],
            });
            const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
            expect(capturedArgs).toContain("--custom-flag");
            expect(capturedArgs).toContain("custom-value");
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
            await rm(argsFileDir, { recursive: true, force: true });
        }
    });
});
