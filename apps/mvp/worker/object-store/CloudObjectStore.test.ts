import { describe, expect, it } from "vitest"
import { handles, parseObjectsPath, r2KeyFor } from "./CloudObjectStore.vibe"

describe("CloudObjectStore routes and keys", () => {
  it("parses object store list and single-object paths safely", () => {
    expect(handles("/api/repos/smithersai/smithers/objects")).toBe(true)
    expect(handles("/api/repos/smithersai/smithers/objects/audit-report/latest.json")).toBe(true)
    expect(handles("/api/repos/smithersai/smithers/objects/audit-report/untrusted/bob/run-1.json")).toBe(true)
    expect(handles("/api/repos/smithersai/smithers/issues")).toBe(false)

    expect(parseObjectsPath("/api/repos/smithersai/smithers/objects")).toEqual({
      owner: "smithersai",
      name: "smithers",
      namespace: undefined,
      key: undefined,
    })
    expect(parseObjectsPath("/api/repos/smithersai/smithers/objects/wiki/architecture.md")).toEqual({
      owner: "smithersai",
      name: "smithers",
      namespace: "wiki",
      key: "architecture.md",
    })
    expect(parseObjectsPath("/api/repos/smithersai/smithers/objects/audit-report/untrusted/bob/latest.json")).toEqual({
      owner: "smithersai",
      name: "smithers",
      namespace: "audit-report",
      key: "untrusted/bob/latest.json",
    })
  })

  it("derives deterministic content-addressed R2 keys", () => {
    const key = r2KeyFor("github/smithersai/smithers", "audit-report", "latest.json", "a".repeat(64))
    expect(key).toBe("cloud/github/smithersai/smithers/audit-report/latest.json@aaaaaaaaaaaaaaaa")
  })
})
