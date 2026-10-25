# Opening memory

## Previous behavior

`@smthrs/agent`'s `Memory.ts` and `internal/memory/wiki.ts` still contain the old implementation. It read catalog documents from `.smithers/coding-project.json`, `.agents/skills/*/SKILL.md`, imported `.flows/wiki/deps` documentation and `.smithers/wiki/decisions`. It shortlisted 30 wiki candidates by keyword, asked Jev `memory/needed`, walked README-guided directories, and read touched commits and remembered facts. Seeds bypassed judgment. It packed a 16 KiB opening snapshot; later calls appended context without rewriting the cache prefix. `Relevance.ts` withheld memories and catalog skills only at 90% confidence of being unnecessary, retaining uncertain and truncated items. SQL-backed `@smthrs/memory` supplied keyword/FTS/semantic recall and namespace enforcement. The old filesystem composition cannot run in a browser.

## Browser port

Implementation and executed validation receipts are recorded below as the port progresses.

`chat/Answer` now seals `chat/Opening` between `chat/LoadTurn` and
`chat/Respond`. The host composes the catalog's `@smthrs/memory` entry
(`Opening`, `MemoryStore`, `RecallKeyword`) with the existing Jev
`Relevance.judge`. Jev runs as `chat/Opening/model`, a sealed `ModelStep`
through `/api/model/judge`, one call per question that recalls anything. A
refusal no wait clears (a provider's 402 for credit, or a quota with no reset)
is the step's answer on its first attempt; on smithers.sh on 2026-10-25 each
question asked such a provider six times. The SQL store and serialized writer come from the
engine host, including SQLite in OPFS in the browser. The default authorized
bank is `agent-chat`; this is device-local memory, not a cross-device sync feature.

The shared keyword shortlist caps candidates at 30, reserving half for memories
and half for skills before filling spare slots. It ignores conversational
boilerplate and scores whole words. Jev ranks memories and
skills, retaining uncertain items and items whose text was truncated for judging;
only confident unnecessary items are withheld. Whole selected rows fit a configurable conservative-token budget (`AGENT_OPENING_TOKENS`, default 4096), counting the complete escaped render. Retained skill
descriptions join the same opening block; discarded descriptions never
reach the responding agent. Injected skill bodies use the same selection path. The app currently has no filesystem skill discovery.
The existing tools retain their authority envelopes.

Hosts may supply `HostOptions.memorySources`, an `Opening.Sources` layer, to
compose their authorized memory banks and skills. Wiki discovery and memory are
explicitly deferred to the future wiki feature, which can add one injected source.
The maintainer app's existing concept is deferred too and will likely become that
wiki feature. Nothing reads `.smithers/wiki`.

The sealed opening payload freezes the prefix across resume. The opening step's
`memoryDebug` receipt records recalled, inserted, filtered and retained-skill
counts for the run debugger. Logs, spans and metrics contain only counts and
elapsed milliseconds: `memory.opening`, `smithers_memory_recalled`,
`smithers_memory_inserted`, `smithers_memory_filtered`, `smithers_memory_ms`.
Retrieval has its own `memory.recall` span and `smithers_memory_recall_ms` timing.
Transient source failures retry through the engine (three attempts); permission
refusals and exhausted failures settle the answer as failed; no empty-memory
success substitutes for an unavailable source.

Validation: `Opening.test.ts` exercises real SQL recall and selection with 100%
coverage of the added SDK module; the existing `Source.test.ts` has 41 passing
snapshot tests. `evals/memory.eval.ts` exercises the real model, HTTP endpoint,
browser engine, SQL memory and run inspector. Its executed result is recorded
in the work note. The fact is supplied only through durable memory, not a wiki.

The production skill shortlist reads saved personal flows' names, revisions and
descriptions through `FlowsClient.list`. These are the app's available reusable
skills; their relevant catalog entries enter the opening block. It does not
import old filesystem skills or auto-run a saved flow. Core callable tools keep
their existing policy; this filter never grants new authority.

Retrieval itself seals as `chat/RecallOpening` before the judge can run, closing
the crash interval between a paid judgment and its outer action's completion.
Both retrieval and judgment read the newest 16 KiB of the question and its preceding conversation,
so follow-up questions retain their referents. This is agent infrastructure;
future plugin sources use the public injected source service rather than a
private feature API.


People can ask the agent to remember a fact. `app/memory/remember` is a public
model-invocable durable flow and records it in the same engine SQL store that
opening recall reads. Its bank is fixed by the host, and `Flows.handlersFor`
enforces the `WithMemory` namespace policy before I/O. There is no model-selected
bank. Sign-out's existing device wipe deletes the engine database, including
these device-local records. `memory.remember` and `smithers_memory_remembered`
record successful writes without the key or text.

`pnpm --filter @smthrs/mvp eval:memory` runs the real-model memory proofs and
new-module coverage checks; it spends model tokens. It covers snippet filtering,
source retry, faulty-judge refusal, public remember followed by production recall,
and a new engine resuming after the judge sealed without querying a changed
source or paying for judgment again. API/catalog discovery uses the real HTTP
routes and SQL in `memory.test.ts`. Catalog failures are intentionally visible:
three durable attempts for transient errors, immediate refusal for permission
errors, never an unreported empty catalog.

The unavailable-judge regression injects short retry delays through `JudgeSeat`.
It keeps the durable model step's six attempts and verifies `OpeningFailed`;
production uses the model step's default backoff policy.
