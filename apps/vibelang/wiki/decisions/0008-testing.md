# 0008. Testing

**Status:** accepted, 2026-11-07. **Rulings:** VL-10, VL-13, VL-14, VL-15.

**Suites,** each meant to cover the whole app on its own:

| Suite | Where | Runs |
| --- | --- | --- |
| Properties and units | `test/conversation.test.vibe` | `pnpm test` |
| Integration of the Effect API | `test/MockFactory.test.vibe` | `pnpm test` |
| Scenes: the real view and update, driven by role and text, no browser | `test/app.scene.test.vibe` | `pnpm test` |
| Browser end to end: dark, light-preferring (still dark, 0013), phone | `e2e/chat.spec.ts` | `pnpm e2e`; `E2E_BASE_URL=https://vibelang.smithers.sh pnpm e2e` |
| Agent surfaces | `test/{commands,cli,mcp}.test.*`: Factory commands, emitted CLI process, stdio McpClient, skill and schema parity | `pnpm test` |
| Proofs | All marked production VibeLang decisions; inventory in [0018](0018-proofs.md) | `pnpm verify` |
| Proof sensitivity | Executable mutations with byte-identical contracts | `pnpm verify:broken` |
| Live Factory in local workerd: the API Worker's objects, LiveFactory, the protocol, the CLI | `test/*.workerd.test.*` | `pnpm test:workerd` (0010) |
| The live agent in a browser, opt in | `e2e/live.spec.ts` | `E2E_LIVE_URL=<origin> pnpm exec playwright test e2e/live.spec.ts` |
| Fuzzing and corpus regressions | `fuzz/*.fuzz.vibe`, native workerd and Chromium (0015); `@smthrs/fuzz`, `@smthrs/testing` | `pnpm fuzz`; independent strict gate `pnpm fuzz:coverage` |
| Benchmarks | `bench/`: built-in Vitest, Chromium, native wiki/identity journeys, streamed reply cancellation, agent draft replay, deferred action binding, unbound device refusals, sandbox slash/minute state and issue chat cards, explicit backend sessions and plain command output, concurrent daily reservations and ledger recovery, reply preview replacement, safe error tags and counts-only draft charge exhaustion, signed-in issue and wiki routes, mock-agent requests, retained journals and contention, unannotated history folds and dispatch scans, emitted CLI/MCP/scripts, SQLite recovery and sandbox/object-startup recovery, opt-in real public GitHub reads and real workerd with object health (0017); fault-path coverage set on the `e2e` build, counts only (`bench/browser-faults.spec.ts`) | `pnpm bench`; opt-in `pnpm bench:live`; independent strict `pnpm bench:coverage` (unfinished) |

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

`node --import=vibelang/register test/check-recovery-mutations.vibe --browser` removes the gap branch, then separately removes the reconnect
epoch/cursor update. Each suite must fail exactly the cases the mutation breaks (drop for the gap branch; disconnect and
end for reconnect) while its other cases pass. It restores the
source however the run ends; run it with no other build/test process using the workspace. Set `VIBELANG_MUTATION_LOG_DIR` to
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

**Proof CI (0018).** Both proof targets run in the normal CI tier. Their inputs include all production VibeLang
modules and the verification tools; the positive gate also checks function-inventory drift. No new dependency is added.

**Shared-host determinism (2026-11-07).** Vitest uses three workers per lane. The cross-conversation lifecycle
case waits for the independent room's actual completed reply, then asserts the busy room has not completed one.
A fixed count of scheduler yields did not guarantee that the durable engine had finished its due work under coverage.

The reduced-motion case holds the real first reply delta in a faulty Effect transport until its CSS is checked,
then releases it and requires the complete reply. It no longer polls for a state that can end in 25 ms.
`E2E_4502=4502 pnpm e2e` selects this lane's port, including local fault pages.


**Startup deadline control (0018).** The fault browser host supplies an Effect Clock that holds only the health
selection deadline; it forwards real time reads and other sleeps, including mock streaming. Startup forwards its
current Clock to the resource layer. The browser deliberately outlives the normal deadline, then tests keyboard,
focus and posting while health is still uncancelled. It releases health and requires one complete answer. This
elapsed-time probe does not replace any UI-state wait. Independent TestClock cases assert selection at exactly
three seconds and no late switch. No request interception or new dependency is used.

