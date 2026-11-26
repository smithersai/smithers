import type { AudienceRole, PaneSize } from "@smthrs/ui"

export type WorkbenchPaneId =
  | "plan"
  | "attach"
  | "workflow"
  | "state-machine"
  | "diff"
  | "waitlist"

export type DiffScope = "turn" | "branch" | "all"

export type WorkbenchLayout = {
  readonly pane: WorkbenchPaneId
  readonly size: PaneSize
  readonly frame: number | "live"
  readonly selectedId?: string
  readonly causeRef?: string
  readonly audience: AudienceRole
  readonly diffScope: DiffScope
}

export type WorkbenchAction =
  | { readonly type: "openPane"; readonly pane: WorkbenchPaneId; readonly size?: PaneSize }
  | { readonly type: "inspect" }
  | { readonly type: "maximize" }
  | { readonly type: "restore" }
  | { readonly type: "close" }
  | { readonly type: "seek"; readonly frame: number; readonly totalFrames: number }
  | { readonly type: "stepBack"; readonly totalFrames: number }
  | { readonly type: "stepForward"; readonly totalFrames: number }
  | { readonly type: "returnLive" }
  | { readonly type: "selectNode"; readonly id: string | undefined }
  | { readonly type: "revealCause"; readonly causeRef: string | undefined }
  | { readonly type: "setAudience"; readonly role: AudienceRole; readonly maxRole: AudienceRole }
  | { readonly type: "setDiffScope"; readonly scope: DiffScope }

const VALID_PANES: ReadonlySet<string> = new Set([
  "plan",
  "attach",
  "workflow",
  "state-machine",
  "diff",
  "waitlist",
])

const VALID_SIZES: ReadonlySet<string> = new Set(["inline", "side", "full"])

const VALID_DIFF_SCOPES: ReadonlySet<string> = new Set(["turn", "branch", "all"])

const ROLE_RANK: Record<AudienceRole, number> = {
  maintainer: 0,
  contributor: 1,
  visitor: 2,
}

const RANK_ROLE: ReadonlyArray<AudienceRole> = ["maintainer", "contributor", "visitor"]

