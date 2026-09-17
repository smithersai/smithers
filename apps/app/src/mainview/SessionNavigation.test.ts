import { expect, test } from "bun:test"
import { modeShortcut } from "./SessionNavigation"

const key = (fields: Record<string, unknown> = {}) => ({ key: "w", ...fields }) as unknown as KeyboardEvent

test("Mode uses bare M, preserves editing, and never uses the old direct dictation chord", () => {
  expect(modeShortcut(key({ key: "m" }))).toBe(true)
  expect(modeShortcut(key({ key: "M" }))).toBe(true)
  expect(modeShortcut(key({ key: "d", metaKey: true }))).toBe(false)
  for (const field of ["repeat", "isComposing", "metaKey", "ctrlKey", "altKey", "shiftKey"]) expect(modeShortcut(key({ key: "m", [field]: true }))).toBe(false)
  expect(modeShortcut(key({ key: "m", target: { closest: () => ({}) } }))).toBe(false)
})
