# 0010. The live agent on Cloudflare

**Status:** accepted, 2026-11-07; posts are flows since 0011; the reply is smithers.sh's agent since 0012. **Rulings:** VL-4, VL-7, VL-10, VL-11, VL-12, VL-13. **Roadmap:** brick 1b.

**Decision.** The live Factory is an Effect-native Alchemy Worker, `VibelangApi` (`worker/Api.vibe`), that the site
Worker hands `/api/*` over a service binding, and two Durable Object classes it hosts:

```
browser / CLI / MCP ── LiveFactory (HttpClient) ──▶ site Worker ──▶ VibelangApi ──▶ Conversation (one per conversation)
                                                                                     │  sequencer: decide, apply, log, followers
                                                                                     │  reply flow: ExecutionObject + engine in its SQLite
                                                                                     └──▶ Budget (one per UTC day)
```

- **The sequencer** (`worker/Sequencer.vibe`) is the conversation's only writer. Every intent runs `decide` and
  `apply` from `src/core/conversation.vibe` under one lock; an accepted event is written to the object's storage
  (`event/<seq>`), then published to every follower. A person's post reaches it as the record step of a
  `vibelang/Post` flow run in the posting request, whose next step dispatches the reply (0011). A new incarnation replays the log. Post ids are `m<seq>`; a
  post's reply is `r<seq>`, so each post has exactly one possible reply.
- **The reply is a durable flow.** `vibelang/Reply` (`worker/Reply.vibe`) is an `@smthrs/flow` flow whose steps are
  journaled actions: start the reply, admit against the day's budget, read the history, run smithers.sh's agent
  (`@smthrs/agent`'s `AgentAction`, 0012; its model calls are its own `ModelStep`s, never a raw provider call),
  record the spend, and settle the reply as finished or
  failed. Every failure, a missing model, a spent budget, a provider refusal or a defect, becomes `FailReply` with a
  reason the person reads; interruption is the engine's and resumes the flow.
- **One execution per conversation object.** A conversation answers one post at a time, so its object hosts that
  post's execution itself (`@smthrs/platform-cloudflare`'s `ExecutionObject`, its alarm and its intent) with the
  engine's journal in the object's own SQLite (`ObjectDatabase`, added to the SDK for this). The flow's steps reach
  the sequencer in the same object, with no RPC. A settled execution is forgotten at its next alarm, which starts the
  next unanswered post's. A post is started at most once, so a flow that settles without answering can't loop.
  Separate execution objects would need the two namespaces to reach each other, a cycle Alchemy's layers can't build.
- **Streaming.** The agent's events become `AppendReply` pieces with an attempt and offset, and `RestartReply` when
  the visible answer starts over (0012); the sequencer drops a piece it already has, so a replay changes nothing.
  `finish` sets exactly the settled text, whatever pieces arrived.
