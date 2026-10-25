import { questionIn } from "./messages"
import type { Page } from "@playwright/test"
import { SIGN_IN_TO_ASK, SIGN_OUT } from "../src/features/auth/contract"
import { COMMANDS } from "../src/features/commands/contract"
import { THEME_ATTRIBUTE } from "../src/features/theme/contract"
import { expect, test } from "./devices"
import { requires } from "./target"

// Slash commands, end to end (docs/features/slash-commands.md): the real app, its engine worker and ChatApi. Typing
// `/` in the composer lists the commands this person may run; the keyboard completes and runs one, which dispatches
// the same flow the theme button runs. No mocks. Under `alchemy dev` the page is the local developer, an Admin; in a
// deployment, the test account. The composer is a Member's or above's.
requires("member")

/** The mode the page paints: `<html data-theme>`. */
const painted = (page: Page) => page.evaluate((attribute) => document.documentElement.getAttribute(attribute), THEME_ATTRIBUTE)

/** Typing a person can follow in the video. */
const typing = { delay: 60 }

test("complete and run: / lists the commands, typing filters, the keyboard completes, and /theme dark sets the theme", { annotation: [{ type: "theme", description: "light" }, { type: "summary", description: "Typing / lists the commands, the keyboard completes one, and /theme dark runs it." }] }, async ({ devices }) => {
  const [a] = await devices.open("A")
  const page = a.page
  // The browser starts light (Playwright's color scheme), with no preference on the device.
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible({ timeout: 30_000 })
  await a.openComposer()

  // `/` lists every command, each with its description; the input points at the highlighted first row.
  await a.composer.pressSequentially("/", typing)
  const commands = page.getByRole("listbox", { name: COMMANDS })
  await expect(commands).toBeVisible()
  const theme = commands.getByRole("option", { name: /^\/theme/ })
  await expect(theme).toContainText("Set this device's theme to light or dark.")
  const first = commands.getByRole("option").first()
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect(a.composer).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!)
  await expect(a.composer).toHaveAttribute("aria-controls", (await commands.getAttribute("id"))!)

  // Typing filters: only `/theme` starts with "them".
  await a.composer.pressSequentially("them", typing)
  await expect(commands.getByRole("option")).toHaveCount(1)
  await expect(commands.getByRole("option")).toHaveAttribute("aria-selected", "true")

  // Tab completes the command, and the list becomes its argument's values.
  await a.composer.press("Tab")
  await expect(a.composer).toHaveValue("/theme ")
  await expect(a.composer).toBeFocused()
  const modes = page.getByRole("listbox", { name: "Mode" })
  await expect(modes.getByRole("option")).toHaveText(["light", "dark"])

  // The arrows move the highlight, wrapping; Tab completes the value.
  await a.composer.press("ArrowDown")
  await expect(modes.getByRole("option", { name: "dark" })).toHaveAttribute("aria-selected", "true")
  await a.composer.press("ArrowDown")
  await expect(modes.getByRole("option", { name: "light" })).toHaveAttribute("aria-selected", "true")
  await a.composer.press("ArrowUp")
  await a.composer.press("Tab")
  await expect(a.composer).toHaveValue("/theme dark")

  // Enter runs it: the composer clears, nothing goes to the agent, and the flow sets the theme.
  await a.composer.press("Enter")
  await expect(a.composer).toHaveValue("")
  await expect(modes).toBeHidden()
  await expect.poll(() => painted(page), { timeout: 30_000 }).toBe("dark")
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible()
  await expect(questionIn(a.conversation, "/theme")).toHaveCount(0)

  // The whole line, typed and sent, runs the same flow.
  await a.composer.pressSequentially("/theme light", typing)
  await a.composer.press("Enter")
  await expect(a.composer).toHaveValue("")
  await expect.poll(() => painted(page), { timeout: 30_000 }).toBe("light")

  // A line naming no command stays, says so, and never reaches the agent.
  await a.composer.pressSequentially("/nope", typing)
  await a.composer.press("Enter")
  await expect(a.composer).toHaveValue("/nope")
  await expect(a.composerForm.getByText("/nope isn't a command")).toBeVisible()
  await expect(questionIn(a.conversation, "/nope")).toHaveCount(0)
})

test("escape: Escape closes the list and keeps the draft, and a second Escape hides the composer", { annotation: { type: "summary", description: "Escape closes the command list and keeps the draft; a second Escape hides the composer." } }, async ({ devices }) => {
  const [a] = await devices.open("A")
  const page = a.page
  await expect(a.chatButton).toBeVisible({ timeout: 30_000 })
  await a.openComposer()
  await a.composer.pressSequentially("/", typing)
  const commands = page.getByRole("listbox", { name: COMMANDS })
  await expect(commands).toBeVisible()

  await a.composer.press("Escape")
  await expect(commands).toBeHidden()
  await expect(a.composer).toBeVisible()
  await expect(a.composer).toHaveValue("/")
  await expect(a.composer).not.toHaveAttribute("aria-activedescendant", /.+/)

  // Typing lists again.
  await a.composer.pressSequentially("t", typing)
  await expect(commands).toBeVisible()
  await a.composer.press("Escape")
  await expect(commands).toBeHidden()

  // With no list open, Escape is the composer's own: it hides, keeping the draft.
  await a.composer.press("Escape")
  await expect(a.composer).toBeHidden()
  await expect(a.chatButton).toBeVisible()
  await a.openComposer()
  await expect(a.composer).toHaveValue("/t")
})

test("roles: a member-only command is offered to an Admin, never to a signed-out person, and typing one does nothing", { annotation: { type: "summary", description: "A member-only command is offered to an Admin, never to a signed-out person." } }, async ({ devices }) => {
  requires("devSignIn")
  const [a] = await devices.open("A")
  const page = a.page
  await expect(a.chatButton).toBeVisible({ timeout: 30_000 })

  // The local developer is an Admin: offered every command, `/web` (Members and up) among them.
  await a.openComposer()
  await a.composer.pressSequentially("/", typing)
  const commands = page.getByRole("listbox", { name: COMMANDS })
  await expect(commands.getByRole("option", { name: /^\/theme/ })).toBeVisible()
  await expect(commands.getByRole("option", { name: /^\/web/ })).toBeVisible()
  await a.composer.press("Escape")
  await a.composer.press("Escape")
  await expect(a.composer).toBeHidden()

  // Signed out, the sign-in prompt stands where the composer was (decision 0008): no list is offered, and typing a
  // member-only command, with ⌘K first, opens nothing and runs nothing.
  await page.getByRole("button", { name: SIGN_OUT }).click()
  await expect(page.getByText(SIGN_IN_TO_ASK)).toBeVisible({ timeout: 30_000 })
  const pages = page.context().pages().length
  const url = page.url()
  await page.keyboard.press("ControlOrMeta+k")
  await page.keyboard.type("/web https://example.com", typing)
  await page.keyboard.press("Enter")
  await expect(a.composer).toBeHidden()
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await expect(page.getByRole("option")).toHaveCount(0)
  expect(page.context().pages().length).toBe(pages)
  await expect(page).toHaveURL(url)
})
