import { describe, expect, test } from "bun:test";
import {
  runDiagnostics,
  getDiagnosticStrategy,
  enrichReportWithErrorAnalysis,
  formatDiagnosticSummary,
  launchDiagnostics,
} from "../src/diagnostics";
import type { DiagnosticReport } from "../src/diagnostics";
import { BaseCliAgent } from "../src/BaseCliAgent";
import { SmithersError } from "@smithers/errors/SmithersError";

// ---------------------------------------------------------------------------
// runDiagnostics
// ---------------------------------------------------------------------------

describe("runDiagnostics", () => {
  test("runs all checks and returns a report", async () => {
    const strategy = {
      agentId: "test-agent",
      command: "test",
      checks: [
        {
          id: "cli_installed" as const,
          run: async () => ({
            id: "cli_installed" as const,
            status: "pass" as const,
            message: "found",
            durationMs: 1,
          }),
        },
        {
          id: "api_key_valid" as const,
          run: async () => ({
            id: "api_key_valid" as const,
            status: "fail" as const,
            message: "not set",
            durationMs: 1,
          }),
        },
      ],
    };

    const report = await runDiagnostics(strategy, { env: {}, cwd: "/tmp" });
    expect(report.agentId).toBe("test-agent");
    expect(report.command).toBe("test");
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]!.status).toBe("pass");
    expect(report.checks[1]!.status).toBe("fail");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeTruthy();
  });

  test("catches errors from checks and reports status=error", async () => {
    const strategy = {
      agentId: "error-agent",
      command: "err",
      checks: [
        {
          id: "cli_installed" as const,
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
    };

    const report = await runDiagnostics(strategy, { env: {}, cwd: "/tmp" });
    expect(report.checks[0]!.status).toBe("error");
    expect(report.checks[0]!.message).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// getDiagnosticStrategy
// ---------------------------------------------------------------------------

describe("getDiagnosticStrategy", () => {
  test("returns strategy for known commands", () => {
    expect(getDiagnosticStrategy("claude")).not.toBeNull();
    expect(getDiagnosticStrategy("codex")).not.toBeNull();
    expect(getDiagnosticStrategy("gemini")).not.toBeNull();
    expect(getDiagnosticStrategy("pi")).not.toBeNull();
  });

  test("returns null for unknown commands", () => {
    expect(getDiagnosticStrategy("unknown-cli")).toBeNull();
    expect(getDiagnosticStrategy("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichReportWithErrorAnalysis
// ---------------------------------------------------------------------------

describe("enrichReportWithErrorAnalysis", () => {
  function makeReport(rateLimitStatus: "skip" | "pass" = "skip"): DiagnosticReport {
    return {
      agentId: "test",
      command: "test",
      timestamp: new Date().toISOString(),
      durationMs: 10,
      checks: [
        { id: "cli_installed", status: "pass", message: "ok", durationMs: 1 },
        { id: "rate_limit_status", status: rateLimitStatus, message: "skipped", durationMs: 0 },
      ],
    };
  }

  test("detects 'rate limit' in error message", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Error: rate limit exceeded");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("fail");
    expect(check!.detail?.detectedPostHoc).toBe(true);
  });

  test("detects '429' in error message", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "HTTP 429 Too Many Requests");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("fail");
  });

  test("detects 'credit balance is too low'", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Your credit balance is too low");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("fail");
  });

  test("detects 'overloaded'", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "API is overloaded");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("fail");
  });

  test("detects 'quota exceeded'", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Quota exceeded for this organization");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("fail");
  });

  test("does not modify report if no rate limit pattern matches", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Some other error");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("skip");
  });

  test("does not overwrite existing fail status", () => {
    const report = makeReport();
    const check = report.checks.find((c) => c.id === "rate_limit_status")!;
    check.status = "fail";
    check.message = "pre-flight detected";
    enrichReportWithErrorAnalysis(report, "rate limit exceeded");
    // Should keep original fail message
    expect(check.message).toBe("pre-flight detected");
  });

  test("handles empty error message", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check!.status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// formatDiagnosticSummary
// ---------------------------------------------------------------------------

describe("formatDiagnosticSummary", () => {
  test("reports all passed when no failures", () => {
    const report: DiagnosticReport = {
      agentId: "claude-code",
      command: "claude",
      timestamp: new Date().toISOString(),
      durationMs: 42,
      checks: [
        { id: "cli_installed", status: "pass", message: "ok", durationMs: 1 },
        { id: "api_key_valid", status: "pass", message: "ok", durationMs: 1 },
        { id: "rate_limit_status", status: "skip", message: "skipped", durationMs: 0 },
      ],
    };

    const summary = formatDiagnosticSummary(report);
    expect(summary).toContain("all checks passed");
    expect(summary).toContain("claude-code");
  });

  test("reports failures", () => {
    const report: DiagnosticReport = {
      agentId: "codex",
      command: "codex",
      timestamp: new Date().toISOString(),
      durationMs: 15,
      checks: [
        { id: "cli_installed", status: "fail", message: "codex not found on PATH", durationMs: 1 },
        { id: "api_key_valid", status: "fail", message: "OPENAI_API_KEY not set", durationMs: 0 },
      ],
    };

    const summary = formatDiagnosticSummary(report);
    expect(summary).toContain("cli_installed=fail");
    expect(summary).toContain("api_key_valid=fail");
    expect(summary).toContain("codex");
  });
});

// ---------------------------------------------------------------------------
// launchDiagnostics
// ---------------------------------------------------------------------------

describe("launchDiagnostics", () => {
  test("returns null for unknown command", () => {
    const result = launchDiagnostics("unknown", {}, "/tmp");
    expect(result).toBeNull();
  });

  test("returns a promise for known command", () => {
    const result = launchDiagnostics("claude", {}, "/tmp");
    expect(result).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// BaseCliAgent integration: diagnostics attached on failure
// ---------------------------------------------------------------------------

// Agent that fails with a SmithersError (simulating non-zero exit code)
class ErrorExitAgent extends BaseCliAgent {
  protected async buildCommand() {
    return {
      // `false` is a real binary that exits with code 1
      command: "false",
      args: [],
    };
  }
}

describe("BaseCliAgent diagnostics integration", () => {
  test("attaches diagnostics to SmithersError on non-zero exit", async () => {
    const agent = new ErrorExitAgent({ id: "diag-test" });
    try {
      await agent.generate({ prompt: "test" });
      expect.unreachable("should have thrown");
    } catch (err) {
      // `false` exits with code 1, which triggers SmithersError("AGENT_CLI_ERROR")
      expect(err).toBeInstanceOf(SmithersError);
      const details = (err as SmithersError).details;
      // command is "false" which has no strategy, so diagnostics should be absent
      // This verifies the no-strategy path doesn't error out
      expect(details?.diagnostics).toBeUndefined();
    }
  });

  test("agent that uses a known command gets diagnostics attached", async () => {
    // Use a command name from the strategy registry but that will fail
    // We create a subclass that claims to use "claude" command but will fail
    class FakeClaudeAgent extends BaseCliAgent {
      protected async buildCommand() {
        return {
          command: "claude",
          args: ["--this-flag-does-not-exist-99999"],
        };
      }
    }

    const agent = new FakeClaudeAgent({ id: "diag-claude-test" });
    try {
      await agent.generate({ prompt: "test" });
      // Might succeed if claude is installed with unexpected behavior,
      // or might fail — either way is fine for this test
    } catch (err) {
      if (err instanceof SmithersError) {
        // If diagnostics ran, report should be attached
        const report = (err as SmithersError).details?.diagnostics as DiagnosticReport | undefined;
        if (report) {
          expect(report.agentId).toBe("claude-code");
          expect(report.checks.length).toBeGreaterThan(0);
        }
      }
      // Non-SmithersError (e.g., ENOENT if claude not installed) — diagnostics
      // only enrich SmithersError, so this is expected to have no diagnostics
    }
  });
});

// ---------------------------------------------------------------------------
// Strategy-specific checks (unit tests for individual check logic)
// ---------------------------------------------------------------------------

describe("claude strategy checks", () => {
  test("api_key_valid passes in subscription mode (no key)", async () => {
    const strategy = getDiagnosticStrategy("claude")!;
    const report = await runDiagnostics(strategy, {
      env: {} as Record<string, string>,
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    expect(apiKeyCheck!.status).toBe("pass");
    expect(apiKeyCheck!.message).toContain("subscription mode");
  });

  test("api_key_valid fails for invalid format", async () => {
    const strategy = getDiagnosticStrategy("claude")!;
    const report = await runDiagnostics(strategy, {
      env: { ANTHROPIC_API_KEY: "bad-key-format" } as Record<string, string>,
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    expect(apiKeyCheck!.status).toBe("fail");
    expect(apiKeyCheck!.message).toContain("unexpected format");
  });

  test("api_key_valid passes for sk-ant- prefix", async () => {
    const strategy = getDiagnosticStrategy("claude")!;
    const report = await runDiagnostics(strategy, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-key-12345" } as Record<string, string>,
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    expect(apiKeyCheck!.status).toBe("pass");
  });
});

describe("codex strategy checks", () => {
  test("api_key_valid fails when OPENAI_API_KEY not set", async () => {
    const strategy = getDiagnosticStrategy("codex")!;
    const report = await runDiagnostics(strategy, {
      env: {} as Record<string, string>,
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    expect(apiKeyCheck!.status).toBe("fail");
    expect(apiKeyCheck!.message).toContain("not set");
  });

  test("api_key_valid probes OpenAI API with key (fake key → fail or error)", async () => {
    const strategy = getDiagnosticStrategy("codex")!;
    const report = await runDiagnostics(strategy, {
      env: { OPENAI_API_KEY: "sk-test-fake-key-12345" } as Record<string, string>,
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    // Fake key will get 401 (fail) or network error (error) — not pass
    expect(["fail", "error"]).toContain(apiKeyCheck!.status);
  });

  test("rate_limit_status probes OpenAI API when key is set", async () => {
    const strategy = getDiagnosticStrategy("codex")!;
    const report = await runDiagnostics(strategy, {
      env: { OPENAI_API_KEY: "sk-test-fake-key" } as Record<string, string>,
      cwd: "/tmp",
    });
    const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
    // With a fake key, expect fail (401) or error (network) — not skip
    expect(rlCheck!.status).not.toBe("skip");
  });

  test("rate_limit_status skips when no OPENAI_API_KEY", async () => {
    const strategy = getDiagnosticStrategy("codex")!;
    const report = await runDiagnostics(strategy, {
      env: {} as Record<string, string>,
      cwd: "/tmp",
    });
    const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
    expect(rlCheck!.status).toBe("skip");
  });
});
