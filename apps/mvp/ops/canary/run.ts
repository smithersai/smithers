import { Channels } from "@smthrs/notifications"
import { Effect } from "effect"

// Continuous production canary checks for smithers.sh (M3 release gate).
// Verifies SPA deep links return HTTP 200 with zero redirects (catching Cloudflare /index.html 308 loops),
// checks /version.json build identity, verifies all 7 example forks load, and proves unauthenticated
// private Smithers-Ops probes fail closed (401/404, never 200).
// Emits structured status/latency summaries only: never prints cookies, tokens, or response payloads.

export interface CanaryCheck {
  readonly id: string
  readonly path: string
  readonly kind: "spa_200" | "version_json" | "fail_closed"
}

export interface CanaryCheckResult {
  readonly id: string
  readonly path: string
  readonly ok: boolean
  readonly status: number | null
  readonly durationMs: number
  readonly reason?: string
}

export interface CanarySummary {
  readonly origin: string
  readonly build: string | null
  readonly ok: boolean
  readonly passed: number
  readonly failed: number
  readonly results: ReadonlyArray<CanaryCheckResult>
}

export const DEFAULT_CANARY_CHECKS: ReadonlyArray<CanaryCheck> = [
  { id: "root", path: "/", kind: "spa_200" },
  { id: "app", path: "/app", kind: "spa_200" },
  { id: "waitlist", path: "/app/waitlist", kind: "spa_200" },
  { id: "voltaire", path: "/evmts/voltaire", kind: "spa_200" },
  { id: "voltaire-workbench", path: "/evmts/voltaire/workbench", kind: "spa_200" },
  { id: "smithers", path: "/smithersai/smithers", kind: "spa_200" },
  { id: "smithers-workbench", path: "/smithersai/smithers/workbench", kind: "spa_200" },
  { id: "fork-effect", path: "/smithersai/effect", kind: "spa_200" },
  { id: "fork-alchemy", path: "/smithersai/alchemy", kind: "spa_200" },
  { id: "fork-foldkit", path: "/smithersai/foldkit", kind: "spa_200" },
  { id: "fork-t3code", path: "/smithersai/t3code", kind: "spa_200" },
  { id: "fork-opencode", path: "/smithersai/opencode", kind: "spa_200" },
  { id: "fork-needlefish", path: "/smithersai/needlefish", kind: "spa_200" },
  { id: "fork-eliza", path: "/smithersai/eliza", kind: "spa_200" },
  { id: "version", path: "/version.json", kind: "version_json" },
  { id: "ops-plan-closed", path: "/api/repos/smithersai/Smithers-Ops/plan/snapshot", kind: "fail_closed" },
  { id: "ops-artifact-closed", path: "/api/repos/smithersai/Smithers-Ops/artifacts/private-canary", kind: "fail_closed" },
]

export type CanaryFetch = (
  input: string,
  init: { readonly redirect: "manual"; readonly headers: Readonly<Record<string, string>> },
) => Promise<{ readonly status: number; readonly json: () => Promise<unknown> }>

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "")
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

