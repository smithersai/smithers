/*
 * The onboarding tutorial, script v4 (~/Desktop/smithers-tutorial/SCRIPT.md
 * section 5, "E2E test plan"). One walk covers every beat, keyboard first,
 * at 1280x800 in the light theme with reduced motion and a fake clock, and
 * writes one screenshot per beat to apps/app/tutorial2-shots/.
 *
 * Beats 0–9 call the anonymous live API through deterministic test doubles.
 * No test requests leave this machine; every operation is recorded and checked.
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
  await page.clock.pauseAt(new Date(now + 1000))
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
  if (lessonMessage(step, guide) === "") await expect(line(page, step)).toHaveCount(0)
  else await expect(line(page, step)).toHaveText(lessonMessage(step, guide))
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
  if (GUIDE_STAGES[step]?.message === "") { await atStage(page, step + 1); return }
  await until(page, followup(page, step).locator(".guide-step-done"), `beat ${step} is checked`)
  const lesson = GUIDE_STAGES[step]!
  if (lesson.kind === "do" && lesson.success !== undefined) await expect(followup(page, step)).toContainText(lesson.success)
  await atStage(page, step)
}
const goalMark = (page: Page, goal: string): Locator => page.locator(`.guide-goal [data-checkpoint="${goal}"]`)

/** Keyboard through the practice beats to the picker (beat 8). */
const toPicker = async (page: Page) => {
  for (const [step, key] of [[1, "i"], [2, "r"], [3, "e"], [4, "r"], [5, "f"], [6, "g"], [7, "d"], [8, "o"]] as const) {
    await atStage(page, step)
    await doBeat(page, step, key)
  }
  await atStage(page, 9)
  await expect(card(page, "commit-pick")).toBeVisible()
}