**Announcement observation (0018).** A faulty Effect transport holds each real ReplyFinished until the browser
observes the preceding nonempty text with `done=false` and the previous announcement. The test releases completion
and still checks every rendered announcement, duplicate suppression and the accessibility tree. No events are
fabricated and no rendering timeout is widened; this removes the assumption that host scheduling exposes a
transient intermediate state before completion.

The happy-dom startup runtime check uses that same held-health Clock and statically loads the real mock before
its responsiveness assertions begin. This excludes cold source-compiler work from a compiled-page latency check;
browser cases retain cold asset loading. Its 500 ms input, four-second completion and five-second overall limits
remain unchanged. The cold-load regression failed before this fixture correction (0014 production follow-up).

## Tool list: actions SDK foundation

- `vibelang-unplugin@0.0.12`: engine browser bundles and Cloudflare Worker fixtures for VibeLang source (including native Node crash-test loader setup). Already used in the monorepo; added only as the SDK package's build/test tool. Awaiting Will's VL-5 approval. No new app dependency.
- `vibelang-runtime@0.0.12`: the registry and engine now publish VibeLang sources and declare the runtime already used by this app.

**Coverage boundary tests (0016).** The ordinary suite adds real loopback HTTP over both client protocols,
sequencer ordering, history pages and lifecycle, cancellation, exact backend deadlines, budget boundaries, model
configuration and the Alchemy resource graph. The prototype uses the monorepo's V8 provider 5.0.0 and Chromium's
built-in API. Strict 100% gates remain below target and are not installed on main. Proposed app test-tool declarations
`@vitest/coverage-v8` 5.0.0 and `ast-v8-to-istanbul` 1.0.5 await Will's VL-5 approval; see [0016](0016-coverage.md).
The benchmark coverage gate adds the monorepo's `istanbul-lib-instrument` 6.0.3, `istanbul-lib-coverage` 3.2.2 and
`istanbul-lib-source-maps` 5.0.6 as test-only tools for workerd execution evidence (0017); likewise awaiting Will's
VL-5 approval. No runtime dependency is added.
Node cases use the workspace's finite 30-second budget: MCP discovery starts the real stdio server and CLI, whose
combined cold startup exceeded the implicit five seconds after engine observation landed. The MCP protocol's own
10-second limit and browser assertions are unchanged; whole-history replay under coverage measured 23.5 seconds.

**Concurrent post acceptance (0017).** The two-follower Factory test checks person order, reply identity and complete scripted answers, contiguous event numbers, and serialized reply starts/finishes. It permits the first reply to start before the second post is accepted; asynchronous module/engine scheduling can select either valid interleaving. The former global entry-name order failed on a real run.

**Sandbox lane tool review (0024).** `@smthrs/fuzz` is the monorepo's existing feedback-fuzz tool, added as a test dependency, awaiting Will's VL-5 approval. Sandbox fuzz uses fixed seeds and a millisecond-by-millisecond clock oracle; the benchmark checks 100 actual mock lifecycle cycles. Neither is a whole-app coverage or live-container performance claim.



**History boundary regressions (0018).** Six behavioral tests cover invalid ranks, rejected bootstrap, faulty stored
replay, cached follow rereads, redacted JSON diagnostics, and the final safe event followed by a write-free capacity
refusal. Four initial cases and the two follow-up cases failed before their fixes. No dependency was added.

**Tour page observation (0018).** The tour browser test observes rendered iframe sources from startup and checks
all five stops in exact order. This retains the first/second page and narration assertions without assuming earlier
glow/layout checks finish before the tour advances. The final iframe, finished answer and released controls remain
asserted; no request interception or synthetic events are used.

**Accounting bounds and ordered context (0018).** Three failing-first budget regressions cover overflow, corrupt
persisted totals and admission; the final safe charge/replay stays green. Model-history integration preserves the
requested prefix and excludes tour narration. The shared CLI/MCP and sequence policies add 44 rejected mutants.

**Source-map and script controls (0016).** Vitest and `@vitest/coverage-v8` now both use the root's **5.0.0**, including
its provider patch. The added provider declaration awaits Will's **VL-5 approval**. A child suite with a passing
assertion must still exit 1 for its unvisited Effect return at original `.vibe` line 4. CLI/MCP and script emissions
retain maps and inline source text. Generator process tests use a separate ignored compiler-output tree whose maps
remain available until reporting; they never overwrite the app's generated context or history seed. The seed command
reads real jj commits and queue entries, including known commits in its second revset batch, and must preserve output
after failed reads. `ast-v8-to-istanbul` 1.0.5 and whole-app coverage gates remain proposed in the measurement prototype.

