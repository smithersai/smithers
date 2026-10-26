import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test"
import { strictTest as base } from "./watch"
import { writeFile } from "node:fs/promises"
import { SIGN_IN, SIGN_OUT } from "../src/features/auth/contract"
import {
  ACCEPT,
  ENABLE_TRIAGE,
  NEW_ISSUE,
  NOT_ACCEPTED,
  PAUSE_TRIAGE,
  RUN_TRIAGE_AGAIN,
} from "../src/features/issues/contract"
import { recordActions, writeManifest } from "./fixtures"
import { requires, scratchRepository } from "./target"

// Issues, end to end (docs/features/issues.md, decision 0012 slice G0): the real app, ChatApi, Durable Objects,
// Postgres and Electric, two devices side by side in one video each, so `pnpm e2e:gifs` makes one GIF per flow.
//
// - "who reads" runs wherever the app runs: a signed-out device is asked to sign in on a repository GitHub hasn't said
//   is public, while a signed-in Member's device gets the list and New issue. It writes nothing anywhere.
// - "two devices" is G1 and G3: device A opens an issue, device B sees it numbered by GitHub, B comments, A sees the
//   comment. It writes to GitHub as a real person, so it runs only against a deployment, signed in as the test account
//   (e2e/deployment/sign-in.setup.ts), on a scratch repository Will owns with the Smithers GitHub App installed, never
//   `smithersai/*`: E2E_ISSUES_REPOSITORY, `owner/name` of that repository (`requires("syncedScratch")`,
//   e2e/target.ts). A local stack with the GitHub App runs it as a deployment (`E2E_TARGET=deployment`).
// - "who triages" runs wherever the app runs without the App, like "who reads": a Maintainer gets New issue but no
//   triage switch, which waits for the repository's first complete issue sync (decision 0079,
//   src/features/issues/view.ts `mayManageTriageOnList`) that only the App brings, and a signed-out device gets
//   neither (docs/features/issues.md#triage). It presses nothing. "triage" below proves Enable triage once synced.
// - "triage" is G7: a Maintainer enables triage, opens an issue, runs triage on it, sees the flow's label, overrides it
//   on another device, and runs triage again. It needs what "two devices" needs, with the test account a Maintainer
//   on the scratch repository, and the deployment's model for the judge.
//
// The issues list shows a loading state until the repository's first complete sync (0012 §2, never "No issues"
// before), so these tests don't use the no-spinner fixtures: a loading list is the specified state, not a regression.

/** The repository the "who reads" test opens, read-only: the dev server's default `GITHUB_REPOSITORY`. */
const READ_REPOSITORY = "smithersai/smithers"

const VIEWPORT = { width: 560, height: 720 }

/** A device: its own browser context, video and log, labelled in its video. */
interface Device {
  readonly name: string
  readonly context: BrowserContext
  readonly page: Page
  readonly openedAt: number
  readonly log: Array<string>
}

class Devices {
  readonly all: Array<Device> = []
  private readonly startedAt = Date.now()
  constructor(private readonly browser: Browser, private readonly testInfo: TestInfo) {}

  // Against a deployment the context starts from the run's stored session (playwright.config.ts).
  async open(name: string) {
    const context = await this.browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: this.testInfo.outputPath("videos"), size: VIEWPORT },
    })
    const page = await context.newPage()
    await page.addInitScript((label: string) => {
      addEventListener("DOMContentLoaded", () => {
        const badge = document.createElement("div")
        badge.setAttribute("aria-hidden", "true")
        badge.textContent = label
        Object.assign(badge.style, {
          position: "fixed",
          top: "6px",
          right: "6px",
          zIndex: "2147483647",
          pointerEvents: "none",
          font: "600 12px/1.6 system-ui, sans-serif",
          color: "#fff",
          background: "#1f2937",
          padding: "0 8px",
          borderRadius: "999px",
        })
        document.body.append(badge)
      })
    }, name)
    await recordActions(page, this.testInfo, name)
    const log: Array<string> = []
    page.on("console", (message) => log.push(`${message.type()}: ${message.text()}`))
    page.on("pageerror", (error) => log.push(`pageerror: ${error.message}`))
    const device = { name, context, page, openedAt: (Date.now() - this.startedAt) / 1000, log }
    this.all.push(device)
    return device
  }

  async teardown() {
    if (this.testInfo.status !== this.testInfo.expectedStatus) {
      for (const device of this.all) {
        const path = this.testInfo.outputPath(`${device.name}-browser.log`)
        await writeFile(path, device.log.join("\n"))
        await this.testInfo.attach(`${device.name}-browser.log`, { path, contentType: "text/plain" })
      }
    }
    await Promise.all(this.all.map((device) => device.context.close().catch(() => undefined)))
    const videos = await Promise.all(
      this.all.map(async (device) => ({ name: device.name, video: await device.page.video()?.path(), openedAt: device.openedAt })),
    )
    await writeManifest(this.testInfo, "devices.json", this.startedAt, videos)
  }
}

