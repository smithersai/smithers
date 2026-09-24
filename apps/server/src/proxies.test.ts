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

test("coding connection proxy exposes only the account enrollment, list and revoke methods", () => {
  expect(platformProxyMatch("/api/user/provider-connections", "GET")).toBe(true)
  expect(platformProxyMatch("/api/user/provider-connections", "POST")).toBe(true)
  expect(platformProxyMatch("/api/user/provider-connections/conn-1/grants", "POST")).toBe(false)
  expect(platformProxyMatch("/api/user/provider-connections/conn-1", "DELETE")).toBe(true)
  expect(platformProxyMatch("/api/user/provider-connections/conn-1", "GET")).toBe(false)
  expect(platformProxyMatch("/api/user/provider-connections/conn-1/refresh", "POST")).toBe(false)
  expect(platformProxyMatch("/api/user/provider-connections/conn-1/grants/2", "DELETE")).toBe(false)
})

test("a prefix rule opens its family only at a path segment boundary", () => {
  for (const path of ["/api/user/repos", "/api/user/repos/", "/api/user/workspaces", "/api/user/orgs", "/api/github/import", "/api/github/import/job-1"]) {
    expect(platformProxyMatch(path, "GET")).toBe(true)
  }
  for (const path of [
    "/api/user/repos-admin",
    "/api/user/reposx/1",
    "/api/user/workspaces-internal",
    "/api/user/orgsecrets",
    "/api/user/github-repos-admin",
    "/api/github/importfoo",
    "/api/github/import-admin/1"
  ]) {
    expect(platformProxyMatch(path, "GET")).toBe(false)
  }
})
