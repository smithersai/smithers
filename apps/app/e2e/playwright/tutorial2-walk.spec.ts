/*
 * The onboarding tutorial, script v4 (~/Desktop/smithers-tutorial/SCRIPT.md
 * section 5, "E2E test plan"). One walk covers every beat, keyboard first,
 * at 1280x800 in the light theme with reduced motion and a fake clock, and
 * writes one screenshot per beat to apps/app/tutorial2-shots/.
 *
 * Beats 0–9 run on the bundled practice repository and must make ZERO
 * requests off this machine: the walk records every request and asserts it.
 * No lesson signal is injected: every check comes from the real producer.
 * Beats 10–12 cross the boundary doubles in tutorial-stubs.ts.
 *
 * SMITHERS_TUTORIAL_LIVE=1 adds the @live test: beats 10–12 against a real
 * host with a signed-in browser profile. It is opt-in and never runs in CI.
 */
import { chromium, expect, test, type Locator, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { GUIDE_STAGES, lessonMessage, lessonText } from "../../src/mainview/onboarding/lessons"
import { REEL_BUTTON } from "../../src/mainview/onboarding/reel"
import commitsFixture from "../../src/mainview/state/practice/hello-server/commits.json"
import stack23 from "../../src/mainview/state/practice/hello-server/stacks/2-3.json"
import { INSTALLED_REPO, launchedFlows, stubTutorialHost, TUTORIAL_LOGIN, type TutorialHost } from "./tutorial-stubs"

/* Playwright loads specs as CommonJS, so the output directory resolves from __dirname. */
const SHOTS = join(__dirname, "..", "..", "tutorial2-shots")
const START = new Date("2026-09-10T12:00:00Z")

test.use({ contextOptions: { reducedMotion: "reduce" }, viewport: { width: 1280, height: 800 }, colorScheme: "light" })
/* Every wait pumps the paused clock one round trip at a time, so a walk through two page hops needs room. */
test.setTimeout(240_000)

const shell = (page: Page) => page.locator(".guide-shell")
const card = (page: Page, kind: string) => page.locator(`[data-tutorial-cards] section.smithers-card[data-kind="${kind}"]`)
const line = (page: Page, step: number) => page.locator(`[data-message-step="${step}"] p[data-line="1"]`)
const followup = (page: Page, step: number) => page.locator(`[data-message-step="${step}"] [data-followup]`)
const stageOf = async (page: Page) => Number(await shell(page).getAttribute("data-stage"))

/*
 * Time moves only on command. The clock is paused once the shell is up, and
 * the app's own scheduler (Effect, persistence) runs on timers too, so every
 * wait pumps fake time in small steps until the state it expects holds. Small
 * steps stop exactly on a beat: a say-beat after a do-beat is observable
 * before its own read pause fires.
 */
const pumpUntil = async (page: Page, what: string, done: () => Promise<boolean>, step = 10, max = 1500) => {
  for (let i = 0; i < max; i++) {
    if (await done()) return
    await page.clock.runFor(step)
  }
  throw new Error(`Timed out pumping the clock until ${what}`)
}
const until = (page: Page, locator: Locator, what = "a locator is visible") =>
  pumpUntil(page, what, async () => await locator.first().isVisible().catch(() => false))
const gone = (page: Page, locator: Locator, what = "a locator is gone") => pumpUntil(page, what, async () => (await locator.count()) === 0)
const advanceTo = (page: Page, value: number) => pumpUntil(page, `data-stage=${value}`, async () => (await stageOf(page)) === value, 25)
const atStage = async (page: Page, value: number) => {
  await advanceTo(page, value)
  await expect(shell(page)).toHaveAttribute("data-stage", String(value))
}
/** Let fake time pass without waiting on anything (a do-beat's 0.9 s hold is longer than this). */
const tick = async (page: Page, ms = 100) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) await page.clock.runFor(25)
}
const shoot = async (page: Page, index: number) => {
  await page.screenshot({ path: join(SHOTS, `stage-${String(index).padStart(2, "0")}.png`) })
}

const boot = async (page: Page, baseURL: string | undefined): Promise<TutorialHost> => {
  mkdirSync(SHOTS, { recursive: true })
  const host = await stubTutorialHost(page, baseURL ?? "http://127.0.0.1:47311")
  // Boot needs running timers; once the shell is up, time moves only on command.
  await page.clock.install({ time: START })
  await page.goto("/")
  await shell(page).waitFor()
  await expect(shell(page)).toHaveAttribute("data-theme", "light")
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(now + 5))
  if (await stageOf(page) === 0) {
    await page.getByRole("button", { name: "Start tutorial" }).click()
    await advanceTo(page, 1)
  }
  return host
}
/** A reload under the paused clock (the OAuth and install hops): pump until the shell is back. */
const rebooted = (page: Page) => pumpUntil(page, "the app is back after the hop", async () => await shell(page).isVisible().catch(() => false), 25)