test("the whole tutorial walks every beat, keyboard first, through asynchronous live API doubles", async ({ page, baseURL }) => {
  const host = await boot(page, baseURL)

  // Beat 0: both greeting lines and the goal card with four empty checkpoints; it advances with no input.
  // The boot helper explicitly starts the tutorial.
  await expect(line(page, 0)).toHaveText(lessonMessage(0, {}))
  await expect(page.locator('[data-message-step="0"] p[data-line="2"]')).toHaveCount(0)
  await expect(page.locator(".guide-goal [data-checkpoint]")).toHaveCount(4)
  await expect(page.locator('.guide-goal [data-done="true"]')).toHaveCount(0)
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
  await expect(issues.locator("[data-practice]")).toHaveCount(0)

  // Beat 2: Read issue #3 · R — the body shows the bug; the Issue checkpoint fills.
  await expectBeat(page, 2)
  await doBeat(page, 2, "r")
  await expect(card(page, "issue")).toContainText(`GET /hello without a name replies "Hello, null!"`)
  await expect(card(page, "issue")).toContainText(/Actual:\s+Hello, null!/)
  await expect(goalMark(page, "issue")).toHaveAttribute("data-done", "true")
  await shoot(page, 2)

  // Issue navigation keeps the list's frame; the official flow view shows the actual repro prompt.
  await expect(card(page, "issue-list")).toHaveCount(0)
  await expect(card(page, "issue")).toHaveCount(1)
  await expect(card(page, "issue").getByRole("button", { name: "Back in frame" })).toBeEnabled()
  await expectBeat(page, 3)
  await doBeat(page, 3, "e")
  const flowView = card(page, "workflow-list")
  await expect(flowView).toContainText("issue.repro")
  await expect(flowView).toContainText("Do not implement the fix")
  await shoot(page, 3)

  await expectBeat(page, 4)
  await doBeat(page, 4, "r")
  await expect(card(page, "run-trace")).toContainText("Relevant source: src/hello.ts")
  expect(host.live.find(call => call.operation === "research")).toBeDefined()
  await shoot(page, 4)

  // Beat 5: Plan the fix · F — three commits in order, returned by the live planning operation.
  await expectBeat(page, 5)
  await doBeat(page, 5, "f")
  const plan = page.locator('[data-tutorial-cards] [data-testid="card-practice-plan"]')
  await expect(plan).toContainText("Document the /hello default in README")
  await expect(plan).toContainText('Default greet() name to "world"')
  await expect(plan).toContainText("Test /hello without a name")
  await expect(goalMark(page, "plan")).toHaveAttribute("data-done", "true")
  await shoot(page, 5)

  // Beat 6: Go ahead · G — the asynchronous implementation returns three fixture-derived commits.
  await expectBeat(page, 6)
  await doBeat(page, 6, "g")
  const run = page.locator('[data-tutorial-cards] [data-testid="card-flow-run-practice-fix-hello-3"]')
  await expect(run).toContainText("3 commits on smithers/fix-hello-3")
  expect(host.live.find(call => call.operation === "implement")?.body.planId).toBe("fixture-live-plan")
  await expect(plan.getByRole("button", { name: "Start implementation", exact: true })).toHaveCount(0)
  await expect(plan).toContainText("Implementation started")
  expect(host.livePolls.length).toBeGreaterThanOrEqual(6)
  const picker = card(page, "commit-pick")
  await expect(picker.locator("[data-commit-id]")).toHaveCount(3)
  expect(await picker.locator("[data-commit-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-commit-id"))))
    .toEqual(commitsFixture.commits.map(commit => commit.commitId))
  await expect(goalMark(page, "commits")).toHaveAttribute("data-done", "true")
  await shoot(page, 6)

  // Review the diff, then open the file inside that frame.
  await expectBeat(page, 7)
  await doBeat(page, 7, "d")
  const diff = card(page, "diff")
  await expect(diff).toContainText("src/hello.ts")
  await shoot(page, 7)
  await expectBeat(page, 8)
  await doBeat(page, 8, "o")
  await expect(card(page, "diff")).toHaveCount(0)
  await expect(card(page, "file")).toContainText('name || "world"')
  await expect(card(page, "file").getByRole("button", { name: "Back in frame" })).toBeEnabled()
  await shoot(page, 8)

  // Beat 9: uncheck the README commit with 1; Make the Change sends the selected actual commits.
  await expectBeat(page, 9)
  await page.keyboard.press("1")
  await until(page, picker.locator('[data-pick-row="1"][data-picked="false"]'), "row 1 unchecks")
  await shoot(page, 9)
  await doBeat(page, 9, "m")
  const change = card(page, "change")
  await expect(card(page, "commit-pick")).toHaveCount(0)
  await expect(change).toContainText("2 commits selected for review")
  expect(host.live.find(call => call.operation === "change")?.body.commitIds).toEqual(commitsFixture.commits.slice(1).map(commit => commit.commitId))
  await expect(page.locator(".guide-goal")).toHaveAttribute("data-goal-state", "complete")

  expect(host.external()).toEqual([])

  // Beat 10: the bridge. The practice cards step aside; Log in · L, Not now · X.
  await expectBeat(page, 10)
  await expect(page.locator("[data-tutorial-cards] [data-practice]")).toHaveCount(0)
  await shoot(page, 10)
  await page.keyboard.press("l")
  await rebooted(page)
  await until(page, followup(page, 10), "login is checked")
  await expect(followup(page, 10)).toContainText(`Signed in as @${TUTORIAL_LOGIN}.`)

  // Beat 11: Install the GitHub App · A — GitHub's page, then the setup-URL return, verified on the server.
  await expectBeat(page, 11)
  await shoot(page, 11)
  const beforeInstallUrl = page.url()
  const popupReady = page.context().waitForEvent("page")
  await page.keyboard.press("a")
  await pumpUntil(page, "GitHub install page opens", async () => host.installed)
  const installPage = await popupReady
  await installPage.waitForLoadState("domcontentloaded")
  expect(installPage.url()).toContain("github.com/apps/smitherspreviewrelease/installations/new")
  await installPage.close()
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  expect(page.url()).toBe(beforeInstallUrl)
  await until(page, followup(page, 11), "the install is verified")
  await expect(followup(page, 11)).toContainText(`I can see ${INSTALLED_REPO}.`)
  expect(host.verifyCalls).toBeGreaterThanOrEqual(1)
  expect(new URL(page.url()).search).toBe("")

  // Beat 12: Create Wiki · W, Create Mythical history · H — two launches, two chips, no run card opened.
  await expectBeat(page, 12, { repo: INSTALLED_REPO })
  await expect(page.locator(".guide-primary-subtitle")).toHaveText("On its own branch. Your branches stay untouched.")
  await page.keyboard.press("k")
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
  await expect(followup(page, 13)).toContainText("Type a message here, or choose Dictation to speak. Escape closes Chat.")

  // Beat 14: terminal, on acme/api, with the run chips still in the chrome and the reel on E.
  await expectBeat(page, 14, { repo: INSTALLED_REPO })
  const more = page.getByRole("button", { name: /What else can you do/ })
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute("aria-keyshortcuts", REEL_BUTTON.key.toLowerCase())
  await expect(page.locator(".guide-location")).toHaveText("Your workspace")
  await expect(page.locator('[data-run-chip="wiki"]')).toBeVisible()
  await tick(page, 5_000)
  await expect(shell(page)).toHaveAttribute("data-stage", "14")
  await shoot(page, 14)
})

