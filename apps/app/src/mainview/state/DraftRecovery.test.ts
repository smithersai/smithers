import { describe, expect, test } from "bun:test"
import type { StorageApi } from "@tanstack/db"
import {
  clearDraftRecovery,
  DRAFT_RECOVERY_STORAGE_KEY,
  readDraftRecovery,
  writeDraftRecovery
} from "./DraftRecovery"

const storage = (): StorageApi & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  }
}

describe("composer draft crash recovery", () => {
  test("round-trips a multiline or empty draft with its SQLite revision", () => {
    const host = storage()
    const raw = writeDraftRecovery(host, 7, "first line\nsecond line")
    expect(readDraftRecovery(host)).toEqual({ raw: raw!, revision: 7, draft: "first line\nsecond line" })

    const emptyRaw = writeDraftRecovery(host, 8, "")
    expect(readDraftRecovery(host)).toEqual({ raw: emptyRaw!, revision: 8, draft: "" })
  })

  test("an older commit acknowledgement cannot erase a newer edit", () => {
    const host = storage()
    const older = writeDraftRecovery(host, 1, "same text")!
    const newer = writeDraftRecovery(host, 2, "same text")!
    clearDraftRecovery(host, older)
    expect(readDraftRecovery(host)).toEqual({ raw: newer, revision: 2, draft: "same text" })
    clearDraftRecovery(host, newer)
    expect(host.values.has(DRAFT_RECOVERY_STORAGE_KEY)).toBe(false)
  })

  test("leaves malformed recovery evidence untouched", () => {
    const host = storage()
    host.setItem(DRAFT_RECOVERY_STORAGE_KEY, "not-json")
    expect(readDraftRecovery(host)).toBeUndefined()
    expect(host.getItem(DRAFT_RECOVERY_STORAGE_KEY)).toBe("not-json")
  })
})
