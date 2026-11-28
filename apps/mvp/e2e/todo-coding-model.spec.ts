import { Effect, Redacted } from "effect"
import * as Database from "../db/Database"
import { serverUrl } from "../db/TestDatabase"
import * as Stack from "../worker/stack/Stack.vibe"
import { expect, test } from "./fixtures"
import { expectServerError } from "./watch"
import { dropTodo, dropWord } from "./stackWrites"
import { baseURL, LOCAL_DEVELOPER, onThisMachine, stackRepository, target } from "./target"

// Produce the settled attempt through the stack writer before the device opens it, as with an existing failed TODO.
test("the stack shows a coding model failure after a fresh load and keeps its Retry", async ({ page }) => {
  test.skip(target !== "local" || !onThisMachine(baseURL) || process.env.E2E_CODING_MODEL_FIXTURE !== "fresh-without-code-storage",
    "requires a fresh local developer database with Code Storage disabled")
  const repo = stackRepository()
  const title = "Check the coding connection"
  await dropWord(page, repo, title)
  const number = await Effect.runPromise(Effect.gen(function* () {
    const applied = yield* Stack.apply({
      opId: crypto.randomUUID(), repoId: `github/${repo.toLowerCase()}`,
      actor: { id: LOCAL_DEVELOPER.personId, login: LOCAL_DEVELOPER.login }, via: "person",
      op: { kind: "commit", title, prompt: "Fixture", acceptance: [] },
    }, { runs: true })
    if (applied.kind !== "applied" || !applied.receipt.starts[0]) throw new Error("Could not start fixture attempt")
    const attempt = applied.receipt.starts[0]
    yield* Stack.report(attempt, { kind: "finished", state: "failed", failure: "no_seat" }, { runs: true })
    return attempt.number
  }).pipe(Effect.provide(Database.layer(serverUrl.pipe(Effect.map(url => Redacted.make(url.toString())))))))
  try {
    // The shared repository header asks for refs on a direct load. This database-only fixture deliberately
    // has no Code Storage binding. Its typed 503 cannot prevent the TODO, cause or Retry from rendering.
    const refs = `/api/repos/${repo}/refs`
    expectServerError(503, refs)
    const refsResponse = page.waitForResponse(response => new URL(response.url()).pathname === refs)
    await page.goto(`/${repo}/stack/${number}`)
    const response = await refsResponse
    expect(response.status()).toBe(503)
    expect(await response.json()).toMatchObject({ code: "not_configured" })
    await expect(page.getByText("Coding model unavailable", { exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: /^History(?: \(\d+\))?$/ })).toBeVisible()
    await page.reload()
    await expect(page.getByText("Coding model unavailable", { exact: true })).toBeVisible()
    const model = page.getByRole("link", { name: "Your model", exact: true })
    await expect(model).toHaveAttribute("href", "/app/settings#your-model")
    await model.focus()
    await model.press("Enter")
    await expect(page).toHaveURL(/\/app\/settings#your-model$/)
    await expect(page.locator("#your-model").getByRole("heading", { name: "Your model" })).toBeVisible()
  } finally {
    expect((await dropTodo(page, repo, number)).status).toBe(202)
  }
})
