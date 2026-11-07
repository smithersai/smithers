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
| Live Factory in local workerd: the API Worker's objects, LiveFactory, the protocol, the CLI | `test/*.workerd.test.*` | `pnpm test:workerd` (0010) |
| The live agent in a browser, opt in | `e2e/live.spec.ts` | `E2E_LIVE_URL=<origin> pnpm exec playwright test e2e/live.spec.ts` |
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
manual return to the bottom and the Latest action. A follow subscription waits for the render commit. Model dependencies cancel obsolete work; a native intent
revision also vetoes work that already resumed against the old DOM. The permission check and native scroll run in
one synchronous operation. Wheel and touch-move listeners are non-passive (without preventing the default action),
so Chromium dispatches intent before applying its compositor scroll. A passive listener can arrive after a follow
write changed the offset that the compositor calculated, leaving a 20–56px remainder even if following then stops.
An unchanged bottom notification from an earlier follow cannot resume after upward intent; downward movement back
into the bottom or Latest can. Returning through the splash preserves the paused state.

**Scroll ordering regression (lane scrollfix).** `test/scroll.runtime.test.vibe` embeds Foldkit's real update, view
and subscriptions. Its happy-dom host controls animation-frame delivery and observes attempted native scroll writes
(happy-dom has no layout). It releases a pending follow, delivers upward wheel intent, then the old follow's bottom
notification and a fresh reply delta in one host turn. Following must remain paused and no follow write may run.
The original wheel case fails on main 87c54fa7 because the stale bottom notification resumes following before
native movement. The suite now covers wheel, touch drag, PageUp, Home and ArrowUp in commit-first, intent-first and
delta-first orderings (15 cases). Each checks subsequent growth while paused and resumption by both downward return
to the bottom and Latest. `test/viewport.test.ts` independently checks the permission veto while the old rendered
attribute still says true, paused rendered state, editor keyboard navigation, and splash/palette isolation. The native
revision is acknowledged even when the model is already on an inactive surface but the old chat DOM remains on
screen; tests hold this transition gap for both the palette and splash so it cannot strand follow permission.
The browser case remains the layout and real wheel-scrolling receipt; its assertions and timeout are unchanged.

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
Native upward intent invalidates follow permission before queued scroll work; the render's follow attribute also
guards paused transcripts. Native scroll anchoring is disabled because the app owns following. Splash and palette
scrolling do not change chat follow state. Playwright keeps the original three-browser concurrency as files are added,
so streamed render assertions run under the same browser load; assertion thresholds and timeouts are unchanged.

**Fable review 3–12.** Reply correlation has direct target guards and an out-of-order/skip transport fixture over the
real sequencer. The shared entry codec is identical across snapshots and client state; all cursors use the same safe
nonnegative integer schema. Markdown tests cover info strings, unclosed fences and odd inline backticks. Scripted
examples use the full compiler with bad syntax/types as negative controls. Worker route tests run as JavaScript so
Worker globals remain in `worker/tsconfig.json`, separately checked by `pnpm typecheck`; they cannot pollute the
browser's DOM globals.

Scenes cover product refusal labels, Retry and session-specific `You` labels. Browser recovery also closes a real
stream normally mid-answer, then checks reconnect from the last applied cursor. A one-shot refusal tests Retry
through the real runtime with the same post id and neutral wire author. The Mock pill has no explanatory tooltip;
answer failure is shown once on the message, with a concise accessible completion announcement.

The splash video has native playback controls and disables autoplay when the browser requests reduced motion at
initialization. That media preference also disables the thinking dots and palette fade in CSS. `e2e/motion.spec.ts`
checks controls and paused state, then the reduced-motion poster, fade and real thinking indicator in every viewport.
