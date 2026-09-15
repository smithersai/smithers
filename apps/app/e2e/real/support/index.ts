import { test as base, expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test"
import { cp, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { spawn } from "node:child_process"

export { expect }

export type RealScenarioMetadata = {
  /** Stable lower-case identifier, shared by local proof and production canary evidence. */
  readonly id: string
  /** Capabilities which must be advertised by the real host's /api/bootstrap response. */
  readonly capabilities: readonly string[]
  /** Machine tokens such as action:repo.open, path:success, door:slash, dimension:keyboard. */
  readonly coverage: readonly string[]
  readonly description?: string
}

export type OwnedLocalRepo = {
  readonly root: string
  readonly path: string
  readonly name: string
}

export type OwnedLocalRepoOptions = {
  readonly name?: string
  readonly fixture?: string
  readonly files?: Readonly<Record<string, string>>
}

type RegisteredRepo = { readonly id: string; readonly path?: string }
type Lifecycle = {
  readonly request: APIRequestContext
  readonly baseURL: URL
  readonly sessionToken?: string
  readonly ptys: Set<string>
  readonly repos: Map<string, RegisteredRepo>
  readonly localRepos: Set<string>
}

let activeLifecycle: Lifecycle | undefined
// Playwright loads this package as CommonJS; __dirname follows its compiled module.
const supportDir = __dirname
const appDir = resolve(supportDir, "../../..")
const defaultFixture = join(supportDir, "../../fixtures/repo-plugin")
const fixtureRoot = resolve(supportDir, "../../fixtures")

const run = async (command: string, args: readonly string[], cwd: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`)))
  })
}

const requireLifecycle = (): Lifecycle => {
  if (!activeLifecycle) throw new Error("A real E2E resource can only be registered while a test is running.")
  return activeLifecycle
}

const requireSameOrigin = (page: Page, target: URL): void => {
  const current = new URL(page.url())
  if (!/^https?:$/.test(current.protocol) || current.origin !== target.origin) {
    throw new Error(`realApi refuses a cross-origin request: page=${current.origin}, request=${target.origin}`)
  }
}

const isDescendant = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`)

const authorizedFetch = (
  lifecycle: Pick<Lifecycle, "request" | "baseURL" | "sessionToken">,
  method: string,
  path: string,
  data?: unknown
): Promise<APIResponse> => lifecycle.request.fetch(new URL(path, lifecycle.baseURL).toString(), {
  method,
  ...(lifecycle.sessionToken ? { headers: { "x-smithers-local-session": lifecycle.sessionToken } } : {}),
  ...(data === undefined ? {} : { data })
})

/** Make an authenticated API call to the origin currently loaded in the product page. */
export const realApi = async (
  page: Page,
  _request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown
): Promise<APIResponse> => {
  const target = new URL(path, page.url())
  requireSameOrigin(page, target)
  // Cloud pages use their browser session and do not carry the local host's
  // session tag. Read the optional tag without waiting for one to appear.
  const token = await page.evaluate(() =>
    document.querySelector('meta[name="smithers-local-session"]')?.getAttribute("content") ?? null)
  return page.context().request.fetch(target.toString(), {
    method,
    ...(token ? { headers: { "x-smithers-local-session": token } } : {}),
    ...(data === undefined ? {} : { data })
  })
}

/** The same product entry, with the deployed site's marketing root excluded. */
export const appEntryPath = (): string => {
  const path = process.env.SMITHERS_REAL_APP_PATH ?? (process.env.SMITHERS_REAL_E2E_HOST === "production" ? "/codeplanesmithers/canary-sandbox" : "/")
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("SMITHERS_REAL_APP_PATH must be a same-origin absolute path.")
  return path
}

export const openApp = async (page: Page): Promise<void> => {
  await page.goto(appEntryPath())
}

/** Open the transient Command-K composer and wait for its real input focus. */
export const openComposer = async (page: Page): Promise<void> => {
  const input = page.getByTestId("composer-input")
  const closed = !(await input.isVisible()) || await input.evaluate((element) => element.closest('[inert], [aria-hidden="true"]') !== null)
  if (closed) await page.keyboard.press("ControlOrMeta+k")
  // A visible guide composer can be unfocused after interacting with a card.
  // Focus its real input; Command-K would instead toggle the guide dock closed.
  else if (!(await input.evaluate((element) => element === document.activeElement))) await input.click()
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
}

/** Submit one slash command or natural-language turn through the visible composer. */
export const command = async (page: Page, text: string): Promise<void> => {
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await input.fill(text)
  await input.press("Enter")
}

/** Dismiss the composer unless a confirmation dialog already owns keyboard input. */
export const closeComposer = async (page: Page): Promise<void> => {
  const input = page.getByTestId("composer-input")
  const modal = page.locator('.sui-dialog-content[role="dialog"]:visible').first()
  const inactive = async (): Promise<boolean> => !(await input.isVisible()) || await modal.isVisible()
  const waitForInactive = async (): Promise<boolean> => {
    try {
      await expect.poll(inactive, { timeout: 750 }).toBe(true)
      return true
    } catch {
      return false
    }
  }
  // Enter closes a command composer itself. Let that state transition and its
  // dock animation settle before emitting any new physical Escape. A modal
  // is also an inactive composer: it is now the top keyboard layer, and a
  // further Escape would correctly cancel that dialog.
  if (await waitForInactive()) return
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press("Escape")
    if (await waitForInactive()) return
  }
  await expect(input).toBeHidden()
}

/**
 * Create a disposable, runner-local repository with a real jj store.
 * External canaries must use a server-side disposable repository instead.
 */
export const createOwnedLocalRepo = async (options: OwnedLocalRepoOptions = {}): Promise<OwnedLocalRepo> => {
  if (process.env.SMITHERS_REAL_BASE_URL) {
    throw new Error("createOwnedLocalRepo is local-only; an external canary must provision a repository visible to its host.")
  }
  const lifecycle = requireLifecycle()
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-real-e2e-repo-")))
  const name = options.name ?? "real-e2e-repository"
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === "." || name === "..") {
    await rm(root, { recursive: true, force: true })
    throw new Error(`Owned repository name must be one safe path component: ${JSON.stringify(name)}`)
  }
  const path = join(root, name)
  try {
    if (options.fixture === "none") await mkdir(path, { recursive: true })
    else {
      const fixture = resolve(options.fixture ?? defaultFixture)
      if (!isDescendant(fixtureRoot, fixture)) throw new Error(`Repository fixture must be inside ${fixtureRoot}.`)
      await cp(fixture, path, {
        recursive: true,
        filter: (entry) => ![".git", ".jj", ".flows", "node_modules"].includes(basename(entry))
      })
    }
    for (const [relative, contents] of Object.entries(options.files ?? {})) {
      const destination = resolve(path, relative)
      if (!isDescendant(path, destination)) throw new Error(`Owned repository file escapes its root: ${JSON.stringify(relative)}`)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, contents)
    }
    await run("jj", ["git", "init", "--no-colocate", path], appDir)
    lifecycle.localRepos.add(root)
    return { root, path, name }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export const cleanupOwnedLocalRepo = async (repo: OwnedLocalRepo): Promise<void> => {
  const lifecycle = requireLifecycle()
  if (!lifecycle.localRepos.has(repo.root)) throw new Error(`Refusing cleanup of an unregistered directory: ${repo.root}`)
  if (!isDescendant(repo.root, repo.path)) throw new Error(`Refusing cleanup for an invalid owned repository path: ${repo.path}`)
  lifecycle.localRepos.delete(repo.root)
  await rm(repo.root, { recursive: true, force: true })
}

export const registerOwnedPty = (id: string): void => { requireLifecycle().ptys.add(id) }
export const registerOwnedRepo = (repo: RegisteredRepo): void => { requireLifecycle().repos.set(repo.id, repo) }

const validateScenario = (value: RealScenarioMetadata | undefined): RealScenarioMetadata => {
  if (!value || !/^[a-z0-9][a-z0-9._-]+$/.test(value.id)) {
    throw new Error("Every real E2E test must set realScenario with a stable lower-case id.")
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => !item.trim())) throw new Error(`Real scenario ${value.id} requires an explicit capabilities array; browser-only scenarios may declare [].`)
  if (value.coverage.length === 0 || value.coverage.some((token) => !/^(action|path|door|dimension|surface|host|evidence):[^:]+/.test(token))) {
    throw new Error(`Real scenario ${value.id} must declare prefixed coverage tokens.`)
  }
  return value
}

