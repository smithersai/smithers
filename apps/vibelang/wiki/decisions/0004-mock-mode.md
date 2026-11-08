# 0004. Mock mode

**Status:** accepted, 2026-11-07. **Ruling:** VL-13 (an invariant for all development).

**Decision.** `MockFactory` is a `Factory` layer with no backend and no model. It runs the live factory's flows
(0011) on `@smthrs/engine`'s engine in memory, one engine per conversation: each post is a `vibelang/Post` execution
whose steps record it through the real sequencer (`decide`, `apply`) and dispatch its reply, and each reply is a
`vibelang/Reply` execution whose steps stream the scripted answer in pieces (`src/core/mockReplies.vibe`), oldest
unanswered post first, one at a time per conversation. Independent conversations answer in parallel. Acceptance and
publication are one uninterruptible operation under that conversation's sequencer lock. One `forkIn` worker per room
starts the replies; it, the engines and the shared PubSub belong to the layer's scope. Scope closure waits for
in-flight acceptance, interrupts workers, shuts down engines and subscriptions, and refuses further calls. The page
renders and starts listening to the keyboard before backend selection or a module download. Its immediately available
Factory (`src/web/backend.vibe`) starts one scoped selection: `post`, `read` and `events` share its result and wait only
for that selection. The page starts with mode `pending`; a Foldkit `ResolvedMode` message sets the chosen mode and
shows the **Mock** pill after the mock is ready. The mock's module loads only when chosen, including forced mock
mode. Cancelling an individual caller leaves selection running; disposing the runtime cancels selection and closes
the chosen layer.

**Rules.**
- Every new feature ships its mock layer in the same change, and its browser test runs against the mock first.
- Scripted replies use only current, compiled VibeLang syntax (from the language's skill and the launch kit's verified
  snippets). `test/scriptedReplies.test.vibe` extracts every fenced `vibe` block from every scripted answer, including
  the fallback, and compiles each independently with the installed compiler. The full `--noEmit` typecheck must exit zero with no diagnostics; malformed syntax and invalid types are negative controls. Examples declare their own services/layers; the test
  supplies no hidden prelude. Recovery runs inside effect code, never at module scope.
- The mock stays every suite's default backend. A page uses the live agent only when its origin's `/api/health`
  says `live` within three seconds (0010); `?agent=mock` or the `vibelang.agent` storage key forces the mock, as deployed browser suites do.

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

**Startup regression.** `test/startup.runtime.test.vibe` and `e2e/startup.spec.ts` run the production startup with an
injected HttpClient whose health answer stays open until released. First render, ⌘K, Tab and a pending post work
before health answers, then the chosen mock answers that post. `test/backend.test.vibe` checks shared selection,
cancellation, the three-second fallback and forced mock without health. No request interception.

## The switch (2026-11-08, ruling VL-30)

The top bar shows the mode the page runs, **Live** or **Mock**, and a click switches: it loads the page with
`?agent=mock` or `?agent=live`. Startup saves the choice in the `vibelang.agent` storage key (`?agent=live` clears it),
so it survives reloads, signed in or out. ⌘K's slash menu lists `/mock` or `/live` beside the registered actions; they
are not flows, only a page load. The history page has the same switch. In Mock, the "Visit as" picker plays each of the
five roles, and chat, the tour, the wiki, issues and VIPs, actions, the mythical history and sandboxes all run with no
backend, no model and no sign-in. `e2e/mock-switch.spec.ts` switches with the top bar and uses each of them, locally and
against the deployment. `/api/health` reports the deployed commit (`VIBELANG_COMMIT`, set by the deploy).
