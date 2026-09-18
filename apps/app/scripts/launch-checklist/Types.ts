/*
 * Launch checklist (U7) — the shared vocabulary.
 *
 * The runner drives the signed-in checklist (§A-F) headlessly against an
 * explicit target origin. Two probe kinds share one context:
 *
 *  - HTTP probes call the target's client-facing seams with `ctx.fetch`.
 *  - Browser probes ask `ctx.page(cookie)` for a real headless page on the
 *    target and assert against the rendered document. The page is an
 *    interface, not a concrete driver, so the row catalog is unit-testable
 *    without launching a browser (the CDP-backed implementation lives in
 *    scripts/headless-page.ts).
 */

export type Section = "A" | "B" | "C" | "D" | "E" | "F"

export type Status = "pass" | "fail" | "not-testable-yet" | "skipped-dry-run"

/** Thrown by a page factory that has no browser to drive. Rows report not-testable-yet, never fail. */
export class BrowserUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "BrowserUnavailableError"
  }
}

/** A live headless page on the target origin, already carrying the session cookie it was opened with. */
export interface ProbePage {
  /** `document.body.innerText` as the user would read it. */
  text(signal?: AbortSignal): Promise<string>
  /**
   * Evaluate an expression and return its JSON value (or legitimate undefined).
   * Rejects on page exceptions, malformed responses, transport failure,
   * cancellation or timeout.
   */
  evaluate<T = unknown>(expression: string, signal?: AbortSignal): Promise<T>
  /** Type literal characters into the focused element with real key events. */
  type(text: string, signal?: AbortSignal): Promise<void>
  /** Press one named key ("Enter", "Escape", "Tab", "/") with real key events. */
  press(key: string, signal?: AbortSignal): Promise<void>
  /** Reload the page, as closing and reopening the browser would. */
  reload(signal?: AbortSignal): Promise<void>
}

export interface ProbeContext {
  /** The runner aborts this signal at the row deadline and when the row finishes. */
  readonly signal?: AbortSignal
  readonly target: string
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * A headless page on the target, authenticated with `cookie` (a cookie
   * header string, or undefined for a signed-out page). Pages are cached per
   * cookie for the run. Rejects with `BrowserUnavailableError` when no
   * browser can be driven.
   */
  page(cookie: string | undefined, signal?: AbortSignal): Promise<ProbePage>
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** Monotonic-enough clock, injected so probes' timing assertions are testable. */
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface ProbeResult {
  readonly status: "pass" | "fail" | "not-testable-yet"
  readonly detail: string
}

export interface ChecklistRow {
  readonly id: string
  readonly section: Section
  readonly title: string
  /** Env vars this row needs before it can run for real; missing ones report not-testable-yet. */
  readonly requiredEnv?: ReadonlyArray<string>
  /** True when the probe drives a headless page (so a run without a browser can say so precisely). */
  readonly browser?: boolean
  /**
   * The row's single lifecycle. Every row has one: a row with no probe is a row
   * this runner does not actually check. A row that must undo state left by an
   * earlier run does that inside its probe and reports one outcome.
   */
  readonly probe: (ctx: ProbeContext) => Promise<ProbeResult>
}

export interface RowResult {
  readonly id: string
  readonly section: Section
  readonly title: string
  readonly status: Status
  readonly reasons: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<string>
  readonly durationMs: number
  readonly tests: ReadonlyArray<string>
  /**
   * True when the PROBE returned not-testable-yet in a real run — the row
   * ran and still decided nothing. Missing env and a missing browser are
   * capability gaps and stay green; a probe that punted is an incomplete
   * check, and in run mode it fails the command (see exitCodeFor).
   */
  readonly undecidedInProbe?: boolean
}

export interface Totals {
  readonly pass: number
  readonly fail: number
  readonly notTestableYet: number
  /** Rows whose probe ran and still decided nothing (subset of notTestableYet). */
  readonly probeUndecided: number
  readonly skippedDryRun: number
}

export interface ChecklistReport {
  readonly generatedAt: string
  readonly mode: "dry-run" | "run"
  readonly target: string | null
  readonly totals: Totals
  readonly rows: ReadonlyArray<RowResult>
}
