import { describe, expect, test } from "bun:test";

// We test the exported pure-logic functions by importing the module.
// detectAvailableAgents calls spawnSync so we test the scoring/status logic
// via generateAgentsTs with controlled env.
import { detectAvailableAgents } from "../src/cli/agent-detection";

// We can't easily mock spawnSync, but we can test the detection logic
// by verifying structure and scoring behavior with the real environment.

describe("detectAvailableAgents", () => {
  test("returns array with entries for all known agents", () => {
    const results = detectAvailableAgents({});
    const ids = results.map((r) => r.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
    expect(ids).toContain("pi");
    expect(ids).toContain("kimi");
    expect(ids).toContain("amp");
    expect(results.length).toBe(6);
  });

  test("each result has required fields", () => {
    const results = detectAvailableAgents({});
    for (const result of results) {
      expect(typeof result.id).toBe("string");
      expect(typeof result.binary).toBe("string");
      expect(typeof result.hasBinary).toBe("boolean");
      expect(typeof result.hasAuthSignal).toBe("boolean");
      expect(typeof result.hasApiKeySignal).toBe("boolean");
      expect(typeof result.status).toBe("string");
      expect(typeof result.score).toBe("number");
      expect(typeof result.usable).toBe("boolean");
      expect(Array.isArray(result.checks)).toBe(true);
    }
  });

  test("status is 'unavailable' when no binary, no auth, no api key", () => {
    // Empty env, no HOME (so auth signals won't match)
    const results = detectAvailableAgents({ HOME: "/nonexistent-path-xyz" });
    for (const result of results) {
      if (!result.hasBinary && !result.hasAuthSignal && !result.hasApiKeySignal) {
        expect(result.status).toBe("unavailable");
        expect(result.score).toBe(0);
        expect(result.usable).toBe(false);
      }
    }
  });

  test("api key signal detected from env", () => {
    const results = detectAvailableAgents({
      HOME: "/nonexistent-path-xyz",
      ANTHROPIC_API_KEY: "sk-ant-test123",
    });
    const claude = results.find((r) => r.id === "claude")!;
    expect(claude.hasApiKeySignal).toBe(true);
    // Should be "api-key" if no binary, or higher if binary found
    if (!claude.hasBinary) {
      expect(claude.status).toBe("api-key");
      expect(claude.score).toBe(3);
    }
  });

  test("openai api key detected for codex", () => {
    const results = detectAvailableAgents({
      HOME: "/nonexistent-path-xyz",
      OPENAI_API_KEY: "sk-test123",
    });
    const codex = results.find((r) => r.id === "codex")!;
    expect(codex.hasApiKeySignal).toBe(true);
  });

  test("google api key detected for gemini", () => {
    const results = detectAvailableAgents({
      HOME: "/nonexistent-path-xyz",
      GOOGLE_API_KEY: "test-key",
    });
    const gemini = results.find((r) => r.id === "gemini")!;
    expect(gemini.hasApiKeySignal).toBe(true);
  });

  test("GEMINI_API_KEY also detected for gemini", () => {
    const results = detectAvailableAgents({
      HOME: "/nonexistent-path-xyz",
      GEMINI_API_KEY: "test-key",
    });
    const gemini = results.find((r) => r.id === "gemini")!;
    expect(gemini.hasApiKeySignal).toBe(true);
  });

  test("checks array includes binary check", () => {
    const results = detectAvailableAgents({});
    for (const result of results) {
      const binaryCheck = result.checks.find((c) => c.startsWith("binary:"));
      expect(binaryCheck).toBeDefined();
    }
  });

  test("checks array includes env checks for agents with api keys", () => {
    const results = detectAvailableAgents({});
    const claude = results.find((r) => r.id === "claude")!;
    const envCheck = claude.checks.find((c) => c.startsWith("env:ANTHROPIC_API_KEY:"));
    expect(envCheck).toBeDefined();
  });

  test("usable is true when score > 0", () => {
    const results = detectAvailableAgents({
      HOME: "/nonexistent-path-xyz",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    const claude = results.find((r) => r.id === "claude")!;
    expect(claude.usable).toBe(claude.score > 0);
  });

  test("kimi detects KIMI_SHARE_DIR as auth signal path", () => {
    const results = detectAvailableAgents({
      HOME: "/nonexistent-path-xyz",
      KIMI_SHARE_DIR: "/tmp/kimi-test",
    });
    const kimi = results.find((r) => r.id === "kimi")!;
    const authCheck = kimi.checks.find((c) => c.includes("/tmp/kimi-test"));
    expect(authCheck).toBeDefined();
  });
});
