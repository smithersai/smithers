# 0004. Mock mode

**Status:** accepted, 2026-11-07. **Ruling:** VL-13 (an invariant for all development).

**Decision.** `MockFactory` is a `Factory` layer with no backend and no model. It runs the real sequencer (`decide`,
`apply`) in memory, publishes events to every follower, and answers each post with a scripted reply streamed in
pieces (`src/core/mockReplies.vibe`), one reply at a time per conversation. Independent conversations answer in parallel.
Acceptance, publication and enqueueing are one uninterruptible operation under that conversation's sequencer lock.
A FIFO queue receives each accepted prompt before the lock releases; callers never launch reply fibers. One
`forkIn` consumer per room belongs to the layer's scope, as do its queue and the shared PubSub. Scope closure waits
for in-flight acceptance, interrupts workers, shuts down queues and subscriptions, and refuses further calls. The page
shows a **Mock** pill whenever it runs.

**Rules.**
- Every new feature ships its mock layer in the same change, and its browser test runs against the mock first.
- Scripted replies use only current, compiled VibeLang syntax (from the language's skill and the launch kit's verified
  snippets). `test/scriptedReplies.test.vibe` extracts every fenced `vibe` block from every scripted answer, including
  the fallback, and compiles each independently with the installed compiler. The full `--noEmit` typecheck must exit zero with no diagnostics; malformed syntax and invalid types are negative controls. Examples declare their own services/layers; the test
  supplies no hidden prelude. Recovery runs inside effect code, never at module scope.
- The mock stays every suite's default backend. A page uses the live agent only when its origin's `/api/health`
  says `live` (0010); `?agent=mock` or the `vibelang.agent` storage key forces the mock, as deployed browser suites do.

**Regression evidence (review findings 1, 2, 4).** Factory integration tests use the real service with a
`Scheduler.MixedScheduler` subclass yielding every 6, 7 or 11 checks. They compare the complete live event sequence
and every answer against accepted prompt order. Disposal checks actual runtime fibers have exited at `Scope.close`,
then advances the test clock to prove no queued work or publication resumes. The suite also interrupts an accepted
posting fiber and checks its complete answer, and proves a busy room cannot delay another room's reply. It uses the
app's existing Effect Semaphore, Queue, PubSub and Scope primitives (0001); no new dependency or model call.

**Live room isolation (review finding 12).** Both followers subscribe before distinct posts and remain live through
both complete answers; every sequence, author, prompt and answer must belong to its room. Cancelling an additional
live follower leaves the other followers and workers running. The retained mutation check removes only
`item.conversation === conversation &&` from the compiled factory and must fail this assertion:

```sh
pnpm exec vitest run --config test/mutations/room-isolation.config.ts test/MockFactory.test.vibe -t 'keeps complete live transcripts'
```
