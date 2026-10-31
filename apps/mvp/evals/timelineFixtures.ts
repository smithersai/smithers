// Realistic coding-agent conversations for evals/timeline.eval.ts: research, fixes, reviews, failures. Each exchange is
// [question, answer]; `phases` lists the exchange numbers (from 0) where a person would say a new phase starts.

export interface TimelineFixture {
  readonly name: string
  readonly exchanges: ReadonlyArray<readonly [string, string]>
  readonly phases: ReadonlyArray<number>
}

const flaky: ReadonlyArray<readonly [string, string]> = [
  ["Open issue #450", "Opened #450: Saved card test is flaky. It was reported 3 days ago and fails about one run in five on main."],
  ["What does the failure look like in CI?", "The last 6 failing runs all time out in e2e/checkout.spec.ts at \"pays with a saved card\", waiting for the iframe `payment-frame`, after 2 s."],
  ["Where does that wait come from?", "e2e/checkout.spec.ts line 88 calls `page.waitForTimeout(2000)`, then clicks inside the frame. Nothing waits for the frame to be ready."],
  ["How long does the frame really take?", "Across the last 40 CI runs: median 1.4 s, p95 2.6 s, slowest 3.1 s. So a fixed 2 s wait fails whenever the runner is slow."],
  ["Does anything else use that wait?", "Two more specs do: e2e/coupon.spec.ts line 40 and e2e/refund.spec.ts line 17, both with the same fixed 2 s wait."],
  ["Fix the saved card test first", "Replaced the wait in e2e/checkout.spec.ts with `await frame.locator('[data-ready]').waitFor()`. One line changed."],
  ["Run it 20 times", "Ran it 20 times on this branch's machine: 20 passed, slowest 3.0 s."],
  ["Do the same for the coupon and refund specs", "Changed both specs the same way. The refund spec also needed the frame locator moved into its `beforeEach`."],
  ["Run the whole e2e folder", "Ran it: 41 passed, 1 failed. e2e/refund.spec.ts:\"refunds a partial order\" expected 2 rows and found 3."],
  ["Why did the refund one fail?", "The test creates its order in `beforeEach` and the new locator runs after it, so the seed runs twice. Nothing is wrong with the app."],
  ["Move the seed into the test body", "Moved it. The spec now seeds once."],
  ["Run the e2e folder again", "Ran it: 42 passed, 0 failed."],
  ["Open a pull request for this", "Opened #512, Wait for the payment frame in e2e specs. It changes 3 files and closes #450."],
  ["Show me its checks", "Lint and typecheck passed. e2e is still running, 31 of 42 done."],
  ["Did e2e finish?", "e2e passed: 42 of 42 in 6 min 12 s."],
  ["Is there anything a reviewer would object to?", "One thing: the locator string `[data-ready]` is repeated in three specs. A helper in e2e/payment.ts would remove it."],
  ["Add that helper", "Added `paymentFrameReady(page)` to e2e/payment.ts and used it in all three specs."],
  ["Did Maya review it?", "Maya approved #512 and left one comment asking to rename the helper to `waitForPaymentFrame`."],
  ["Rename it", "Renamed it in e2e/payment.ts and all three specs, and pushed to #512."],
  ["Is it ready to merge?", "Its checks passed and Maya approved. A person merges it."],
  ["Now look at the login redirect bug, #440", "Opened #440: Login loses the page you were on. It has 7 reports since the last release."],
  ["Where does the return path get lost?", "In src/auth/redirect.ts line 9: the return path is read after `startSession` clears the cookie, so it is always empty."],
  ["Is there a test for it?", "src/auth/redirect.test.ts has one test, \"keeps the return path\". It is skipped with a TODO from March."],
  ["Unskip it and run it", "Unskipped it and ran it: it fails, expecting /cart and getting /."],
  ["Read the path before starting the session", "Moved the read above `startSession` in src/auth/redirect.ts. The test now passes."],
  ["Run all the auth tests", "Ran them: 41 passed, 1 failed. src/auth/session.test.ts:\"renews on visit\" timed out after 5 s."],
  ["Is that related?", "No. It also fails on main; the fake clock in that file was broken by the Vitest upgrade last week."],
  ["Fix the clock too", "I couldn't: the sandbox lost its connection while installing, so nothing changed."],
  ["Try again", "Fixed it: `vi.useFakeTimers` now passes `toFake: ['Date']`. All 42 auth tests pass."],
  ["Open a pull request", "Opened #513, Read the return path before the session starts. It changes 3 files and closes #440."],
  ["What changed since v2.3.0?", "14 pull requests merged since v2.3.0: 9 fixes, 4 features and 1 docs change."],
  ["Draft the release notes", "Drafted them as a TODO, fixes first, then features. Edit it and press Commit."],
  ["Which issues does it close?", "Eleven: #405, #418, #422, #433, #440, #441, #444, #450, #452, #460 and #463."],
  ["Run all the tests for the release", "Ran them: 248 passed, 1 failed. src/receipt.test.tsx:\"renders the receipt\": its snapshot has the old rounding."],
  ["Update that snapshot", "Updated the receipt snapshot on this branch."],
  ["Open the release pull request", "Opened #514, Release v2.4.0."],
]