/** The line equals the table's copy, and each pill shows its label and its key chip. */
const expectBeat = async (page: Page, step: number, guide: { repo?: string; declined?: Array<string> } = {}) => {
  await atStage(page, step)
  await expect(line(page, step)).toHaveText(lessonMessage(step, guide))
  const lesson = GUIDE_STAGES[step]!
  if (lesson.kind !== "do") return
  for (const action of lesson.actions) {
    const pill = page.locator(`.guide-actions button.guide-primary[data-flow="${action.flow}"]`)
    await expect(pill).toBeVisible()
    await expect(pill).toContainText(lessonText(action.label, guide))
    await expect(pill.locator("kbd")).toHaveText(action.key)
  }
  if (lesson.secondary !== undefined) {
    const secondary = page.locator(".guide-actions [data-secondary]")
    await expect(secondary).toContainText(lesson.secondary.label)
    await expect(secondary.locator("kbd")).toHaveText(lesson.secondary.key)
  }
}

/** A do-beat by its key: the real producer's check and follow-up line land; the 0.9 s hold has not fired yet. */
const doBeat = async (page: Page, step: number, key: string) => {
  await page.keyboard.press(key)
  await until(page, followup(page, step).locator(".guide-step-done"), `beat ${step} is checked`)
  const lesson = GUIDE_STAGES[step]!
  if (lesson.kind === "do" && lesson.success !== undefined) await expect(followup(page, step)).toContainText(lesson.success)
  await atStage(page, step)
}
const goalMark = (page: Page, goal: string): Locator => page.locator(`.guide-goal [data-checkpoint="${goal}"]`)

/** Keyboard through the practice beats to the picker (beat 8). */
const toPicker = async (page: Page) => {
  for (const [step, key] of [[1, "i"], [2, "r"], [3, "p"], [4, "o"], [5, "f"], [6, "g"], [7, "t"]] as const) {
    await atStage(page, step)
    await doBeat(page, step, key)
  }
  await atStage(page, 8)
  await expect(card(page, "commit-pick")).toBeVisible()
}

