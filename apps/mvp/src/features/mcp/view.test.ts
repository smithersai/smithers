import { describe, expect, test } from "vitest"
import { SIGN_IN } from "../auth/contract"
import { MCP_BLOCKED_ACTS, MCP_CLIENTS, type McpConsentDetails, type McpTokenSummary } from "./contract"
import { ALL_REPOSITORIES, CLIENT_LABEL, connectTitle, errorText, revokeLabel } from "./copy"
import { connectDialogView, consentView, repoScopeLabel, scopeLabels, searchOf, tokenRows, tokenRowView, verifiedRedirect } from "./view"

const ORIGIN = "https://smithers.sh"
const dialog = (client: (typeof MCP_CLIENTS)[number], role: Parameters<typeof connectDialogView>[4] = "maintainer", login: string | null = "roninjin10") =>
  connectDialogView(client, ORIGIN, "evmts", "voltaire", role, login)

describe("connectDialogView: each client's snippet", () => {
  test("claude: one terminal command with the repository's endpoint", () => {
    expect(dialog("claude").snippet.command).toBe("claude mcp add voltaire --transport http https://smithers.sh/evmts/voltaire/mcp")
  })

  test("Antigravity accepts its HTTP type flag before the server name and URL", () => {
    expect(dialog("agy").snippet.command).toBe("agy mcp add --type http voltaire https://smithers.sh/evmts/voltaire/mcp")
  })

  test("codex: one terminal command with --url", () => {
    expect(dialog("codex").snippet.command).toBe("codex mcp add voltaire --url https://smithers.sh/evmts/voltaire/mcp")
  })

  test("cursor: the mcp.json entry, as JSON that parses", () => {
    expect(JSON.parse(dialog("cursor").snippet.command)).toEqual({
      mcpServers: { voltaire: { url: "https://smithers.sh/evmts/voltaire/mcp" } },
    })
  })

  test("http: the endpoint, its discovery document and the auth it needs", () => {
    const { command, note } = dialog("http").snippet
    expect(command).toContain("https://smithers.sh/evmts/voltaire/mcp")
    expect(command).toContain("https://smithers.sh/.well-known/oauth-protected-resource")
    expect(command).toContain("PKCE (S256)")
    expect(note).toContain("https://smithers.sh/api/mcp")
  })

  test("stdio: login, then serve this repository", () => {
    expect(dialog("stdio").snippet.command).toBe(
      "npx @smthrs/cli mcp login --origin https://smithers.sh\nnpx @smthrs/cli mcp serve --repo evmts/voltaire",
    )
  })

  test("every client has a label, a command and a note, and a trailing slash on the origin changes nothing", () => {
    for (const client of MCP_CLIENTS) {
      const { snippet, endpoint } = connectDialogView(client, `${ORIGIN}/`, "evmts", "voltaire", "member", "roninjin10")
      expect(snippet.label).not.toBe("")
      expect(snippet.command).not.toBe("")
      expect(snippet.note).not.toBe("")
      expect(snippet.command).not.toContain("smithers.sh//")
      expect(endpoint).toBe("https://smithers.sh/evmts/voltaire/mcp")
    }
  })
})

describe("connectDialogView: what the viewer's role discloses", () => {
  test("a Maintainer's agent acts as them, may write, and never merges", () => {
    const view = dialog("claude", "maintainer")
    expect(view.actor).toBe("roninjin10 (agent)")
    expect(view.signedIn).toBe(true)
    expect(view.roleLabel).toBe("Maintainer")
    expect(view.allowed).toContain("Post live work links")
    expect(view.blocked.join("\n")).toContain("Merge pull requests")
    expect(view.blockedActs).toEqual(MCP_BLOCKED_ACTS)
  })

  test("a Member's agent may open issues, and never commits them", () => {
    const view = dialog("claude", "member")
    expect(view.roleLabel).toBe("Member")
    expect(view.allowed).toContain("Open issues and post comments attributed as your agent")
    expect(view.blocked.join("\n")).toContain("Commit TODOs")
  })

  test("an Admin is told the same person-only limits", () => {
    const view = dialog("claude", "admin")
    expect(view.roleLabel).toBe("Admin")
    expect(view.blocked).toEqual(dialog("claude", "maintainer").blocked)
  })

  test("an external Guest's agent may open issues, and may not triage or reach the stack", () => {
    const view = dialog("claude", "guest", "outsider")
    expect(view.actor).toBe("outsider (agent)")
    expect(view.roleLabel).toBe("Contributor (Guest)")
    expect(view.allowed).toContain("Open issues and comment attributed as your agent")
    expect(view.allowed.join("\n")).not.toContain("Draft TODOs")
    expect(view.blocked.join("\n")).toContain("Triage issues")
  })

  test("someone signed in with no role reads as the public does", () => {
    const view = dialog("claude", null, "stranger")
    expect(view.actor).toBe("stranger (agent)")
    expect(view.roleLabel).toBe("Public Visitor")
    expect(view.allowed.join("\n")).not.toContain("Open issues")
  })

  test("a signed-out visitor is asked to sign in and gets no role, whatever role is passed", () => {
    const view = dialog("claude", "admin", null)
    expect(view.actor).toBe(SIGN_IN)
    expect(view.signedIn).toBe(false)
    expect(view.roleLabel).toBe("Public Visitor")
    expect(view.allowed.join("\n")).not.toContain("Open issues")
    expect(view.blocked.join("\n")).toContain("Approve or merge pull requests")
  })
})