const issues: ReadonlyArray<readonly [string, string]> = [
  ["Which open issues are bugs?", "Of 23 open issues, 9 are bugs: #401, #405, #409, #412, #418, #420, #422, #425 and #433."],
  ["Label them bug", "Labeled 9 issues bug."],
  ["Which ones mention checkout?", "Three: #405, #418 and #422."],
  ["Open #418", "Opened #418: Coupon field clears on back."],
  ["Find the cause", "In src/checkout/CouponField.tsx line 27: the code lives in the field's own state, so leaving the page drops it."],
  ["Draft a TODO to fix it", "Drafted. Edit it and press Commit."],
  ["Create a flow that labels new issues", "Here is its form, with northwind/shop filled in. Answer what you like, then press Create."],
  ["Run it on the last 10 issues", "It ran: 6 bug, 3 enhancement, 1 question."],
  ["Why is #431 a question?", "It asks how to export orders as CSV; nothing in it is broken."],
  ["Open that run", "Opened the run. Its classify step took 1.2 s."],
  ["Show open pull requests", "5 are open; #96 Fix coupon rounding is the newest."],
  ["Show the diff of #96", "The diff is open. Most of it is in src/money.ts; the test adds two cases."],
  ["Is #96 ready to merge?", "Its checks passed and one reviewer approved it. A person merges it."],
  ["Does it round the same way Stripe does?", "Yes: it rounds the total, which matches what Stripe charges."],
]

const oneGoal: ReadonlyArray<readonly [string, string]> = [
  ["Upgrade Vitest to 3.2 in the web package", "Bumped vitest to 3.2.0 in packages/web/package.json and updated the lockfile."],
  ["Run the web tests", "Ran them: 188 passed, 12 failed, all in src/charts with `vi.mock` hoisting errors."],
  ["Why those?", "They call `vi.mock` inside a helper; 3.2 requires it at the top of the file."],
  ["Fix them", "Moved the calls to the top of 12 files in src/charts."],
  ["Run them again", "Ran them: 196 passed, 4 failed in src/charts/legend.test.tsx, snapshot differences in whitespace."],
  ["Are those real differences?", "No: 3.2 changed how snapshots serialize empty text nodes."],
  ["Update those snapshots", "Updated 4 snapshots in src/charts/__snapshots__."],
  ["Run everything once more", "Ran them: 200 passed, 0 failed."],
  ["Commit it", "Committed: chore(web): upgrade Vitest to 3.2."],
  ["Open a pull request", "Opened #88, Upgrade Vitest to 3.2. Its checks are running."],
]

export const TIMELINE_FIXTURES: ReadonlyArray<TimelineFixture> = [
  { name: "long-coding-chat", exchanges: flaky, phases: [0, 5, 12, 20, 30] },
  { name: "issues-flows-review", exchanges: issues, phases: [0, 6, 10] },
  { name: "one-goal-with-failures", exchanges: oneGoal, phases: [0] },
]

/** Boundaries matched within one exchange: precision and recall of `found` against `truth`, as F1. Item 0 doesn't count. */
export const boundaryF1 = (found: ReadonlyArray<number>, truth: ReadonlyArray<number>): number => {
  const made = found.filter(at => at > 0), real = truth.filter(at => at > 0)
  if (made.length === 0 && real.length === 0) return 1
  if (made.length === 0 || real.length === 0) return 0
  const taken = new Set<number>()
  let hits = 0
  for (const at of made) {
    const match = real.find(candidate => !taken.has(candidate) && Math.abs(candidate - at) <= 1)
    if (match !== undefined) { taken.add(match); hits++ }
  }
  const precision = hits / made.length, recall = hits / real.length
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)
}