**Dogfooding and view transitions (vl-audit, 2026-11-08).** `test/dogfood.runtime.test.vibe` embeds the real app
and runs the `ask` and `read` commands the CLI and MCP server run, on one mock Factory: the app shows the agent's
posts before its person posts, and `read` returns the person's post. `e2e/live.spec.ts` repeats it with the emitted
CLI and a browser on a live origin. `e2e/transitions.spec.ts` records which typed view transitions the page renders
(`:active-view-transition-type`) in every project: `to-chat`, then `to-splash`, none for ⌘K. Removing the transition,
or running one on every change, fails it.

**Coverage range merge (0016).** The root's existing V8 provider patch preserves one counter per mapped source span
when native subprocess and transformed coverage meet. Both JS and `.vibe` controls require full execution to give
100% in all four metrics; missing branch/statement and same-line unused-function controls must still fail. The tool
version remains 5.0.0; no dependency or compiler behavior changes. Native touch tests compare the gesture's first
move with its final scroll position, preserving real pause and Latest behavior while the answer continues growing.

The app also matches the monorepo test peers `@types/node` 26.4.1 and `happy-dom` 20.13.2. Distinct optional peers
created two Vitest 5.0.0 instances; Effect's test helpers registered against the other instance, so suites could not
load after a fresh install. These are version alignments of existing test tools, with no runtime dependency added.

**Marketing media (0026).** `e2e/media.spec.ts` checks every tour placement in dark, light-preferring and phone browsers, decoded images/videos, native loading posters, loop policy, silence, reduced-motion stills, native decode failures through a faulty `MediaAssets` Effect service, and failed empty-state images. The compiler-card scene fails on the old view. Both designer-reported CSS bugs pass on current main (390px header and computed gradient); no CSS fix is needed. Existing monorepo tool versions `@types/node` 26.4.1 and `happy-dom` 20.13.2 share one Vitest runtime; this adds no dependency. `E2E_4516=4516` selects this lane’s local host across all fault suites.

**Conversation storage and proof harness (0018).** A faulty Effect Log supplies invalid cursors, text and variants;
replay must fail before writes or dispatch and redact stored content. The failing-first harness regressions reject
mixed union-destructor/tool failures and ambiguous assertion targets, and enforce additions-only checked induction
in a fresh empty lemma. No dependency is added. Exact gate counts and exits are in 0018 and the lane report.

**Alarm observation (0018).** The real mock sandbox alarm test now awaits a meter event observed after start returns,
instead of assuming fifty scheduler yields complete native asynchronous flow work. Startup's own metering cannot
satisfy the observer. The merged host regression retains its five-second live deadline and removes the fixed yields.
Idle and post-stop counts remain unchanged, and the post-start count must increase.

The app and isolated coverage fixture also deduplicate `vitest` and transform `@effect/vitest` through Vite,
retaining the app's Foldkit transform. This keeps the adapter in the running CLI's suite context when pnpm binds
optional peers differently. This lane adds no dependency version, coverage threshold or file-exclusion change.

**Benchmark independence (0017).** Reuses the patched monorepo V8 provider and matching Vitest 5.0.0, with no new benchmark library or runtime dependency. Existing test-tool declarations await Will’s VL-5 approval. Timing and benchmark-only coverage receipts remain separate; strict coverage is unfinished.

The benchmark source profile uses the unminified `bench-coverage` build after failed-first native skipped-return
qualification, plus the provider's identical end-column normalization and complete-range merging. Optimized builds
remain the timing workload; methods, per-file counters and remaining gaps are in [0017](0017-benchmarks.md) and
[the measurement table](../benchmarks.md). No threshold or production exclusion was relaxed.

**Seed replay capacity (0018).** Two behavioral regressions fail when replay starts at the maximum safe cursor or
accepts its final safe event before another intent. The seed helper now uses the shared capacity decision; the
valid final event remains and the next intent is refused. No dependency is added.

**Desktop (0025).** The native app reuses VibeLang 0.0.12, Vite 8.3.4, Vitest 5.0.0, Effect Vitest 4.1.1,
esbuild 0.28.2, Playwright 1.62.1, happy-dom 20.13.2 and workspace `@smthrs/std`. These reused tools remain awaiting
Will's VL-5 review. Desktop units include a 1,000-case Effect Arbitrary property. Actual Electrobun/GTK/CEF cases
use a real Effect HTTP model server. Native wrapper coverage runs under V8 against actual foreign APIs through a
native test transport: no own-code mocks, interception, production exclusions or lowered SDK thresholds.

