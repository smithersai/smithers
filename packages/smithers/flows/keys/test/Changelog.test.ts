import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

import * as Keys from "../src/index.ts"

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")
const releaseNote = changelog.slice(changelog.indexOf("## [1.0.0-rc.0]"), changelog.indexOf("## [0.1.0]"))

it("the rc.0 note does not promise the removed Key compatibility schema", () => {
  expect("Key" in Keys).toBe(false)
  expect(releaseNote).not.toMatch(/Retain `Key`/)
})

it("the rc.0 note documents the Key removal with a migration table", () => {
  expect(releaseNote).toContain("### Removed")
  expect(releaseNote).toContain("838d85c430")
  const rows = releaseNote.split("\n").map((line) => line.trim().replace(/\s+/g, " "))
  expect(rows).toContain("| `Key` | `DerivedKey` |")
  expect(rows).toContain("| `Key.derive` | `deriveKey` |")
  expect(rows).toContain("| `Key.StoredKey` | `StoredKey` |")
  expect(rows).toContain("| `Key.KeyV1` | `KeyV1` |")
})
