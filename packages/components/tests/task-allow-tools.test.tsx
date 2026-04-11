/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createSmithers } from "smithers";
import { renderFrame } from "@smithers/engine";
import { buildContext } from "@smithers/react-reconciler/context";
import { ClaudeCodeAgent } from "@smithers/agents/ClaudeCodeAgent";
import { GeminiAgent } from "@smithers/agents/GeminiAgent";
import { PiAgent } from "@smithers/agents/PiAgent";

describe("Task allowTools", () => {
  test("passes an allowlist through to ClaudeCodeAgent tasks", async () => {
    const api = createSmithers(
      {
        output: z.object({ ok: z.boolean() }),
      },
      { dbPath: ":memory:" },
    );

    const workflow = api.smithers(() => (
      <api.Workflow name="claude-allow-tools">
        <api.Task
          id="agent"
          output={api.outputs.output}
          agent={new ClaudeCodeAgent({ model: "claude-test" })}
          allowTools={["read", "grep"]}
        >
          prompt
        </api.Task>
      </api.Workflow>
    ));

    const frame = await renderFrame(workflow, {
      runId: "preview",
      iteration: 0,
      input: {},
      outputs: {},
    });
    const taskAgent = frame.tasks[0]?.agent as any;
    const command = await taskAgent.buildCommand({
      prompt: "prompt",
      cwd: process.cwd(),
      options: {},
    });

    expect(command.args).toContain("--allowed-tools");
    const flagIndex = command.args.indexOf("--allowed-tools");
    expect(command.args.slice(flagIndex + 1, flagIndex + 3)).toEqual([
      "read",
      "grep",
    ]);
  });

  test("disables PiAgent tools when allowTools is empty", async () => {
    const api = createSmithers(
      {
        output: z.object({ ok: z.boolean() }),
      },
      { dbPath: ":memory:" },
    );

    const workflow = api.smithers(() => (
      <api.Workflow name="pi-allow-tools">
        <api.Task
          id="agent"
          output={api.outputs.output}
          agent={new PiAgent({ model: "pi-test" })}
          allowTools={[]}
        >
          prompt
        </api.Task>
      </api.Workflow>
    ));

    const frame = await renderFrame(workflow, {
      runId: "preview",
      iteration: 0,
      input: {},
      outputs: {},
    });
    const taskAgent = frame.tasks[0]?.agent as any;
    const args = taskAgent.buildArgs({
      prompt: "prompt",
      cwd: process.cwd(),
      options: {},
      mode: "text",
    });

    expect(args).toContain("--no-tools");
    expect(args).not.toContain("--tools");
  });

  test("disables GeminiAgent tools when allowTools is empty", async () => {
    const api = createSmithers(
      {
        output: z.object({ ok: z.boolean() }),
      },
      { dbPath: ":memory:" },
    );

    const workflow = api.smithers(() => (
      <api.Workflow name="gemini-allow-tools">
        <api.Task
          id="agent"
          output={api.outputs.output}
          agent={new GeminiAgent({ model: "gemini-test" })}
          allowTools={[]}
        >
          prompt
        </api.Task>
      </api.Workflow>
    ));

    const frame = await renderFrame(workflow, {
      runId: "preview",
      iteration: 0,
      input: {},
      outputs: {},
    });
    const taskAgent = frame.tasks[0]?.agent as any;
    const command = await taskAgent.buildCommand({
      prompt: "prompt",
      cwd: process.cwd(),
      options: {},
    });

    expect(command.args).toContain("--allowed-tools");
    const flagIndex = command.args.indexOf("--allowed-tools");
    expect(command.args[flagIndex + 1]).toBe("");
  });

  test("applies explicit-only CLI tool defaults from runtime context", async () => {
    const api = createSmithers(
      {
        output: z.object({ ok: z.boolean() }),
      },
      { dbPath: ":memory:" },
    );

    const workflow = api.smithers(() => (
      <api.Workflow name="context-cli-tool-defaults">
        <api.Task
          id="agent"
          output={api.outputs.output}
          agent={new PiAgent({ model: "pi-test" })}
        >
          prompt
        </api.Task>
      </api.Workflow>
    ));

    const frame = await renderFrame(
      workflow,
      buildContext({
        runId: "preview",
        iteration: 0,
        input: {},
        auth: null,
        outputs: {},
        runtimeConfig: {
          cliAgentToolsDefault: "explicit-only",
        },
      }),
    );
    const taskAgent = frame.tasks[0]?.agent as any;
    const args = taskAgent.buildArgs({
      prompt: "prompt",
      cwd: process.cwd(),
      options: {},
      mode: "text",
    });

    expect(args).toContain("--no-tools");
    expect(args).not.toContain("--tools");
  });
});