/** Run every canary check against `origin` with manual redirect handling (maxRedirects: 0). */
export async function runCanary(options: {
  readonly origin: string
  readonly checks?: ReadonlyArray<CanaryCheck>
  readonly fetchImpl?: CanaryFetch
  readonly now?: () => number
}): Promise<CanarySummary> {
  const origin = normalizeOrigin(options.origin)
  const checks = options.checks ?? DEFAULT_CANARY_CHECKS
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as CanaryFetch)
  const now = options.now ?? (() => Date.now())

  let build: string | null = null
  const results: Array<CanaryCheckResult> = []

  for (const check of checks) {
    const started = now()
    const url = `${origin}${check.path}`
    try {
      const response = await fetchImpl(url, {
        redirect: "manual",
        headers: { accept: check.kind === "version_json" ? "application/json" : "text/html,application/json" },
      })
      const durationMs = Math.max(0, now() - started)
      const status = response.status

      if (check.kind === "spa_200") {
        if (status === 200) {
          results.push({ id: check.id, path: check.path, ok: true, status, durationMs })
        } else {
          results.push({
            id: check.id,
            path: check.path,
            ok: false,
            status,
            durationMs,
            reason: isRedirect(status) ? "unexpected_redirect" : "unexpected_status",
          })
        }
        continue
      }

      if (check.kind === "fail_closed") {
        if (status === 401 || status === 403 || status === 404) {
          results.push({ id: check.id, path: check.path, ok: true, status, durationMs })
        } else {
          results.push({
            id: check.id,
            path: check.path,
            ok: false,
            status,
            durationMs,
            reason: "private_route_not_closed",
          })
        }
        continue
      }

      // version_json
      if (status !== 200) {
        results.push({
          id: check.id,
          path: check.path,
          ok: false,
          status,
          durationMs,
          reason: isRedirect(status) ? "unexpected_redirect" : "unexpected_status",
        })
        continue
      }
      let parsed: unknown
      try {
        parsed = await response.json()
      // expected: invalid JSON payload on /version.json fails the canary check cleanly
      } catch {
        results.push({
          id: check.id,
          path: check.path,
          ok: false,
          status,
          durationMs,
          reason: "invalid_version_json",
        })
        continue
      }
      const rawBuild =
        parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "build")
          ? (parsed as { readonly build?: unknown }).build
          : undefined
      if (typeof rawBuild === "string" && rawBuild.trim().length > 0) {
        build = rawBuild.trim()
        results.push({ id: check.id, path: check.path, ok: true, status, durationMs })
      } else {
        results.push({
          id: check.id,
          path: check.path,
          ok: false,
          status,
          durationMs,
          reason: "missing_build_id",
        })
      }
    // expected: network error recorded cleanly as transport_error without leaking payloads
    } catch {
      const durationMs = Math.max(0, now() - started)
      results.push({
        id: check.id,
        path: check.path,
        ok: false,
        status: null,
        durationMs,
        reason: "transport_error",
      })
    }
  }

  const passed = results.filter((item) => item.ok).length
  const failed = results.length - passed
  return {
    origin,
    build,
    ok: failed === 0,
    passed,
    failed,
    results,
  }
}

/** Format a concise, secret-free alert line suitable for Telegram or email notification delivery. */
export function formatCanaryAlert(summary: CanarySummary): string {
  const buildLabel = summary.build ?? "unknown"
  if (summary.ok) {
    return `Canary healthy on ${summary.origin} (build ${buildLabel}): ${summary.passed}/${summary.results.length} passed.`
  }
  const failedItems = summary.results
    .filter((item) => !item.ok)
    .map((item) => `${item.id}=${item.status ?? "err"}(${item.reason ?? "failed"})`)
    .join(", ")
  return `Canary FAILED on ${summary.origin} (build ${buildLabel}): ${summary.failed} failed [${failedItems}].`
}

export interface CanaryAlertResult {
  readonly delivered: boolean
  readonly skippedReason?: "healthy" | "unconfigured"
  readonly errorTag?: string
}

/**
 * Deliver a canary failure alert through @smthrs/notifications Telegram channel.
 * Skips silently when the canary is healthy or when no chatId is configured.
 * Never logs or returns secret credentials.
 */
export function notifyCanaryFailure(
  summary: CanarySummary,
  chatId: string | undefined,
): Effect.Effect<CanaryAlertResult, never, Channels.Channels> {
  if (summary.ok) {
    return Effect.succeed({ delivered: false, skippedReason: "healthy" })
  }
  const target = chatId?.trim()
  if (!target) {
    return Effect.succeed({ delivered: false, skippedReason: "unconfigured" })
  }
  const message = formatCanaryAlert(summary)
  return Effect.flatMap(Channels.Channels, (channels) =>
    channels
      .send(
        { _tag: "telegram", chatId: target },
        {
          id: `canary-${summary.build ?? "unknown"}-${summary.failed}`,
          subject: `Canary failed on ${summary.origin}`,
          text: message,
        },
      )
      .pipe(
        Effect.as<CanaryAlertResult>({ delivered: true }),
        Effect.catch((error) =>
          Effect.succeed<CanaryAlertResult>({
            delivered: false,
            errorTag: error._tag,
          }),
        ),
      ),
  )
}
