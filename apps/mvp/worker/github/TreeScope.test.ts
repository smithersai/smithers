// A tree scope's route (worker/github/TreeScope.vibe): only `/api/repos/<owner>/<name>/issues/tree-scope` names a
// repository, and only when its owner and name decode to a valid GitHub repository.
import { describe, expect, test } from "vitest"
import { parseTreeScopePath } from "./TreeScope.vibe"

describe("parseTreeScopePath", () => {
  test("names the decoded owner and repository", () => {
    expect(parseTreeScopePath("/api/repos/acme/widgets/issues/tree-scope")).toEqual({ owner: "acme", name: "widgets" })
    expect(parseTreeScopePath("/api/repos/acme/my%2Ewidgets/issues/tree-scope")).toEqual({ owner: "acme", name: "my.widgets" })
  })

  test("refuses any other route", () => {
    expect(parseTreeScopePath("/api/other/acme/widgets/issues/tree-scope")).toBeUndefined()
    expect(parseTreeScopePath("/api/repos/acme/widgets/issues")).toBeUndefined()
    expect(parseTreeScopePath("/api/repos/acme/widgets/pulls/tree-scope")).toBeUndefined()
    expect(parseTreeScopePath("/api/repos/acme/widgets/issues/tree")).toBeUndefined()
  })

  test("refuses an owner or name that doesn't decode, or isn't a repository", () => {
    expect(parseTreeScopePath("/api/repos/%ZZ/widgets/issues/tree-scope")).toBeUndefined()
    expect(parseTreeScopePath("/api/repos/acme/%E0%A4%A/issues/tree-scope")).toBeUndefined()
    expect(parseTreeScopePath("/api/repos/-acme/widgets/issues/tree-scope")).toBeUndefined()
    expect(parseTreeScopePath("/api/repos/acme/wid%20gets/issues/tree-scope")).toBeUndefined()
  })
})