- **Events stream as Server-Sent Events**: `id: <seq>`, `data: <event JSON>`, a keep-alive comment every 20 s. A
  plain GET that `curl` can read, Effect's `Sse` decoder on the client, and the existing reconnect from the last
  `seq` when it ends. An open stream keeps its object in memory; if idle followers' duration ever costs real money,
  move to hibernatable WebSockets (`Cloudflare.upgrade`, as apps/mvp's `RunContent` does) behind the same `follow`.
- **`LiveFactory`** (`src/core/LiveFactory.vibe`) is the `Factory` layer over this protocol (`src/core/wire.vibe`)
  with Effect's `HttpClient`. The browser uses it when its origin's `/api/health` says `agent: "live"`, else the mock;
  `?agent=mock` or the `vibelang.agent` storage key set to `mock` forces the mock, which the deployed browser suites
  use (VL-13). Startup never waits on that request: `src/web/startup.vibe` renders and starts keyboard subscriptions
  with an immediately available Factory and mode `pending`. `src/web/backend.vibe` owns one scoped selection fiber;
  `post`, `read` and `events` wait on its shared result. A health failure, invalid response or three-second timeout
  selects the mock permanently for that page; forced mock skips health entirely. Only a chosen mock downloads its
  module. A `ResolvedMode` message updates the mode and Mock pill independently of conversation traffic. Disposing
  the runtime cancels the probe and releases the chosen backend. This uses Effect's existing Layer, Scope and Fiber
  primitives (0001), retaining the real Factory API for every surface. The CLI and MCP server use it unless `--mock` or `VIBELANG_FACTORY=mock`, at `VIBELANG_FACTORY_URL`
  (default `https://vibelang.smithers.sh`); a deployment whose health says `mock`, or that can't be reached, fails
  with `LiveBackendNotDeployed`.

**Configuration** (Effect `Config`, the API Worker's bindings; `worker/AgentModel.vibe`):

| Name | What | Unset |
| --- | --- | --- |
| `CHAT_MODEL` | A configured-model record as JSON: `protocol`, `baseUrl`, `path`, `modelId`, `credential`, `extraBody` | smithers.sh's chat model: Cerebras `qwen-3.8-27b` over `openai-chat` |
| the record's credential, `CEREBRAS_API_KEY` for the default | The model's key; a custom credential `NAME` reads `SMITHERS_MODEL_KEY_NAME` | Every reply fails: "The agent has no model configured." |
| `CHAT_DAILY_TOKENS` | The day's token budget, every conversation together | 2,000,000 |
| `VIBELANG_DOMAIN` | The site's hostname (0006) | workers.dev only |

The agent is open to everyone until sign-in (roadmap brick 2), so the daily budget bounds spend. Every flow that calls
a model (a reply, a VIP or wiki draft, each specification reviewer) first reserves its ceiling, frames × (context
window + answer tokens), in the day's Budget object under that object's lock, and is refused when the day's charges,
its open reservations and that ceiling would pass `CHAT_DAILY_TOKENS`. Its settlement frees the reservation and
charges, once, what the provider reported, or the whole ceiling when the provider reported no usable count. So the
day's charges pass the budget only by tokens a call spent beyond its own ceiling, which the ledger keeps as `over` and
`vibelang_budget_overshoot_tokens` counts (0018). A reply's ceiling is 278,528 tokens: at most seven replies run at
once on the default day.
No configured model means no reservation. Failed calls, malformed reports and an unavailable SDK usage meter charge
the reserved ceiling; a usable provider total takes precedence over component counts.
Its system context is VibeLang's own skill (`worker/agentContext.vibe`, generated by `pnpm agent-context` from the
installed `vibelang`; `test/agentContext.test.vibe` fails when it is stale).

**Observability.** Requests log and count by route and status (`vibelang.api`, `vibelang_api_requests`), dispatch
and replies by outcome (`vibelang.dispatch`, `vibelang.reply.model` with tokens), the budget by admission and spend
(`vibelang.budget.*`, `vibelang_agent_tokens`), and the engine's own `cloudflare.execution.*` lines. None carries a
post, an answer, a provider's message or a key.

**Proof.** `pnpm test:workerd` runs the API Worker's objects over this code in Miniflare's workerd and talks to them
over HTTP with `LiveFactory`, the raw protocol and the emitted CLI: the reply flow runs on real alarms and fails with
the real "no model" reason, posts are answered one at a time in order, two followers see the same events, a cursor
resumes, refusals carry the sequencer's reasons, a zero budget refuses before any model call, and the site without
the API says `mock`. `alchemy dev` runs the Alchemy objects themselves; `E2E_LIVE_URL=http://localhost:1337 pnpm
exec playwright test e2e/live.spec.ts` drives the page against it. With `CEREBRAS_API_KEY` set, the workerd suite also
asks the real model, and `E2E_LIVE_ANSWERS=1` makes the browser case require an answer. No model is scripted.

**Outside this decision.** Sign-in and per-person limits (brick 2); the agent's tools (0012 lists them; it answers from the skill
alone); TLA+ of the object protocol (0005's "Outside the proof").