test("the whole tutorial walks every beat, keyboard first, offline through beat 9", async ({ page, baseURL }) => {
  const host = await boot(page, baseURL)

  // Beat 0: both greeting lines and the goal card with four empty checkpoints; it advances with no input.
  // The boot helper explicitly starts the tutorial.
  await expect(line(page, 0)).toHaveText(lessonMessage(0, {}))
  await expect(page.locator('[data-message-step="0"] p[data-line="2"]')).toHaveCount(0)
  await expect(page.locator(".guide-goal [data-checkpoint]")).toHaveCount(4)
  await expect(page.locator('.guide-goal [data-done="true"]')).toHaveCount(0)
  await expect(page.locator(".guide-repo-chip[data-practice]")).toContainText("hello-server")
  await shoot(page, 0)

  // Beat 1: Show issues · I — #3 and #2, #3 labelled good first issue and highlighted.
  await expectBeat(page, 1)
  await shoot(page, 1)
  await doBeat(page, 1, "i")
  const issues = card(page, "issue-list")
  await expect(issues.locator("[data-issue]")).toHaveCount(2)
  await expect(issues.locator("[data-issue]").first()).toHaveAttribute("data-issue", "3")
  await expect(issues.locator('[data-issue="3"]')).toHaveAttribute("data-good-first", "true")
  await expect(issues.locator('[data-issue="3"] [data-label="good first issue"]')).toBeVisible()
  await expect(issues.locator("[data-practice]")).toHaveText("Practice")

  // Beat 2: Read issue #3 · R — the body shows the bug; the Issue checkpoint fills.
  await expectBeat(page, 2)
  await doBeat(page, 2, "r")
  await expect(card(page, "issue")).toContainText(`GET /hello without a name replies "Hello, null!"`)
  await expect(card(page, "issue")).toContainText(/Actual:\s+Hello, null!/)
  await expect(goalMark(page, "issue")).toHaveAttribute("data-done", "true")
  await shoot(page, 2)

  // Beat 3: Show pull requests · P — Mira's logging PR touches server.ts, not hello.ts.
  await expectBeat(page, 3)
  await doBeat(page, 3, "p")
  // The GitHub-style row (cards/LandingCards.tsx): title, number, author and the branch it comes from.
  await expect(card(page, "pr-list")).toContainText("Add request logging")
  await expect(card(page, "pr-list")).toContainText("#4")
  await expect(card(page, "pr-list")).toContainText("Mira Chen")
  await expect(card(page, "pr-list")).toContainText("mira/request-logging")
  await expect(card(page, "pr-list").locator("[data-landing-files]")).toContainText("src/server.ts")
  await shoot(page, 3)

  // Beat 4: Open hello.ts · O — the file card is anchored on line 2.
  await expectBeat(page, 4)
  await doBeat(page, 4, "o")
  const file = card(page, "file")
  await expect(file).toContainText("src/hello.ts")
  await expect(file.locator('[data-line="2"]')).toBeVisible()
  await expect(file).toContainText("`Hello, ${name}!`")
  await shoot(page, 4)

  // Beat 5: Plan the fix · F — three commits in order, tagged optional / required / recommended.
  await expectBeat(page, 5)
  await doBeat(page, 5, "f")
  const plan = page.locator('[data-tutorial-cards] [data-testid="card-practice-plan"]')
  await expect(plan.locator("[data-planned-commit]")).toHaveCount(3)
  await expect(plan.locator("[data-planned-commit]")).toHaveText([/Document the \/hello default in README.*optional/, /Default greet\(\) name to "world".*required/, /Test \/hello without a name.*recommended/])
  await expect(plan.locator('[data-plan-check="npm-test"]')).toContainText("npm test")
  await expect(goalMark(page, "plan")).toHaveAttribute("data-done", "true")
  await shoot(page, 5)

  // Beat 6: Go ahead · G — the recorded run: red before green, three commits whose ids equal commits.json.
  await expectBeat(page, 6)
  await doBeat(page, 6, "g")
  const run = page.locator('[data-tutorial-cards] [data-testid="card-flow-run-practice-fix-hello-3"]')
  await expect(run.locator("[data-run-steps]")).toContainText("3 commits on smithers/fix-hello-3")
  const steps = await run.locator("[data-run-steps] li").allTextContents()
  expect(steps.indexOf("Fails on the old code: Hello, null! (expected)")).toBeLessThan(steps.indexOf("2 tests pass"))
  expect(steps.indexOf("Fails on the old code: Hello, null! (expected)")).toBeGreaterThanOrEqual(0)
  const picker = card(page, "commit-pick")
  await expect(picker.locator("[data-commit-id]")).toHaveCount(3)
  expect(await picker.locator("[data-commit-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-commit-id"))))
    .toEqual(commitsFixture.commits.map(commit => commit.commitId))
  await expect(goalMark(page, "commits")).toHaveAttribute("data-done", "true")
  await shoot(page, 6)

  // Beat 7: Open the trace · T — the src/hello.ts edit turn: its source and its calls; ↓ moves the selection.
  await expectBeat(page, 7)
  await doBeat(page, 7, "t")
  const selectedTurn = run.locator('.run-turn[aria-pressed="true"]')
  await expect(selectedTurn).toContainText("Edit src/hello.ts")
  await expect(run.getByRole("region", { name: "Recorded turn source" })).toContainText(`name || "world"`)
  await expect(run.locator('[data-trace-span][data-kind="call"]').first()).toBeVisible()
  await shoot(page, 7)
  await page.keyboard.press("ArrowDown")
  await until(page, run.locator('.run-turn[aria-pressed="true"]', { hasText: "Document the default in the README." }), "the down arrow selects the next turn")
  await page.keyboard.press("ArrowUp")
  await until(page, run.locator('.run-turn[aria-pressed="true"]', { hasText: "Edit src/hello.ts" }), "the up arrow selects the edit turn")

  // Beat 8: uncheck the README commit with 1; 2 is locked; Make the Change · M turns the picker into the stack.
  await expectBeat(page, 8)
  await page.keyboard.press("1")
  await until(page, picker.locator('[data-pick-row="1"][data-picked="false"]'), "row 1 unchecks")
  await page.keyboard.press("2")
  await tick(page)
  await expect(picker.locator('[data-pick-row="2"]')).toHaveAttribute("data-picked", "true")
  await shoot(page, 8)
  await doBeat(page, 8, "m")
  const change = card(page, "change")
  await expect(card(page, "commit-pick")).toHaveCount(0)
  await expect(change.getByTestId("change-stack-header")).toHaveText("Change #1 · stack of 2 · target main · checks ✓ · Practice")
  await expect(change.locator(".change-stack")).toHaveAttribute("data-stack-size", "2")
  await expect(change.locator(".change-stack")).toHaveAttribute("data-target", "main")
  await expect(change.locator('[data-stack-row="1"] .change-stack-message')).toHaveText(`Default greet() name to "world"`)
  await expect(change.locator('[data-stack-row="2"] .change-stack-message')).toHaveText("Test /hello without a name")
  await expect(change).not.toContainText("Document the /hello default in README")
  for (const [position, row] of stack23.rows.entries()) {
    const chip = change.locator(`[data-stack-row="${position + 1}"] .change-stack-rebased`)
    await expect(chip).toHaveAttribute("data-from", row.rebased.from)
    await expect(chip).toHaveAttribute("data-to", row.rebased.to)
    await expect(change.locator(`[data-stack-row="${position + 1}"]`)).toHaveAttribute("data-change-id", row.changeId)
  }
  await expect(followup(page, 8)).toContainText("Rebased 2 commits onto main. Change #1 is ready for review.")
  await expect(page.locator(".guide-goal")).toHaveAttribute("data-goal-state", "complete")

  // Beat 9: the loop, named; the goal card is complete. Nothing has left the machine since beat 0.
  await expectBeat(page, 9)
  await shoot(page, 9)
  expect(host.external()).toEqual([])

  // Beat 10: the bridge. The practice chip gives way to "Your repository"; Log in · L, Not now · X.
  await expectBeat(page, 10)
  await expect(page.locator(".guide-repo-chip[data-your-repo]")).toHaveText("Your repository")
  await expect(page.locator(".guide-repo-chip[data-practice]")).toHaveCount(0)
  await expect(page.locator("[data-tutorial-cards] [data-practice]")).toHaveCount(0)
  await shoot(page, 10)
  await page.keyboard.press("l")
  await rebooted(page)
  await until(page, followup(page, 10), "login is checked")
  await expect(followup(page, 10)).toContainText(`Signed in as @${TUTORIAL_LOGIN}.`)

  // Beat 11: Install the GitHub App · A — GitHub's page, then the setup-URL return, verified on the server.
  await expectBeat(page, 11)
  await shoot(page, 11)
  await page.keyboard.press("a")
  await rebooted(page)
  await until(page, followup(page, 11), "the install is verified")
  await expect(followup(page, 11)).toContainText(`I can see ${INSTALLED_REPO}.`)
  expect(host.verifyCalls).toBe(1)
  await expect(page.locator(".guide-repo-chip[data-your-repo]")).toHaveText(INSTALLED_REPO)
  expect(new URL(page.url()).search).toBe("")

  // Beat 12: Create Wiki · W, Create Mythical history · H — two launches, two chips, no run card opened.
  await expectBeat(page, 12, { repo: INSTALLED_REPO })
  await expect(page.locator(".guide-primary-subtitle")).toHaveText("On its own branch. Your branches stay untouched.")
  await page.keyboard.press("w")
  await until(page, page.locator('[data-run-chip="wiki"]'), "the Wiki run chip")
  await page.keyboard.press("h")
  await until(page, page.locator('[data-run-chip="history"]'), "the history run chip")
  await until(page, followup(page, 12), "both runs launched")
  await expect(followup(page, 12)).toContainText("Both are running. I'll tell you when they're done.")
  expect(launchedFlows(host)).toEqual([`librarian/wiki ${INSTALLED_REPO}`, `librarian/history ${INSTALLED_REPO}`])
  await shoot(page, 12)

  // Beat 13: ⌘K opens the palette with Ask Smithers first; Escape closes it.
  await expectBeat(page, 13, { repo: INSTALLED_REPO })
  await expect(page.locator('.guide-footer [data-pulse="true"]')).toBeVisible()
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByTestId("palette")
  await until(page, palette, "the palette opens")
  await expect(palette.getByRole("option").first()).toHaveText(/Ask Smithers/)
  await shoot(page, 13)
  await page.keyboard.press("Escape")
  await gone(page, palette, "Escape closes the palette")
  await expect(followup(page, 13)).toContainText("That's me. Esc closes it.")

  // Beat 14: terminal, on acme/api, with the run chips still in the chrome and the reel on E.
  await expectBeat(page, 14, { repo: INSTALLED_REPO })
  const more = page.getByRole("button", { name: /What else can you do/ })
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute("aria-keyshortcuts", REEL_BUTTON.key.toLowerCase())
  await expect(page.locator(".guide-location")).toContainText(INSTALLED_REPO)
  await expect(page.locator('[data-run-chip="wiki"]')).toBeVisible()
  await tick(page, 5_000)
  await expect(shell(page)).toHaveAttribute("data-stage", "14")
  await shoot(page, 14)
})

