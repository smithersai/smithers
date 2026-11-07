# 0008. Testing

**Status:** accepted, 2026-11-07. **Rulings:** VL-10, VL-13, VL-14, VL-15.

**Suites,** each meant to cover the whole app on its own:

| Suite | Where | Runs |
| --- | --- | --- |
| Properties and units | `test/conversation.test.vibe` | `pnpm test` |
| Integration of the Effect API | `test/MockFactory.test.vibe` | `pnpm test` |
| Scenes: the real view and update, driven by role and text, no browser | `test/app.scene.test.ts` | `pnpm test` |
| Browser end to end: dark, light, phone | `e2e/chat.spec.ts` | `pnpm e2e`; `E2E_BASE_URL=https://vibelang.smithers.sh pnpm e2e` |
| Proofs | `src/core/conversation.ts` contracts | `pnpm verify` (roadmap 1d) |
| Benchmarks, fuzzing | next | with roadmap 1b |

**Rules.** No mocks besides the mock backend itself, which is a product mode (0004). Every test that waits on the UI
waits on what a person sees (a role, a text, `data-done`), never a timer. Screenshots wait for view transitions to end.
