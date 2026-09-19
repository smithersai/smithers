import { expect, test } from "bun:test"
import { platformProxyMatch } from "./proxies"

test("the bare GitHub inventory read is allowlisted for GET only", () => {
  // RepositoriesSeam.rankTutorialRepositories reads /api/user/github-repos with no trailing slash.
  expect(platformProxyMatch("/api/user/github-repos", "GET")).toBe(true)
  expect(platformProxyMatch("/api/user/github-repos/o/r/issues", "GET")).toBe(true)
  expect(platformProxyMatch("/api/user/github-repos", "POST")).toBe(false)
})

test("only billing overview and catalog GETs join the platform proxy", () => {
  for (const path of ["/api/billing", "/api/billing/plans"]) {
    expect(platformProxyMatch(path, "GET")).toBe(true)
    expect(platformProxyMatch(path, "POST")).toBe(false)
  }
  expect(platformProxyMatch("/api/billing/balance", "GET")).toBe(false)
})
