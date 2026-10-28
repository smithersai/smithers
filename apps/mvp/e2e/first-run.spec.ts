import { DONE } from "../src/features/first-run/contract"
import { SIGN_IN } from "../src/features/auth/contract"
import { expect, test } from "./devices"
import { step, test as pageTest } from "./fixtures"
import { firstRun, firstRunStep } from "./firstRun"
import { baseURL, requires, scriptedAgent, signedOut, target } from "./target"

// The first run (decision 0121, docs/features/first-run.md): until a person has a conversation of their own, `/app`
// shows the steps to their first one where the composer would be, each a mark and a title, the current one with its
// button. The walk runs locally as a brand-new person (local development's `newcomer-<word>`, worker/DevChatApi.ts)
// with the scripted `hello` agent answering (src/test/scriptedAgent.ts). The first page runs everywhere, production
// included: it reads and writes nothing of the test account's but its own page visit.

/** A step's ✓: its mark says Done to assistive technology. */
const done = (page: Parameters<typeof firstRunStep>[0], title: string) => firstRunStep(page, title).getByRole("img", { name: DONE })

/** What `/api/auth/session` says of the deployment's own model, which decides whether Add your model is a step. */
const hostedModelOf = async (page: Parameters<typeof firstRunStep>[0]) =>
  ((await (await page.request.get("/api/auth/session")).json()) as { hostedModel?: boolean }).hostedModel === true

test("first run: a brand-new person signs in from the first step, asks Smithers, and the steps are gone", {
  annotation: {
    type: "summary",
    description: "A new person sees the steps, signs in from the first one, opens Chat, gets an answer, and never sees the steps again.",
  },
}, async ({ devices }) => {
  requires("devPeople", "devSignIn", "scriptedAgent")
  test.setTimeout(240_000)
  const word = devices.word
  const person = `newcomer-${word}` as const
  const [a] = await devices.openVisitorAs(person, "Newcomer")
  const page = a.page

  await step("Open Smithers signed out: the first step is Sign in", async () => {
    // The scripted agent answers here: the engine worker is named for the page's parameters as it starts.
    await page.goto(scriptedAgent("hello"))
    await a.ready()
    await expect(firstRunStep(page, "Sign in")).toHaveAttribute("aria-current", "step", { timeout: 30_000 })
    await expect(firstRunStep(page, "Ask Smithers")).toHaveAttribute("data-state", "later")
    // One sign-in action on the page: the step's.
    await expect(page.getByRole("link", { name: SIGN_IN })).toHaveCount(1)
    await expect(a.chatButton).toHaveCount(0)
  })

  await step("Sign in with GitHub: back on the page, Sign in done, Ask Smithers next", async () => {
    await firstRun(page).getByRole("link", { name: SIGN_IN }).click()
    await expect(done(page, "Sign in")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel("Account")).toContainText(person)
    await expect(firstRunStep(page, "Ask Smithers")).toHaveAttribute("aria-current", "step")
    await expect(a.chatButton).toBeVisible()
  })

  const question = `Say hello to ${word}`
  await step("Chat opens the composer in the steps' place, and Smithers answers", async () => {
    await a.chatButton.click()
    await expect(a.composer).toBeVisible()
    await expect(firstRun(page)).toHaveCount(0)
    await a.ask(question)
    await a.expectAnswered(question, `Hello, ${word}.`, 90_000)
  })

  await step("Hide the chat: the steps are gone, and stay gone after a reload", async () => {
    await page.keyboard.press("Escape")
    await expect(a.composer).toBeHidden()
    await expect(a.chatButton).toBeVisible()
    await expect(firstRun(page)).toHaveCount(0)
    await a.reload()
    await expect(a.chatButton).toBeVisible({ timeout: 30_000 })
    await expect(firstRun(page)).toHaveCount(0)
  })
})

pageTest.describe("the first page", () => {
  pageTest.describe("signed out", () => {
    pageTest.use(signedOut)

    pageTest("first run: a visitor's first page is the Sign in step, with the steps they will have", {
      annotation: { type: "summary", description: "Signed out, /app shows Sign in as the current step, the steps to come after it, and one sign-in link." },
    }, async ({ page }) => {
      if (target === "local") {
        // Local development signs its developer in without a cookie; its signed-out cookie makes this browser a visitor.
        const secure = baseURL.startsWith("https:")
        await page.context().addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: baseURL, secure }])
      }
      await step("Open the app signed out", async () => {
        await page.goto("/app")
        await expect(firstRunStep(page, "Sign in")).toHaveAttribute("aria-current", "step", { timeout: 30_000 })
      })
      await step("The steps to come: Add your model while the deployment's own model is off, then Ask Smithers", async () => {
        const model = firstRunStep(page, "Add your model")
        if (await hostedModelOf(page)) await expect(model).toHaveCount(0)
        else await expect(model).toHaveAttribute("data-state", "later")
        await expect(firstRunStep(page, "Ask Smithers")).toHaveAttribute("data-state", "later")
        await expect(firstRun(page).getByRole("link", { name: SIGN_IN })).toHaveCount(1)
        await expect(page.getByRole("link", { name: SIGN_IN })).toHaveCount(1)
      })
    })
  })

  pageTest("first run: a signed-in person who is set up sees every step before Ask done, or no steps once they have a conversation", {
    annotation: {
      type: "summary",
      description: "Signed in, /app shows Sign in and Your model done with Chat as the next step, or, once the account has a conversation, Chat alone.",
    },
  }, async ({ page }) => {
    requires("member", "personalModel")
    const chat = page.getByRole("button", { name: /^Chat\b/ })
    // The account is set up: signed in, with its own model saved (the deployment setup saves it) where the
    // deployment's own model is off. Whether it has had a conversation, open or archived, decides what /app shows.
    const hasConversation = await step("Count the account's conversations, open and archived", async () => {
      await page.goto("/app/conversations")
      const counted: Array<number> = []
      for (const [show, empty] of [["Open", "No conversations"], ["Archived", "No archived conversations"]] as const) {
        await page.getByRole("radio", { name: show }).click()
        const rows = page.getByRole("list", { name: "Conversations" }).getByRole("listitem")
        await expect(rows.first().or(page.getByText(empty, { exact: true }))).toBeVisible({ timeout: 30_000 })
        counted.push(await rows.count())
      }
      return counted.some((count) => count > 0)
    })
    await step("Back to chat", async () => {
      await page.getByRole("link", { name: "Back to chat" }).click()
      await expect(chat).toBeVisible({ timeout: 30_000 })
    })
    if (hasConversation) {
      await step("No steps: Chat stands where the composer goes", async () => {
        await expect(firstRun(page)).toHaveCount(0)
        await expect(page.getByRole("link", { name: SIGN_IN })).toHaveCount(0)
      })
    } else {
      await step("Every step before Ask Smithers is done, and Chat is the next step's button", async () => {
        await expect(done(page, "Sign in")).toBeVisible({ timeout: 30_000 })
        if (await hostedModelOf(page)) await expect(firstRunStep(page, "Add your model")).toHaveCount(0)
        else await expect(done(page, "Add your model")).toBeVisible()
        await expect(firstRunStep(page, "Ask Smithers")).toHaveAttribute("aria-current", "step")
      })
    }
  })
})
