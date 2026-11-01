import { expect, test } from "./devices"
import { step } from "./fixtures"
import { github } from "./github"
import { type Runner, startRunner } from "./runner"
import { configureStack, dropTodo } from "./stackWrites"
import { requires } from "./target"

// A TODO coded by an external agent on a runner (decision 0136, docs/features/agent-runners.md): an Admin registers a
// runner and names the repository's coding agent, the spec starts that runner itself (`smthrs runner serve`) with the
// deterministic ACP test agent as the profile's command, a person commits a TODO, and the App opens its pull request
// with the agent's change. Everything is real: the app, its routes and flows, Postgres, the runner, its jj checkout, the
// agent process and GitHub. The test agent stands in for a model, so this proves the seam; a real agent's lane is the
// production proof (FINAL.md §5).
//
// It writes to GitHub, so it runs only signed in through the GitHub App, against a deployment or a dev build, on a
// scratch repository the test account administers (`agentRunner`, e2e/target.ts). It never merges. The runner's setup
// is e2e/runner.ts.

const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""

test("agent runner: an external agent's TODO publishes a pull request", {
  annotation: { type: "summary", description: "An Admin points TODOs at an agent on a runner; the App opens its pull request." },
}, async ({ devices }) => {
  requires("agentRunner")
  test.setTimeout(15 * 60_000)
  // A device of its own (e2e/devices.ts): Commit needs the browser's engine, which a private window can't run.
  const [maya] = await devices.open("Maya")
  const page = maya!.page
  const word = `a${Date.now().toString(36)}`
  const row = page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: word })
  let runner: Runner | undefined
  let number: string | undefined
  try {
    await step("An Admin registers a runner and names the coding agent", async () => {
      await page.goto(`/${repo}/stack`)
      runner = await startRunner(page, repo, word, 1)
      // Independent lanes: the TODO starts whatever else the shared scratch stack holds open (decision 0135).
      expect(await configureStack(page, repo, 1, "independent")).toMatchObject({ status: 202 })
    })

    const title = `Note alpha ${word}`
    await step("A person commits a TODO", async () => {
      await page.getByRole("button", { name: "New TODO", exact: true }).click()
      const draft = page.getByRole("form", { name: "TODO draft" })
      await draft.getByLabel("Title", { exact: true }).fill(title)
      await draft.getByLabel("Prompt", { exact: true }).fill(`add the line \`alpha ${word}\` to \`NOTES.md\``)
      await draft.getByRole("button", { name: "Commit", exact: true }).click()
    })

    await step("The runner's agent works on it", async () => {
      await expect(row).toHaveAttribute("data-status", /running|in_review/, { timeout: 60_000 })
    })

    await step("The App opens its pull request with the agent's change", async () => {
      // Settled either way, then In review: a failed TODO fails the test at once, with the runner's log.
      await expect(row).toHaveAttribute("data-status", /in_review|failed/, { timeout: 10 * 60_000 })
      await expect(row).toHaveAttribute("data-status", "in_review")
      number = (await row.textContent())!.match(/T(\d+)/)![1]!
      const pulls = await github<Array<{ number: number; head: { ref: string }; user: { type: string } }>>(
        page,
        `/repos/${repo}/pulls?state=open&per_page=100`,
      )
      const pull = pulls.find((each) => each.head.ref.startsWith(`smithers/t${number}-`))
      expect(pull, "one pull request on the TODO's branch").toBeDefined()
      expect(pull!.user.type).toBe("Bot")
      const files = await github<Array<{ filename: string; patch?: string }>>(page, `/repos/${repo}/pulls/${pull!.number}/files`)
      expect(files.map((file) => file.filename)).toEqual(["NOTES.md"])
      expect(files[0]!.patch).toContain(`+alpha ${word}`)
    })
  } catch (error) {
    await test.info().attach("runner.log", { body: runner?.log() ?? "" })
    throw error
  } finally {
    number ??= (await row.textContent({ timeout: 5_000 }).catch(() => null))?.match(/T(\d+)/)?.[1]
    if (number !== undefined) await dropTodo(page, repo, Number(number))
    await configureStack(page, repo, 1, "stacked")
    await runner?.stop()
  }
})