test.describe("beat 9: four commit selections are sent to the live Change operation", () => {
  const cases = [
    { pick: [2, 3], toggle: ["1"], size: 2, rebased: 2, line: "Rebased 2 commits onto main. Change #1 is ready for review." },
    { pick: [1, 2, 3], toggle: [], size: 3, rebased: 0, line: "Already in order. Change #1 is a stack of 3." },
    { pick: [1, 2], toggle: ["3"], size: 2, rebased: 0, line: "Already in order. Change #1 is a stack of 2." },
    { pick: [2], toggle: ["1", "3"], size: 1, rebased: 1, line: "Rebased 1 commit onto main. Change #1 is ready for review." },
  ] as const
  for (const row of cases) {
    test(`{${row.pick.join(", ")}}: ${row.size} commits sent to live Change`, async ({ page, baseURL }) => {
      const host = await boot(page, baseURL)
      await toPicker(page)
      for (const key of row.toggle) await page.keyboard.press(key)
      await until(page, card(page, "commit-pick").locator(`section.commit-pick[data-picked="${row.pick.join(" ")}"]`), "the pick is set")
      await page.keyboard.press("m")
      const change = card(page, "change")
      await until(page, change, "the stack view")
      await expect(change).toContainText(`${row.size} commits selected for review`)
      expect(host.live.find(call => call.operation === "change")?.body.commitIds).toEqual(row.pick.map(index => commitsFixture.commits[index - 1]!.commitId))
      expect(host.external()).toEqual([])
    })
  }

  test("live implementation commits can be selected individually and Back restores the previous pick", async ({ page, baseURL }) => {
    await boot(page, baseURL)
    await toPicker(page)
    await page.keyboard.press("2")
    await tick(page)
    const pickRow = (index: number) => card(page, "commit-pick").locator(`[data-pick-row="${index}"]`)
    await expect(pickRow(2)).toHaveAttribute("data-picked", "false")
    await page.keyboard.press("1")
    await until(page, pickRow(1).and(page.locator('[data-picked="false"]')), "row 1 unchecks")
    await page.keyboard.press("m")
    await until(page, card(page, "change"), "the stack view")
    await until(page, followup(page, 9), "the Change is recorded")
    await page.keyboard.press("b")
    await until(page, card(page, "commit-pick"), "Back restores the picker")
    await expect(shell(page)).toHaveAttribute("data-stage", "9")
    await expect(pickRow(1)).toHaveAttribute("data-picked", "false")
    await expect(pickRow(2)).toHaveAttribute("data-picked", "false")
    await expect(pickRow(3)).toHaveAttribute("data-picked", "true")
    await expect(followup(page, 9)).toHaveCount(0)
    await page.reload()
    await rebooted(page)
    await atStage(page, 9)
    await until(page, card(page, "commit-pick"), "the restored picker finishes hydrating")
    await expect(pickRow(1)).toHaveAttribute("data-picked", "false")
    await expect(pickRow(2)).toHaveAttribute("data-picked", "false")
    await expect(pickRow(3)).toHaveAttribute("data-picked", "true")
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
    await expect(page.locator(".guide-goal li")).toHaveText(["Issue", "Plan", "Commits", "Change"])
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
  for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await atStage(page, step)
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind !== "do") throw new Error(`beat ${step} asks for no action`)
    await page.locator(`.guide-actions button.guide-primary[data-flow="${lesson.actions[0]!.flow}"]`).click()
    if (lesson.message === "") await atStage(page, step + 1)
    else await until(page, followup(page, step).locator(".guide-step-done"), `beat ${step} is checked`)
  }
  await atStage(page, 9)
  await card(page, "commit-pick").locator('[data-pick-row="1"] input').click()
  await until(page, card(page, "commit-pick").locator('[data-pick-row="1"][data-picked="false"]'), "the checkbox unchecks row 1")
  await page.locator('.guide-actions button.guide-primary[data-flow="change.open"]').click()
  await until(page, card(page, "change"), "the stack view")
  await expect(card(page, "change")).toContainText("2 commits selected for review")
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
      await page.keyboard.press("k")
      await page.keyboard.press("h")
      await expect(page.locator("[data-run-chip]").or(page.locator("[data-tutorial-cards] .smithers-card")).first()).toBeVisible({ timeout: 120_000 })
    }
  } finally {
    await context.close()
  }
})


