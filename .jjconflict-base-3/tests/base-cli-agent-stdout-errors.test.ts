import { describe, expect, test } from "bun:test";
import { BaseCliAgent } from "../src/agents/BaseCliAgent";

type StdoutHandling = {
  stdoutBannerPatterns?: RegExp[];
  stdoutErrorPatterns?: RegExp[];
  errorOnBannerOnly?: boolean;
};

/**
 * Test agent that writes a fixed string to stdout and exits 0.
 * Optional stdout handling patterns emulate agent-specific parsing behavior.
 */
class StdoutAgent extends BaseCliAgent {
  constructor(
    private readonly stdoutText: string,
    private readonly handling: StdoutHandling = {},
  ) {
    super({ id: "stdout-test-agent" });
  }

  protected async buildCommand(_params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    return {
      command: "printf",
      args: ["%s", this.stdoutText],
      ...this.handling,
    };
  }
}

describe("BaseCliAgent stdout handling defaults", () => {
  test("does not treat generic 'Error:' text as CLI failure by default", async () => {
    const agent = new StdoutAgent("Error: this is model-authored text");
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toBe("Error: this is model-authored text");
  });

  test("does not strip YOLO banner by default", async () => {
    const agent = new StdoutAgent(
      "YOLO mode is enabled. All tool calls will be automatically approved.",
    );
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toContain("YOLO mode is enabled");
  });
});

describe("BaseCliAgent stdout handling (opt-in)", () => {
  const kimiErrorPatterns = [
    /^LLM not set/i,
    /^LLM not supported/i,
    /^Max steps reached/i,
    /^Interrupted by user$/i,
    /^Unknown error:/i,
    /^Error:/i,
  ];

  const errorCases = [
    "LLM not set",
    "LLM not supported",
    "Max steps reached: 50",
    "Interrupted by user",
    "Unknown error: connection refused",
    "Error: something went wrong",
    "error: lowercase variant",
  ];

  for (const errorText of errorCases) {
    test(`throws for stdout error pattern: "${errorText}"`, async () => {
      const agent = new StdoutAgent(errorText, {
        stdoutErrorPatterns: kimiErrorPatterns,
      });
      await expect(agent.generate({ prompt: "test" })).rejects.toThrow(
        "CLI agent error (stdout):",
      );
    });
  }

  test("does not throw for valid JSON output", async () => {
    const agent = new StdoutAgent('{"result": "ok"}', {
      stdoutErrorPatterns: kimiErrorPatterns,
    });
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toContain("ok");
  });

  test("does not throw for JSON array output", async () => {
    const agent = new StdoutAgent('[{"id": 1}]', {
      stdoutErrorPatterns: kimiErrorPatterns,
    });
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toContain("id");
  });

  test("does not throw for normal text output", async () => {
    const agent = new StdoutAgent("Hello, this is a normal response", {
      stdoutErrorPatterns: kimiErrorPatterns,
    });
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toBe("Hello, this is a normal response");
  });
});

describe("BaseCliAgent banner handling (opt-in)", () => {
  const yoloBanner = /^YOLO mode is enabled\b[^\n]*/gm;

  test("throws when stdout is only the banner", async () => {
    const agent = new StdoutAgent(
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      {
        stdoutBannerPatterns: [yoloBanner],
        errorOnBannerOnly: true,
      },
    );
    await expect(agent.generate({ prompt: "test" })).rejects.toThrow(
      "CLI agent error (stdout):",
    );
  });

  test("strips banner and returns remaining JSON", async () => {
    const content = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      '{"result": "actual model output"}',
    ].join("\n");
    const agent = new StdoutAgent(content, {
      stdoutBannerPatterns: [yoloBanner],
      errorOnBannerOnly: true,
    });
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toContain("actual model output");
  });

  test("strips banner when followed by plain text", async () => {
    const content = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      "Here is the actual response from the model.",
    ].join("\n");
    const agent = new StdoutAgent(content, {
      stdoutBannerPatterns: [yoloBanner],
      errorOnBannerOnly: true,
    });
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toBe("Here is the actual response from the model.");
  });
});

describe("BaseCliAgent Codex banner stripping (opt-in)", () => {
  const codexBanner = /^OpenAI Codex v[^\n]*$/gm;

  test("strips Codex startup banner and keeps JSON payload", async () => {
    const content = [
      "OpenAI Codex v0.99.0-alpha.13 (research preview)",
      '{"tickets":[{"id":"t1"}]}',
    ].join("\n");
    const agent = new StdoutAgent(content, {
      stdoutBannerPatterns: [codexBanner],
    });
    const result = await agent.generate({ prompt: "test" });
    expect(result.text).toBe('{"tickets":[{"id":"t1"}]}');
  });
});
