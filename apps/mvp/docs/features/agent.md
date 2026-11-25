# Attached agents (BYOA)

Smithers does not run a built-in browser agent. People bring their own coding agent (Claude Code, Codex, Antigravity, Cursor, or any MCP client) and connect it to a conversation through [MCP](mcp.md). [Decision 0173](../decisions/0173-byoa-only-mcp-attach-and-jev-config.md) records the cutover and retirement of the browser-side `chat/Answer` runtime and public `/api/model/*` proxy.

## How a conversation works

1. A person opens a repository or branch conversation and attaches an agent with `smthrs attach` (default local stdio MCP) or the hosted Streamable HTTP MCP attach flow.
2. The server mints an attenuated, conversation-scoped attach grant (`attach_grants`) that can read questions (`conversation_read`) and post replies (`conversation_respond`), while keeping person-only actions (approvals, merges, settings, secrets) strictly behind the person's session.
3. Server-owned workflows (such as issue triage and scheduled coding runs) invoke models exclusively through `worker/ModelSeats.ts` ([server model seats](model-endpoint.md)) and fail with a typed `NoSeat` error when no seat is configured.
4. Any request to the retired `/api/model` or `/api/model/*` paths returns `404`.
