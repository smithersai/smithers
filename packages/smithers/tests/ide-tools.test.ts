import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Cli } from "incur";
import { runPromise } from "@smithers/runtime/runtime";
import {
  createAvailableSmithersIdeCli,
  createSmithersIdeCli,
  createSmithersIdeService,
  detectSmithersIdeAvailabilityEffect,
  SMITHERS_IDE_TOOL_NAMES,
} from "../src/ide";

const TEST_CLIENT_INFO = {
  capabilities: {},
  clientInfo: { name: "smithers-ide-test", version: "1.0.0" },
  protocolVersion: "2025-03-26",
};

const tempDirs = new Set<string>();

async function makeFakeSmithersCtl() {
  const dir = await mkdtemp(join(tmpdir(), "smithers-ide-tools-"));
  tempDirs.add(dir);

  const binPath = join(dir, "smithers-ctl");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.SMITHERS_CTL_LOG;
if (logPath) {
  fs.appendFileSync(
    logPath,
    JSON.stringify({ args, cwd: process.cwd() }) + "\\n",
    "utf8",
  );
}

if (process.env.SMITHERS_CTL_HANG === "1") {
  setInterval(() => {}, 1000);
  return;
}

if (args[0] === "overlay") {
  process.stdout.write(JSON.stringify({ overlayId: "overlay-123", status: "shown" }));
  process.exit(0);
}

if (args[0] === "webview" && args[1] === "open") {
  process.stdout.write(JSON.stringify({ tabId: "tab-456" }));
  process.exit(0);
}

if (args[0] === "terminal" && args.includes("run")) {
  process.stdout.write(JSON.stringify({ status: "launched" }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ status: "ok" }));
`;

  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);

  const logPath = join(dir, "smithers-ctl.log");
  return { binPath, dir, logPath };
}

function buildEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

async function readInvocations(logPath: string) {
  try {
    const raw = await readFile(logPath, "utf8");
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  } catch {
    return [];
  }
}

async function mcpRequest(
  cli: Cli.Cli<any, any, any>,
  body: unknown,
  sessionId?: string,
) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  return cli.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function initMcpSession(cli: Cli.Cli<any, any, any>) {
  const response = await mcpRequest(cli, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: TEST_CLIENT_INFO,
  });
  const sessionId = response.headers.get("mcp-session-id");
  expect(response.status).toBe(200);
  expect(sessionId).toBeTruthy();
  await mcpRequest(
    cli,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId ?? undefined,
  );
  return sessionId!;
}

async function callIdeTool(
  cli: Cli.Cli<any, any, any>,
  name: string,
  args: Record<string, unknown>,
) {
  const sessionId = await initMcpSession(cli);
  const response = await mcpRequest(
    cli,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    },
    sessionId,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.result.isError).toBeUndefined();
  return JSON.parse(body.result.content[0].text);
}

async function listMainCliToolNames(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/cli/index.ts", "--mcp"],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({
    name: "smithers-ide-tests",
    version: "1.0.0",
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).sort();
  } finally {
    await transport.close();
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("Smithers IDE tools", () => {
  test("maps open_file arguments through smithers-ctl", async () => {
    const fake = await makeFakeSmithersCtl();
    const env = buildEnv({
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      SMITHERS_CTL_LOG: fake.logPath,
      SMITHERS_IDE: "1",
    });
    const cli = createSmithersIdeCli({ env });

    const result = await callIdeTool(cli, "smithers_ide_open_file", {
      path: "/tmp/example.ts",
      line: 12,
      col: 4,
    });

    expect(result.path).toBe("/tmp/example.ts");
    expect(result.line).toBe(12);
    expect(result.column).toBe(4);

    const invocations = await readInvocations(fake.logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual(["open", "/tmp/example.ts", "+12:4"]);
  });

  test("maps open_diff arguments through smithers-ctl", async () => {
    const fake = await makeFakeSmithersCtl();
    const env = buildEnv({
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      SMITHERS_CTL_LOG: fake.logPath,
      SMITHERS_IDE: "1",
    });
    const cli = createSmithersIdeCli({ env });

    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const result = await callIdeTool(cli, "smithers_ide_open_diff", {
      content: diff,
    });

    expect(result.opened).toBe(true);

    const invocations = await readInvocations(fake.logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual(["diff", "show", "--content", diff]);
  });

  test("maps overlay, terminal, ask_user, and webview commands", async () => {
    const fake = await makeFakeSmithersCtl();
    const env = buildEnv({
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      SMITHERS_CTL_LOG: fake.logPath,
      SMITHERS_IDE: "1",
    });
    const overlay = await callIdeTool(createSmithersIdeCli({ env }), "smithers_ide_show_overlay", {
      type: "progress",
      message: "Building",
      percent: 35,
      title: "Compile",
      duration: 5,
      position: "center",
    });
    expect(overlay.overlayId).toBe("overlay-123");

    const terminal = await callIdeTool(createSmithersIdeCli({ env }), "smithers_ide_run_terminal", {
      cmd: "bun test tests/ide-tools.test.ts",
      cwd: "/tmp/project",
    });
    expect(terminal.status).toBe("launched");
    expect(terminal.cwd).toBe("/tmp/project");

    const askUser = await callIdeTool(createSmithersIdeCli({ env }), "smithers_ide_ask_user", {
      prompt: "Approve deploy?",
    });
    expect(askUser.status).toBe("prompted");
    expect(askUser.overlayId).toBe("overlay-123");

    const webview = await callIdeTool(createSmithersIdeCli({ env }), "smithers_ide_open_webview", {
      url: "https://example.com",
    });
    expect(webview.tabId).toBe("tab-456");

    const invocations = await readInvocations(fake.logPath);
    expect(invocations.map((entry) => entry.args)).toEqual([
      [
        "overlay",
        "--type",
        "progress",
        "--message",
        "Building",
        "--title",
        "Compile",
        "--position",
        "center",
        "--duration",
        "5",
        "--percent",
        "35",
      ],
      [
        "terminal",
        "--cwd",
        "/tmp/project",
        "run",
        "bun test tests/ide-tools.test.ts",
      ],
      ["overlay", "--type", "chat", "--message", "Approve deploy?"],
      ["webview", "open", "https://example.com"],
    ]);
  });

  test("lists only IDE-prefixed tools in the dedicated namespace", async () => {
    const fake = await makeFakeSmithersCtl();
    const env = buildEnv({
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      SMITHERS_IDE: "1",
    });
    const cli = createSmithersIdeCli({ env });
    const sessionId = await initMcpSession(cli);
    const response = await mcpRequest(
      cli,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );
    const body = await response.json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual([...SMITHERS_IDE_TOOL_NAMES].sort());
  });

  test("does not expose IDE tools on the main orchestrator MCP surface", async () => {
    const fake = await makeFakeSmithersCtl();
    const env = buildEnv({
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      SMITHERS_IDE: "1",
    });

    const toolNames = await listMainCliToolNames(env);
    expect(toolNames.some((name) => name.startsWith("smithers_ide_"))).toBe(false);
  });

  test("detects capability cleanly when smithers-ctl is missing", async () => {
    const env = buildEnv({
      PATH: "/definitely/missing",
      SMITHERS_IDE: "1",
    });

    const availability = await runPromise(
      detectSmithersIdeAvailabilityEffect({ env }),
    );

    expect(availability).toEqual({
      available: false,
      binaryAvailable: false,
      binaryPath: null,
      environmentActive: true,
      reason: "binary-missing",
      signals: ["SMITHERS_IDE"],
    });

    const cli = await createAvailableSmithersIdeCli({ env });
    expect(cli).toBeNull();
  });

  test("times out hung smithers-ctl invocations", async () => {
    const fake = await makeFakeSmithersCtl();
    const env = buildEnv({
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      SMITHERS_CTL_HANG: "1",
      SMITHERS_IDE: "1",
    });
    const service = createSmithersIdeService({
      env,
      idleTimeoutMs: 1_000,
      timeoutMs: 50,
    });

    await expect(
      runPromise(service.openWebview("https://example.com")),
    ).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
    });
  });
});
