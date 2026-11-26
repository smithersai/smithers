import type { AudienceRole, PaneSize } from "@smthrs/ui"
import {
  defaultWorkbenchLayout,
  parseWorkbenchSearch,
  type WorkbenchLayout,
} from "./layout"

// Per-conversation keyed workbench restoration (t3code UX architecture P0 #2).
// Anchors durable navigation in the URL while remembering each conversation's distinct pane state and draft
// across A -> B -> Back transitions and clamping compact viewports to a single focused pane.

export const COMPACT_VIEWPORT_PX = 768

export interface ConversationPaneSnapshot {
  readonly conversationKey: string
  readonly layout: WorkbenchLayout
  readonly draft: string
}

export type ConversationPaneStore = ReadonlyMap<string, ConversationPaneSnapshot>

/** Normalize a repository + conversation identifier into a stable map key. */
export function conversationStateKey(repoSlug: string, conversationId?: string | null): string {
  const cleanRepo = repoSlug.trim().toLowerCase()
  const cleanConv = conversationId?.trim()
  return cleanConv ? `${cleanRepo}#${cleanConv}` : cleanRepo
}

/** Save a conversation's active workbench layout and partially typed draft without mutating prior snapshots. */
export function saveConversationSnapshot(
  store: ConversationPaneStore,
  snapshot: ConversationPaneSnapshot,
): ConversationPaneStore {
  const next = new Map(store)
  next.set(snapshot.conversationKey, {
    conversationKey: snapshot.conversationKey,
    layout: { ...snapshot.layout },
    draft: snapshot.draft,
  })
  return next
}

/**
 * Restore workbench layout and draft when entering or returning to a conversation.
 * Explicit deep-link URL search params always win on reload. Otherwise the saved conversation snapshot
 * restores pane focus, frame cursor, selection, and draft for A -> B -> Back transitions.
 */
export function restoreConversationSnapshot(options: {
  readonly store: ConversationPaneStore
  readonly conversationKey: string
  readonly search: URLSearchParams | string | Record<string, unknown>
  readonly maxRole: AudienceRole
}): ConversationPaneSnapshot {
  const hasExplicitSearch = hasWorkbenchSearchKeys(options.search)
  const saved = options.store.get(options.conversationKey)
  if (hasExplicitSearch) {
    return {
      conversationKey: options.conversationKey,
      layout: parseWorkbenchSearch(options.search, options.maxRole),
      draft: saved?.draft ?? "",
    }
  }
  if (saved !== undefined) {
    return {
      conversationKey: options.conversationKey,
      layout: {
        ...saved.layout,
        audience: parseWorkbenchSearch({ audience: saved.layout.audience }, options.maxRole).audience,
      },
      draft: saved.draft,
    }
  }
  return {
    conversationKey: options.conversationKey,
    layout: defaultWorkbenchLayout(options.maxRole),
    draft: "",
  }
}

const WORKBENCH_QUERY_KEYS = ["pane", "size", "frame", "node", "cause", "audience", "diffScope"]

function hasWorkbenchSearchKeys(search: URLSearchParams | string | Record<string, unknown>): boolean {
  if (typeof search === "string") {
    const params = new URLSearchParams(search)
    return WORKBENCH_QUERY_KEYS.some((key) => params.has(key))
  }
  if (search instanceof URLSearchParams) {
    return WORKBENCH_QUERY_KEYS.some((key) => search.has(key))
  }
  return WORKBENCH_QUERY_KEYS.some((key) => Object.hasOwn(search, key) && search[key] !== undefined && search[key] !== "")
}

/**
 * Resolve the rendered pane tier for the active viewport width.
 * On compact viewports (< 768px), side-by-side layout collapses cleanly to a single full pane while
 * preserving inline collapsed state.
 */
export function effectivePaneSize(size: PaneSize, viewportWidth: number): PaneSize {
  if (Number.isFinite(viewportWidth) && viewportWidth > 0 && viewportWidth < COMPACT_VIEWPORT_PX) {
    return size === "side" ? "full" : size
  }
  return size
}
