import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import { clearWikiRecovery, readWikiRecovery, WIKI_RECOVERY_STORAGE_KEY, writeWikiRecovery } from "./WikiRecovery"

const storage = (): StorageApi & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: key => void values.delete(key)
  }
}

const document = (body: string) => ({
  id: "world-home", path: "World.md", title: "World", body, links: [], tags: [],
  sources: ["user:world-editor"], confidence: 1
})

describe("Wiki edit crash recovery", () => {
  test("round-trips the exact authoritative document input and revision", () => {
    const host = storage()
    const raw = writeWikiRecovery(host, 7, document("# World\n\nimmediate"))!
    expect(readWikiRecovery(host)).toEqual({ raw, revision: 7, document: document("# World\n\nimmediate") })
  })

  test("an older acknowledgement cannot erase a newer edit", () => {
    const host = storage()
    const older = writeWikiRecovery(host, 7, document("older"))!
    const newer = writeWikiRecovery(host, 8, document("newer"))!
    clearWikiRecovery(host, older)
    expect(readWikiRecovery(host)?.document.body).toBe("newer")
    clearWikiRecovery(host, newer)
    expect(host.values.has(WIKI_RECOVERY_STORAGE_KEY)).toBe(false)
  })
})
