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
state and resolve the real close command. Chat retains its docked input while the palette is open.

**Scroll regressions (review 7).** `e2e/scroll.spec.ts` submits an answer and four follow-ups in each viewport. It
checks real IntersectionObserver viewport intersection and that the final paragraph clears the fixed composer.
During the next streamed answer a real wheel scroll reaches the top; the scroll offset must stay there through
completion. Latest must return to the tail and resume following. `app.scene.test.ts` independently checks pausing,
manual return to the bottom and the Latest action. A follow subscription waits for the render commit; model
dependencies cancel obsolete scroll work whenever a newer piece arrives or the reader leaves the bottom.

**Scroll ordering regression (lane scrollfix).** `test/scroll.runtime.test.vibe` embeds Foldkit's real update, view
and subscriptions. Its happy-dom host controls animation-frame delivery and observes attempted native scroll writes
(happy-dom has no layout). It releases a pending follow, delivers upward wheel intent, then the old follow's bottom
notification and a fresh reply delta in one host turn. Following must remain paused and no follow write may run.
This case fails on main 87c54fa7 because the stale bottom notification resumes following before native movement.
The browser case remains the layout and real wheel-scrolling receipt.

**Announcements (review 9).** The transcript is the named Conversation `role="log"` with `aria-live="off"`, so
stream pieces do not repeat the whole answer. Persistent Answer and Connection status regions are polite and atomic.
Only accepted completion/failure events update Answer; an answer ordinal distinguishes identical successive answers.
`e2e/announcements.spec.ts` inspects Chromium's accessibility tree (log name and live/atomic properties), checks the
region remains empty during the first stream, and preserves its completed value during the next. Scenes separately
check completion, duplicate replay and connection transitions. Fault recovery browser cases inspect Connection's
accessibility node and Disconnected/Connected changes. These are browser accessibility-tree receipts, not a claim of
manual listening with an installed screen reader.

**Recovery regressions (review 11, browser/runtime half).** `test/recovery.runtime.test.vibe` embeds Foldkit's actual
application, update, commands and subscription runtime. `test/support/FaultyFactory.vibe` decorates the real product
MockFactory: it drops event 3 once, or fails the stream before event 4 in the middle of a reply. It never invents
posts, events, replies or replay data. Both cases assert acquisition cursors (`[0, 2]` / `[0, 3]`), equality with the
real factory's full replay, removal of pending posts, entry uniqueness, and live delivery of a subsequent reply
without another subscription. The browser repeats these cases in every project in `e2e/recovery.spec.ts`, including
Connection's accessibility-tree live property and composer focus after Reconnect. Observations are read-only.

The fault host is an additional HTML entry **only in Vite's e2e build mode**; it is absent from ordinary builds.
Playwright always starts that local host, including when `E2E_BASE_URL` sends product tests to a deployment. Fault
cases explicitly target the local host so test-only fault controls never enter deployed code.

`node test/check-recovery-mutations.mjs --browser` removes the gap branch, then separately removes the reconnect
epoch/cursor update. Each suite must fail exactly the affected case while its other case passes. It restores the
source in `finally`; run it with no other build/test process using the workspace. Set `VIBELANG_MUTATION_LOG_DIR` to
retain the four failure logs. The browser fix here leaves the shared core and its convergence property to the core
lane.

Announcements remain accessible while the palette is modal; only the noninteractive live-region container is exempt
from background isolation. The native closed dialog controls its own accessibility visibility. The browser observes
all rendered stream states and announcement text changes from before sending, including a completion while the
palette is open; it requires exactly one completed announcement per answer and no partial answer announcements.
Upward wheel intent pauses following, and the render's follow attribute guards
against stale scroll work. Native scroll anchoring is disabled because the app owns following. Splash and palette
scrolling do not change chat follow state. Playwright keeps the original three-browser concurrency as files are added,
so streamed render assertions run under the same browser load; assertion thresholds and timeouts are unchanged.