test.describe("beat 8: all four picks keep the fix and precompute the stack", () => {
  const cases = [
    { pick: [2, 3], toggle: ["1"], size: 2, rebased: 2, line: "Rebased 2 commits onto main. Change #1 is ready for review." },
    { pick: [1, 2, 3], toggle: [], size: 3, rebased: 0, line: "Already in order. Change #1 is a stack of 3." },
    { pick: [1, 2], toggle: ["3"], size: 2, rebased: 0, line: "Already in order. Change #1 is a stack of 2." },
    { pick: [2], toggle: ["1", "3"], size: 1, rebased: 1, line: "Rebased 1 commit onto main. Change #1 is ready for review." },
  ] as const
  for (const row of cases) {
    test(`{${row.pick.join(", ")}}: stack of ${row.size}, ${row.rebased} rebased`, async ({ page, baseURL }) => {
      const host = await boot(page, baseURL)
      await toPicker(page)
      for (const key of row.toggle) await page.keyboard.press(key)
      await until(page, card(page, "commit-pick").locator(`section.commit-pick[data-picked="${row.pick.join(" ")}"]`), "the pick is set")
      await page.keyboard.press("m")
      const change = card(page, "change")
      await until(page, change, "the stack view")
      await expect(change.locator(".change-stack")).toHaveAttribute("data-stack-size", String(row.size))
      const messages = await change.locator(".change-stack-row").evaluateAll(nodes =>
        nodes.map(node => [Number(node.getAttribute("data-stack-row")), node.querySelector(".change-stack-message")?.textContent ?? ""] as const)
          .sort((a, b) => a[0] - b[0]).map(([, message]) => message))
      expect(messages).toEqual(row.pick.map(index => commitsFixture.commits[index - 1]!.message))
      await expect(change.locator(".change-stack-rebased")).toHaveCount(row.rebased)
      await expect(followup(page, 8)).toContainText(row.line)
      expect(host.external()).toEqual([])
    })
  }

  test("the locked fix stays in, and Back from the stack view restores the picker with the previous pick", async ({ page, baseURL }) => {
    await boot(page, baseURL)
    await toPicker(page)
    await page.keyboard.press("2")
    await tick(page)
    const pickRow = (index: number) => card(page, "commit-pick").locator(`[data-pick-row="${index}"]`)
    await expect(pickRow(2)).toHaveAttribute("data-picked", "true")
    await page.keyboard.press("1")
    await until(page, pickRow(1).and(page.locator('[data-picked="false"]')), "row 1 unchecks")
    await page.keyboard.press("m")
    await until(page, card(page, "change"), "the stack view")
    await until(page, followup(page, 8), "the Change is recorded")
    await page.keyboard.press("ArrowLeft")
    await until(page, card(page, "commit-pick"), "Back restores the picker")
    await expect(shell(page)).toHaveAttribute("data-stage", "8")
    await expect(pickRow(1)).toHaveAttribute("data-picked", "false")
    await expect(pickRow(2)).toHaveAttribute("data-picked", "true")
    await expect(pickRow(3)).toHaveAttribute("data-picked", "true")
    await expect(followup(page, 8)).toHaveCount(0)
  })
})