const scenarioFromAnnotations = (
  annotations: readonly { readonly type: string; readonly description?: string }[],
  fallback: RealScenarioMetadata | undefined
): RealScenarioMetadata => {
  const declaredId = annotations.find((annotation) => annotation.type === "real-scenario")?.description
  if (!declaredId) return validateScenario(fallback)
  const descriptions = annotations.find((annotation) => annotation.type === "real-description")?.description
  return validateScenario({
    id: declaredId,
    capabilities: annotations
      .filter((annotation) => annotation.type === "real-capability")
      .flatMap((annotation) => annotation.description ? [annotation.description] : []),
    coverage: annotations
      .filter((annotation) => annotation.type === "real-coverage")
      .flatMap((annotation) => annotation.description ? [annotation.description] : []),
    ...(descriptions ? { description: descriptions } : {})
  })
}

type RealFixtures = { readonly realScenario: RealScenarioMetadata | undefined; readonly _realLifecycle: void }

/**
 * Prefer a unique per-test `scenario(id, metadata)` details object from
 * ../coverage/types. `test.use({ realScenario })` remains a suite-level
 * fallback for a describe containing exactly one scenario.
 */
export const test = base.extend<RealFixtures>({
  realScenario: [undefined, { option: true }],
  _realLifecycle: [async ({ page, realScenario }, use, testInfo) => {
    const scenario = scenarioFromAnnotations(testInfo.annotations, realScenario)
    if (!testInfo.annotations.some((annotation) => annotation.type === "real-scenario")) {
      testInfo.annotations.push({ type: "real-scenario", description: scenario.id })
      if (scenario.description) testInfo.annotations.push({ type: "real-description", description: scenario.description })
      for (const capability of scenario.capabilities) testInfo.annotations.push({ type: "real-capability", description: capability })
      for (const coverage of scenario.coverage) testInfo.annotations.push({ type: "real-coverage", description: coverage })
    }

    const request = page.context().request
    const baseURL = new URL(testInfo.project.use.baseURL ?? page.url())
    const html = await request.get(new URL(appEntryPath(), baseURL).toString())
    if (!html.ok()) throw new Error(`Real host document preflight failed: HTTP ${html.status()}`)
    const token = /<meta\s+name=["']smithers-local-session["']\s+content=["']([^"']+)["']/i.exec(await html.text())?.[1]
    const bootstrap = await request.get(new URL("/api/bootstrap", baseURL).toString(), {
      ...(token ? { headers: { "x-smithers-local-session": token } } : {})
    })
    if (!bootstrap.ok()) throw new Error(`Real host bootstrap preflight failed: HTTP ${bootstrap.status()} ${await bootstrap.text()}`)
    const body = await bootstrap.json() as { host?: unknown; capabilities?: unknown; buildSha?: unknown }
    const verifiedHost = body.host === "cloud" ? "production" : body.host
    if (verifiedHost !== "local" && verifiedHost !== "production" && verifiedHost !== "native") {
      throw new Error(`Real host bootstrap returned an unsupported host identity: ${JSON.stringify(body.host)}`)
    }
    const expectedHost = process.env.SMITHERS_REAL_E2E_HOST
    if (expectedHost && expectedHost !== verifiedHost) {
      throw new Error(`Real host identity mismatch: expected ${expectedHost}, bootstrap verified ${verifiedHost}.`)
    }
    testInfo.annotations.push({ type: "real-host-verified", description: verifiedHost })
    if (verifiedHost === "production") {
      if (typeof body.buildSha !== "string" || !/^[0-9a-f]{40,64}$/.test(body.buildSha)) throw new Error("Production bootstrap did not identify the deployed build SHA.")
      if (body.buildSha !== process.env.SMITHERS_REAL_E2E_BUILD_SHA) throw new Error("Production build changed since preflight; restart the canary against a consistent deployment.")
      testInfo.annotations.push({ type: "real-build-sha", description: body.buildSha })
    }
    if (body.host === "local" && !token) throw new Error("Local real host preflight found no local-session token in the served product document.")
    if (body.host === "local") {
      const health = await request.get(new URL("/api/health", baseURL).toString())
      if (!health.ok()) throw new Error(`Local real host health preflight failed: HTTP ${health.status()} ${await health.text()}`)
    }
    const advertised = Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === "string") : []
    const missing = scenario.capabilities.filter((capability) => !advertised.includes(capability))
    if (missing.length > 0) throw new Error(`Real scenario ${scenario.id} requires unavailable capabilities: ${missing.join(", ")}. Advertised: ${advertised.join(", ")}`)

    const events: Array<{ readonly method: string; readonly path: string; readonly status: number }> = []
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith("/api/")) events.push({ method: response.request().method(), path: url.pathname, status: response.status() })
    })
    const lifecycle: Lifecycle = { request, baseURL, ...(token ? { sessionToken: token } : {}), ptys: new Set(), repos: new Map(), localRepos: new Set() }
    if (activeLifecycle) throw new Error("The real E2E lifecycle requires workers=1 and fullyParallel=false.")
    activeLifecycle = lifecycle
    try {
      await use()
    } finally {
      const failures: string[] = []
      for (const id of lifecycle.ptys) {
        try {
          const deleted = await authorizedFetch(lifecycle, "DELETE", `/api/pty/${encodeURIComponent(id)}`)
          if (!deleted.ok()) throw new Error(`DELETE returned HTTP ${deleted.status()}`)
        }
        catch (error) { failures.push(`PTY ${id}: ${String(error)}`) }
      }
      for (const repo of lifecycle.repos.values()) {
        try {
          const closed = await authorizedFetch(lifecycle, "POST", "/api/repo/close", { repoId: repo.id })
          if (!closed.ok()) throw new Error(`close returned HTTP ${closed.status()}`)
        }
        catch (error) { failures.push(`repository ${repo.id}${repo.path ? ` (${repo.path})` : ""}: ${String(error)}`) }
      }
      if (lifecycle.ptys.size > 0) {
        try {
          const response = await authorizedFetch(lifecycle, "GET", "/api/pty")
          if (!response.ok()) throw new Error(`GET returned HTTP ${response.status()}`)
          const body = await response.json() as { sessions?: Array<{ sessionId?: string }> }
          const remaining = (body.sessions ?? []).map((session) => session.sessionId).filter((id): id is string => typeof id === "string")
            .filter((id) => lifecycle.ptys.has(id))
          if (remaining.length > 0) throw new Error(`sessions remain: ${remaining.join(", ")}`)
        } catch (error) { failures.push(`PTY verification: ${String(error)}`) }
      }
      if (lifecycle.repos.size > 0) {
        try {
          const response = await authorizedFetch(lifecycle, "GET", "/api/repos")
          if (!response.ok()) throw new Error(`GET returned HTTP ${response.status()}`)
          const body = await response.json() as { repos?: Array<{ id?: string }> }
          const remaining = (body.repos ?? []).map((repo) => repo.id).filter((id): id is string => typeof id === "string")
            .filter((id) => lifecycle.repos.has(id))
          if (remaining.length > 0) throw new Error(`repositories remain: ${remaining.join(", ")}`)
        } catch (error) { failures.push(`repository verification: ${String(error)}`) }
      }
      for (const root of lifecycle.localRepos) {
        try { await rm(root, { recursive: true, force: true }) }
        catch (error) { failures.push(`directory ${root}: ${String(error)}`) }
      }
      activeLifecycle = undefined
      await testInfo.attach("real-network-statuses", { body: JSON.stringify(events, null, 2), contentType: "application/json" })
      if (failures.length > 0) throw new Error(`Real E2E resource cleanup failed:\n${failures.join("\n")}`)
    }
  }, { auto: true }]
})