const NOW = Date.parse("2026-11-22T12:00:00.000Z")
const token = (over: Partial<McpTokenSummary> = {}): McpTokenSummary => ({
  id: "tok_1",
  clientName: "Claude Code",
  repoScope: "github/evmts/voltaire",
  scopes: ["mcp:read", "mcp:write"],
  createdAt: "2026-11-20T12:00:00.000Z",
  expiresAt: "2026-12-20T12:00:00.000Z",
  lastUsedAt: "2026-11-22T11:00:00.000Z",
  revokedAt: null,
  ...over,
})

describe("tokenRowView", () => {
  test("an active token: Active, its repository, its times, and revocable", () => {
    expect(tokenRowView(token(), NOW)).toEqual({
      id: "tok_1",
      clientName: "Claude Code",
      state: "active",
      status: "Active",
      repoScope: "evmts/voltaire",
      scopes: ["Read", "Write"],
      createdAt: Date.parse("2026-11-20T12:00:00.000Z"),
      lastUsedAt: Date.parse("2026-11-22T11:00:00.000Z"),
      expiresAt: Date.parse("2026-12-20T12:00:00.000Z"),
      canRevoke: true,
    })
  })

  test("a revoked token: Revoked, not revocable, even once it has also expired", () => {
    const view = tokenRowView(token({ revokedAt: "2026-11-21T00:00:00.000Z", expiresAt: "2026-11-21T12:00:00.000Z" }), NOW)
    expect(view.status).toBe("Revoked")
    expect(view.canRevoke).toBe(false)
  })

  test("a token past its expiry: Expired, at the very millisecond it ends", () => {
    expect(tokenRowView(token({ expiresAt: "2026-11-22T12:00:00.000Z" }), NOW).status).toBe("Expired")
    expect(tokenRowView(token({ expiresAt: "2026-11-22T12:00:00.001Z" }), NOW).status).toBe("Active")
    expect(tokenRowView(token({ expiresAt: "2026-11-22T12:00:00.000Z" }), NOW).canRevoke).toBe(false)
  })

  test("a token for every repository, never used", () => {
    const view = tokenRowView(token({ repoScope: null, lastUsedAt: null, scopes: ["mcp:read"] }), NOW)
    expect(view.repoScope).toBe(ALL_REPOSITORIES)
    expect(view.lastUsedAt).toBeNull()
    expect(view.scopes).toEqual(["Read"])
  })

  test("a time that doesn't parse has no instant, and the row still renders", () => {
    const view = tokenRowView(token({ createdAt: "not a date", expiresAt: "nor this" }), NOW)
    expect(view.createdAt).toBeNull()
    expect(view.status).toBe("Active")
  })

  test("repoScopeLabel reads a bare owner/name too", () => {
    expect(repoScopeLabel("evmts/voltaire")).toBe("evmts/voltaire")
    expect(repoScopeLabel("")).toBe(ALL_REPOSITORIES)
  })

  test("tokenRows lists active tokens first, then the newest", () => {
    const rows = tokenRows([
      token({ id: "revoked", revokedAt: "2026-11-21T00:00:00.000Z", createdAt: "2026-11-22T00:00:00.000Z" }),
      token({ id: "old", createdAt: "2026-11-01T00:00:00.000Z" }),
      token({ id: "new", createdAt: "2026-11-21T00:00:00.000Z" }),
    ], NOW)
    expect(rows.map((row) => row.id)).toEqual(["new", "old", "revoked"])
    // A time that doesn't parse sorts as the oldest, on either side of the comparison.
    const undated = tokenRows([token({ id: "undated", createdAt: "?" }), token({ id: "dated" }), token({ id: "undated-2", createdAt: "?" })], NOW)
    expect(undated.map((row) => row.id)).toEqual(["dated", "undated", "undated-2"])
    expect(tokenRows([token()]).length).toBe(1)
  })
})

const details = (over: Partial<McpConsentDetails> = {}): McpConsentDetails => ({
  clientId: "client_1",
  clientName: "Claude Code",
  redirectUri: "http://127.0.0.1:53682/callback",
  repoScope: "github/evmts/voltaire",
  scopes: ["mcp:write", "mcp:read"],
  state: "xyz",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  login: "roninjin10",
  effectiveRole: "maintainer",
  ...over,
})

