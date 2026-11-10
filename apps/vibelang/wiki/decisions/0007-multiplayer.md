# 0007. Multiplayer

**Status:** accepted, 2026-11-07. **Ruling:** VL-12 ("simplist most robust solution").

**Decision.** Multiplayer is the sequencer's event stream. Everyone in a conversation follows the same numbered
events; a post is an intent the sequencer accepts or refuses. No CRDTs, no operational transforms, no per-client
merge. A client that drops a connection replays from its last `seq`.

**Why.** One writer per conversation gives a total order for free. On Cloudflare the writer is the conversation's
Durable Object, which already serializes its requests. Presence and co-editing of documents are separate features and
are not part of this.

**The page joins at start (2026-11-08, VL-26).** A tab follows its conversation from the moment it starts, not from
its first post, so a person sees everyone's posts as they arrive, the agent's through the CLI or MCP server included.
Before, a tab that had not posted saw nothing, then the whole history at its first post. Receipts:
`test/dogfood.runtime.test.vibe` (the real app and the Factory commands on one mock Factory) and the opt-in
`e2e/live.spec.ts` case that runs the emitted CLI beside a browser page on the live backend.
