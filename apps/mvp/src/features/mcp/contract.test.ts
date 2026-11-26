import { expect, test } from "vitest"
import {
  mcpPermissionsFor,
  mcpServerSlug,
  parsePublicRepoMcpPath,
  publicRepoMcpPath,
  repoMcpRoute,
} from "./contract.ts"

test("repository MCP paths encode each repository segment and parse public endpoints", () => {
  expect(repoMcpRoute("my org", "web+api")).toBe("/api/repos/my%20org/web%2Bapi/mcp")
  expect(publicRepoMcpPath("my org", "web+api")).toBe("/my%20org/web%2Bapi/mcp")
  expect(parsePublicRepoMcpPath("/my-org/web-api/mcp")).toEqual({ owner: "my-org", name: "web-api" })
})

test.each([
  "/owner/mcp",
  "host/owner/repo/mcp",
  "/owner/repo/other",
  "//repo/mcp",
  "/owner//mcp",
  "/api/repo/mcp",
  "/app/repo/mcp",
  "/assets/repo/mcp",
  "/.well-known/repo/mcp",
])("does not recognize %s as a public repository MCP endpoint", (path) => {
  expect(parsePublicRepoMcpPath(path)).toBeNull()
})

test("an empty normalized server name uses the default slug", () => {
  expect(mcpServerSlug(" ! ")).toBe("smithers")
})

test("permission disclosures follow read and write scopes", () => {
  expect(mcpPermissionsFor("maintainer", ["mcp:read"]).allowed).toEqual([
    "Read repository files, refs, issues, pull requests, and workflows",
    "Run bug validation (issue/repro), PoC, and review flows locally",
  ])
  expect(mcpPermissionsFor("member", ["mcp:write"]).allowed).toEqual([
    "Open issues and post comments attributed as your agent",
  ])
})
