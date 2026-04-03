import { describe, expect, test } from "bun:test";
import { BaseCliAgent } from "../src/agents/BaseCliAgent";
import type { BaseCliAgentOptions } from "../src/agents/BaseCliAgent";

class TimedAgent extends BaseCliAgent {
  constructor(
    private readonly script: string,
    opts: BaseCliAgentOptions = {},
  ) {
    super({ id: "timeout-test-agent", ...opts });
  }

  protected async buildCommand(_params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    return {
      command: "bash",
      args: ["-lc", this.script],
    };
  }
}

describe("BaseCliAgent timeouts", () => {
  test("idle timeout resets on stdout activity", async () => {
    const agent = new TimedAgent(
      "for i in 1 2 3 4 5; do echo tick; sleep 0.05; done",
      { idleTimeoutMs: 80 },
    );

    const result = await agent.generate({ prompt: "run" });
    expect(result.text).toContain("tick");
  });

  test("idle timeout fails after inactivity", async () => {
    const agent = new TimedAgent("echo start; sleep 0.2; echo end", {
      idleTimeoutMs: 80,
    });

    await expect(agent.generate({ prompt: "run" })).rejects.toThrow(
      "CLI idle timed out after 80ms",
    );
  });

  test("hard timeout still applies", async () => {
    const agent = new TimedAgent("sleep 0.2; echo done", {
      timeoutMs: 50,
      idleTimeoutMs: 1000,
    });

    await expect(agent.generate({ prompt: "run" })).rejects.toThrow(
      "CLI timed out after 50ms",
    );
  });
});
