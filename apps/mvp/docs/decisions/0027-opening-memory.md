# Opening memory before the agent

Status: accepted implementation of AGENT-5 and Will's 2026-10-21 correction.

Recall durable records and the saved-flow skill catalog in a sealed action before
judging. Judge the frozen candidates through the existing Jev metered ModelStep,
then pass budgeted rows through AgentAction.memory. Include conversation history
when retrieving and judging. Separately sealing retrieval prevents changed live
records from re-keying a paid judgment after a crash.

The memory SDK owns source injection and selection; the app composes it. Wiki
memory and the maintainer concept wait for the future wiki feature, which will
supply another source. The browser engine injects its SQL client and serialized
writer; no filesystem source or second database is introduced.

`app/memory/remember` records device-local facts through the same public flow catalog
the agent uses. Its host-owned bank is enforced by SDK policy handlers; sign-out
wipes the engine database. Catalog outages are visible failures after bounded
durable retries, rather than silent empty catalogs. Shortlisting reserves slots
for both memory and skill candidates so a busy bank cannot starve skills.

## Amendment, 2026-10-25: an unavailable judge opens with no memory

Memory is context, never a gate on answering. Until this amendment, a judge that couldn't answer settled the answer
failed. That was an implementation choice, not Will's words. On smithers.sh on 2026-10-25 a judge's failure ended every
question that recalled anything "Couldn't answer" before the agent ran; the agent's own model was never asked.

- **A judge that can't answer** (an outage after its durable retries, a timeout, an answer it couldn't read) opens the
  turn with no memory: the sealed opening holds no rows, `memoryDebug` counts every candidate as filtered,
  `chat.opening.skipped` logs the reading's reason (`unreachable`, `timeout`, `invalid_answer` and the like) and
  `smithers_chat_opening_skipped` counts it by reason, and the answer goes on.
- **A quota or credit refusal** (a 402, `quota_exceeded`, `out_of_credit`) is the exception: the person's agent uses the
  same key and would be refused the same way, so the opening fails `OpeningFailed({ quota: true })` after one call, and
  the answer fails at once with "Model credit or quota used up".
- **A source that can't be read** (the memory store, or a permission refusal) still settles the answer failed, as
  above.

The lead approved this change on 2026-10-25.
