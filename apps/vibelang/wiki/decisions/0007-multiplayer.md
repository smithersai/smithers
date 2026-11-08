# 0007. Multiplayer

**Status:** accepted, 2026-11-07. **Ruling:** VL-12 ("simplist most robust solution").

**Decision.** Multiplayer is the sequencer's event stream. Everyone in a conversation follows the same numbered
events; a post is an intent the sequencer accepts or refuses. No CRDTs, no operational transforms, no per-client
merge. A client that drops a connection replays from its last `seq`.

**Why.** One writer per conversation gives a total order for free. On Cloudflare the writer is the conversation's
Durable Object, which already serializes its requests. Presence and co-editing of documents are separate features and
are not part of this.