function isValidFrame(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validTotalFrames(totalFrames: number): number {
  return Number.isSafeInteger(totalFrames) && totalFrames > 0 ? totalFrames : 0
}

/**
 * Clamp an audience view role strictly downward relative to the caller's maxRole.
 * A visitor can never view as contributor or maintainer. Display lens only.
 */
export function clampAudienceRole(requested: string | undefined, maxRole: AudienceRole): AudienceRole {
  const maxRank = ROLE_RANK[maxRole]
  if (requested === "maintainer" || requested === "contributor" || requested === "visitor") {
    const reqRank = ROLE_RANK[requested]
    return RANK_ROLE[Math.max(maxRank, reqRank)]!
  }
  return maxRole
}

export function defaultWorkbenchLayout(maxRole: AudienceRole = "visitor"): WorkbenchLayout {
  return {
    pane: "plan",
    size: "inline",
    frame: "live",
    audience: maxRole,
    diffScope: "turn",
  }
}

/**
 * Parse URL search parameters into a sanitized WorkbenchLayout.
 * Invalid values fall back cleanly to safe defaults, record lookups check own properties,
 * and audience clamps strictly downward.
 */
export function parseWorkbenchSearch(
  search: URLSearchParams | string | Record<string, unknown>,
  maxRole: AudienceRole = "visitor",
): WorkbenchLayout {
  const get = (key: string): string | undefined => {
    if (typeof search === "string") {
      return new URLSearchParams(search).get(key) ?? undefined
    }
    if (search instanceof URLSearchParams) {
      return search.get(key) ?? undefined
    }
    if (!Object.hasOwn(search, key)) return undefined
    const raw = search[key]
    return typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : undefined
  }

  const rawPane = get("pane")
  const pane: WorkbenchPaneId = rawPane && VALID_PANES.has(rawPane) ? (rawPane as WorkbenchPaneId) : "plan"

  const rawSize = get("size")
  const size: PaneSize = rawSize && VALID_SIZES.has(rawSize) ? (rawSize as PaneSize) : "inline"

  const rawFrame = get("frame")
  let frame: number | "live" = "live"
  if (rawFrame !== undefined && rawFrame !== "live" && /^[0-9]+$/.test(rawFrame)) {
    const parsed = Number.parseInt(rawFrame, 10)
    if (isValidFrame(parsed)) {
      frame = parsed
    }
  }

  const rawNode = get("node")?.trim()
  const selectedId = rawNode && rawNode.length > 0 ? rawNode : undefined

  const rawCause = get("cause")?.trim()
  const causeRef = rawCause && rawCause.length > 0 ? rawCause : undefined

  const audience = clampAudienceRole(get("audience"), maxRole)

  const rawDiffScope = get("diffScope")
  const diffScope: DiffScope =
    rawDiffScope && VALID_DIFF_SCOPES.has(rawDiffScope) ? (rawDiffScope as DiffScope) : "turn"

  return {
    pane,
    size,
    frame,
    ...(selectedId !== undefined ? { selectedId } : {}),
    ...(causeRef !== undefined ? { causeRef } : {}),
    audience,
    diffScope,
  }
}

/**
 * Serialize WorkbenchLayout into minimal canonical URLSearchParams (omitting defaults and invalid frames).
 */
export function serializeWorkbenchSearch(
  layout: WorkbenchLayout,
  maxRole: AudienceRole = "visitor",
): URLSearchParams {
  const params = new URLSearchParams()
  if (layout.pane !== "plan") params.set("pane", layout.pane)
  if (layout.size !== "inline") params.set("size", layout.size)
  if (layout.frame !== "live" && isValidFrame(layout.frame)) {
    params.set("frame", String(layout.frame))
  }
  if (layout.selectedId) params.set("node", layout.selectedId)
  if (layout.causeRef) params.set("cause", layout.causeRef)
  const clampedAudience = clampAudienceRole(layout.audience, maxRole)
  if (clampedAudience !== maxRole) params.set("audience", clampedAudience)
  if (layout.diffScope !== "turn") params.set("diffScope", layout.diffScope)
  return params
}

/**
 * Pure reducer governing progressive-disclosure pane tiers (inline -> side -> full),
 * replay frame cursor, selection, causal trace focus, and downward audience lens.
 */
export function reduceWorkbenchLayout(state: WorkbenchLayout, action: WorkbenchAction): WorkbenchLayout {
  switch (action.type) {
    case "openPane":
      return {
        ...state,
        pane: action.pane,
        size: action.size ?? (state.size === "inline" ? "side" : state.size),
      }
    case "inspect":
      return state.size === "inline" ? { ...state, size: "side" } : state
    case "maximize":
      return { ...state, size: "full" }
    case "restore":
      return state.size === "full" ? { ...state, size: "side" } : state
    case "close":
      return { ...state, size: "inline" }
    case "seek": {
      const total = validTotalFrames(action.totalFrames)
      if (total === 0) return { ...state, frame: "live" }
      if (!Number.isFinite(action.frame)) return state
      const maxFrame = total - 1
      const clamped = Math.min(Math.max(0, Math.trunc(action.frame)), maxFrame)
      return { ...state, frame: clamped }
    }
    case "stepBack": {
      const total = validTotalFrames(action.totalFrames)
      if (total === 0) return { ...state, frame: "live" }
      const maxFrame = total - 1
      const current =
        state.frame === "live" || !isValidFrame(state.frame)
          ? maxFrame
          : Math.min(state.frame, maxFrame)
      return { ...state, frame: Math.max(0, current - 1) }
    }
    case "stepForward": {
      const total = validTotalFrames(action.totalFrames)
      if (total === 0) return { ...state, frame: "live" }
      const maxFrame = total - 1
      if (state.frame === "live" || !isValidFrame(state.frame)) return { ...state, frame: "live" }
      const current = Math.min(state.frame, maxFrame)
      return current >= maxFrame ? { ...state, frame: "live" } : { ...state, frame: current + 1 }
    }
    case "returnLive":
      return { ...state, frame: "live" }
    case "selectNode": {
      const next = { ...state }
      if (action.id) {
        return { ...next, selectedId: action.id }
      }
      const { selectedId: _removed, ...rest } = next
      return rest
    }
    case "revealCause": {
      const next = { ...state, size: state.size === "inline" ? ("side" as const) : state.size }
      if (action.causeRef) {
        return { ...next, causeRef: action.causeRef }
      }
      const { causeRef: _removed, ...rest } = next
      return rest
    }
    case "setAudience":
      return {
        ...state,
        audience: clampAudienceRole(action.role, action.maxRole),
      }
    case "setDiffScope":
      return {
        ...state,
        diffScope: action.scope,
      }
  }
}

export type WorkbenchKeyEventLike = {
  readonly key: string
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  readonly repeat?: boolean
  readonly defaultPrevented?: boolean
  readonly isComposing?: boolean
  readonly targetTag?: string
  readonly targetEditable?: boolean
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])
const PANE_BY_DIGIT: ReadonlyArray<WorkbenchPaneId> = [
  "plan",
  "attach",
  "workflow",
  "state-machine",
  "diff",
  "waitlist",
]

/**
 * Resolve a keyboard chord in the workbench following strict shortcut precedence:
 * ignores already-handled events, IME composition, modified shortcuts, repeats on pane switches,
 * and editable inputs.
 */
export function workbenchShortcutAction(
  event: WorkbenchKeyEventLike,
  layout: WorkbenchLayout,
  totalFrames: number,
): WorkbenchAction | null {
  if (event.defaultPrevented || event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (event.targetEditable || (event.targetTag !== undefined && EDITABLE_TAGS.has(event.targetTag.toUpperCase()))) {
    return null
  }
  if (event.key === "Escape") {
    if (event.repeat) return null
    if (layout.size === "full") return { type: "restore" }
    if (layout.size === "side") return { type: "close" }
    return null
  }
  if (event.key === "[") {
    return { type: "stepBack", totalFrames }
  }
  if (event.key === "]") {
    return { type: "stepForward", totalFrames }
  }
  if (event.key === "0" && !event.repeat && layout.frame !== "live") {
    return { type: "returnLive" }
  }
  if (!event.repeat && !event.shiftKey && /^[1-6]$/.test(event.key)) {
    const pane = PANE_BY_DIGIT[Number.parseInt(event.key, 10) - 1]
    if (pane !== undefined && pane !== layout.pane) {
      return { type: "openPane", pane }
    }
  }
  return null
}
