import { describe, expect, it } from "vitest"
import {
  COMPACT_VIEWPORT_PX,
  conversationStateKey,
  effectivePaneSize,
  restoreConversationSnapshot,
  saveConversationSnapshot,
  type ConversationPaneStore,
} from "./conversationState"
import { defaultWorkbenchLayout } from "./layout"

describe("workbench conversationState", () => {
  it("normalizes conversation keys cleanly", () => {
    expect(conversationStateKey("Evmts/Voltaire", "conv-a")).toBe("evmts/voltaire#conv-a")
    expect(conversationStateKey("Evmts/Voltaire")).toBe("evmts/voltaire")
    expect(conversationStateKey("Evmts/Voltaire", "   ")).toBe("evmts/voltaire")
  })

  it("preserves distinct pane states and drafts across A -> B -> Back transitions", () => {
    let store: ConversationPaneStore = new Map()
    const keyA = conversationStateKey("evmts/voltaire", "conv-a")
    const keyB = conversationStateKey("evmts/voltaire", "conv-b")

    store = saveConversationSnapshot(store, {
      conversationKey: keyA,
      layout: {
        pane: "diff",
        size: "side",
        frame: 4,
        selectedId: "M1.1",
        audience: "maintainer",
        diffScope: "branch",
      },
      draft: "Draft for conversation A",
    })

    store = saveConversationSnapshot(store, {
      conversationKey: keyB,
      layout: {
        pane: "attach",
        size: "full",
        frame: "live",
        audience: "contributor",
        diffScope: "turn",
      },
      draft: "Draft for conversation B",
    })

    // Return to A with empty search params -> restores A's pane, frame, selection, and draft.
    const restoredA = restoreConversationSnapshot({
      store,
      conversationKey: keyA,
      search: {},
      maxRole: "maintainer",
    })
    expect(restoredA.layout).toEqual({
      pane: "diff",
      size: "side",
      frame: 4,
      selectedId: "M1.1",
      audience: "maintainer",
      diffScope: "branch",
    })
    expect(restoredA.draft).toBe("Draft for conversation A")

    // Audience clamps strictly downward if role was lowered to visitor.
    const clampedA = restoreConversationSnapshot({
      store,
      conversationKey: keyA,
      search: "",
      maxRole: "visitor",
    })
    expect(clampedA.layout.audience).toBe("visitor")
  })

  it("lets explicit deep-link URL search params win on reload while preserving saved draft", () => {
    const keyA = conversationStateKey("evmts/voltaire", "conv-a")
    const store = saveConversationSnapshot(new Map(), {
      conversationKey: keyA,
      layout: defaultWorkbenchLayout("maintainer"),
      draft: "Unsent note",
    })

    const fromString = restoreConversationSnapshot({
      store,
      conversationKey: keyA,
      search: "?pane=state-machine&size=full&frame=2",
      maxRole: "maintainer",
    })
    expect(fromString.layout.pane).toBe("state-machine")
    expect(fromString.layout.size).toBe("full")
    expect(fromString.layout.frame).toBe(2)
    expect(fromString.draft).toBe("Unsent note")

    const fromParams = restoreConversationSnapshot({
      store,
      conversationKey: keyA,
      search: new URLSearchParams("pane=workflow&size=side"),
      maxRole: "maintainer",
    })
    expect(fromParams.layout.pane).toBe("workflow")
    expect(fromParams.layout.size).toBe("side")

    const fromRecord = restoreConversationSnapshot({
      store: new Map(),
      conversationKey: "evmts/voltaire#fresh",
      search: { pane: "waitlist" },
      maxRole: "visitor",
    })
    expect(fromRecord.layout.pane).toBe("waitlist")
    expect(fromRecord.draft).toBe("")
  })

  it("returns clean default layout for unseen conversations", () => {
    const restored = restoreConversationSnapshot({
      store: new Map(),
      conversationKey: "evmts/voltaire#unseen",
      search: new URLSearchParams(),
      maxRole: "visitor",
    })
    expect(restored).toEqual({
      conversationKey: "evmts/voltaire#unseen",
      layout: defaultWorkbenchLayout("visitor"),
      draft: "",
    })
  })

  it("clamps compact viewports to a single visible pane while preserving inline and wide layouts", () => {
    expect(effectivePaneSize("side", COMPACT_VIEWPORT_PX - 1)).toBe("full")
    expect(effectivePaneSize("inline", 390)).toBe("inline")
    expect(effectivePaneSize("full", 390)).toBe("full")
    expect(effectivePaneSize("side", COMPACT_VIEWPORT_PX)).toBe("side")
    expect(effectivePaneSize("side", 1440)).toBe("side")
    expect(effectivePaneSize("side", 0)).toBe("side")
  })
})
