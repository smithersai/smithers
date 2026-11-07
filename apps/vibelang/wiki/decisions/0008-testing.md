# 0008. Testing

**Status:** accepted, 2026-11-07. **Rulings:** VL-10, VL-13, VL-14, VL-15.

**Suites,** each meant to cover the whole app on its own:

| Suite | Where | Runs |
| --- | --- | --- |
| Properties and units | `test/conversation.test.vibe` | `pnpm test` |
| Integration of the Effect API | `test/MockFactory.test.vibe` | `pnpm test` |
| Scenes: the real view and update, driven by role and text, no browser | `test/app.scene.test.ts` | `pnpm test` |
| Browser end to end: dark, light, phone | `e2e/chat.spec.ts` | `pnpm e2e`; `E2E_BASE_URL=https://vibelang.smithers.sh pnpm e2e` |
| Agent surfaces | `test/{commands,cli,mcp}.test.*`: Factory commands, emitted CLI process, stdio McpClient, skill and schema parity | `pnpm test` |
| Proofs | `src/core/conversation.ts` contracts | `pnpm verify` (roadmap 1d) |
| Benchmarks, fuzzing | next | with roadmap 1b |

**Rules.** No mocks besides the mock backend itself, which is a product mode (0004). Every test that waits on the UI
waits on what a person sees (a role, a text, `data-done`), never a timer. Screenshots wait for view transitions to end.

**Keyboard regressions (review 6, 8, 13).** `e2e/focus.spec.ts` uses only the keyboard to send, dismiss with Escape
or a second ⌘K, restore the actual opener, retain an unsent draft, and wrap Tab/Shift+Tab. The native dialog is opened
with Foldkit `Dom.showDialog({ isModal: true })`: background controls disappear from role queries. Tests await the
specific palette or docked input's focus before typing, assert its value, and await Send becoming enabled before
navigating to it. A focus assertion on the shared accessible name alone can accidentally accept the outgoing input.
The dialog stays mounted so `Dom.closeDialog` can release isolation and restore its opener; scenes assert its closed
accessibility state and resolve the real close command. Chat retains its docked input while the palette is open.

**Scroll regressions (review 7).** `e2e/scroll.spec.ts` submits an answer and four follow-ups in each viewport. It
checks real IntersectionObserver viewport intersection and that the final paragraph clears the fixed composer.
During the next streamed answer a real wheel scroll reaches the top; the scroll offset must stay there through
completion. Latest must return to the tail and resume following. `app.scene.test.ts` independently checks pausing,
manual return to the bottom, the Latest action and cancellation of pending scroll commands. Scroll commands wait for
the render commit and are cancelled when the reader leaves the bottom, including commands queued by earlier pieces.
