# 0011. A person's post is a durable flow

**Status:** accepted, 2026-11-07. **Rulings:** VL-8, VL-11, VL-13; repository rule "Everything is a durable flow"
(DUR-1, DUR-2). **Changes:** 0003, 0004, 0010.

**Decision.** `POST /api/conversations/<id>/posts` runs a `vibelang/Post` execution of `@smthrs/flow`
(`src/core/flows.vibe`) in the conversation's Durable Object, inline in the request, on the engine in the object's own
SQLite (`CloudflareRuntime.layer` over `ObjectDatabase.layer`, the store the reply flow uses):

```
POST ─▶ Conversation object ─▶ vibelang/Post  post/<uuid>
                                ├─ step vibelang/post/record    decide + apply + log  (Sequencer.post)
                                └─ step vibelang/post/dispatch  only when accepted: arm the reply's execution
        ◀── 200 {} | 409 {refusal}   once the flow settles: never after the model
                                     alarm ─▶ vibelang/Reply  reply/m<seq>  (0010)
```

- The record step calls the sequencer, which calls `decide` and `apply` from `src/core/conversation.vibe` (0003). The
  flow decides nothing; there is still one state machine.
- The dispatch step starts the oldest unanswered post's `vibelang/Reply` execution (`ExecutionObject.start`, which
  arms the alarm). The model runs in that alarm, so the POST answers as soon as the post is durable.
- A refusal (`empty`, `too-long`, `duplicate`, `busy`, `not-replying`) is the record step's answer; the flow
  settles at once and the request answers 409. Nothing is dispatched.
- Each request is its own execution, `post/<uuid>` from Web Crypto. A repeated client id therefore meets the
  sequencer's `duplicate`, exactly as before; posts stay numbered `m<seq>` and replayable from `event/<seq>`.
- **Mock mode runs the same flows.** `MockFactory` builds `@smthrs/engine`'s `FlowEngine.layerMemory` per
  conversation (as live has one engine per conversation object) and registers the same `Post` with the same body and
  `Reply` with the scripted agent's body. The engine is pure Effect, so it runs in the browser, the CLI and the MCP
  server. The page loads the mock with a dynamic `import()`, so a live page never downloads the engine.

**Alternative: one flow per post, its first step records and its later steps reply.** Rejected:

1. The Cloudflare host runs one alarm-driven execution per object (`ExecutionObject`), and a conversation answers one
   post at a time. A second post's flow could not start, so it could not be recorded, until the first reply settled.
   That breaks instant chat.
2. `FlowRuntime.execute` answers when the flow settles. Answering after the first step would need a deferred
   handshake between the request and the alarm, a second protocol beside the engine's.
3. A refused post would be a reply flow that never replies; posts and replies have different lifetimes and
   ordering.

**Why this one.** The post is a journaled step with the engine's retries and idempotency. The reply keeps its own
execution, ordering and resumption (0010). The two flows meet only at the sequencer.

**Durability.** The record step commits the post's event before the flow settles. If the invocation dies mid-flow,
the client's existing retry (same client id) gets `duplicate`, and the reply is still dispatched: every alarm and
every events subscription calls `ensureDispatched`. An abandoned `post/*` run stays unsettled in the object's store;
nothing drives it again, and nothing needs to.

**Observability.** Each post logs `vibelang.post` with `outcome` (`accepted` or the refusal), counts
`vibelang_posts{outcome}` and runs in a `vibelang.post` span; the engine adds `flow.run.*` lines with the run id
and flow tag. None carries the text, the client id or the name. The CLI and MCP server print only warnings, on
stderr, so `--json` and the protocol stay clean.

**Cost.** The mock's engine adds 168 KB (58 KB gzipped) as its own chunk, loaded only by mock pages. The live page's
JavaScript went from 667 KB (180 KB gzipped) to 708 KB (193 KB gzipped) across two chunks.

**Proof.** `test/postFlow.test.vibe` runs `Post` on the in-memory engine over the live sequencer: accepted posts
record then dispatch, each refusal records and dispatches nothing, a replayed execution answers from its journal
without recording again, and the log lines carry no person's words. `test/live.workerd.test.vibe` checks, in the
object's own SQLite, that an accepted and a refused post each settled as a completed `post/*` run beside `reply/m1`.
The mock suites, the browser suites and the CLI and MCP suites run the same flows on the in-memory engine.