const test = base.extend<{ devices: Devices }>({
  devices: async ({ browser }, use, testInfo) => {
    const devices = new Devices(browser, testInfo)
    await use(devices)
    await devices.teardown()
  },
})

test("who reads: signed out, a repository GitHub hasn't said is public asks to sign in; a Member gets the list", { annotation: { type: "summary", description: "Signed out, a repository not known to be public asks to sign in; a Member sees its issues." } }, async ({ devices }) => {
  // The visitor signs out of local development, on a dev server without the GitHub App, so GitHub hasn't said the
  // repository is public.
  requires("devSignIn", "noGitHubApp")
  const member = await devices.open("Member")
  const visitor = await devices.open("signed out")
  // A Member (alchemy dev's local developer, an Admin) gets the list, and New issue opens the form.
  await member.page.goto(`/${READ_REPOSITORY}/issues`)
  await expect(member.page.getByRole("region", { name: `${READ_REPOSITORY} issues` })).toBeVisible({ timeout: 30_000 })
  expect((await member.page.request.get("/api/shapes/items?offset=-1")).status()).toBe(200)
  await member.page.getByRole("link", { name: NEW_ISSUE }).click()
  await expect(member.page).toHaveURL(new RegExp(`/${READ_REPOSITORY}/issues/new$`))
  await expect(member.page.getByLabel("Title")).toBeVisible()

  // The visitor signs out: alchemy dev's local developer stays signed out with the dev cookie.
  await visitor.page.goto("/app")
  await visitor.page.getByRole("button", { name: SIGN_OUT }).click({ timeout: 30_000 })
  await expect(visitor.page.getByRole("link", { name: SIGN_IN }).first()).toBeVisible({ timeout: 30_000 })
  // Signed out, the shape itself refuses: nothing of the repository reaches the device.
  expect((await visitor.page.request.get("/api/shapes/items?offset=-1")).status()).toBe(401)
  await visitor.page.goto(`/${READ_REPOSITORY}/issues`)
  await expect(visitor.page.getByRole("main", { name: "Issues" }).getByRole("link", { name: SIGN_IN })).toBeVisible({
    timeout: 30_000,
  })
  await expect(visitor.page.getByRole("region", { name: `${READ_REPOSITORY} issues` })).toHaveCount(0)
  // The Member's form is still there beside it.
  await expect(member.page.getByLabel("Title")).toBeVisible()
})

