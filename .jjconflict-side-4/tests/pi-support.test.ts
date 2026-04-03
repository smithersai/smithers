import { afterEach, describe, expect, test } from "bun:test";
 import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
 import { join } from "node:path";
 import { tmpdir } from "node:os";
 import { PiAgent } from "../src/agents";
 
 const originalPath = process.env.PATH ?? "";
 
 async function makeFakePi(stdoutScript: string) {
   const dir = await mkdtemp(join(tmpdir(), "smithers-pi-test-"));
   const binPath = join(dir, "pi");
   const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
   await writeFile(binPath, script, "utf8");
   await chmod(binPath, 0o755);
   return { dir, binPath };
 }
 
 afterEach(() => {
   process.env.PATH = originalPath;
   delete process.env.PI_ARGS_FILE;
  delete process.env.PI_RESPONSE_FILE;
 });
 
describe("PI CLI agent", () => {
  test("PiAgent emits resumable session and tool lifecycle events when hijack hooks are enabled", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-pi-events-"));
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakePi(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.PI_ARGS_FILE) fs.writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify(args), "utf8");
const lines = [
  JSON.stringify({ type: "session", version: 3, id: "session-abc", cwd: process.cwd() }),
  JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read_file", args: { path: "README.md" } }),
  JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }),
  JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read_file", result: { content: "ok" }, isError: false }),
  JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } })
];
process.stdout.write(lines.join("\\n") + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.PI_ARGS_FILE = argsFile;

      const events: any[] = [];
      const agent = new PiAgent({
        env: { PATH: process.env.PATH! },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Ping?" }],
        resumeSession: "session-abc",
        onEvent: (event: any) => {
          events.push(event);
        },
      });

      expect(result.text).toBe("done");

      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(capturedArgs).toContain("--mode");
      expect(capturedArgs).toContain("json");
      expect(capturedArgs).toContain("--session");
      expect(capturedArgs).toContain("session-abc");
      expect(capturedArgs).not.toContain("--no-session");

      expect(events).toEqual([
        expect.objectContaining({
          type: "started",
          engine: "pi",
          resume: "session-abc",
        }),
        expect.objectContaining({
          type: "action",
          phase: "started",
          action: expect.objectContaining({
            id: "tool-1",
            title: "read_file",
          }),
        }),
        expect.objectContaining({
          type: "action",
          phase: "completed",
          action: expect.objectContaining({
            id: "tool-1",
            title: "read_file",
          }),
          ok: true,
        }),
        expect.objectContaining({
          type: "completed",
          engine: "pi",
          ok: true,
          answer: "done",
          resume: "session-abc",
        }),
      ]);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("PiAgent builds expected CLI arguments", async () => {
     const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-pi-args-"));
     const argsFile = join(argsFileDir, "args.json");
 
     const fake = await makeFakePi(`
 const fs = require("node:fs");
 const args = process.argv.slice(2);
 if (process.env.PI_ARGS_FILE) fs.writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify(args), "utf8");
 process.stdout.write(JSON.stringify({ args }) + "\\n");
 `);
 
     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;
       process.env.PI_ARGS_FILE = argsFile;
 
       const agent = new PiAgent({
         mode: "json",
         continue: true,
         resume: true,
         provider: "openai",
         model: "gpt-4o-mini",
         apiKey: "pi-test-key",
         systemPrompt: "Base system",
         appendSystemPrompt: "Extra system",
         session: "session.jsonl",
         sessionDir: "/tmp/pi-sessions",
         models: ["openai/*", "anthropic/*"],
         listModels: "openai",
         export: "session.html",
         tools: ["read", "bash"],
         extension: ["ext-a", "ext-b"],
         skill: ["skill-a", "skill-b"],
         promptTemplate: ["prompt-a", "prompt-b"],
         theme: ["theme-a", "theme-b"],
         files: ["prompt.md"],
         thinking: "low",
         verbose: true,
         env: { PATH: process.env.PATH! },
       });
 
       const result = await agent.generate({
         messages: [
           { role: "system", content: "System from messages" },
           { role: "user", content: "Hello from user" },
         ],
       });
 
       const payload = result.output as { args: string[] };
       expect(Array.isArray(payload.args)).toBe(true);
 
       expect(payload.args).toContain("--mode");
       expect(payload.args).toContain("json");
       expect(payload.args).toContain("--continue");
       expect(payload.args).toContain("--resume");
       expect(payload.args).toContain("--provider");
       expect(payload.args).toContain("openai");
       expect(payload.args).toContain("--api-key");
       expect(payload.args).toContain("pi-test-key");
       expect(payload.args).toContain("--system-prompt");
       expect(payload.args).toContain("Base system");
       expect(payload.args).toContain("--session");
       expect(payload.args).toContain("session.jsonl");
       expect(payload.args).toContain("--session-dir");
       expect(payload.args).toContain("/tmp/pi-sessions");
       expect(payload.args).not.toContain("--no-session");
       expect(payload.args).toContain("--list-models");
       const listIndex = payload.args.indexOf("--list-models");
       expect(payload.args[listIndex + 1]).toBe("openai");
       expect(payload.args).toContain("--export");
       expect(payload.args).toContain("session.html");
       expect(payload.args).toContain("--tools");
       expect(payload.args).toContain("read,bash");
       expect(payload.args).toContain("--extension");
       expect(payload.args).toContain("ext-a");
       expect(payload.args).toContain("ext-b");
       expect(payload.args.filter((arg) => arg === "--extension")).toHaveLength(2);
       expect(payload.args).toContain("--skill");
       expect(payload.args).toContain("skill-a");
       expect(payload.args).toContain("skill-b");
       expect(payload.args.filter((arg) => arg === "--skill")).toHaveLength(2);
       expect(payload.args).toContain("--prompt-template");
       expect(payload.args).toContain("prompt-a");
       expect(payload.args).toContain("prompt-b");
       expect(payload.args.filter((arg) => arg === "--prompt-template")).toHaveLength(2);
       expect(payload.args).toContain("--theme");
       expect(payload.args).toContain("theme-a");
       expect(payload.args).toContain("theme-b");
       expect(payload.args.filter((arg) => arg === "--theme")).toHaveLength(2);
       expect(payload.args).toContain("--thinking");
       expect(payload.args).toContain("low");
       expect(payload.args).toContain("--models");
       expect(payload.args).toContain("openai/*,anthropic/*");
       expect(payload.args).toContain("@prompt.md");
       expect(payload.args).toContain("--verbose");
 
       const appendIndex = payload.args.indexOf("--append-system-prompt");
       expect(appendIndex).toBeGreaterThan(-1);
       const appendValue = payload.args[appendIndex + 1];
       expect(appendValue).toContain("Extra system");
       expect(appendValue).toContain("System from messages");
 
       const lastArg = payload.args[payload.args.length - 1];
       expect(lastArg).toContain("USER: Hello from user");
 
       const capturedArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
       expect(capturedArgs).toEqual(payload.args);
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
       await rm(argsFileDir, { recursive: true, force: true });
     }
   });
 
   test("PiAgent RPC mode sends prompt and returns output", async () => {
     const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-pi-rpc-"));
     const argsFile = join(argsFileDir, "prompt.json");
 
     const fake = await makeFakePi(`
 const fs = require("node:fs");
 let buffer = "";
 process.stdin.on("data", (chunk) => {
   buffer += chunk.toString("utf8");
   const lines = buffer.split(/\\r?\\n/);
   buffer = lines.pop();
   for (const line of lines) {
     if (!line.trim()) continue;
     const msg = JSON.parse(line);
     if (msg.type === "prompt") {
       if (process.env.PI_ARGS_FILE) fs.writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify(msg), "utf8");
       process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true, id: msg.id }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" } }) + "\\n");
     }
   }
 });
 `);
 
     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;
       process.env.PI_ARGS_FILE = argsFile;
 
       const agent = new PiAgent({
         mode: "rpc",
         model: "gpt-4o-mini",
         env: { PATH: process.env.PATH! },
       });
 
       const result = await agent.generate({
         messages: [{ role: "user", content: "Ping?" }],
       });
 
       expect(result.text).toBe("Hello");
 
       const promptPayload = JSON.parse(await readFile(argsFile, "utf8")) as { type: string; message: string };
       expect(promptPayload.type).toBe("prompt");
       expect(promptPayload.message).toContain("USER: Ping?");
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
       await rm(argsFileDir, { recursive: true, force: true });
     }
   });
 
   test("PiAgent RPC mode handles extension UI requests", async () => {
     const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-pi-rpc-ui-"));
     const argsFile = join(argsFileDir, "prompt.json");
     const responseFile = join(argsFileDir, "response.json");
 
     const fake = await makeFakePi(`
 const fs = require("node:fs");
 const readline = require("node:readline");
 const rl = readline.createInterface({ input: process.stdin });
 
 rl.on("line", (line) => {
   if (!line.trim()) return;
   const msg = JSON.parse(line);
   if (msg.type === "prompt") {
     if (process.env.PI_ARGS_FILE) fs.writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify(msg), "utf8");
     process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: true, id: msg.id }) + "\\n");
     process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "req-1", method: "input", title: "Need input", placeholder: "Type here" }) + "\\n");
   } else if (msg.type === "extension_ui_response") {
     if (process.env.PI_RESPONSE_FILE) fs.writeFileSync(process.env.PI_RESPONSE_FILE, JSON.stringify(msg), "utf8");
     process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } }) + "\\n");
     process.exit(0);
   }
 });
 `);
 
     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;
       process.env.PI_ARGS_FILE = argsFile;
       process.env.PI_RESPONSE_FILE = responseFile;
 
       let requestSeen: { id: string; method: string } | null = null;
 
       const agent = new PiAgent({
         mode: "rpc",
         model: "gpt-4o-mini",
         env: { PATH: process.env.PATH! },
         onExtensionUiRequest: (request) => {
           requestSeen = { id: request.id, method: request.method };
           return { type: "extension_ui_response", id: request.id, value: "Input value" };
         },
       });
 
       const result = await agent.generate({
         messages: [{ role: "user", content: "Ping?" }],
       });
 
       expect(result.text).toBe("Done");
       expect((requestSeen as { id: string; method: string } | null)?.method).toBe("input");
 
       const promptPayload = JSON.parse(await readFile(argsFile, "utf8")) as { type: string; message: string };
       expect(promptPayload.type).toBe("prompt");
 
       const responsePayload = JSON.parse(await readFile(responseFile, "utf8")) as { type: string; value?: string };
       expect(responsePayload.type).toBe("extension_ui_response");
       expect(responsePayload.value).toBe("Input value");
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
       await rm(argsFileDir, { recursive: true, force: true });
     }
   });
 
   test("PiAgent throws when using file args in RPC mode", async () => {
     const agent = new PiAgent({
       mode: "rpc",
       files: ["README.md"],
     });
 
     await expect(
       agent.generate({
         messages: [{ role: "user", content: "Ping?" }],
       })
     ).rejects.toThrow(/RPC mode does not support file arguments/);
   });
 
   test("PiAgent surfaces stderr on non-zero exit", async () => {
     const fake = await makeFakePi(`
 process.stderr.write("pi failed for test\\n");
 process.exit(23);
 `);
 
     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;
 
       const agent = new PiAgent({
         mode: "text",
         model: "gemini-2.5-flash",
         env: { PATH: process.env.PATH! },
       });
 
       await expect(
         agent.generate({
           messages: [{ role: "user", content: "trigger failure" }],
         })
       ).rejects.toThrow(/pi failed for test/);
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
     }
   });

   test("PiAgent json mode extracts text from turn_end in NDJSON stream", async () => {
     // Simulates real pi --mode json output: NDJSON stream with session metadata first,
     // then message events, then turn_end containing the actual response.
     const fake = await makeFakePi(`
 const lines = [
   JSON.stringify({ type: "session", version: 3, id: "test-session-id", timestamp: "2026-02-15T18:00:00.000Z", cwd: "/tmp" }),
   JSON.stringify({ type: "agent_start" }),
   JSON.stringify({ type: "turn_start" }),
   JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
   JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
   JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
   JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Here is" } }),
   JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " your data" } }),
   JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Here is your data" }] } }),
   JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Here is your data" }], stopReason: "stop" } }),
   JSON.stringify({ type: "agent_end" })
 ];
 process.stdout.write(lines.join("\\n") + "\\n");
 `);

     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;

       const agent = new PiAgent({
         mode: "json",
         model: "test-model",
         env: { PATH: process.env.PATH! },
       });

       const result = await agent.generate({
         messages: [{ role: "user", content: "Hello" }],
       });

       // Should extract text from turn_end, not from first JSON (session metadata)
       expect(result.text).toBe("Here is your data");
       // First JSON should NOT be parsed as output (would have "type: session")
       expect(result.output).not.toHaveProperty("type", "session");
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
     }
   });

   test("PiAgent json mode extracts JSON from text content in turn_end", async () => {
     // Simulates pi output where the agent returns JSON in the text content
     const fake = await makeFakePi(`
 const lines = [
   JSON.stringify({ type: "session", version: 3, id: "test-session-id" }),
   JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: '{"v":1,"tickets":[{"id":"task-1","title":"First task"}],"batchComplete":true}' }], stopReason: "stop" } }),
   JSON.stringify({ type: "agent_end" })
 ];
 process.stdout.write(lines.join("\\n") + "\\n");
 `);

     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;

       const agent = new PiAgent({
         mode: "json",
         model: "test-model",
         env: { PATH: process.env.PATH! },
       });

       const result = await agent.generate({
         messages: [{ role: "user", content: "Generate JSON" }],
       });

       expect(result.text).toContain('"v":1');
       expect(result.output).toEqual({
         v: 1,
         tickets: [{ id: "task-1", title: "First task" }],
         batchComplete: true,
       });
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
     }
   });

   test("PiAgent json mode extracts text from agent_end when turn_end missing", async () => {
     // Edge case: agent_end has messages array if turn_end is not present
     const fake = await makeFakePi(`
 const lines = [
   JSON.stringify({ type: "session", version: 3, id: "test-session-id" }),
   JSON.stringify({ type: "agent_end", messages: [
     { role: "user", content: [{ type: "text", text: "Hello" }] },
     { role: "assistant", content: [{ type: "text", text: "Response from agent_end" }] }
   ]})
 ];
 process.stdout.write(lines.join("\\n") + "\\n");
 `);

     try {
       process.env.PATH = `${fake.dir}:${originalPath}`;

       const agent = new PiAgent({
         mode: "json",
         model: "test-model",
         env: { PATH: process.env.PATH! },
       });

       const result = await agent.generate({
         messages: [{ role: "user", content: "Hello" }],
       });

       expect(result.text).toBe("Response from agent_end");
     } finally {
       await rm(fake.dir, { recursive: true, force: true });
     }
   });
 });