A fresh install exposed duplicate Vitest peer graphs. Both apps use the root's Node types 26.4.1 and happy-dom
20.13.2, with the patched Vitest/provider 5.0.0. Refresh the desktop's retained optional peer with a scoped pnpm
update, then verify its physical runner matches Effect Vitest. The desktop declares that DOM peer for resolution;
its service suite still uses Node. These are test-only choices, not browser runtime changes.

The shared keyboard stream ignores handled key events: a native picker consumes Escape once, preserving the
command palette. Native tests cover both composers and returning focus. Real GTK drivers select only mapped dialogs;
both fixtures retain one advisory OS lock through bounded teardown. The setup budget includes the lock wait; browser
case deadlines are unchanged. The sandbox alarm test awaits an actual meter signal with a bounded live-clock timeout,
retaining real WebCrypto and the idle/running/stopped assertions instead of racing a fixed number of scheduler yields.

The retained stale-edit red reproduced overwriting a person's file. `fs.edit` now requires its reader's exact
`before`; stale and unchanged requests return false, and replay validates its original request before cached success.
Five marked policy functions prove ten Dafny obligations, with five unchanged-contract negative controls.

A native role regression first reproduced a nonfunctional Mock identity picker after 0019 landed. The shared Accounts seam now follows the selected Factory, refreshes identity on model-mode changes and restores Viewer for local project operations. The real native case opens People in Mock and verifies that local sign-in reports unavailable without navigation.

**Fuzz lane tools (0015).** Existing monorepo test tools `@smthrs/testing`, `@smthrs/platform-node`,
`ast-v8-to-istanbul` 1.0.5, `istanbul-lib-coverage` ^3.2.2, `istanbul-lib-report` ^3.0.1 and
`istanbul-reports` ^3.2.0 are added at their monorepo versions, awaiting Will's VL-5 approval.
The fuzz runner is a durable Smithers flow using the real Node SQLite host, production step and file boundaries,
workerd and Chromium on lane port 4501. It never merges unit-suite coverage into fuzz evidence.
The strict coverage target is explicit, like benchmark qualification; its current failure remains recorded in 0015.

**History coverage (0016).** All 57 startup cases measure historyStartup.vibe at 100% on all four metrics. Native form
and real HTTP runtime tests cover planning, every note section, approval/folding, insertion/amendment and unavailable
read/write recovery, with persisted-state assertions. Amendment focuses Task and reopening is checked in Chromium.
Dated per-file unit, browser and Node-only workerd tables are recorded in 0016; whole-app 100% remains unfinished.
The strict all-four thresholds and Playwright coverage collector remain in the retained measurement prototype.

**Web decision extraction (0018).** Existing scene, media, viewport, tour and roles tests check the production
callbacks after pure decision extraction. Executable mutations cover every new projected field and guard. The
real-rounding fixture intentionally disagrees with native execution and remains a tool-boundary reproduction.

**Budget charge keys (0018).** The two-conversation ledger regression fails while a shared reply id merges both
conversations' charges and passes once the proved key decision namespaces each charge by its conversation object.
The test host gains a ledger window route; no dependency is added.


**Client identifier regressions (0016).** The public Factory/Actions matrix checks empty/oversized conversation
IDs and both unpaired surrogate classes before transport. Its 14 first-run failures are fixed; valid maximum-length
and emoji/reserved-character conversation IDs are independently exercised over real loopback HTTP.

**Durable action/storage and wiki command boundaries (0016).** Unit cases run the actual index and per-run hosts
on SQLite with product role/history services, then drive their public alarms, replay, cancellation and permission
changes. An unadmitted cancellation no longer crashes receipt polling. The optional Container resource graph is
compiled without deployment. The emitted wiki generator is exercised against actual fixture files and failed reads.

**Sandbox proof refactor regression (0018).** Two 20,000-entry ledger cases fail with native stack overflow on the
unlanded recursive candidate and pass with the original iterative traversals. Stronger contracts remain proved;
no runtime implementation change or dependency is needed. The exact admission, refusal, event and replacement
fields have executable contract-preserving mutations.

**Startup policy extraction (0018).** Existing browser/runtime startup, saved tutorial, role and Mock-switch tests
exercise the shared proved choices. Executable mutants cover query precedence, persistence actions, role membership,
tutorial state, session fallback and opposite-mode navigation, with unchanged contracts.

