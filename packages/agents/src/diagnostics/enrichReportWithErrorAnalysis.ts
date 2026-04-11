import type { DiagnosticReport } from "./DiagnosticReport";

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