test("live plan and implementation remain readable on a phone", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const host = await boot(page, baseURL)
  for (const [step, key] of [[1, "i"], [2, "r"], [3, "e"], [4, "r"], [5, "f"]] as const) {
    await atStage(page, step)
    await doBeat(page, step, key)
  }
  const research = page.locator('[data-tutorial-cards] [data-testid="card-live-tutorial-research"]')
  await research.getByRole("tab", { name: "Transcript", exact: true }).click()
  await until(page, research.locator(".flow-run-transcript"), "signed-out research transcript opens")
  await expect(research).toContainText("research complete")
  await research.getByRole("tab", { name: "Trace", exact: true }).click()
  await until(page, research.locator(".live-tutorial-events"), "research trace returns")
  const plan = page.locator('[data-tutorial-cards] [data-testid="card-practice-plan"]')
  await plan.scrollIntoViewIfNeeded()
  await page.screenshot({ path: "/tmp/smithers-live-plan-mobile.png" })
  expect((await plan.boundingBox())!.width).toBeLessThanOrEqual(390)
  expect(await plan.evaluate(node => getComputedStyle(node.querySelector(".live-tutorial-run")!).textAlign)).toBe("left")
  expect(await plan.evaluate(node => getComputedStyle(node.querySelector(".live-tutorial-plan ol")!).listStyleType)).toBe("decimal")
  await atStage(page, 6)
  await doBeat(page, 6, "g")
  const run = page.locator('[data-tutorial-cards] [data-testid="card-flow-run-practice-fix-hello-3"]')
  await run.scrollIntoViewIfNeeded()
  await page.screenshot({ path: "/tmp/smithers-live-result-mobile.png" })
  await expect(run).toContainText("Tests passed")
  await run.getByRole("tab", { name: "Transcript", exact: true }).click()
  await until(page, run.locator('.flow-run-transcript'), "the live transcript is visible")
  await expect(run.locator(".flow-run-transcript")).toContainText("implement complete")
  await run.getByRole("tab", { name: "Trace", exact: true }).click()
  await until(page, run.locator('.live-tutorial-events'), "the live trace is visible again")
  expect(host.rpc).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
