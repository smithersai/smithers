import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCodeAgent } from "../src/OpenCodeAgent.js";

const originalPath = process.env.PATH ?? "";

/**
 * @param {string} stdoutScript
 */
async function makeFakeOpenCode(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-opencode-test-"));
  const binPath = join(dir, "opencode");
  const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.OPENCODE_ARGS_FILE;
});

// ---------------------------------------------------------------------------
// Helper: build real OpenCode nd-JSON events
//
// Real format (verified from source: packages/opencode/src/cli/cmd/run.ts):
//
//   emit(type, data) → JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL
//
// Events:
//   step_start  → { type:"step_start", timestamp, sessionID, part: StepStartPart }
//   text        → { type:"text",       timestamp, sessionID, part: TextPart }
//   tool_use    → { type:"tool_use",   timestamp, sessionID, part: ToolPart }
//   step_finish → { type:"step_finish", timestamp, sessionID, part: StepFinishPart }
//   reasoning   → { type:"reasoning",  timestamp, sessionID, part: ReasoningPart }
//   error       → { type:"error",      timestamp, sessionID, error: NamedError }
// ---------------------------------------------------------------------------

let _partIdCounter = 0;
function nextPartId() {
  return `part-${++_partIdCounter}`;
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string}
 */
function j(obj) {
  return JSON.stringify(obj);
}

/** step_start event */
function stepStart(sessionID = "sess-1", messageID = "msg-1") {
  return j({
    type: "step_start",
    timestamp: Date.now(),
    sessionID,
    part: {
      id: nextPartId(),
      sessionID,
      messageID,
      type: "step-start",
    },
  });
}

/** text event (only emitted when text is finalized, i.e. part.time.end is set) */
function textEvent(text, sessionID = "sess-1", messageID = "msg-1") {
  return j({
    type: "text",
    timestamp: Date.now(),
    sessionID,
    part: {
      id: nextPartId(),
      sessionID,
      messageID,
      type: "text",
      text,
      time: { start: Date.now() - 100, end: Date.now() },
    },
  });
}

/** tool_use event (emitted when tool completes or errors) */
function toolUseEvent({
  tool = "bash",
  callID = "call-1",
  status = "completed",
  input = { command: "ls", description: "List files" },
  output = "file1.txt\nfile2.txt",
  error,
  sessionID = "sess-1",
  messageID = "msg-1",
} = {}) {
  const state =
    status === "error"
      ? {
          status: "error",
          input,
          error: error ?? output,
          metadata: {},
          time: { start: Date.now() - 200, end: Date.now() },
        }
      : {
          status: "completed",
          input,
          output,
          title: `${tool}: ${input.description || ""}`,
          metadata: {},
          time: { start: Date.now() - 200, end: Date.now() },
        };

  return j({
    type: "tool_use",
    timestamp: Date.now(),
    sessionID,
    part: {
      id: nextPartId(),
      sessionID,
      messageID,
      type: "tool",
      callID,
      tool,
      state,
    },
  });
}

/** step_finish event */
function stepFinish({
  sessionID = "sess-1",
  messageID = "msg-1",
  reason = "stop",
  tokens = {
    total: 1000,
    input: 800,
    output: 200,
    reasoning: 0,
    cache: { write: 0, read: 100 },
  },
  cost = 0.005,
} = {}) {
  return j({
    type: "step_finish",
    timestamp: Date.now(),
    sessionID,
    part: {
      id: nextPartId(),
      sessionID,
      messageID,
      type: "step-finish",
      reason,
      tokens,
      cost,
    },
  });
}

/** error event */
function errorEvent({
  name = "UnknownError",
  message = "Something went wrong",
  sessionID = "sess-1",
} = {}) {
  return j({
    type: "error",
    timestamp: Date.now(),
    sessionID,
    error: { name, data: { message } },
  });
}