describe("consentView", () => {
  test("a Maintainer: who asks, as whom, on what, and the person-only guard", () => {
    const view = consentView(details())
    expect(view.heading).toBe("Claude Code wants to connect to Smithers")
    expect(view.actor).toBe("Acting as roninjin10 (agent)")
    expect(view.repoScope).toBe("evmts/voltaire")
    expect(view.scopes).toEqual(["Read", "Write"])
    expect(view.roleLabel).toBe("Maintainer")
    expect(view.returnsTo).toBe("127.0.0.1:53682")
    expect(view.blocked.join("\n")).toContain("person-only")
    expect(view).not.toHaveProperty("lifetime")
    const writeOnly = consentView(details({ scopes: ["mcp:write"] }))
    expect(writeOnly.allowed).toEqual(["Open issues and post comments attributed as your agent", "Post live work links"])
    expect(view.summary).toBe("Claude Code · Acting as roninjin10 (agent) · evmts/voltaire · Read + Write · Maintainer")
  })

  test("a Guest on every repository, read only", () => {
    const view = consentView(details({ effectiveRole: "guest", repoScope: null, scopes: ["mcp:read"] }))
    expect(view.roleLabel).toBe("Contributor (Guest)")
    expect(view.repoScope).toBe(ALL_REPOSITORIES)
    expect(view.scopes).toEqual(["Read"])
    expect(view.blocked.join("\n")).toContain("Triage issues")
  })

  test("no role on the repository reads as the public does; a native client's callback shows its scheme", () => {
    const view = consentView(details({ effectiveRole: null, redirectUri: "cursor://anysphere.cursor-mcp/oauth/callback" }))
    expect(view.roleLabel).toBe("Public Visitor")
    expect(view.returnsTo).toBe("anysphere.cursor-mcp")
    expect(consentView(details({ redirectUri: "not a url" })).returnsTo).toBe("not a url")
    expect(consentView(details({ redirectUri: "myagent:/oauth/callback" })).returnsTo).toBe("myagent:")
  })

  test("scopeLabels says each scope once, read first", () => {
    expect(scopeLabels(["mcp:write", "mcp:read", "mcp:write"])).toEqual(["Read", "Write"])
    expect(scopeLabels([])).toEqual([])
  })
})

describe("verifiedRedirect", () => {
  const registered = "http://127.0.0.1:53682/callback"

  test("the registered callback with its code and state passes", () => {
    expect(verifiedRedirect(registered, `${registered}?code=abc&state=xyz`)).toBe(`${registered}?code=abc&state=xyz`)
  })

  test("another host, port, path or scheme is refused", () => {
    expect(verifiedRedirect(registered, "http://evil.example/callback?code=abc")).toBeUndefined()
    expect(verifiedRedirect(registered, "http://127.0.0.1:1/callback?code=abc")).toBeUndefined()
    expect(verifiedRedirect(registered, "http://127.0.0.1:53682/other?code=abc")).toBeUndefined()
    expect(verifiedRedirect(registered, "https://127.0.0.1:53682/callback?code=abc")).toBeUndefined()
  })

  test("a script URL is refused even when registered, and so is anything that isn't a URL", () => {
    expect(verifiedRedirect("javascript:alert(1)", "javascript:alert(1)")).toBeUndefined()
    expect(verifiedRedirect(registered, "/callback?code=abc")).toBeUndefined()
    expect(verifiedRedirect("nope", `${registered}?code=abc`)).toBeUndefined()
  })
})

test("searchOf keeps a query as a query and an empty one empty", () => {
  expect(searchOf("?client_id=a")).toBe("?client_id=a")
  expect(searchOf("client_id=a")).toBe("?client_id=a")
  expect(searchOf("")).toBe("")
  expect(searchOf("?")).toBe("")
})

describe("copy", () => {
  test("every client preset has its label", () => {
    expect(MCP_CLIENTS.map((client) => CLIENT_LABEL[client])).toEqual(["Claude Code", "Codex", "Antigravity (agy)", "Cursor", "Streamable HTTP", "CLI / Stdio"])
    expect(connectTitle("evmts", "voltaire")).toBe("Connect your agent to evmts/voltaire")
    expect(revokeLabel("Claude Code")).toBe("Revoke Claude Code")
  })

  test("errorText says why by code, nothing for none, and unreachable for a code it doesn't know", () => {
    expect(errorText(null)).toBe("")
    expect(errorText("authentication")).toBe("Sign in to continue.")
    expect(errorText("forbidden")).toBe(errorText("person_only"))
    expect(errorText("token_limit")).toContain("limit")
    for (const code of ["invalid_request", "invalid_client", "invalid_scope", "invalid_redirect_uri"]) {
      expect(errorText(code)).toContain("isn't valid")
    }
    expect(errorText("invalid_redirect")).toContain("return address")
    expect(errorText("not_found")).toContain("already gone")
    expect(errorText("unavailable")).toBe(errorText("anything else"))
  })
})
