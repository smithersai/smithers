import type { APIRequestContext, BrowserContext, Locator, Page, TestInfo } from "@playwright/test"
import { command, expect, realApi } from "../support/test"
import { readAuthenticatedSession } from "../auth-permissions/profile"

export const PRODUCTION_REPO = "codeplanesmithers/canary-sandbox"

export const cloudRepoPath = (repo: string, suffix = ""): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `/api/cloud/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`
}

/** Product repository reads are served by the app's direct repository facade. */
export const repositoryApiPath = (repo: string, suffix = ""): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`
}

export const bootProductionRepository = async (page: Page, repo = PRODUCTION_REPO): Promise<void> => {
  // The authenticated fixture already opens appEntryPath. Preserve that page
  // and its freshly verified cookie instead of issuing a redundant navigation.
  if (new URL(page.url()).pathname.replace(/\/$/, "") !== `/${repo}`) {
    await page.goto(`/${repo}`, { waitUntil: "domcontentloaded" })
  }
  await expect(page).toHaveURL(new RegExp(`/${repo.replace("/", "\\/")}$`))
  await expect(page.getByTestId("transcript")).toBeVisible()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  expect(await readAuthenticatedSession(page)).toEqual({
    login: "codeplanesmithers",
    allowlisted: true,
    admin: true
  })
}

export const enableProductionVerbose = async (page: Page): Promise<void> => {
  await command(page, "/verbose")
  const toggledOff = page.getByText("Verbose off", { exact: true }).last()
  if (await toggledOff.isVisible().catch(() => false)) await command(page, "/verbose")
  await expect(page.getByTestId("transcript")).toContainText("Verbose on")
}

export const readJson = async <T>(
  page: Page,
  request: APIRequestContext,
  path: string
): Promise<T> => {
  const response = await realApi(page, request, "GET", path)
  expect(response.status(), `GET ${path}`).toBe(200)
  return await response.json() as T
}

export const attachProductionJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

export type OwnedGitHubRepository = {
  readonly fullName: string
  readonly name: string
  readonly url: string
  readonly page: Page
}

/** Provision the uniquely named source through GitHub's live repository form. */
export const createOwnedGitHubRepository = async (
  context: BrowserContext,
  name: string
): Promise<OwnedGitHubRepository> => {
  if (!/^smithers-e2e-import-[a-z0-9-]+$/.test(name)) {
    throw new Error(`Refusing to create a GitHub repository outside the owned E2E namespace: ${name}`)
  }
  const github = await context.newPage()
  const fullName = `codeplanesmithers/${name}`
  const url = `https://github.com/${fullName}`
  const owned = { fullName, name, url, page: github }
  let submitted = false
  try {
    await github.goto("https://github.com/new", { waitUntil: "domcontentloaded" })
    if (new URL(github.url()).hostname !== "github.com" || /^\/(login|session)(\/|$)/.test(new URL(github.url()).pathname)) {
      throw new Error("The sanctioned GitHub session cannot reach the repository creation UI.")
    }
    await expect(github.locator("body")).toContainText("Create a new repository")
    await expect(github.locator("body")).toContainText("codeplanesmithers")

    const nameInput = github.getByLabel(/Repository name/i)
      .or(github.getByRole("textbox", { name: /Repository name/i }))
      .or(github.locator([
        'input[name="repository[name]"]:visible',
        '#repository_name:visible',
        'input[aria-label*="Repository name"]:visible'
      ].join(", ")))
      .first()
    await expect(nameInput).toBeVisible()
    await nameInput.fill(name)

    const privateChoice = github.getByLabel(/^Private/i)
      .or(github.locator('input[type="radio"][value="private"]:visible'))
      .first()
    if (await privateChoice.isVisible().catch(() => false)) await privateChoice.check()
    else {
      const visibility = github.getByRole("button", { name: "Public", exact: true })
      await expect(visibility).toBeVisible()
      await visibility.click()
      const privateOption = github.getByRole("menuitemradio", { name: /^Private/i })
        .or(github.getByRole("menuitem", { name: /^Private/i }))
        .or(github.getByText("Private", { exact: true }))
        .last()
      await expect(privateOption).toBeVisible()
      await privateOption.click()
      await expect(github.getByRole("button", { name: "Private", exact: true })).toBeVisible()
    }
    const readmeChoice = github.locator('input[name="repository[auto_init]"]:visible').first()
    if (await readmeChoice.count()) await readmeChoice.check()
    else {
      const readmeText = github.getByText(/Add (a )?README/i).first()
      await expect(readmeText).toBeVisible()
      const readmeToggle = readmeText.locator("xpath=ancestor::div[.//button][1]").getByRole("button").first()
      await expect(readmeToggle).toBeVisible()
      await readmeToggle.click()
    }

    await expect(github.getByText("Checking availability...", { exact: true })).toHaveCount(0, { timeout: 30_000 })
    const create = github.getByRole("button", { name: /^Create repository$/ }).last()
    await expect(create).toBeEnabled({ timeout: 30_000 })
    // From this point onward cleanup treats the exact full name as possibly
    // existing, even if navigation or a later assertion fails.
    submitted = true
    await create.focus()
    await expect(create).toBeFocused()
    await create.press("Enter")
    await github.waitForURL((candidate) => candidate.origin === "https://github.com" && candidate.pathname.replace(/\/$/, "") === `/${fullName}`, {
      timeout: 60_000
    })
    await expect(github.locator(`a[href="/codeplanesmithers"]:visible`).first()).toBeVisible()
    await expect(github.getByText("Private", { exact: true }).first()).toBeVisible()
    return owned
  } catch (error) {
    const failureUrl = new URL(github.url())
    const creationFailure = {
      origin: failureUrl.origin,
      path: failureUrl.pathname,
      title: await github.title().catch(() => ""),
      alerts: await github.getByRole("alert").allInnerTexts().catch(() => [])
    }
    const cleanupFailures: unknown[] = []
    if (submitted) {
      try {
        await deleteOwnedGitHubRepository(owned)
      } catch (cleanupError) {
        const probe = await github.goto(url, { waitUntil: "domcontentloaded" }).catch((probeError) => {
          cleanupFailures.push(new Error(`Existence probe for possibly-created ${fullName} failed`, { cause: probeError }))
          return undefined
        })
        if (probe?.status() !== 404) {
          cleanupFailures.push(new Error(`Cleanup of possibly-created ${fullName} was not verified`, { cause: cleanupError }))
        }
      }
    }
    await github.close().catch((closeError) => {
      cleanupFailures.push(new Error(`Closing the GitHub page for ${fullName} failed`, { cause: closeError }))
    })
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], `GitHub repository creation failed and ${fullName} may require cleanup`)
    }
    throw new Error(`GitHub repository creation failed at ${creationFailure.origin}${creationFailure.path}: ${JSON.stringify({ title: creationFailure.title, alerts: creationFailure.alerts })}`, { cause: error })
  }
}