/** reasoning event (emitted with --thinking flag) */
function reasoningEvent(text, sessionID = "sess-1", messageID = "msg-1") {
  return j({
    type: "reasoning",
    timestamp: Date.now(),
    sessionID,
    part: {
      id: nextPartId(),
      sessionID,
      messageID,
      type: "reasoning",
      text,
    },
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("OpenCode CLI agent", () => {
  // -----------------------------------------------------------------------
  // buildCommand tests (args capture via OPENCODE_ARGS_FILE)
  // -----------------------------------------------------------------------

  test("builds correct args for basic prompt with model", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({
    args,
     env: {
       OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || null,
     },
  }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("done")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Analyze this code" }],
      });

      expect(result.text).toBe("done");

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("run");
      expect(captured.args).toContain("-m");
      expect(captured.args).toContain("anthropic/claude-opus-4-20250514");
      expect(captured.args).toContain("--format");
      expect(captured.args).toContain("json");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("includes --agent flag when agentName is specified", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        agentName: "readonly",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Read-only analysis" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("--agent");
      expect(captured.args).toContain("readonly");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("includes -f flags for attached files (repeated flag)", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        attachFiles: ["src/main.ts", "README.md"],
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Review these files" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      const args = captured.args;

      // Each file should be preceded by its own -f flag
      const firstFIdx = args.indexOf("-f");
      expect(firstFIdx).toBeGreaterThan(-1);
      expect(args[firstFIdx + 1]).toBe("src/main.ts");
      const secondFIdx = args.indexOf("-f", firstFIdx + 2);
      expect(secondFIdx).toBeGreaterThan(-1);
      expect(args[secondFIdx + 1]).toBe("README.md");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("places '--' separator before prompt when -f is used (prevents yargs array consumption)", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        attachFiles: ["data.txt"],
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "What is the secret number?" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      const args = captured.args;

      // The prompt should appear AFTER a '--' separator so yargs doesn't
      // consume it as part of the -f array.
      const dashDashIdx = args.indexOf("--");
      expect(dashDashIdx).toBeGreaterThan(-1);

      // The prompt should come after '--'
      const promptIdx = args.indexOf("USER: What is the secret number?");
      expect(promptIdx).toBeGreaterThan(dashDashIdx);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("sets OPENCODE_PERMISSION env var as JSON when yolo is true", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({
    args,
    env: { OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || null },
  }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        yolo: true,
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Do something" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      // OPENCODE_PERMISSION expects a JSON permission object; {"*":"allow"} grants blanket approval
      expect(captured.env.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("does NOT set OPENCODE_PERMISSION when yolo is false", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({
    args,
    env: { OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || null },
  }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        yolo: false,
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Do something" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.env.OPENCODE_PERMISSION).toBeNull();
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("includes --variant flag when variant is specified", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        variant: "high",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Think hard" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("--variant");
      expect(captured.args).toContain("high");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("includes --continue flag when continueSession is true", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        continueSession: true,
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Continue working" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("--continue");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("includes --session flag with session ID", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        sessionId: "abc-123",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Resume session" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("--session");
      expect(captured.args).toContain("abc-123");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("prepends Smithers systemPrompt to the positional prompt", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        systemPrompt: "You are a careful reviewer.",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Analyze this diff" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      const prompt = captured.args[captured.args.length - 1];

      expect(prompt).toContain("You are a careful reviewer.");
      expect(prompt).toContain("USER: Analyze this diff");
      expect(prompt.indexOf("You are a careful reviewer.")).toBeLessThan(
        prompt.indexOf("USER: Analyze this diff")
      );
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("uses per-call resumeSession as --session", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        continueSession: true,
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Resume work" }],
        resumeSession: "resume-123",
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("--session");
      expect(captured.args).toContain("resume-123");
      expect(captured.args).not.toContain("--continue");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("fails generate when OpenCode emits an error event even if exit code is zero", async () => {
    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${errorEvent({
  sessionID: "s-1",
  name: "ProviderAuthError",
  message: "Invalid API key",
})}' + "\\n");
process.exit(0);
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      await expect(
        agent.generate({
          messages: [{ role: "user", content: "test" }],
        })
      ).rejects.toThrow("Invalid API key");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Output interpreter tests (real nd-JSON format)
  // -----------------------------------------------------------------------

  test("parses step_start + text + step_finish and returns accumulated text", async () => {
    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1", "m-1")}' + "\\n");
process.stdout.write('${textEvent("The answer ", "s-1", "m-1")}' + "\\n");
process.stdout.write('${textEvent("is 42.", "s-1", "m-1")}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", messageID: "m-1" })}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "What is 6*7?" }],
      });

      expect(result.text).toBe("The answer is 42.");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("emits started event from step_start and completed from step_finish", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${textEvent("Hello", "s-1")}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", reason: "stop" })}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Hi" }],
        onEvent: (event) => events.push(event),
      });

      const startedEvents = events.filter((e) => e.type === "started");
      expect(startedEvents.length).toBe(1);
      expect(startedEvents[0].engine).toBe("opencode");
      expect(startedEvents[0].resume).toBe("s-1");

      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].ok).toBe(true);
      expect(completedEvents[0].answer).toBe("Hello");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("captures tool_use events as action events", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${toolUseEvent({
  tool: "bash",
  callID: "call-1",
  status: "completed",
  input: { command: "ls -la", description: "List files" },
  output: "total 8\\nfile1.txt\\nfile2.txt",
  sessionID: "s-1",
})}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", reason: "tool-calls" })}' + "\\n");
process.stdout.write('${stepStart("s-1", "m-2")}' + "\\n");
process.stdout.write('${textEvent("I found 2 files.", "s-1", "m-2")}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", messageID: "m-2", reason: "stop" })}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Run ls" }],
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("I found 2 files.");

      // Should have tool action events
      const toolEvents = events.filter(
        (e) => e.type === "action" && e.action?.kind === "command"
      );
      expect(toolEvents.length).toBeGreaterThanOrEqual(1);

      // Tool event should have the call ID
      const bashTool = toolEvents.find((e) => e.action?.title === "bash");
      expect(bashTool).toBeDefined();
      expect(bashTool.action.id).toBe("call-1");

      // Completed events
      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].ok).toBe(true);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("handles multi-step interaction (tool then text)", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    // Real pattern: step_start → tool_use → step_finish(tool-calls) → step_start → text → step_finish(stop)
    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1", "m-1")}' + "\\n");
process.stdout.write('${toolUseEvent({
  tool: "read",
  callID: "call-read-1",
  input: { filePath: "/tmp/test.txt" },
  output: "file contents here",
  sessionID: "s-1",
  messageID: "m-1",
})}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", messageID: "m-1", reason: "tool-calls" })}' + "\\n");
process.stdout.write('${stepStart("s-1", "m-2")}' + "\\n");
process.stdout.write('${textEvent("The file contains: file contents here", "s-1", "m-2")}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", messageID: "m-2", reason: "stop" })}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Read the file" }],
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("The file contains: file contents here");

      // Should have exactly one started event (first step_start)
      const startedEvents = events.filter((e) => e.type === "started");
      expect(startedEvents.length).toBe(1);

      // Should have tool action event for read
      const toolEvents = events.filter(
        (e) => e.type === "action" && e.action?.title === "read"
      );
      expect(toolEvents.length).toBeGreaterThanOrEqual(1);

      // Should have text action event
      const textEvents = events.filter(
        (e) => e.type === "action" && e.entryType === "message"
      );
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("extracts usage/tokens from step_finish into completed event", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${textEvent("Hello", "s-1")}' + "\\n");
process.stdout.write('${stepFinish({
  sessionID: "s-1",
  reason: "stop",
  tokens: {
    total: 1500,
    input: 1000,
    output: 500,
    reasoning: 50,
    cache: { write: 10, read: 200 },
  },
  cost: 0.01,
})}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Hi" }],
        onEvent: (event) => events.push(event),
      });

      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents.length).toBe(1);

      const usage = completedEvents[0].usage;
      expect(usage).toBeDefined();
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(500);
      expect(usage.totalTokens).toBe(1500);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("extracts usage/tokens from step_finish into generate() result usage", async () => {
    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${textEvent("Hello", "s-1")}' + "\\n");
process.stdout.write('${stepFinish({
  sessionID: "s-1",
  reason: "stop",
  tokens: {
    total: 1500,
    input: 1000,
    output: 500,
    reasoning: 50,
    cache: { write: 10, read: 200 },
  },
  cost: 0.01,
})}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.usage).toBeDefined();
      expect(result.usage.inputTokens).toBe(1000);
      expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(200);
      expect(result.usage.inputTokenDetails.cacheWriteTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(500);
      expect(result.usage.outputTokenDetails.reasoningTokens).toBe(50);
      expect(result.usage.totalTokens).toBe(1500);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("declares opencode as cliEngine and has correct capabilities", () => {
    const agent = new OpenCodeAgent({
      model: "anthropic/claude-opus-4-20250514",
    });

    expect(agent.cliEngine).toBe("opencode");
    expect(agent.capabilities).toBeDefined();
    expect(agent.capabilities.engine).toBe("opencode");
    expect(agent.capabilities.mcp.supportsProjectScope).toBe(true);
    expect(agent.capabilities.skills.supportsSkills).toBe(true);
    expect(agent.capabilities.builtIns).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "glob",
        "grep",
        "list",
        "task",
        "skill",
        "todowrite",
        "webfetch",
        "websearch",
        "question",
        "apply_patch",
      ])
    );
  });

  test("passes --dir from cwd constructor option", async () => {
    const argsFileDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-args-")
    );
    const argsFile = join(argsFileDir, "args.json");
    const projectDir = await mkdtemp(
      join(tmpdir(), "smithers-opencode-project-")
    );

    const fake = await makeFakeOpenCode(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.OPENCODE_ARGS_FILE) {
  fs.writeFileSync(process.env.OPENCODE_ARGS_FILE, JSON.stringify({ args }), "utf8");
}
process.stdout.write('${stepStart()}' + "\\n");
process.stdout.write('${textEvent("ok")}' + "\\n");
process.stdout.write('${stepFinish()}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.OPENCODE_ARGS_FILE = argsFile;

      const agent = new OpenCodeAgent({
        model: "openai/gpt-5.4",
        cwd: projectDir,
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Hello" }],
      });

      const captured = JSON.parse(await readFile(argsFile, "utf8"));
      expect(captured.args).toContain("--dir");
      expect(captured.args).toContain(projectDir);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("handles non-zero exit code gracefully", async () => {
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stderr.write("Error: Rate limit exceeded\\n");
process.exit(1);
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      let threw = false;
      try {
        await agent.generate({
          messages: [{ role: "user", content: "Ping" }],
          onEvent: (event) => events.push(event),
        });
      } catch {
        threw = true;
      }

      // Should throw because exit code is non-zero
      expect(threw).toBe(true);

      // Should have emitted completed event with ok: false
      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].ok).toBe(false);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("handles error event from session.error", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${errorEvent({
  sessionID: "s-1",
  name: "ProviderAuthError",
  message: "Invalid API key",
})}' + "\\n");
process.exit(1);
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      let threw = false;
      try {
        await agent.generate({
          messages: [{ role: "user", content: "test" }],
          onEvent: (event) => events.push(event),
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);

      // Should have emitted a completed event with ok: false and error info
      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0].ok).toBe(false);
      expect(completedEvents[0].error).toContain("Invalid API key");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("throws with structured OpenCode error instead of generic CLI failure", async () => {
    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${errorEvent({
  sessionID: "s-1",
  name: "ProviderAuthError",
  message: "Invalid API key",
})}' + "\\n");
process.exit(1);
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      await expect(
        agent.generate({
          messages: [{ role: "user", content: "test" }],
        })
      ).rejects.toThrow("Invalid API key");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("handles tool_use with error status", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1")}' + "\\n");
process.stdout.write('${toolUseEvent({
  tool: "bash",
  callID: "call-err-1",
  status: "error",
  input: { command: "rm -rf /", description: "Delete everything" },
  error: "Permission denied",
  sessionID: "s-1",
})}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", reason: "tool-calls" })}' + "\\n");
process.stdout.write('${stepStart("s-1", "m-2")}' + "\\n");
process.stdout.write('${textEvent("The command failed.", "s-1", "m-2")}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", messageID: "m-2", reason: "stop" })}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Try something" }],
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("The command failed.");

      // Tool event should have ok: false for error status
      const toolEvents = events.filter(
        (e) => e.type === "action" && e.action?.id === "call-err-1"
      );
      expect(toolEvents.length).toBeGreaterThanOrEqual(1);
      const completedTool = toolEvents.find((e) => e.phase === "completed");
      expect(completedTool).toBeDefined();
      expect(completedTool.ok).toBe(false);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("accumulates tokens across multiple step_finish events", async () => {
    /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
    const events = [];

    // Multi-step: tool call step + text step, each with their own token counts
    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1", "m-1")}' + "\\n");
process.stdout.write('${toolUseEvent({ tool: "bash", callID: "c1", sessionID: "s-1", messageID: "m-1" })}' + "\\n");
process.stdout.write('${stepFinish({
  sessionID: "s-1",
  messageID: "m-1",
  reason: "tool-calls",
  tokens: { total: 500, input: 400, output: 100, reasoning: 0, cache: { write: 0, read: 50 } },
  cost: 0.002,
})}' + "\\n");
process.stdout.write('${stepStart("s-1", "m-2")}' + "\\n");
process.stdout.write('${textEvent("Result.", "s-1", "m-2")}' + "\\n");
process.stdout.write('${stepFinish({
  sessionID: "s-1",
  messageID: "m-2",
  reason: "stop",
  tokens: { total: 700, input: 500, output: 200, reasoning: 10, cache: { write: 5, read: 80 } },
  cost: 0.003,
})}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Do stuff" }],
        onEvent: (event) => events.push(event),
      });

      const completedEvents = events.filter((e) => e.type === "completed");
      expect(completedEvents.length).toBe(1);

      const usage = completedEvents[0].usage;
      expect(usage).toBeDefined();
      // Accumulated: 400+500=900 input, 100+200=300 output, 500+700=1200 total
      expect(usage.inputTokens).toBe(900);
      expect(usage.outputTokens).toBe(300);
      expect(usage.totalTokens).toBe(1200);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("parses reasoning events as thought actions", async () => {
    const events = [];

    const fake = await makeFakeOpenCode(`
process.stdout.write('${stepStart("s-1", "m-1")}' + "\\n");
process.stdout.write('${reasoningEvent("Let me think about this carefully...", "s-1", "m-1")}' + "\\n");
process.stdout.write('${textEvent("The answer is 42.", "s-1", "m-1")}' + "\\n");
process.stdout.write('${stepFinish({ sessionID: "s-1", messageID: "m-1" })}' + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      await agent.generate({
        messages: [{ role: "user", content: "Think hard" }],
        onEvent: (event) => events.push(event),
      });

      // Should emit a thought action for the reasoning event
      const thoughtActions = events.filter(
        (e) => e.type === "action" && e.entryType === "thought"
      );
      expect(thoughtActions.length).toBe(1);
      expect(thoughtActions[0].action.title).toBe("reasoning");
      expect(thoughtActions[0].message).toContain("Let me think about this");
      expect(thoughtActions[0].ok).toBe(true);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("handles clean exit with no output (empty stdout)", async () => {
    const events = [];

    // Process exits 0 immediately without emitting any nd-JSON events
    const fake = await makeFakeOpenCode(`
// no output at all
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;

      const agent = new OpenCodeAgent({
        model: "anthropic/claude-opus-4-20250514",
        env: { PATH: process.env.PATH },
      });

      const result = await agent.generate({
        messages: [{ role: "user", content: "Hi" }],
        onEvent: (event) => events.push(event),
      });

      // Should still emit a completed event via onExit
      const completed = events.filter((e) => e.type === "completed");
      expect(completed.length).toBe(1);
      expect(completed[0].ok).toBe(true);
      expect(completed[0].answer).toBeUndefined();

      // result.text should be empty (no model response)
      expect(result.text).toBe("");
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });
});
