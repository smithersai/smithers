import { describe, expect, it } from "vitest"
import {
  changedFileAnchorId,
  createLineRangeHandoff,
  filterChangedFiles,
  reviewShortcutAction,
  stepChangedFile,
} from "./reviewNav"
import type { ChangedFile } from "./schema"

const FILES: ReadonlyArray<ChangedFile> = [
  {
    filename: "apps/mvp/src/router.tsx",
    status: "modified",
    additions: 4,
    deletions: 1,
    patch: "@@ -1,3 +1,6 @@\n+export const workbenchRoute = true\n+const token = 1",
  },
  {
    filename: "apps/mvp/worker/Body.vibe",
    status: "added",
    additions: 12,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+export const MAX_BYTES = 65536\n+export const token = MAX_BYTES",
  },
  {
    filename: "README.md",
    status: "modified",
    additions: 1,
    deletions: 0,
  },
]

describe("pulls reviewNav", () => {
  it("filters across filenames and full patch contents including collapsed hunks", () => {
    expect(filterChangedFiles(FILES, "   ")).toHaveLength(3)

    const tokenMatches = filterChangedFiles(FILES, "TOKEN")
    expect(tokenMatches).toEqual([
      { filename: "apps/mvp/src/router.tsx", index: 0, filenameMatched: false, patchMatchCount: 1 },
      { filename: "apps/mvp/worker/Body.vibe", index: 1, filenameMatched: false, patchMatchCount: 1 },
    ])

    const readmeMatches = filterChangedFiles(FILES, "readme")
    expect(readmeMatches).toEqual([
      { filename: "README.md", index: 2, filenameMatched: true, patchMatchCount: 0 },
    ])
  })

  it("steps cleanly between files within bounds", () => {
    expect(stepChangedFile([], null, "next")).toBeNull()
    expect(stepChangedFile(FILES, null, "next")).toBe("apps/mvp/src/router.tsx")
    expect(stepChangedFile(FILES, null, "prev")).toBe("README.md")
    expect(stepChangedFile(FILES, "apps/mvp/src/router.tsx", "next")).toBe("apps/mvp/worker/Body.vibe")
    expect(stepChangedFile(FILES, "README.md", "next")).toBe("README.md")
    expect(stepChangedFile(FILES, "apps/mvp/worker/Body.vibe", "prev")).toBe("apps/mvp/src/router.tsx")
    expect(stepChangedFile(FILES, "apps/mvp/src/router.tsx", "prev")).toBe("apps/mvp/src/router.tsx")
  })

  it("resolves review keyboard shortcuts while ignoring editable targets, IME, and modifiers", () => {
    expect(reviewShortcutAction({ key: "j" })).toEqual({ type: "nextFile" })
    expect(reviewShortcutAction({ key: "k" })).toEqual({ type: "prevFile" })
    expect(reviewShortcutAction({ key: "/" })).toEqual({ type: "focusSearch" })
    expect(reviewShortcutAction({ key: "/", repeat: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", shiftKey: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", metaKey: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", ctrlKey: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", altKey: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", defaultPrevented: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", isComposing: true })).toBeNull()
    expect(reviewShortcutAction({ key: "j", targetTag: "input" })).toBeNull()
    expect(reviewShortcutAction({ key: "k", targetEditable: true })).toBeNull()
    expect(reviewShortcutAction({ key: "x" })).toBeNull()
  })

  it("builds normalized line-range handoff anchors and rejects invalid ranges", () => {
    expect(
      createLineRangeHandoff({
        comparisonId: "cmp-1",
        filename: "apps/mvp/src/router.tsx",
        startLine: 18,
        endLine: 12,
      }),
    ).toEqual({
      comparisonId: "cmp-1",
      filename: "apps/mvp/src/router.tsx",
      startLine: 12,
      endLine: 18,
      side: "new",
      promptRef: "apps/mvp/src/router.tsx:L12-L18 (new)",
    })

    expect(
      createLineRangeHandoff({
        comparisonId: "cmp-1",
        filename: "apps/mvp/worker/Body.vibe",
        startLine: 7,
        endLine: 7,
        side: "old",
      }),
    ).toEqual({
      comparisonId: "cmp-1",
      filename: "apps/mvp/worker/Body.vibe",
      startLine: 7,
      endLine: 7,
      side: "old",
      promptRef: "apps/mvp/worker/Body.vibe:L7 (old)",
    })

    expect(createLineRangeHandoff({ comparisonId: " ", filename: "a.ts", startLine: 1, endLine: 2 })).toBeNull()
    expect(createLineRangeHandoff({ comparisonId: "cmp", filename: "a.ts", startLine: 0, endLine: 2 })).toBeNull()
    expect(createLineRangeHandoff({ comparisonId: "cmp", filename: "a.ts", startLine: 1.5, endLine: 2 })).toBeNull()
  })

  it("generates stable DOM anchor IDs for changed file cards", () => {
    expect(changedFileAnchorId("apps/mvp/src/router.tsx")).toBe("diff-file-apps-mvp-src-router-tsx")
  })
})
