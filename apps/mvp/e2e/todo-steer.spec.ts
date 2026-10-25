import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { me, requires } from "./target"

// Steering a TODO's agent, end to end (ruling TODO-3, docs/features/runs.md#steering): a Member commits a TODO, opens its
// run from Watch, and sends the working agent a message from the run's page. The message goes through the device's
// outbox and ChatApi into the run's durable queue on Cloudflare; the agent reads it at its next turn, and the pull
// request carries what it asked for. Everything is real: the run on its Durable Object, the branch's machine, the
// deployment's model and GitHub. No scripted agent: the person types the TODO and the message. It never merges: the
// TODO is dropped at the end, which closes its pull request.
//
// It writes to GitHub, so it runs against a deployment signed in as the test account, a Member or above on the scratch
// repository (E2E_TODO_REPOSITORY, roninjin10/smithers-github-tests unless set, never smithersai/*), and waits out a
// TODO's run, so it needs E2E_LONG=1, as the todo run in e2e/remote-flows.spec.ts does.

/** The repository the TODO runs on: a scratch one, never smithersai's. */
const TODO_REPOSITORY = process.env.E2E_TODO_REPOSITORY ?? "roninjin10/smithers-github-tests"

/** README.md on `ref` of the repository, as GitHub serves it; empty until it exists. */
const readme = async (request: import("@playwright/test").APIRequestContext, ref: string) => {
  const response = await request.get(`https://raw.githubusercontent.com/${TODO_REPOSITORY}/${encodeURIComponent(ref)}/README.md?at=${Date.now()}`)
  return response.status() === 200 ? await response.text() : ""
}

test("todo-steer: message a TODO's working agent from its run, and its pull request does what the message asked", {
  annotation: { type: "summary", description: "Commit a TODO, open its run, and steer the agent while it works." },
}, async ({ devices }) => {
  requires("personalModel", "githubApp", "member", "longRun")
  expect(TODO_REPOSITORY, "a TODO run writes to GitHub: never a smithersai repository").not.toMatch(/^smithersai\//i)
  test.setTimeout(45 * 60_000)
  const word = devices.word
  const [a] = await devices.open("Maya")
  const page = a.page
  const stack = page.getByRole("region", { name: `${TODO_REPOSITORY} stack` })
  const row = stack.locator("[data-slot=issues-row]", { hasText: word })
  const title = `README lines ${word}`
  // The person changes the task while the agent works: the pull request must carry the second line too.
  const steer = `Please also append a second line to README.md that says steered ${word}, right after the first one.`
  const messages = page.getByRole("region", { name: "Steer" }).getByRole("listitem").filter({ hasText: steer })

  await step("Commit a TODO", async () => {
    await page.goto(`/${TODO_REPOSITORY}/stack`)
    await expect(stack).toBeVisible({ timeout: 60_000 })
    await page.getByRole("button", { name: "New TODO" }).click()
    const draft = page.getByRole("form", { name: "TODO draft" }).first()
    await draft.getByLabel("Title").fill(title)
    await draft.getByLabel("Prompt").fill(`Append one line that says ${word} to the end of README.md.`)
    await draft.getByRole("button", { name: "Commit" }).click()
    await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
  })
  const number = (await row.textContent())!.match(/T(\d+)/)![1]!
  // The stack runs one TODO at a time: whatever happens here, the TODO is dropped at the end, so the next run's starts.
  let dropped = false
  try {
    await step("It works: Watch opens its run on Cloudflare", async () => {
      await expect(row).toHaveAttribute("data-status", "running", { timeout: 5 * 60_000 })
      await row.getByRole("link", { name: "Watch" }).click()
      await expect(page).toHaveURL(/\/app\/runs\/todo(%3A|:)/, { timeout: 30_000 })
      await expect(page.getByText("Cloud", { exact: true })).toBeVisible({ timeout: 60_000 })
    })
    const runPath = new URL(page.url()).pathname

    await step("Steer the agent while it works", async () => {
      const composer = page.getByRole("textbox", { name: "Steer the agent" })
      await expect(composer).toBeVisible({ timeout: 120_000 })
      await composer.fill(steer)
      await composer.press("Enter")
      await expect(composer).toHaveValue("")
      await expect(messages).toHaveAttribute("data-state", /sending|sent|delivered/, { timeout: 30_000 })
      await expect(messages).toHaveAttribute("data-state", /sent|delivered/, { timeout: 2 * 60_000 })
    })

    await step("The agent reads it and acts on it", async () => {
      await expect(messages).toHaveAttribute("data-state", "delivered", { timeout: 25 * 60_000 })
      await expect(messages).toContainText("Delivered")
      await messages.getByRole("button", { name: "Next step" }).click()
    })

    await step("Its pull request has the steered line", async () => {
      await page.goto(`/${TODO_REPOSITORY}/stack/${number}`)
      const todo = page.getByRole("article", { name: new RegExp(title) })
      await expect(todo).toHaveAttribute("data-status", "in_review", { timeout: 35 * 60_000 })
      const link = page.getByRole("link", { name: /^#\d+$/ })
      await expect(link).toBeVisible({ timeout: 60_000 })
      const pull = await page.request.get(`https://api.github.com/repos/${TODO_REPOSITORY}/pulls/${(await link.textContent())!.slice(1)}`)
      const { head, state } = (await pull.json()) as { head: { ref: string }; state: string }
      expect([state, head.ref]).toEqual(["open", expect.stringMatching(new RegExp(`^smithers/t${number}-`))])
      await expect.poll(() => readme(page.request, head.ref), { timeout: 120_000 }).toContain(word)
      expect(await readme(page.request, head.ref)).toContain(`steered ${word}`)
    })

    await step("Its agent has ended: the run takes no more messages", async () => {
      await page.goto(runPath)
      await expect(messages).toHaveAttribute("data-state", "delivered", { timeout: 60_000 })
      await expect(page.getByRole("textbox", { name: "Steer the agent" })).toHaveCount(0)
      const runId = decodeURIComponent(runPath.split("/").at(-1)!)
      const late = await page.request.post(`/api/remote-runs/${encodeURIComponent(runId)}/steers`, {
        data: { id: crypto.randomUUID(), body: "Too late" },
        headers: { [DEVICE_PERSON_HEADER]: me().personId },
      })
      expect([late.status(), await late.json()]).toEqual([409, { code: "not_working" }])
    })

    await step("Drop the TODO, which closes its pull request", async () => {
      await page.goto(`/${TODO_REPOSITORY}/stack/${number}`)
      const todo = page.getByRole("article", { name: new RegExp(title) })
      await todo.getByRole("button", { name: "Drop", exact: true }).click()
      await page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
      await expect(todo).toHaveAttribute("data-status", "dropped", { timeout: 60_000 })
      dropped = true
    })
  } finally {
    if (!dropped) {
      await page.request.post(`/api/repos/${TODO_REPOSITORY}/stack`, {
        data: { opId: crypto.randomUUID(), op: "drop", number: Number(number) },
        headers: { [DEVICE_PERSON_HEADER]: me().personId },
      })
    }
  }
})