**Theatre policy extraction (0018).** Walkthrough tests retain real injected browser speech/storage and rendered
controls while selectors, speech priority, duplicate prevention and focus wrapping move into a proved kernel.
Guard and field mutations preserve all production contracts.

**Saved audio regression (0018).** A faulty Window Effect service returns malformed audio JSON while retaining
real native storage and host APIs. The first two and then three strengthened cases fail before shape validation;
all sixteen pass after it. Browser speech counters wrap and delegate the native APIs rather than replacing them.
The 30 affected browser cases retain pause, seek, mute, finish and Escape assertions.

**Live dispatch extraction (0018).** Public workerd sequencing, duplicate/replay, retained execution and conversation
isolation cases run the same host with the proved scan/attempt/done decisions. Guard and field mutants include
skipping an unmarked post, attempting a marked/exhausted position, and continuing after a busy refusal.

**Continuation order (0018).** Existing real-engine Post/StartTour refusal, replay, ordering and fault tests exercise
the shared begun/recorded/refused/dispatched model. Mutants cover each admission/terminal guard and invariant
field, with all older flow contracts retained.

**Issue ancestry (0018).** Existing independent generated-tree and malformed-tree tests run the unchanged iterative
link check. New mutations target positive/existing identities, ancestor exclusion, missing parents, bounded traversal,
root completion and each independent measure step. An equivalent redundant self-guard deletion is not counted.

**Reply usage integrity (0018).** Negative, fractional, NaN, infinite and unsafe settlements fail before the fix;
known valid spend is preserved afterward, including the exact safe boundary. Forty-seven contract-preserving mutants
cover initialization, safe-domain admission, all unrelated fields, the invalidity latch and completion outcomes. The
reply fuzz oracle now computes expected sums with independent BigInt arithmetic in Effect, retaining its corpus.

**Shared history decisions (0018).** Existing real-engine role/Plan/Note tests, real HTTP history clients and the
/history browser suite exercise the extracted policies. All 61 current history flow-machine mutants are rerun against
the changed source, including 45 new guard/field/label mutations; generated inputs are checked byte-for-byte.

**Reply event routing (0018).** All 61 current Reply kernel mutants rerun against the changed source, including 14 new
event-kind, ignored-event, text-only, settlement-admission, exact-charge and failure-code mutations. Existing reply
unit/workerd, full units, independent BigInt event fuzzing and affected benchmarks exercise the native projection.

**Reply body order (0018).** A real Effect logger observes counts from the real memory engine in budget/configuration
refusal and replay cases; both fail before the order log is added, then pass with exactly one completed-stage record.
Serialized annotations contain neither post text nor person name. All 102 current flow-kernel mutants are rerun,
including 59 new constructor, stage-admission, field-frame and reachable-invariant cases.

**Tour and accepted-end order (0018).** All 129 current flow-kernel mutants rerun, including 27 new end-kind, speaker
admission, exact phase/outcome and invariant cases. Existing real sequencer/engine tests assert end-before-next-reply,
speaker interruption, no late text, and unchanged content-free step observations. The three browser suites run on
4504 and retain pause/back/seek/exit, live app surface driving and both control themes/phone.

**Issue approval persistence (0016).** Repeated real HTTP reads must not turn external approval fields into saved
local gate receipts. The focused regression fails before the fix. Projections now drop external approvedBy and
approvedAt fields before persisting; only saved local receipts restore them. Actual SQLite/offline HTTP issue flows
also cover comments, parent links, task commitment, invalid content, missing targets and unchanged issue truth.

Walkthrough counter extension (0018, batch20): actual private visit/hold identities use exact BigInt plus-one; pause/seek/clock choices carry contracts and 12 new mutants. Seven regression cases include the observed native-number collision beyond 2**53. No new dependency.

**CLI/MCP identity (0028).** Real CLI processes and a persistent stdio McpClient exercise shared-device sign-in,
signed author labels, logout/revocation, refused sign-in and failed remote logout. Local workerd checks forged
names/roles/doors, current grants after demotion, person-only refusals, registered Post actions and reruns. Product
Mock sign-in has no network and preserves live credentials in a separate fixture file. The native wait uses the
already declared SDK SQLite host and Poll; its actual journal must omit device/access/session secrets. Private
settings use 0700 directories and atomic 0600 files, with faulty FileSystem permission denial. The existing label
renders the fixture agent in Chromium, and the opt-in live suite expects the agent label only with a configured
test session. No tool or dependency was added by this lane.


