# 0173: Agents attach over MCP only, and Jev configs cannot pass silently

Date: 2026-11-24. Status: accepted (Gate 4, approved by Will 2026-11-24, recommended options 1A and 2A).

## Context

The built-in browser agent runs on Smithers' budget through a public `POST /api/model/<role>` proxy and competes with
any agent the person brings. POC-3 inventoried all 2,176 tracked files in `apps/mvp`: removing the browser agent
deletes 33 files (5,141 lines), refactors 317 and keeps 1,826. No attach endpoint exists today.

## Decision

1. The person's own agent (Claude Code, Codex, Antigravity, Cursor) is the only chat agent. It connects over MCP only:
   stdio through a local `smthrs` node, or Streamable HTTP at `/mcp`. There is no fallback transport.
2. The copied attach prompt holds an opaque reference such as `K7QF-2MXD`. It is single use, lives 10 minutes and
   confers nothing if leaked. The agent claims it with an RFC 7636 S256 challenge and gets back only an opaque claim
   receipt and a six-digit pairing code. It learns no repository, branch or conversation. The minting person opens a
   consent view that expires after 2 minutes, then approves that claim by its id and the pairing code their agent
   shows. A claim is approved at most once, even by concurrent approvals, and yields one code and one grant. Only the
   claimant's 43 to 128 character verifier redeems the code, which dies with its reference.
3. Minting, consent, approval and revocation need the person's own session on the host origin. A session carrying
   `act` is refused `person_only`, and the Origin is read from the request itself. The ceiling is the requested
   capabilities the person holds on the target, checked at mint, at approval and on every MCP request.
4. The token is bound to one person, repository, branch and conversation, carries that ceiling and `act: "agent"`,
   and is checked on every MCP request. Every tool declares its policy. A `person_only` tool is absent from
   `tools/list` and refused on `tools/call`. A call's arguments decode strictly against the tool's schema, the
   tool's `authorize` approves any nested resource they name, and the tool runs with its own frozen copy of the
   grant. `tools/list` advertises the JSON Schema derived from that same schema. The grant is verified after the body
   is read, so revocation takes effect at the next request, including one still uploading.
5. A request body is read as a stream and refused past `MCP_MAX_REQUEST_BYTES` before JSON parsing. Expired
   references, claims, codes, tokens and revocations are swept by expiry, not insertion order, and each store has a
   cap that concurrent requests cannot pass.
6. The attach prompt defaults to the local node over stdio for a local checkout, with a one-click switch to remote
   Streamable HTTP.
7. A server-side todo run without a maintainer or personal seat returns a typed `NoSeat`. The deployment-paid fallback
   from `coding` to `agent` goes away.
8. `Jev.config` requires `onUnsure` and `onFailure` on every decision, and neither accepts `pass`. A judge runs only
   where a decision lists it, on a seat the config declares. Consequential verdicts run on the maintainer's seat, never
   on a contributor's agent. Decoding is strict: an unknown or misspelled key refuses the whole config, and
   `Jev.config` runs the same decoder at run time. A repository path holds no `..` segment, and `resolveRepoPath`
   keeps the resolved file, symlinks followed, under the pinned checkout.

## Today

| Part                                   | State                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Attach intent, consent, grant, revoke  | Built in memory: `worker/attach/Attach.ts`. Not yet stored durably or routed. No adapter yet supplies `Sessions` actors or repository permissions. |
| `/mcp` Streamable HTTP handler         | Built: `worker/attach/McpRoute.ts`, with no tools registered and no route mounted yet. |
| `Jev.config` validator                 | Built: `src/features/jev/config.ts`, compile time and run time. No executor calls `resolveRepoPath` yet. |
| Browser agent removal                  | Not built.                                                                              |
| Local `smthrs --mcp` over stdio        | Not built.                                                                              |

## Rejected

- The browser agent behind a feature flag: it keeps the public model proxy and a second chat writer.
- A WebSocket or REST fallback beside MCP: it duplicates auth and attenuation.
- A bearer token in the copied prompt: prompts enter model providers and transcripts.
- A silent model fallback or silent pass in Jev: an outage could approve pull requests.
- Deleting all of `worker/ModelEndpoint.ts`: server-side Triage, TodoAgent and Checks need it. Only the public
  dispatcher goes.