test.describe("escape hatches", () => {
  test("Skip practice (Q) on beat 3 lands on the bridge and marks the goal Skipped", async ({ page, baseURL }) => {
    await boot(page, baseURL)
    await atStage(page, 1)
    await doBeat(page, 1, "i")
    await atStage(page, 2)
    await doBeat(page, 2, "r")
    await atStage(page, 3)
    await page.keyboard.press("q")
    await atStage(page, 10)
    await expect(page.locator(".guide-goal")).toHaveAttribute("data-goal-state", "skipped")
    await expect(page.locator(".guide-goal")).toContainText("Skipped")
  })

  test("Not now (X) at login skips beats 11 and 12; the workspace stays on hello-server", async ({ page, baseURL }) => {
    const host = await boot(page, baseURL)
    await atStage(page, 1)
    await page.keyboard.press("q")
    await atStage(page, 10)
    await page.keyboard.press("x")
    await atStage(page, 13)
    await page.keyboard.press("ControlOrMeta+k")
    await until(page, page.getByTestId("palette"), "the palette opens")
    await page.keyboard.press("Escape")
    await expectBeat(page, 14, { declined: ["login"] })
    await expect(line(page, 14)).toHaveText("You're set. Log in from Account whenever you want to bring your own repository.")
    await expect(page.locator(".guide-location .guide-repo-chip[data-practice]")).toContainText("hello-server")
    expect(host.external()).toEqual([])
  })

  test("Later (Z) at install skips the background runs and says where to pick up", async ({ page, baseURL }) => {
    await boot(page, baseURL)
    await atStage(page, 1)
    await page.keyboard.press("q")
    await atStage(page, 10)
    await page.keyboard.press("l")
    await rebooted(page)
    await until(page, followup(page, 10), "login is checked")
    await expect(followup(page, 10)).toContainText(`Signed in as @${TUTORIAL_LOGIN}.`)
    await atStage(page, 11)
    await page.keyboard.press("z")
    await atStage(page, 13)
    await page.keyboard.press("ControlOrMeta+k")
    await until(page, page.getByTestId("palette"), "the palette opens")
    await page.keyboard.press("Escape")
    await expectBeat(page, 14, { declined: ["install"] })
  })
})

