// Shared approval identity and typing-focus guard (t3code UX architecture P0 #1).
// Ensures a pending approval from a run card or the queue routes to the exact same host-owned request
// without stealing focus from an active composer or losing a partially typed draft.

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

export interface FocusTargetLike {
  readonly tagName?: string
  readonly isContentEditable?: boolean
  readonly closestRunId?: string | null
}

export interface ApprovalFocusInput {
  readonly runId: string
  readonly version: number
  readonly execution: string
  readonly activeTarget: FocusTargetLike | null | undefined
  readonly force?: boolean
  readonly resolvedKeys?: ReadonlySet<string>
  readonly refusedKeys?: ReadonlySet<string>
}

export type ApprovalFocusDecision =
  | { readonly action: "focus"; readonly key: string; readonly reason: "explicit" | "idle_editor" }
  | { readonly action: "hold"; readonly key: string; readonly reason: "typing_elsewhere" }
  | { readonly action: "ignore"; readonly key: string; readonly reason: "resolved" | "refused" }

/**
 * Canonical host-owned identity for an approval or question wait.
 * Shared across conversation run cards, the review queue, and multi-tab delivery.
 */
export function approvalRequestKey(runId: string, version: number, execution: string): string {
  return `${runId}@v${version}:${execution}`
}

/**
 * Returns true when focus is currently inside an editable element belonging to a different surface
 * (such as the chat composer or another run card).
 */
export function isTypingOutsideApproval(
  target: FocusTargetLike | null | undefined,
  runId: string,
): boolean {
  if (target === null || target === undefined) return false
  const tag = target.tagName?.toUpperCase()
  const editable = target.isContentEditable === true || (tag !== undefined && EDITABLE_TAGS.has(tag))
  if (!editable) return false
  return target.closestRunId !== runId
}

/**
 * Decide whether an incoming or clicked approval request should focus its card, hold while the person
 * finishes typing, or ignore because it was already resolved or refused.
 */
export function resolveApprovalFocus(input: ApprovalFocusInput): ApprovalFocusDecision {
  const key = approvalRequestKey(input.runId, input.version, input.execution)
  if (input.resolvedKeys?.has(key)) {
    return { action: "ignore", key, reason: "resolved" }
  }
  if (input.refusedKeys?.has(key)) {
    return { action: "ignore", key, reason: "refused" }
  }
  if (input.force === true) {
    return { action: "focus", key, reason: "explicit" }
  }
  if (isTypingOutsideApproval(input.activeTarget, input.runId)) {
    return { action: "hold", key, reason: "typing_elsewhere" }
  }
  return { action: "focus", key, reason: "idle_editor" }
}

export interface ActiveElementLike {
  readonly tagName: string
  readonly isContentEditable?: boolean
  readonly closest?: (selector: string) => { readonly getAttribute: (name: string) => string | null } | null
}

/** Extract a minimal focus descriptor from an active element, or null when none is focused. */
export function focusTargetFromElement(active: ActiveElementLike | null | undefined): FocusTargetLike | null {
  if (active === null || active === undefined) return null
  const host = active.closest?.("[data-run]") ?? null
  return {
    tagName: active.tagName,
    isContentEditable: active.isContentEditable === true,
    closestRunId: host === null ? null : host.getAttribute("data-run"),
  }
}

/** Read a minimal DOM focus descriptor when running in a browser, or null in headless environments. */
export function readDocumentFocusTarget(): FocusTargetLike | null {
  return focusTargetFromElement(
    (globalThis as { readonly document?: { readonly activeElement?: ActiveElementLike | null } }).document?.activeElement,
  )
}
