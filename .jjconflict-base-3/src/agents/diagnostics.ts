import { spawnSync } from "node:child_process";
import { SmithersError } from "../utils/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiagnosticCheckId =
  | "cli_installed"
  | "api_key_valid"
  | "rate_limit_status";

export type DiagnosticCheckStatus = "pass" | "fail" | "skip" | "error";

export type DiagnosticCheck = {
  id: DiagnosticCheckId;
  status: DiagnosticCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
  durationMs: number;
};

export type DiagnosticReport = {
  agentId: string;
  command: string;
  timestamp: string;
  checks: DiagnosticCheck[];
  durationMs: number;
};

export type DiagnosticContext = {
  env: Record<string, string>;
  cwd: string;
};

type DiagnosticCheckDef = {
  id: DiagnosticCheckId;
  run: (ctx: DiagnosticContext) => Promise<DiagnosticCheck>;
};

type AgentDiagnosticStrategy = {
  agentId: string;
  command: string;
  checks: DiagnosticCheckDef[];
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const PER_CHECK_TIMEOUT_MS = 5_000;

async function runCheck(
  check: DiagnosticCheckDef,
  ctx: DiagnosticContext,
): Promise<DiagnosticCheck> {
  const start = performance.now();
  try {
    return await Promise.race([
      check.run(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new SmithersError(
                "AGENT_DIAGNOSTIC_TIMEOUT",
                "diagnostic check timed out",
                { timeoutMs: PER_CHECK_TIMEOUT_MS },
              ),
            ),
          PER_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    return {
      id: check.id,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - start,
    };
  }
}

export async function runDiagnostics(
  strategy: AgentDiagnosticStrategy,
  ctx: DiagnosticContext,
): Promise<DiagnosticReport> {
  const start = performance.now();
  const results = await Promise.all(
    strategy.checks.map((check) => runCheck(check, ctx)),
  );
  return {
    agentId: strategy.agentId,
    command: strategy.command,
    timestamp: new Date().toISOString(),
    checks: results,
    durationMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Shared check helpers
// ---------------------------------------------------------------------------

function checkCliInstalled(
  command: string,
  agentId: string,
): DiagnosticCheckDef {
  return {
    id: "cli_installed",
    run: async () => {
      const start = performance.now();
      const result = spawnSync("which", [command], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const elapsed = performance.now() - start;
      const binaryPath = result.stdout?.toString("utf8").trim();
      if (result.status === 0 && binaryPath) {
        return {
          id: "cli_installed",
          status: "pass",
          message: `${agentId} found at ${binaryPath}`,
          detail: { binaryPath },
          durationMs: elapsed,
        };
      }
      return {
        id: "cli_installed",
        status: "fail",
        message: `${command} not found on PATH`,
        durationMs: elapsed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Claude strategy
// ---------------------------------------------------------------------------

const claudeApiKeyCheck: DiagnosticCheckDef = {
  id: "api_key_valid",
  run: async (ctx) => {
    const start = performance.now();
    const apiKey = ctx.env.ANTHROPIC_API_KEY;

    // No API key means subscription mode — valid for Claude Code CLI
    if (!apiKey) {
      return {
        id: "api_key_valid",
        status: "pass",
        message: "No ANTHROPIC_API_KEY set — using subscription mode",
        durationMs: performance.now() - start,
      };
    }

    // Validate key format
    if (!apiKey.startsWith("sk-ant-")) {
      return {
        id: "api_key_valid",
        status: "fail",
        message: "ANTHROPIC_API_KEY has unexpected format (expected sk-ant-* prefix)",
        detail: { prefix: apiKey.slice(0, 7) },
        durationMs: performance.now() - start,
      };
    }

    return {
      id: "api_key_valid",
      status: "pass",
      message: "ANTHROPIC_API_KEY format valid",
      durationMs: performance.now() - start,
    };
  },
};

const claudeRateLimitCheck: DiagnosticCheckDef = {
  id: "rate_limit_status",
  run: async (ctx) => {
    const start = performance.now();
    const apiKey = ctx.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        id: "rate_limit_status",
        status: "skip",
        message: "Subscription mode — cannot probe rate limits via API",
        durationMs: performance.now() - start,
      };
    }

    try {
      const res = await fetch(
        "https://api.anthropic.com/v1/messages/count_tokens",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(4_000),
        },
      );

      const elapsed = performance.now() - start;

      if (res.status === 401) {
        return {
          id: "rate_limit_status",
          status: "fail",
          message: "API key is invalid (401 Unauthorized)",
          durationMs: elapsed,
        };
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        return {
          id: "rate_limit_status",
          status: "fail",
          message: `Currently rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
          detail: { retryAfter },
          durationMs: elapsed,
        };
      }

      // Parse rate limit headers
      const remaining = {
        requests: parseHeaderInt(res.headers.get("anthropic-ratelimit-requests-remaining")),
        inputTokens: parseHeaderInt(res.headers.get("anthropic-ratelimit-input-tokens-remaining")),
        outputTokens: parseHeaderInt(res.headers.get("anthropic-ratelimit-output-tokens-remaining")),
      };
      const resets = {
        requests: res.headers.get("anthropic-ratelimit-requests-reset"),
        inputTokens: res.headers.get("anthropic-ratelimit-input-tokens-reset"),
        outputTokens: res.headers.get("anthropic-ratelimit-output-tokens-reset"),
      };

      if (remaining.requests === 0 || remaining.inputTokens === 0 || remaining.outputTokens === 0) {
        return {
          id: "rate_limit_status",
          status: "fail",
          message: "Rate limit quota exhausted",
          detail: { remaining, resets },
          durationMs: elapsed,
        };
      }

      return {
        id: "rate_limit_status",
        status: "pass",
        message: "Rate limit OK",
        detail: { remaining, resets },
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "rate_limit_status",
        status: "error",
        message: `Rate limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: performance.now() - start,
      };
    }
  },
};

const claudeStrategy: AgentDiagnosticStrategy = {
  agentId: "claude-code",
  command: "claude",
  checks: [
    checkCliInstalled("claude", "Claude Code"),
    claudeApiKeyCheck,
    claudeRateLimitCheck,
  ],
};

// ---------------------------------------------------------------------------
// Codex strategy
// ---------------------------------------------------------------------------

// Combined API key validation + rate limit check via GET /v1/models (free, no tokens)
const codexApiKeyAndRateLimitCheck: DiagnosticCheckDef[] = [
  {
    id: "api_key_valid",
    run: async (ctx) => {
      const start = performance.now();
      const apiKey = ctx.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          id: "api_key_valid",
          status: "fail",
          message: "OPENAI_API_KEY not set",
          durationMs: performance.now() - start,
        };
      }

      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(4_000),
        });
        const elapsed = performance.now() - start;

        if (res.status === 401) {
          return {
            id: "api_key_valid",
            status: "fail",
            message: "OPENAI_API_KEY is invalid (401 Unauthorized)",
            durationMs: elapsed,
          };
        }
        if (res.status === 403) {
          return {
            id: "api_key_valid",
            status: "fail",
            message: "OPENAI_API_KEY lacks permission (403 Forbidden)",
            durationMs: elapsed,
          };
        }

        return {
          id: "api_key_valid",
          status: "pass",
          message: "OPENAI_API_KEY is valid",
          durationMs: elapsed,
        };
      } catch (err) {
        return {
          id: "api_key_valid",
          status: "error",
          message: `OpenAI probe failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  },
  {
    id: "rate_limit_status",
    run: async (ctx) => {
      const start = performance.now();
      const apiKey = ctx.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          id: "rate_limit_status",
          status: "skip",
          message: "No API key — cannot check rate limits",
          durationMs: 0,
        };
      }

      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(4_000),
        });
        const elapsed = performance.now() - start;

        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          return {
            id: "rate_limit_status",
            status: "fail",
            message: `Currently rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
            detail: { retryAfter },
            durationMs: elapsed,
          };
        }

        // Parse OpenAI rate limit headers if present
        const remaining = {
          requests: parseHeaderInt(res.headers.get("x-ratelimit-remaining-requests")),
          tokens: parseHeaderInt(res.headers.get("x-ratelimit-remaining-tokens")),
        };
        const resets = {
          requests: res.headers.get("x-ratelimit-reset-requests"),
          tokens: res.headers.get("x-ratelimit-reset-tokens"),
        };
        const limits = {
          requests: parseHeaderInt(res.headers.get("x-ratelimit-limit-requests")),
          tokens: parseHeaderInt(res.headers.get("x-ratelimit-limit-tokens")),
        };

        const hasHeaders = remaining.requests !== undefined || remaining.tokens !== undefined;

        if (hasHeaders && (remaining.requests === 0 || remaining.tokens === 0)) {
          return {
            id: "rate_limit_status",
            status: "fail",
            message: "Rate limit quota exhausted",
            detail: { remaining, resets, limits },
            durationMs: elapsed,
          };
        }

        return {
          id: "rate_limit_status",
          status: "pass",
          message: hasHeaders ? "Rate limit OK" : "Rate limit OK (no headers returned)",
          detail: hasHeaders ? { remaining, resets, limits } : undefined,
          durationMs: elapsed,
        };
      } catch (err) {
        return {
          id: "rate_limit_status",
          status: "error",
          message: `Rate limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  },
];

const codexStrategy: AgentDiagnosticStrategy = {
  agentId: "codex",
  command: "codex",
  checks: [
    checkCliInstalled("codex", "Codex"),
    ...codexApiKeyAndRateLimitCheck,
  ],
};

// ---------------------------------------------------------------------------
// Gemini strategy
// ---------------------------------------------------------------------------

// Validate Google auth via GET /v1beta/models (free, no tokens)
const googleAuthCheck: DiagnosticCheckDef = {
  id: "api_key_valid",
  run: async (ctx) => {
    const start = performance.now();
    const apiKey = ctx.env.GOOGLE_API_KEY ?? ctx.env.GEMINI_API_KEY;

    if (apiKey) {
      // Probe the models endpoint to validate the key
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
          { signal: AbortSignal.timeout(4_000) },
        );
        const elapsed = performance.now() - start;

        if (res.status === 400 || res.status === 403) {
          return {
            id: "api_key_valid",
            status: "fail",
            message: `Google API key is invalid (${res.status})`,
            durationMs: elapsed,
          };
        }

        return {
          id: "api_key_valid",
          status: "pass",
          message: "Google API key is valid",
          durationMs: elapsed,
        };
      } catch (err) {
        return {
          id: "api_key_valid",
          status: "error",
          message: `Google API probe failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    }

    // No API key — check gcloud auth
    const result = spawnSync("gcloud", ["auth", "print-access-token"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3_000,
    });
    const elapsed = performance.now() - start;
    if (result.status === 0 && result.stdout?.toString("utf8").trim()) {
      return {
        id: "api_key_valid",
        status: "pass",
        message: "Authenticated via gcloud",
        durationMs: elapsed,
      };
    }
    return {
      id: "api_key_valid",
      status: "fail",
      message: "No GOOGLE_API_KEY/GEMINI_API_KEY set and gcloud auth not configured",
      durationMs: elapsed,
    };
  },
};

const googleRateLimitCheck: DiagnosticCheckDef = {
  id: "rate_limit_status",
  run: async (ctx) => {
    const start = performance.now();
    const apiKey = ctx.env.GOOGLE_API_KEY ?? ctx.env.GEMINI_API_KEY;

    if (!apiKey) {
      return {
        id: "rate_limit_status",
        status: "skip",
        message: "gcloud auth mode — cannot probe rate limits via API key",
        durationMs: 0,
      };
    }

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        { signal: AbortSignal.timeout(4_000) },
      );
      const elapsed = performance.now() - start;

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        return {
          id: "rate_limit_status",
          status: "fail",
          message: `Currently rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
          detail: { retryAfter },
          durationMs: elapsed,
        };
      }

      return {
        id: "rate_limit_status",
        status: "pass",
        message: "Rate limit OK",
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "rate_limit_status",
        status: "error",
        message: `Rate limit probe failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: performance.now() - start,
      };
    }
  },
};

const geminiStrategy: AgentDiagnosticStrategy = {
  agentId: "gemini",
  command: "gemini",
  checks: [
    checkCliInstalled("gemini", "Gemini CLI"),
    googleAuthCheck,
    googleRateLimitCheck,
  ],
};

// ---------------------------------------------------------------------------
// Pi strategy
// ---------------------------------------------------------------------------

const piStrategy: AgentDiagnosticStrategy = {
  agentId: "pi",
  command: "pi",
  checks: [
    checkCliInstalled("pi", "Pi"),
    googleAuthCheck,
    googleRateLimitCheck,
  ],
};

// ---------------------------------------------------------------------------
// Amp strategy
// ---------------------------------------------------------------------------

const ampApiKeySkip: DiagnosticCheckDef = {
  id: "api_key_valid",
  run: async () => {
    return {
      id: "api_key_valid",
      status: "skip",
      message: "Amp uses its own auth — skipping API key check",
      durationMs: 0,
    };
  },
};

const ampRateLimitSkip: DiagnosticCheckDef = {
  id: "rate_limit_status",
  run: async () => {
    return {
      id: "rate_limit_status",
      status: "skip",
      message: "Amp uses its own auth — skipping rate limit check",
      durationMs: 0,
    };
  },
};

const ampStrategy: AgentDiagnosticStrategy = {
  agentId: "amp",
  command: "amp",
  checks: [
    checkCliInstalled("amp", "Amp"),
    ampApiKeySkip,
    ampRateLimitSkip,
  ],
};

// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------

const strategies: Record<string, AgentDiagnosticStrategy> = {
  claude: claudeStrategy,
  codex: codexStrategy,
  gemini: geminiStrategy,
  pi: piStrategy,
  amp: ampStrategy,
};

export function getDiagnosticStrategy(
  command: string,
): AgentDiagnosticStrategy | null {
  return strategies[command] ?? null;
}

// ---------------------------------------------------------------------------
// Post-hoc error analysis
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /\b429\b/,
  /credit balance.*(too low|insufficient|exhausted)/i,
  /overloaded/i,
  /too many requests/i,
  /quota.*(exceeded|exhausted)/i,
  /retry.?after/i,
];

export function enrichReportWithErrorAnalysis(
  report: DiagnosticReport,
  errorMessage: string,
): void {
  if (!errorMessage) return;

  const rateLimitCheck = report.checks.find(
    (c) => c.id === "rate_limit_status",
  );
  // Only enrich if the rate limit check was skipped or passed —
  // if it already failed, the pre-flight probe already caught it.
  if (rateLimitCheck && (rateLimitCheck.status === "skip" || rateLimitCheck.status === "pass")) {
    const matched = RATE_LIMIT_PATTERNS.some((p) => p.test(errorMessage));
    if (matched) {
      rateLimitCheck.status = "fail";
      rateLimitCheck.message = `Rate limit detected in error: ${errorMessage.slice(0, 200)}`;
      rateLimitCheck.detail = {
        ...rateLimitCheck.detail,
        detectedPostHoc: true,
        errorExcerpt: errorMessage.slice(0, 500),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

export function formatDiagnosticSummary(report: DiagnosticReport): string {
  const failed = report.checks.filter((c) => c.status === "fail");
  const errors = report.checks.filter((c) => c.status === "error");
  if (failed.length === 0 && errors.length === 0) {
    return `[diagnostics] ${report.agentId}: all checks passed (${Math.round(report.durationMs)}ms)`;
  }
  const issues = [...failed, ...errors]
    .map((c) => `${c.id}=${c.status}: ${c.message}`)
    .join("; ");
  return `[diagnostics] ${report.agentId}: ${issues} (${Math.round(report.durationMs)}ms)`;
}

// ---------------------------------------------------------------------------
// Launch helper (used by BaseCliAgent / PiAgent)
// ---------------------------------------------------------------------------

export function launchDiagnostics(
  command: string,
  env: Record<string, string>,
  cwd: string,
): Promise<DiagnosticReport> | null {
  const strategy = getDiagnosticStrategy(command);
  if (!strategy) return null;
  return runDiagnostics(strategy, { env, cwd }).catch(() => null as any);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHeaderInt(value: string | null): number | undefined {
  if (value == null) return undefined;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}