test("two devices: A opens an issue, B sees GitHub number it and comments, A sees the comment", { annotation: { type: "summary", description: "An issue opened on one device gets its GitHub number, and comments flow between devices through GitHub." } }, async ({ devices }) => {
  requires("syncedScratch", "member")
  test.setTimeout(240_000)
  const scratch = scratchRepository()
  const a = await devices.open("A")
  const b = await devices.open("B")
  const title = `Smithers e2e ${new Date().toISOString()}`

  // A opens the issue: Requested at once as #–, then numbered once GitHub has it.
  await a.page.goto(`/${scratch}/issues/new`)
  await a.page.getByLabel("Title").fill(title)
  await a.page.getByLabel("Description").fill("Opened by the two-device e2e test.")
  await a.page.getByRole("button", { name: "Create issue" }).click()
  await expect(a.page).toHaveURL(new RegExp(`/${scratch}/issues$`))
  const row = (page: Page) => page.getByRole("listitem").filter({ hasText: title })
  await expect(row(a.page)).toBeVisible({ timeout: 30_000 })
  await expect(row(a.page)).toContainText(/#\d+/, { timeout: 120_000 })

  // B sees it, numbered, and comments on it.
  await b.page.goto(`/${scratch}/issues`)
  await expect(row(b.page)).toContainText(/#\d+/, { timeout: 60_000 })
  await row(b.page).getByRole("link", { name: title }).click()
  await expect(b.page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 })
  const comment = `Comment from B ${Date.now()}`
  await b.page.getByLabel("Comment").fill(comment)
  await b.page.getByRole("button", { name: "Comment" }).click()
  await expect(b.page.getByText(comment)).toBeVisible({ timeout: 30_000 })

  // A sees B's comment once GitHub has it.
  await row(a.page).getByRole("link", { name: title }).click()
  await expect(a.page.getByText(comment)).toBeVisible({ timeout: 120_000 })
})

test("who triages: a Maintainer gets New issue, and no triage switch before the issues sync; signed out, neither", { annotation: { type: "summary", description: "A Maintainer's triage switch waits for the issue sync; a signed-out person gets neither." } }, async ({ devices }) => {
  // As "who reads": local development's Admin and a visitor who signed out of it, without the GitHub App.
  requires("devSignIn", "noGitHubApp")
  const maintainer = await devices.open("Maintainer")
  const visitor = await devices.open("signed out")
  // alchemy dev's local developer is an Admin: the list's header has New issue. Without the App the repository's
  // issues never finish a sync, so neither Enable triage nor Pause triage shows.
  await maintainer.page.goto(`/${READ_REPOSITORY}/issues`)
  const list = maintainer.page.getByRole("region", { name: `${READ_REPOSITORY} issues` })
  await expect(list).toBeVisible({ timeout: 30_000 })
  await expect(list.getByRole("link", { name: NEW_ISSUE })).toBeVisible()
  await expect(list.getByRole("button", { name: ENABLE_TRIAGE })).toHaveCount(0)
  await expect(list.getByRole("button", { name: PAUSE_TRIAGE })).toHaveCount(0)
  // The repository's triage settings are a shape of their own, refused like the issues to a person who may not read.
  expect((await maintainer.page.request.get("/api/shapes/triage-settings?offset=-1")).status()).toBe(200)

  await visitor.page.goto("/app")
  await visitor.page.getByRole("button", { name: SIGN_OUT }).click({ timeout: 30_000 })
  await expect(visitor.page.getByRole("link", { name: SIGN_IN }).first()).toBeVisible({ timeout: 30_000 })
  expect((await visitor.page.request.get("/api/shapes/triage-settings?offset=-1")).status()).toBe(401)
  await visitor.page.goto(`/${READ_REPOSITORY}/issues`)
  await expect(visitor.page.getByRole("main", { name: "Issues" }).getByRole("link", { name: SIGN_IN })).toBeVisible({
    timeout: 30_000,
  })
  await expect(visitor.page.getByRole("button", { name: ENABLE_TRIAGE })).toHaveCount(0)
  await expect(list.getByRole("link", { name: NEW_ISSUE })).toBeVisible()
})

test("triage: a Maintainer enables it, the flow labels a new issue, another device overrides it, and runs it again", { annotation: { type: "summary", description: "With triage on, the flow labels a new issue, another device overrides it, and it runs again." } }, async ({ devices }) => {
  requires("syncedScratch", "maintainer")
  test.setTimeout(300_000)
  const scratch = scratchRepository()
  const a = await devices.open("A")
  const b = await devices.open("B")
  const title = `Smithers e2e triage ${new Date().toISOString()}`
  const triage = (page: Page) => page.getByRole("group", { name: "Triage" })

  // A turns triage on: the switch says Pause once the settings sync back.
  await a.page.goto(`/${scratch}/issues`)
  const list = a.page.getByRole("region", { name: `${scratch} issues` })
  const enable = list.getByRole("button", { name: ENABLE_TRIAGE })
  if (await enable.isVisible({ timeout: 30_000 }).catch(() => false)) await enable.click()
  await expect(list.getByRole("button", { name: PAUSE_TRIAGE })).toBeVisible({ timeout: 60_000 })

  // A opens an issue; once GitHub numbers it, it shows Proposed.
  await list.getByRole("link", { name: NEW_ISSUE }).click()
  await a.page.getByLabel("Title").fill(title)
  await a.page.getByLabel("Description").fill("Steps: open the issues page and press New issue with an empty title. It crashes.")
  await a.page.getByRole("button", { name: "Create issue" }).click()
  const row = (page: Page) => page.getByRole("listitem").filter({ hasText: title })
  await expect(row(a.page)).toContainText(/#\d+/, { timeout: 120_000 })
  await row(a.page).getByRole("link", { name: title }).click()

  // Run triage again hands it to the flow: the judge decides, and the App's label comes back through the sync.
  await expect(triage(a.page)).toContainText("Proposed", { timeout: 60_000 })
  await triage(a.page).getByRole("button", { name: RUN_TRIAGE_AGAIN }).click()
  await expect(triage(a.page)).toContainText(/Accepted|Not accepted/, { timeout: 120_000 })
  const decided = (await triage(a.page).getAttribute("data-triage"))!

  // B overrides the flow with the other button; A sees it, pinned.
  await b.page.goto(a.page.url())
  const other = decided === "accepted" ? NOT_ACCEPTED : ACCEPT
  await triage(b.page).getByRole("button", { name: other }).click()
  const overridden = decided === "accepted" ? "not_accepted" : "accepted"
  await expect(triage(a.page)).toHaveAttribute("data-triage", overridden, { timeout: 120_000 })
  await expect(triage(b.page)).toHaveAttribute("data-triage", overridden, { timeout: 120_000 })

  // Run triage again unpins it, and the flow decides it once more.
  await triage(a.page).getByRole("button", { name: RUN_TRIAGE_AGAIN }).click()
  await expect(triage(a.page)).toHaveAttribute("data-pending", "requested", { timeout: 30_000 })
  await expect(triage(a.page)).not.toHaveAttribute("data-pending", "requested", { timeout: 120_000 })
  await expect(triage(a.page)).toHaveAttribute("data-triage", /accepted|not_accepted/)
})