**Independent benchmark refresh (0017).** Benchmark-only collection now imports this decision's canonical V8
configuration after it landed. Its include list remains independent, and 100% thresholds run only after all
runtime counters join. The latest per-file source receipt is linked from the benchmark table. Native wiki
editing and emitted wiki CLI/MCP operations are included; product fixture review links are not real GitHub writes.
The complete run's behavioral assertions pass, while its strict coverage qualification remains red.

## Tool list: vendored LemmaScript (0018)

`packages/lemmascript` adds `ts-morph` 25.0.1, `tsx`, `typescript` and `@types/node` at their monorepo versions to the lockfile for
this package. `ts-morph` was already this toolchain's dependency through the npm package. All four are awaiting Will's VL-5 approval.

## Tool list: hosted auth broker (0029)

MVP now declares the monorepo's existing `vibelang-runtime` 0.0.12 for its new VibeLang Worker modules. This is awaiting Will's VL-5 approval. VibeLang's app already declares it; this lane adds no dependency or test tool there.

Benchmark runner controls exercise the real built-in runner: failed-first exact callback counts and serial Promise execution, with explicit sync/async registration (0017). No additional tool is introduced.

The resumed benchmark receipt passes 53 files / 127 tests (125 workload groups plus two real-runner controls). Its benchmark-only source-profile merge covers 5,789/6,991 src/worker lines (82.81%); the unchanged strict gate remains red for 95 files. Full methods, limitations and per-file counters: 0017 and the benchmark wiki. No new tool is added.

Hosted-broker main is independently measured by 54 benchmark files / 128 tests; 5,816/7,035 src/worker lines (82.67%), with 95 files below unchanged strict thresholds. Cookie admission and the broker-unavailable/credential-Connect fault contract are benchmarked without real OAuth. No new app tool or dependency.

Hosted-broker main is independently measured by 54 benchmark files / 128 tests; 5,827/7,036 src/worker lines (82.82%), with 95 files below unchanged strict thresholds. Cookie admission and the broker-unavailable/credential-Connect fault contract are benchmarked without real OAuth. No new app tool or dependency.

**Proof harness, lane vl-proveall2 (0018).** `verify/harness_test.py` gains a regression that a marked generic function is
found and proved; 75 executable mutations join `verify:broken` in `verify/web_mutations.py`. No new tool or dependency.

**Coverage boundary continuation (0016, 2026-11-10).** The fixture factories and sandbox accept injected faulty
Effect engines; real flows retain their typed errors, and defects keep their whole cause. Both specification
revision policies are tested with keep fixed in production. Wiki recovery links and archived status, numeric tour
stop boundaries, and real-jj seed refusal/preservation/recovery are covered. Seed refusal diagnostics keep a count
without intent payloads. Behavioral mutation controls detect each changed failure behavior. Existing Vitest and V8
5.0.0 are unchanged; this continuation adds no dependency. All strict coverage gates remain exclusive until each
passes, under the lead's recorded ruling; current unit, Chromium and isolate measurements are in 0016.


**Worker benchmark continuation (0017).** Ordinary public issue/wiki reads are now independently checked against
real anonymous GitHub, opt-in with `BENCH_PUBLIC_GITHUB=1`; the production read probe is `BENCH_SITE_READS=1`.
History/store and startup failures, chunked HTTP limits, participation/origin, streamed reply replacement, closed
sandbox tools, native agent action cancellation, Budget expiry and refused-id replay have result-checked workloads.
Intentional five-second, cache-TTL and two-minute waits are named in their methods. No tool or dependency added.
The 100% gate stays unchanged; 0017 and the benchmark wiki distinguish the measured base, focused counter unions,
deployed failures and remaining person/Container boundaries.


Worker source receipt on c5bbf81b: 82 benchmark files passed / 174 cases, one opt-in skip and a cached old-RPC failure superseded by a passing corrected API-only collection. Exact-source merged worker lines are 2,201/2,374 (92.71%); src+worker 7,355/7,716 (95.32%). All four 100% thresholds remain red for 112 files. Later main changes need a fresh full receipt; no dependency or tool was added.

Final compatibility on 479f05a3 passes typecheck, 242 unit files / 2,105 cases (one expected failure, four skips), and nine benchmark files / 22 cases (one opt-in skip). Expanded issue/wiki stale-copy checks pass separately timed and instrumented after the anonymous quota reset. No new dependency or tool. The overall strict coverage receipt remains explicitly based on c5bbf81b.