test("every practice pill, clicked, calls the same flow as its key", async ({ page, baseURL }) => {
  const host = await boot(page, baseURL)
  for (const step of [1, 2, 3, 4, 5, 6, 7]) {
    await atStage(page, step)
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind !== "do") throw new Error(`beat ${step} asks for no action`)
    await page.locator(`.guide-actions button.guide-primary[data-flow="${lesson.actions[0]!.flow}"]`).click()
    await until(page, followup(page, step).locator(".guide-step-done"), `beat ${step} is checked`)
  }
  await atStage(page, 8)
  await card(page, "commit-pick").locator('[data-pick-row="1"] input').click()
  await until(page, card(page, "commit-pick").locator('[data-pick-row="1"][data-picked="false"]'), "the checkbox unchecks row 1")
  await page.locator('.guide-actions button.guide-primary[data-flow="change.open"]').click()
  await until(page, card(page, "change"), "the stack view")
  await expect(card(page, "change").locator(".change-stack")).toHaveAttribute("data-stack-size", "2")
  expect(host.external()).toEqual([])
})

/*
 * @live: beats 10–12 against a real host (default the dev app on :8787) with a
 * persistent, already-signed-in browser profile (multi-test-github-account).
 * Asserts that the runs LAUNCHED (or that the lesson said honestly why not),
 * never that they finished.
 */
test("@live beats 10–12 cross the real login, install check and background launches", async () => {
  test.skip(process.env.SMITHERS_TUTORIAL_LIVE !== "1", "opt-in: SMITHERS_TUTORIAL_LIVE=1")
  test.setTimeout(300_000)
  const base = process.env.SMITHERS_TUTORIAL_BASE_URL ?? "http://127.0.0.1:8787"
  const profile = process.env.SMITHERS_TUTORIAL_PROFILE
  if (profile === undefined) throw new Error("Set SMITHERS_TUTORIAL_PROFILE to the signed-in test profile directory.")
  const context = await chromium.launchPersistentContext(profile, { baseURL: base, reducedMotion: "reduce", viewport: { width: 1280, height: 800 } })
  const page = context.pages()[0] ?? await context.newPage()
  try {
    await page.goto("/")
    await page.keyboard.press("s").catch(() => {})
    await shell(page).waitFor({ timeout: 60_000 })
    if (Number(await shell(page).getAttribute("data-stage")) < 10) {
      await page.keyboard.press("q")
      await atStage(page, 10)
    }
    await page.keyboard.press("l")
    await expect(followup(page, 10)).toContainText("Signed in as @", { timeout: 120_000 })
    await atStage(page, 11)
    await page.keyboard.press("a")
    await expect(followup(page, 11).or(page.locator("[data-notice]"))).toBeVisible({ timeout: 120_000 })
    if (await followup(page, 11).count() === 1) {
      await atStage(page, 12)
      await page.keyboard.press("w")
      await page.keyboard.press("h")
      await expect(page.locator("[data-run-chip]").or(page.locator("[data-tutorial-cards] .smithers-card")).first()).toBeVisible({ timeout: 120_000 })
    }
  } finally {
    await context.close()
  }
})
