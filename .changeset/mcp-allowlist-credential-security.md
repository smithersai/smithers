---
"@smthrs/mcp": patch
---

Empty MCP allowlists now project no tools: `McpFlows.mcp(client, { include: [] })`
previously exposed the entire catalog and now returns an empty source. Omit
`include` to select all tools.

Credentialed non-loopback HTTP endpoints now fail with `protocol_error` before
evaluating `authProvider.token` or sending a request. For example,
`http://mcp.example.test/mcp` with `authProvider` or `bearerTokenEnv` previously
sent the bearer token in clear text; use `https://mcp.example.test/mcp` instead.
Loopback HTTP (`localhost`, `127.0.0.0/8`, and `[::1]`) remains allowed.