/** Delete only the exact owned source and verify GitHub now returns 404 for it. */
export const deleteOwnedGitHubRepository = async (owned: OwnedGitHubRepository): Promise<void> => {
  if (!owned.fullName.startsWith("codeplanesmithers/smithers-e2e-import-")) {
    throw new Error(`Refusing to delete a GitHub repository outside the owned E2E namespace: ${owned.fullName}`)
  }
  const github = owned.page
  await github.goto(`${owned.url}/settings`, { waitUntil: "domcontentloaded" })
  const deleteDoor = github.getByRole("button", { name: /^Delete this repository$/ }).last()
  await expect(deleteDoor).toBeVisible({ timeout: 30_000 })
  await deleteDoor.click()

  const intent = github.getByRole("button", { name: /^I want to delete this repository$/ }).last()
  if (await intent.isVisible().catch(() => false)) await intent.click()
  const effects = github.getByRole("button", { name: /^I have read and understand these effects$/ }).last()
  if (await effects.isVisible().catch(() => false)) await effects.click()
  const confirmation = github.getByRole("textbox", { name: /To confirm, type/ }).or(github.locator([
    'input[aria-label*="confirm"]:visible',
    'input[aria-label*="repository name"]:visible',
    'input[name="verify"]:visible'
  ].join(", "))).last()
  await expect(confirmation).toBeVisible({ timeout: 30_000 })
  await confirmation.fill(owned.fullName)
  const finalDelete = github.getByRole("button", { name: /^Delete this repository$/ }).last()
  await expect(finalDelete).toBeEnabled({ timeout: 30_000 })
  await finalDelete.click()
  await github.waitForURL((candidate) => candidate.pathname !== `/${owned.fullName}/settings`, { timeout: 60_000 })

  const missing = await github.goto(owned.url, { waitUntil: "domcontentloaded" })
  expect(missing?.status()).toBe(404)
}

