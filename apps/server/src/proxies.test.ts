import { expect, test } from "bun:test"
import { platformProxyMatch } from "./proxies"

test("the bare GitHub inventory read is allowlisted for GET only", () => {
  // RepositoriesSeam.rankTutorialRepositories reads /api/user/github-repos with no trailing slash.
  expect(platformProxyMatch("/api/user/github-repos", "GET")).toBe(true)
  expect(platformProxyMatch("/api/user/github-repos/o/r/issues", "GET")).toBe(true)
  expect(platformProxyMatch("/api/user/github-repos", "POST")).toBe(false)
})
