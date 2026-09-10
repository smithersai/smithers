import { describe, expect, it } from "vitest"
import * as chain from "../src/index.ts"

describe("index", () => {
  it("exports every namespace", () => {
    expect(Object.keys(chain).sort()).toEqual([
      "Author",
      "AuthorDeclaration",
      "Authorize",
      "CallKey",
      "Catalog",
      "Chain",
      "Event",
      "Journal",
      "JsonBoundary",
      "MemoryEntries",
      "ModelAuthor",
      "Observation",
      "Outcome",
      "Prompt",
      "QuickJsRunner",
      "RegistryCatalog",
      "Script",
      "ScriptRunner",
      "Steering",
      "SubChains"
    ])
  })
})