export const waitForImportJob = async (
  page: Page,
  request: APIRequestContext,
  card: Locator,
  timeout = 240_000
): Promise<Record<string, unknown> | undefined> => {
  const jobLine = card.locator(".world-card-path").filter({ hasText: /^job\s+\S+$/ }).first()
  const terminalBadge = card.getByText(/^(done|failed)$/, { exact: true }).first()
  await expect.poll(async () => {
    const exactJob = await jobLine.textContent().catch(() => null)
    if (exactJob !== null) return exactJob
    return await terminalBadge.textContent().catch(() => null)
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toMatch(/^(job\s+\S+|done|failed)$/i)
  const exactJob = await jobLine.textContent().catch(() => null)
  const jobId = exactJob === null ? undefined : /^job\s+(\S+)$/i.exec(exactJob)?.[1]
  if (jobId === undefined) {
    const terminal = (await terminalBadge.textContent())?.trim().toLowerCase()
    if (terminal === "done") return { status: "ready", observed_from: "repo-import-card" }
    if (terminal === "failed") return { status: "failed", observed_from: "repo-import-card" }
    throw new Error("The repository import card exposed neither an exact job id nor a terminal status.")
  }
  return await waitForImportJobId(page, request, jobId, timeout)
}

/** Poll one accepted import job by its response-owned id until Plue settles it. */
export const waitForImportJobId = async (
  page: Page,
  request: APIRequestContext,
  jobId: string,
  timeout = 240_000
): Promise<Record<string, unknown>> => {
  if (jobId === "") throw new Error("Cannot wait for an import job without its accepted id.")
  let terminal: Record<string, unknown> | undefined
  await expect.poll(async () => {
    const response = await realApi(page, request, "GET", `/api/cloud/api/github/import/${encodeURIComponent(jobId)}`)
    if (response.status() !== 200) return `http-${response.status()}`
    const body = await response.json() as Record<string, unknown>
    terminal = body
    return body.status
  }, { timeout, intervals: [1_000, 2_000, 5_000] }).toMatch(/^(ready|failed)$/)
  if (terminal === undefined) throw new Error(`Import job ${jobId} reached no readable terminal answer.`)
  return terminal
}

/** Remove the imported Smithers Cloud mirror, including its repository host data. */
export const deleteOwnedCloudRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: string
): Promise<{ readonly deleteStatus: number; readonly finalStatus: number }> => {
  if (!repo.startsWith("codeplanesmithers/smithers-e2e-import-")) {
    throw new Error(`Refusing to delete a Smithers Cloud repository outside the owned E2E namespace: ${repo}`)
  }
  const path = cloudRepoPath(repo)
  const deletion = await realApi(page, request, "DELETE", path)
  expect([204, 404]).toContain(deletion.status())
  let finalStatus = 0
  await expect.poll(async () => {
    finalStatus = (await realApi(page, request, "GET", path)).status()
    return finalStatus
  }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(404)
  return { deleteStatus: deletion.status(), finalStatus }
}
