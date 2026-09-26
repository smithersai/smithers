import { describe, expect, test } from "bun:test"
import { deepLinkPath } from "./DeepLink"

describe("deepLinkPath", () => {
  test("smithers://open/<owner>/<repo> opens that repository page", () => {
    expect(deepLinkPath("smithers://open/smithersai/smithers")).toBe("/smithersai/smithers")
    expect(deepLinkPath("smithers://open/Some-Owner/repo_name.js")).toBe("/Some-Owner/repo_name.js")
  })

  test("every other shape is refused", () => {
    for (const url of [
      "",
      "not a url",
      "smithers://x",
      "smithers://open",
      "smithers://open/",
      "smithers://open/owner",
      "smithers://open/owner/",
      "smithers://open/owner/repo/",
      "smithers://open/owner/repo/extra",
      "smithers://open//repo",
      "smithers://open/owner/repo?next=/evil",
      "smithers://open/owner/repo?",
      "smithers://open/owner/repo#frag",
      "smithers://open/owner/repo#",
      "smithers://user:pass@open/owner/repo",
      "smithers://open:8080/owner/repo",
      "smithers://open/owner%2Fx/repo",
      "smithers://open/../repo",
      "smithers://open/owner/..",
      "smithers://open/./repo",
      "smithers://open/own er/repo",
      "smithers://open/api/user",
      "smithers://open/API/user",
      "smithers://run/owner/repo",
      "smithers:open/owner/repo",
      "https://open/owner/repo",
      "javascript:alert(1)",
      "file:///etc/passwd"
    ]) expect({ url, path: deepLinkPath(url) }).toEqual({ url, path: null })
  })
})
