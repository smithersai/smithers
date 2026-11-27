import { describe, expect, it } from "vitest"
import {
  buildSnippets,
  clampTtlSeconds,
  generateMcpBearerToken,
  generateOneTimeToken,
  handles,
  isOneTimePurpose,
  isValidOneTimeToken,
  normalizeScopes,
  parseMintPath,
} from "./OneTimeAuth.vibe"

describe("OneTimeAuth pure helpers", () => {
  it("generates cryptographically formatted one-time and bearer tokens", () => {
    const oneTime = generateOneTimeToken()
    const bearer = generateMcpBearerToken()
    expect(isValidOneTimeToken(oneTime)).toBe(true)
    expect(oneTime.startsWith("smot_")).toBe(true)
    expect(oneTime.length).toBe(69)
    expect(bearer.startsWith("sma_")).toBe(true)
    expect(bearer.length).toBe(68)
    expect(isValidOneTimeToken(bearer)).toBe(false)
    expect(isValidOneTimeToken("smot_short")).toBe(false)
    expect(isValidOneTimeToken("smot_" + "G".repeat(64))).toBe(false)
  })

  it("clamps TTL bounds and normalizes scopes safely", () => {
    expect(clampTtlSeconds(undefined)).toBe(300)
    expect(clampTtlSeconds(NaN)).toBe(300)
    expect(clampTtlSeconds(5)).toBe(60)
    expect(clampTtlSeconds(5000)).toBe(900)
    expect(clampTtlSeconds(420.9)).toBe(420)
    expect(normalizeScopes(undefined)).toEqual(["mcp:read", "mcp:write"])
    expect(normalizeScopes([])).toEqual(["mcp:read", "mcp:write"])
    expect(normalizeScopes(["mcp:read", "mcp:read", "admin:all"])).toEqual(["mcp:read"])
    expect(normalizeScopes(["invalid"])).toEqual(["mcp:read"])
    expect(isOneTimePurpose("sandbox")).toBe(true)
    expect(isOneTimePurpose("agent")).toBe(true)
    expect(isOneTimePurpose("ci")).toBe(true)
    expect(isOneTimePurpose("root")).toBe(false)
  })

  it("matches mint and redeem routes and formats snippets cleanly", () => {
    expect(handles("/api/auth/one-time/redeem")).toBe(true)
    expect(handles("/api/repos/smithersai/smithers/auth/one-time")).toBe(true)
    expect(handles("/api/repos/smithersai/smithers/other")).toBe(false)
    expect(parseMintPath("/api/repos/smithersai/smithers/auth/one-time")).toEqual({
      owner: "smithersai",
      name: "smithers",
    })
    expect(parseMintPath("/api/repos/../bad/auth/one-time")).toBeUndefined()

    const snippets = buildSnippets({
      origin: "https://smithers.sh/",
      owner: "smithersai",
      name: "smithers",
      oneTimeToken: "smot_" + "a".repeat(64),
      purpose: "sandbox",
    })
    expect(snippets.redeemUrl).toBe("https://smithers.sh/api/auth/one-time/redeem")
    expect(snippets.mcpUrl).toBe("https://smithers.sh/smithersai/smithers/mcp")
    expect(snippets.shellSnippet).toContain("SMITHERS_ONE_TIME_TOKEN=")
    expect(snippets.shellSnippet).toContain("unset SMITHERS_ONE_TIME_TOKEN")
    expect(snippets.mcpSnippet).toContain("Authorization: Bearer $SMITHERS_MCP_TOKEN")
  })
})
