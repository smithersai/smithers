import { scenario } from "./coverage/types"
import { fixtureRepositoryName } from "./support/values"
import { command, expect, realApi, test } from "./support/test"
import { authenticatedTest } from "./auth-permissions/profile"
import {
  attachJson,
  bootRepositoryWorkbench,
  createRepositoryPair,
  dismissComposer,
  enableVerboseEvidence,
  expectFlowOutcome,
  openOwnedRepository,
  selectOwnedRepository
} from "./repositories-github/local"
import {
  attachProductionJson,
  bootProductionRepository,
  cloudRepoPath,
  createOwnedGitHubRepository,
  deleteOwnedCloudRepository,
  deleteOwnedGitHubRepository,
  enableProductionVerbose,
  PRODUCTION_REPO,
  readJson,
  repositoryApiPath,
  waitForImportJob,
  waitForImportJobId,
  type OwnedGitHubRepository
} from "./repositories-github/production"

test.setTimeout(120_000)
test.use({ actionTimeout: 20_000 })
authenticatedTest.setTimeout(180_000)
authenticatedTest.use({ actionTimeout: 30_000 })

test(
  "two disposable repositories stay isolated through selection, tree navigation, and file reads",
  scenario("repositories.local-isolation-tree-files", {
    capabilities: ["local.repositories"],
    description: "Open two real jj repositories, navigate their actual directory cards, and prove same-named files remain bound to the selected filesystem.",
    coverage: [
      "action:repo.open", "action:repo.select", "action:files.list", "action:files.read",
      "host:local", "path:success", "door:slash", "door:button", "dimension:repository-isolation",
      "dimension:tree-navigation", "evidence:ui-api-filesystem-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const { first, second, marker } = await createRepositoryPair()
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    const firstOpened = await openOwnedRepository(page, request, first)
    const secondOpened = await openOwnedRepository(page, request, second)

    await selectOwnedRepository(page, first)
    const listingResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await command(page, "/files.list /")
    await dismissComposer(page)
    expect((await listingResponse).status()).toBe(200)
    const root = page.locator('.smithers-card[data-kind="file-list"]').last()
    await expect(root).toContainText(first.name)
    await expect(root.getByRole("button", { name: /docs/ })).toBeVisible()

    const nestedListing = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await root.getByRole("button", { name: /docs/ }).click()
    expect((await nestedListing).status()).toBe(200)
    const docs = page.locator('.smithers-card[data-kind="file-list"]').last()
    await expect(docs).toContainText("docs")
    const firstRead = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await docs.getByRole("button", { name: /shared\.txt/ }).click()
    expect((await firstRead).status()).toBe(200)
    const alpha = page.locator('.smithers-card[data-kind="file"]').last()
    await expect(alpha).toContainText(`ALPHA_TREE_TRUTH_${marker}`)
    await expect(alpha).not.toContainText(`BETA_TREE_TRUTH_${marker}`)

    await selectOwnedRepository(page, second)
    await command(page, "/files.read docs/shared.txt")
    await dismissComposer(page)
    const beta = page.locator('.smithers-card[data-kind="file"]').last()
    await expect(beta).toContainText(`BETA_TREE_TRUTH_${marker}`)
    await expect(beta).not.toContainText(`ALPHA_TREE_TRUTH_${marker}`)

    const firstDisk = await realApi(page, request, "POST", "/api/repo/files", { repoId: firstOpened.id, path: "docs/shared.txt" })
    const secondDisk = await realApi(page, request, "POST", "/api/repo/files", { repoId: secondOpened.id, path: "docs/shared.txt" })
    expect(firstDisk.status()).toBe(200)
    expect(secondDisk.status()).toBe(200)
    const firstBody = await firstDisk.json() as { readonly content?: unknown }
    const secondBody = await secondDisk.json() as { readonly content?: unknown }
    expect(firstBody.content).toBe(`ALPHA_TREE_TRUTH_${marker}\n`)
    expect(secondBody.content).toBe(`BETA_TREE_TRUTH_${marker}\n`)
    await attachJson(testInfo, "repository-isolation", { firstOpened, secondOpened, firstBody, secondBody })
  }
)

authenticatedTest(
  "the existing GitHub App installation verifies the canary and survives a status re-check",
  scenario("repositories.github-app-status-recheck", {
    capabilities: ["identity", "cloud"],
    description: "Resolve the exact App installation from Smithers' status or linked door, independently verify its canary inventory, reconcile the wiring, then require a re-check to preserve installed state.",
    coverage: [
      "action:github.app", "action:github.reconcile", "host:production", "path:success", "door:slash", "door:button",
      "dimension:github-app-installed", "dimension:installation-inventory", "dimension:status-recheck",
      "evidence:session-card-status-and-installation-readback"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    await bootProductionRepository(page)
    await enableProductionVerbose(page)
    const statusPath = cloudRepoPath(PRODUCTION_REPO, "/github-app-status")
    const firstStatus = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === statusPath)
    await command(page, `/github.app ${PRODUCTION_REPO}`)
    await expectFlowOutcome(page, "github.app", PRODUCTION_REPO, "executed")
    expect((await firstStatus).status()).toBe(200)
    await dismissComposer(page)

    const card = page.locator('.smithers-card[data-kind="connector-setup"]').last()
    await expect(card).toBeVisible()
    await expect(card).toContainText(PRODUCTION_REPO)
    const initialStatus = await readJson<{
      readonly github_app_installed?: unknown
      readonly github_app_configured?: unknown
      readonly installation_id?: unknown
      readonly install_url?: unknown
    }>(page, request, statusPath)
    expect(initialStatus.github_app_configured).toBe(true)

    let installationId = typeof initialStatus.installation_id === "number"
      ? String(initialStatus.installation_id)
      : undefined
    if (installationId === undefined) {
      expect(initialStatus.install_url).toBe("https://github.com/apps/smitherspreviewrelease/installations/new")
      const opened = context.waitForEvent("page")
      await card.getByRole("button", { name: "Open GitHub", exact: true }).click()
      await expectFlowOutcome(page, "github.app.open", PRODUCTION_REPO, "executed")
      const github = await opened
      try {
        await github.waitForURL((candidate) => candidate.hostname === "github.com" && /\/settings\/installations\/\d+$/.test(candidate.pathname), {
          timeout: 60_000
        })
        installationId = /\/settings\/installations\/(\d+)$/.exec(new URL(github.url()).pathname)?.[1]
        expect(installationId).toMatch(/^\d+$/)
        await attachProductionJson(testInfo, "github-app-installation-door", {
          installUrl: initialStatus.install_url,
          redirectedOrigin: new URL(github.url()).origin,
          redirectedPath: new URL(github.url()).pathname,
          title: await github.title()
        })
      } finally {
        await github.close()
      }
    }

    const verificationPath = `/api/user/github-app/installations/${encodeURIComponent(installationId!)}`
    const installations = await readJson<{
      readonly repos?: ReadonlyArray<{ readonly fullName?: unknown; readonly full_name?: unknown }>
      readonly repo?: unknown
    }>(page, request, verificationPath)
    const selected = installations.repo === PRODUCTION_REPO || installations.repos?.some((repo) =>
      repo.fullName === PRODUCTION_REPO || repo.full_name === PRODUCTION_REPO) === true
    await attachProductionJson(testInfo, "github-app-installation-inventory", {
      installationId,
      selectedCanary: selected,
      selectedRepositoryCount: installations.repos?.length ?? 1
    })
    expect(selected).toBe(true)

    const reconcilePath = cloudRepoPath(PRODUCTION_REPO, "/github/reconcile")
    const reconciling = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === reconcilePath)
    await command(page, `/github.reconcile ${PRODUCTION_REPO}`)
    const reconcileResponse = await reconciling
    await attachProductionJson(testInfo, "github-app-reconcile-response", {
      method: reconcileResponse.request().method(),
      path: new URL(reconcileResponse.url()).pathname,
      status: reconcileResponse.status()
    })
    expect(reconcileResponse.status()).toBe(202)
    await expectFlowOutcome(page, "github.reconcile", PRODUCTION_REPO, "executed")
    await dismissComposer(page)
    await expect(card).toContainText(/GitHub App installed.*configured/)

    const rechecked = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === statusPath)
    await card.getByRole("button", { name: "Re-check", exact: true }).click()
    expect((await rechecked).status()).toBe(200)
    await expectFlowOutcome(page, "github.app", PRODUCTION_REPO, "executed")

    const status = await readJson<{
      readonly github_app_installed?: unknown
      readonly github_app_configured?: unknown
      readonly installation_id?: unknown
    }>(page, request, statusPath)
    await attachProductionJson(testInfo, "github-app-status", {
      initialStatus,
      status,
      cardTextAfterRecheck: await card.textContent(),
      installationSelection: { selectedCanary: selected, selectedRepositoryCount: installations.repos?.length ?? 1 }
    })
    expect(status.github_app_installed).toBe(true)
    expect(status.github_app_configured).toBe(true)
    expect(typeof status.installation_id).toBe("number")
    await expect(card).toContainText(/GitHub App installed.*configured/)
  }
)

authenticatedTest(
  "branches open a real commit history and keyboard-open a revision detail",
  scenario("repositories.github-branches-commits-revision", {
    capabilities: ["identity", "cloud"],
    description: "List the canary's real branches, open main through its rendered action, keyboard-open the head commit, and verify the revision and diff independently against Smithers Cloud.",
    coverage: [
      "action:branches.list", "action:commits.list", "action:commits.read", "host:production", "path:success",
      "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:branch-to-commit", "dimension:revision-diff",
      "evidence:cards-and-independent-cloud-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    await bootProductionRepository(page)
    const bookmarksPath = repositoryApiPath(PRODUCTION_REPO, "/bookmarks")
    const listed = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === bookmarksPath)
    await command(page, `/branches.list ${PRODUCTION_REPO}`)
    const listedResponse = await listed
    await attachProductionJson(testInfo, "branches-list-response", {
      method: listedResponse.request().method(),
      path: new URL(listedResponse.url()).pathname,
      status: listedResponse.status()
    })
    expect(listedResponse.status()).toBe(200)
    await dismissComposer(page)
    const branches = page.locator('.smithers-card[data-kind="branches"]').last()
    await expect(branches).toBeVisible()
    const main = branches.getByRole("button", { name: "Commits on main", exact: true })
    await expect(main).toBeVisible()

    const bookmarks = await readJson<{
      readonly items?: ReadonlyArray<{
        readonly name?: unknown
        readonly target_change_id?: unknown
        readonly target_commit_id?: unknown
      }>
    }>(page, request, `${bookmarksPath}?limit=100`)
    const mainBookmark = bookmarks.items?.find((item) => item.name === "main")
    expect(mainBookmark).toBeDefined()
    expect(typeof mainBookmark?.target_change_id).toBe("string")
    expect(typeof mainBookmark?.target_commit_id).toBe("string")

    await main.click()
    const commits = page.locator('.smithers-card[data-kind="commit-list"]').last()
    await expect(commits).toBeVisible({ timeout: 60_000 })
    await expect(commits).toContainText("commits on main")
    const headRow = commits.locator(".commit-row").first()
    await expect(headRow).toHaveAttribute("data-commit-id", String(mainBookmark?.target_commit_id))
    const openHead = headRow.locator("[data-row-open]")
    await openHead.focus()
    await expect(openHead).toBeFocused()
    await openHead.press("Enter")

    const detail = page.locator('.smithers-card[data-kind="commit"]').last()
    await expect(detail).toBeVisible({ timeout: 60_000 })
    const changeId = String(mainBookmark?.target_change_id)
    const changePath = repositoryApiPath(PRODUCTION_REPO, `/changes/${encodeURIComponent(changeId)}`)
    const change = await readJson<{
      readonly change_id?: unknown
      readonly commit_id?: unknown
      readonly description?: unknown
    }>(page, request, changePath)
    expect(change.change_id).toBe(changeId)
    expect(change.commit_id).toBe(mainBookmark?.target_commit_id)
    await expect(detail).toContainText(String(change.commit_id).slice(0, 7))
    if (typeof change.description === "string" && change.description.trim() !== "") {
      await expect(detail).toContainText(change.description.trim().split("\n")[0]!)
    }
    const diffResponse = await realApi(page, request, "GET", `${changePath}/diff`)
    expect(diffResponse.status()).toBe(200)
    const diff = await diffResponse.json()
    await attachProductionJson(testInfo, "branches-commits-revision", { mainBookmark, change, diff })
  }
)

authenticatedTest(
  "the owned canary mirror completes and publishes its real repository status",
  scenario("repositories.github-mirror-sync", {
    capabilities: ["identity", "cloud"],
    description: "Start a deployed GitHub mirror run for the owned canary, wait for its actual terminal card, and verify the repository's mirror status independently.",
    coverage: [
      "action:github.mirror-sync", "host:production", "path:success", "door:slash",
      "dimension:mirror-terminal-run", "evidence:sync-card-and-repository-api-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    await bootProductionRepository(page)
    await enableProductionVerbose(page)
    const mirrorPath = cloudRepoPath(PRODUCTION_REPO, "/mirror-sync")
    const started = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === mirrorPath)
    await command(page, `/github.mirror-sync ${PRODUCTION_REPO}`)
    const startedResponse = await started
    await attachProductionJson(testInfo, "mirror-sync-start-response", {
      method: startedResponse.request().method(),
      path: new URL(startedResponse.url()).pathname,
      status: startedResponse.status()
    })
    expect(startedResponse.status()).toBe(202)
    await expectFlowOutcome(page, "github.mirror-sync", PRODUCTION_REPO, "executed")
    await dismissComposer(page)
    const card = page.locator('.smithers-card[data-kind="sync-ops"]').last()
    await expect(card).toBeVisible()
    await expect(card).toContainText(`GitHub → ${PRODUCTION_REPO} mirror`)
    await expect(card).toContainText("succeeded", { timeout: 120_000 })

    const runId = /\brun\s+(\d+)\b/.exec(await card.textContent() ?? "")?.[1]
    expect(runId).toBeDefined()
    const run = await readJson<{
      readonly state?: unknown
      readonly refs?: ReadonlyArray<{ readonly name?: unknown; readonly status?: unknown }>
    }>(page, request, `${mirrorPath}/${encodeURIComponent(runId!)}`)
    expect(run.state).toBe("succeeded")
    expect(Array.isArray(run.refs)).toBe(true)
    expect(run.refs?.length).toBeGreaterThan(0)
    expect(run.refs?.every((ref) => ref.status === "succeeded")).toBe(true)

    const repository = await readJson<{
      readonly mirror_status?: unknown
      readonly behind_refs?: unknown
      readonly failed_refs?: unknown
    }>(
      page,
      request,
      cloudRepoPath(PRODUCTION_REPO)
    )
    expect(repository.mirror_status).toBe("synced")
    expect(repository.behind_refs).toBe(0)
    expect(repository.failed_refs).toBe(0)
    await attachProductionJson(testInfo, "mirror-sync", { runId, run, repository })
  }
)

authenticatedTest(
  "retrying an unfailed mirror ref is refused without changing the repository",
  scenario("repositories.github-mirror-retry-refusal", {
    capabilities: ["identity", "cloud"],
    description: "Exercise the deployed per-ref mirror retry route with a uniquely named ref that is not failed, require its exact missing-ref refusal, and prove the canary's mirror facts remain unchanged.",
    coverage: [
      "action:github.mirror.retry-ref", "host:production", "path:error", "door:slash",
      "dimension:mirror-retry-boundary", "evidence:verbose-failure-api-status-and-before-after-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    await bootProductionRepository(page)
    await enableProductionVerbose(page)
    const before = await readJson<Record<string, unknown>>(page, request, cloudRepoPath(PRODUCTION_REPO))
    const stableMirrorFacts = (repository: Record<string, unknown>) => ({
      mirror_status: repository.mirror_status,
      last_mirror_at: repository.last_mirror_at,
      last_mirror_github_head: repository.last_mirror_github_head,
      behind_refs: repository.behind_refs,
      failed_refs: repository.failed_refs
    })
    const ref = `refs/heads/smithers-e2e-missing-${Date.now()}`
    const retrying = page.waitForResponse((response) =>
      response.request().method() === "POST"
        && new URL(response.url()).pathname.includes("/github/mirror/refs/")
        && new URL(response.url()).pathname.endsWith("/retry"))
    await command(page, `/github.mirror.retry-ref ${ref}`)
    const response = await retrying
    expect(response.status()).toBe(404)
    const refusal = await response.json() as { readonly message?: unknown }
    expect(refusal.message).toBe("mirror ref result not found")
    await expectFlowOutcome(page, "github.mirror.retry-ref", ref, "failed")
    const card = page.locator('.smithers-card[data-kind="sync-ops"]').last()
    await expect(card).toBeVisible()
    await expect(card).toContainText("mirror ref result not found")
    const after = await readJson<Record<string, unknown>>(page, request, cloudRepoPath(PRODUCTION_REPO))
    expect(stableMirrorFacts(after)).toEqual(stableMirrorFacts(before))
    await attachProductionJson(testInfo, "mirror-retry-refusal", {
      ref,
      retryStatus: response.status(),
      refusal,
      before: stableMirrorFacts(before),
      after: stableMirrorFacts(after)
    })
  }
)

authenticatedTest(
  "a repository created in GitHub imports into Smithers Cloud and is deleted from both services",
  scenario("repositories.github-create-import-cleanup", {
    capabilities: ["identity", "cloud"],
    description: "Create a uniquely named private GitHub repository through GitHub's real UI, import it through Smithers, verify the mirrored branch, then delete the owned fixture from Smithers Cloud and GitHub.",
    coverage: [
      "action:repos.import", "host:production", "path:success", "door:slash",
      "dimension:github-repository-create", "dimension:cloud-import", "dimension:two-service-cleanup",
      "evidence:github-ui-import-card-cloud-api-and-deletion-readback"
    ]
  }),
  async ({ page, request, context }, testInfo) => {
    testInfo.setTimeout(420_000)
    await bootProductionRepository(page)
    await enableProductionVerbose(page)
    const appStatusPath = cloudRepoPath(PRODUCTION_REPO, "/github-app-status")
    const checkingApp = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === appStatusPath)
    await command(page, `/github.app ${PRODUCTION_REPO}`)
    await expectFlowOutcome(page, "github.app", PRODUCTION_REPO, "executed")
    expect((await checkingApp).status()).toBe(200)
    const appStatus = await readJson<{
      readonly github_app_installed?: unknown
      readonly github_app_configured?: unknown
      readonly installation_id?: unknown
    }>(page, request, appStatusPath)
    await attachProductionJson(testInfo, "github-import-preflight", { appStatus })
    expect(appStatus.github_app_installed).toBe(true)
    expect(appStatus.github_app_configured).toBe(true)
    expect(typeof appStatus.installation_id).toBe("number")

    const name = fixtureRepositoryName(`smithers-e2e-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    let owned: OwnedGitHubRepository | undefined
    let terminal: Record<string, unknown> | undefined
    let cloudCleanup: { readonly deleteStatus: number; readonly finalStatus: number } | undefined
    let githubDeleted = false
    let importSubmitted = false
    let acceptedJobId: string | undefined
    let scenarioError: unknown
    try {
      owned = await createOwnedGitHubRepository(context, name)
      const importing = page.waitForResponse((response) =>
        response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/cloud/api/github/import")
      importSubmitted = true
      await command(page, `/repos.import ${owned.fullName}`)
      const importResponse = await importing
      const importStart = await importResponse.json().catch(() => undefined) as Record<string, unknown> | undefined
      acceptedJobId = typeof importStart?.importJobId === "string" && importStart.importJobId !== ""
        ? importStart.importJobId
        : undefined
      await attachProductionJson(testInfo, "github-import-start", {
        status: importResponse.status(),
        acceptedJobId,
        jobStatus: importStart?.status
      })
      expect(importResponse.status()).toBeGreaterThanOrEqual(200)
      expect(importResponse.status()).toBeLessThan(300)
      expect(acceptedJobId).toBeDefined()
      await expectFlowOutcome(page, "repos.import", owned.fullName, "executed")
      await dismissComposer(page)

      const card = page.getByTestId(`card-repo-import-${owned.fullName}`)
      await expect(card).toBeVisible()
      await expect(card).toContainText(owned.fullName)
      await expect(card.getByText("done", { exact: true })).toBeVisible({ timeout: 240_000 })
      terminal = await waitForImportJob(page, request, card)
      if (terminal !== undefined) expect(terminal.status).toBe("ready")

      const repository = await readJson<Record<string, unknown>>(page, request, cloudRepoPath(owned.fullName))
      const bookmarks = await readJson<{
        readonly items?: ReadonlyArray<{ readonly name?: unknown; readonly target_commit_id?: unknown }>
      }>(page, request, `${repositoryApiPath(owned.fullName, "/bookmarks")}?limit=100`)
      const defaultBranch = bookmarks.items?.find((item) => item.name === "main" || item.name === "master")
      expect(defaultBranch).toBeDefined()
      expect(typeof defaultBranch?.target_commit_id).toBe("string")
      await attachProductionJson(testInfo, "github-import", { owned: owned.fullName, terminal, repository, bookmarks })
    } catch (error) {
      scenarioError = error
    }

    const cleanupFailures: unknown[] = []
    let importDrained = false
    if (owned !== undefined) {
      const card = page.getByTestId(`card-repo-import-${owned.fullName}`)
      try {
        if (!importSubmitted) importDrained = true
        else {
          const observedTerminal = terminal ?? (acceptedJobId !== undefined
            ? await waitForImportJobId(page, request, acceptedJobId)
            : await (async () => {
                await expect(card, `exact import card for ${owned.fullName}`).toHaveCount(1)
                return await waitForImportJob(page, request, card)
              })())
          if (observedTerminal === undefined) throw new Error(`Import job for ${owned.fullName} exposed no terminal evidence`)
          terminal = observedTerminal
          const cardOnly = observedTerminal.observed_from === "repo-import-card"
          importDrained = !cardOnly && (observedTerminal.status === "ready" || observedTerminal.status === "failed")
        }
        if (!importDrained) throw new Error(`Import job for ${owned.fullName} did not reach a terminal state`)
      } catch (error) {
        cleanupFailures.push(error)
      }

      if (importDrained) {
        // Both eligible owned services get independent cleanup attempts. One
        // failure cannot prevent the other deletion from running.
        const [cloudResult, githubResult] = await Promise.allSettled([
          deleteOwnedCloudRepository(page, request, owned.fullName),
          deleteOwnedGitHubRepository(owned)
        ])
        if (cloudResult.status === "fulfilled") cloudCleanup = cloudResult.value
        else cleanupFailures.push(cloudResult.reason)
        if (githubResult.status === "fulfilled") githubDeleted = true
        else cleanupFailures.push(githubResult.reason)
      } else {
        // A live import can recreate a Cloud repository after deletion. Remove
        // its owned GitHub source first, give the job one bounded chance to
        // settle, and only then make Cloud deletion eligible.
        const [githubResult] = await Promise.allSettled([deleteOwnedGitHubRepository(owned)])
        if (githubResult.status === "fulfilled") githubDeleted = true
        else cleanupFailures.push(githubResult.reason)
        try {
          if (acceptedJobId !== undefined) terminal = await waitForImportJobId(page, request, acceptedJobId, 60_000)
          else if (await card.count() === 1) terminal = await waitForImportJob(page, request, card, 60_000)
          const cardOnly = terminal?.observed_from === "repo-import-card"
          importDrained = !cardOnly && (terminal?.status === "ready" || terminal?.status === "failed")
        } catch (error) {
          cleanupFailures.push(error)
        }
        if (importDrained) {
          const [cloudResult] = await Promise.allSettled([
            deleteOwnedCloudRepository(page, request, owned.fullName)
          ])
          if (cloudResult.status === "fulfilled") cloudCleanup = cloudResult.value
          else cleanupFailures.push(cloudResult.reason)
        } else {
          cleanupFailures.push(new Error(`Cloud cleanup for ${owned.fullName} was withheld because its import job never drained`))
        }
      }
      await owned.page.close().catch((error) => { cleanupFailures.push(error) })
      await attachProductionJson(testInfo, "github-import-cleanup", {
        repo: owned.fullName,
        importSubmitted,
        acceptedJobId,
        terminal,
        importDrained,
        cloudCleanup,
        githubDeleted,
        failures: cleanupFailures.map((error) => String(error))
      })
    }
    const failures = [...(scenarioError === undefined ? [] : [scenarioError]), ...cleanupFailures]
    if (failures.length > 0) {
      throw new AggregateError(failures, `Repository import lifecycle for ${owned?.fullName ?? name} did not complete cleanly`)
    }
  }
)

test(
  "a pinned repository reopens after host close and unpin remains effective after reload",
  scenario("repositories.local-pin-reopen-unpin", {
    capabilities: ["local.repositories", "local.repository-path-entry"],
    description: "Close an owned checkout behind the UI, select its durable pin to reopen it, then unpin and verify the choice remains unavailable after reload.",
    coverage: [
      "action:repo.open", "action:repo.select", "action:repo.unpin", "host:local", "path:success",
      "path:persistence", "door:slash", "dimension:pin-reopen", "dimension:reload", "evidence:host-inventory-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const { first } = await createRepositoryPair()
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    const opened = await openOwnedRepository(page, request, first)
    const key = `local:${first.path}`

    const closed = await realApi(page, request, "POST", "/api/repo/close", { repoId: opened.id })
    expect(closed.status()).toBe(200)
    // A page restart makes the renderer re-read the host inventory while the
    // durable pin stays in SQLite. Selecting that pin must reopen its path.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/smithersai\/smithers$/)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByTestId("transcript")).toBeVisible()
    const reopening = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
    await command(page, `/repo.select ${key}`)
    await expectFlowOutcome(page, "repo.select", key, "executed")
    expect((await reopening).status()).toBe(200)

    const reopenedInventoryResponse = await realApi(page, request, "GET", "/api/repos")
    expect(reopenedInventoryResponse.status()).toBe(200)
    const reopenedInventory = await reopenedInventoryResponse.json() as {
      readonly repos?: ReadonlyArray<{ readonly id?: unknown; readonly path?: unknown }>
    }
    expect(reopenedInventory.repos).toContainEqual(expect.objectContaining({ id: opened.id, path: first.path }))
    await attachJson(testInfo, "pin-reopen-inventory", { key, opened, reopenedInventory })

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/smithersai\/smithers$/)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByTestId("transcript")).toBeVisible()
    await command(page, `/repo.unpin ${key}`)
    await expectFlowOutcome(page, "repo.unpin", key, "executed")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByTestId("transcript")).toBeVisible()
    await command(page, `/repo.select ${key}`)
    await expectFlowOutcome(page, "repo.select", key, "failed")
    await expect(page.getByText(`There is no pinned repository with key ${key}.`, { exact: true }).last()).toBeVisible()

    const inventoryResponse = await realApi(page, request, "GET", "/api/repos")
    expect(inventoryResponse.status()).toBe(200)
    const inventory = await inventoryResponse.json()
    await attachJson(testInfo, "pin-reopen-unpin", { key, opened, reopenedInventory, inventory })
  }
)

test(
  "the real folder prompt cancels cleanly and reports an invalid path without publishing a repo",
  scenario("repositories.local-folder-cancel-invalid", {
    capabilities: ["local.repositories", "local.repository-path-entry"],
    description: "Dismiss the actual browser folder prompt, then submit a missing directory and require the real host error with an unchanged inventory.",
    coverage: [
      "action:repo.open", "host:local", "path:error", "door:user-only",
      "dimension:folder-cancel", "dimension:invalid-path", "evidence:dialog-api-inventory"
    ]
  }),
  async ({ page, request }, testInfo) => {
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    const beforeResponse = await realApi(page, request, "GET", "/api/repos")
    expect(beforeResponse.status()).toBe(200)
    const before = await beforeResponse.json() as { readonly repos?: ReadonlyArray<unknown> }

    let cancelledPrompt = ""
    page.once("dialog", async (dialog) => {
      cancelledPrompt = `${dialog.type()}:${dialog.message()}`
      await dialog.dismiss()
    })
    await command(page, "/repo.open")
    await expectFlowOutcome(page, "repo.open", "", "executed")
    const afterCancelResponse = await realApi(page, request, "GET", "/api/repos")
    expect(afterCancelResponse.status()).toBe(200)
    const afterCancel = await afterCancelResponse.json() as { readonly repos?: ReadonlyArray<unknown> }
    expect(cancelledPrompt).toBe("prompt:Repository path")
    expect(afterCancel.repos).toEqual(before.repos)

    const missing = `/tmp/smithers-e2e-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`
    page.once("dialog", async (dialog) => { await dialog.accept(missing) })
    const rejected = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
    await command(page, "/repo.open")
    const rejectedResponse = await rejected
    expect(rejectedResponse.status()).toBeGreaterThanOrEqual(400)
    expect(rejectedResponse.status()).toBeLessThan(500)
    expect(rejectedResponse.request().postDataJSON()).toEqual({ path: missing })
    await expectFlowOutcome(page, "repo.open", "", "failed")
    const failedTrace = page.locator(".tool-act-line").filter({ hasText: "You ran /repo.open → failed" }).last()
    await expect(failedTrace).toContainText(/does not exist or cannot be read/i)
    const afterInvalidResponse = await realApi(page, request, "GET", "/api/repos")
    expect(afterInvalidResponse.status()).toBe(200)
    const afterInvalid = await afterInvalidResponse.json() as { readonly repos?: ReadonlyArray<unknown> }
    expect(afterInvalid.repos).toEqual(before.repos)
    expect(afterInvalid.repos?.some((repo) => JSON.stringify(repo).includes(missing))).toBe(false)
    await attachJson(testInfo, "folder-cancel-invalid", {
      cancelledPrompt,
      missing,
      rejectedStatus: rejectedResponse.status(),
      before,
      afterCancel,
      afterInvalid
    })
  }
)

test(
  "repo.tree projects a keyboard-operable directory tree in the canonical workbench",
  scenario("repositories.local-visible-tree", {
    capabilities: ["local.repositories"],
    description: "Require repo.tree's real directory read to produce the visible keyboard path promised by the repository tree flow on /owner/repo.",
    coverage: [
      "action:repo.open", "action:repo.tree", "host:local", "path:success", "path:keyboard",
      "door:slash", "door:button", "dimension:canonical-workbench", "dimension:keyboard", "evidence:repo-tree-network-and-dom"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const { first } = await createRepositoryPair()
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    await openOwnedRepository(page, request, first)
    const key = `local:${first.path}`
    await selectOwnedRepository(page, first)
    const loading = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await command(page, `/repo.tree ${key}`)
    await expectFlowOutcome(page, "repo.tree", key, "executed")
    const response = await loading
    expect(response.status()).toBe(200)
    await dismissComposer(page)

    const tree = page.getByTestId(`repo-tree-${key}`)
    await expect(tree).toBeVisible()
    const docs = tree.getByRole("button", { name: /docs/ })
    await docs.focus()
    await expect(docs).toBeFocused()
    await docs.press("Enter")
    await expect(tree).toContainText("shared.txt")
    await attachJson(testInfo, "visible-repository-tree", { key, status: response.status() })
  }
)
