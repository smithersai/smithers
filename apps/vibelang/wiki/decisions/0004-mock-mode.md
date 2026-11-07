# 0004. Mock mode

**Status:** accepted, 2026-11-07. **Ruling:** VL-13 (an invariant for all development).

**Decision.** `MockFactory` is a `Factory` layer with no backend and no model. It runs the real sequencer (`decide`,
`apply`) in memory, publishes events to every follower, and answers each post with a scripted reply streamed in
pieces (`src/core/mockReplies.ts`), one reply at a time. The page shows a **Mock** pill whenever it runs.

**Rules.**
- Every new feature ships its mock layer in the same change, and its browser test runs against the mock first.
- Scripted replies use only current, compiled VibeLang syntax (from the language's skill and the launch kit's verified
  snippets).
- Until the live agent lands (roadmap 1b), the mock is the only backend, including on the deployment.
