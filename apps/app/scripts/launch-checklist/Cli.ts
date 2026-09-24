/*
 * Launch checklist (U7) — CLI surface, kept out of the script so the argument
 * contract the runbook documents is covered by tests.
 */

export interface Args {
  readonly target: string | undefined
  readonly dryRun: boolean
  readonly outDir: string | undefined
  readonly help: boolean
  /** Explicit browser binary for the headless page driver; falls back to discovery. */
  readonly browserPath: string | undefined
  /** Skip the browser entirely: browser rows report not-testable-yet with that reason. */
  readonly noBrowser: boolean
}

export const parseArgs = (argv: ReadonlyArray<string>): Args => {
  let target: string | undefined
  let dryRun = false
  let outDir: string | undefined
  let help = false
  let browserPath: string | undefined
  let noBrowser = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--target" || arg === "-t") {
      target = argv[index + 1]
      index += 1
    } else if (arg?.startsWith("--target=")) {
      target = arg.slice("--target=".length)
    } else if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--no-browser") {
      noBrowser = true
    } else if (arg === "--browser") {
      browserPath = argv[index + 1]
      index += 1
    } else if (arg?.startsWith("--browser=")) {
      browserPath = arg.slice("--browser=".length)
    } else if (arg === "--out") {
      outDir = argv[index + 1]
      index += 1
    } else if (arg?.startsWith("--out=")) {
      outDir = arg.slice("--out=".length)
    } else if (arg === "--help" || arg === "-h") {
      help = true
    }
  }
  return { target, dryRun, outDir, help, browserPath, noBrowser }
}

export const HELP = `Launch checklist runner — headless, one-command re-run of the signed-in launch checklist (§A-F).

Usage:
  pnpm run checklist -- --target <origin>    From the repo root or from apps/app.
  pnpm run checklist -- --dry-run            Enumerate every row, no network calls, no browser, no target needed.
  CHECKLIST_TARGET=<origin> pnpm run checklist

Options:
  --target, -t <origin>   Product Worker origin to check (e.g. https://canary.smithers.sh).
                          Falls back to $CHECKLIST_TARGET. Never defaults to a hardcoded origin.
  --dry-run               Enumerate the row catalog and write a report skeleton; zero network calls.
  --browser <path>        Chrome/Chromium binary for the headless page driver (else $CHECKLIST_BROWSER, else discovery).
  --no-browser            Do not launch a browser; browser-backed rows report not-testable-yet naming that.
  --out <dir>             Report directory (default: apps/reports/launch-checklist/<timestamp>).
  --help, -h              Print this message.

Auth material (never committed; all optional, missing ones report not-testable-yet):
  CHECKLIST_SESSION_COOKIE          Cookie header for a normal signed-in session (§A, §B, §C, §F, D-1, D-2, D-3).
  CHECKLIST_ZERO_BALANCE_BEARER     Cookie header for a session already parked at $0 balance (D-4).
  CHECKLIST_BILLING_UPSTREAM_URL    Billing upstream origin for the §E admin-surface rows.
  CHECKLIST_BILLING_ADMIN_TOKEN     Billing upstream admin token (§E rows E-2, E-3).
  CHECKLIST_BILLING_PRODUCT_SERVICE_TOKEN  Product Worker billing service token (E-3).
`

export const NO_TARGET_ERROR =
  "error: no target origin. Pass --target <origin>, set $CHECKLIST_TARGET, or run --dry-run to enumerate the checklist without one."

/** The report directory a run writes to, relative to apps/app (where the script runs). */
export const reportDir = (args: Args, generatedAt: string): string => {
  if (args.outDir !== undefined) return args.outDir
  const timestamp = generatedAt.replace(/[:.]/g, "-").slice(0, 19)
  return `../reports/launch-checklist/${timestamp}Z-${args.dryRun ? "dry-run" : "run"}`
}
