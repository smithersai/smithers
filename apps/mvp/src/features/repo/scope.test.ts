import { expect, test } from "vitest"
import { githubList } from "./scope"

test("unsynced lists name their GitHub destination without claiming an empty or requested list", () => {
  expect(githubList("smithersai", "vibelang", "issues")).toEqual({ href: "https://github.com/smithersai/vibelang/issues", text: "Issues for this repository are on GitHub." })
  expect(githubList("smithersai", "vibelang", "pulls")).toEqual({ href: "https://github.com/smithersai/vibelang/pulls", text: "Pull requests for this repository are on GitHub." })
})
