import { fixtureRepositoryName } from "../support/values"
import type { APIRequestContext, BrowserContext, Page, TestInfo } from "@playwright/test"
import { authenticatedTest } from "../auth-permissions/profile"
import { expect, realApi } from "../support/test"
import {
  attachProductionJson,
  bootProductionRepository,
  cloudRepoPath,
  createOwnedGitHubRepository,
  deleteOwnedCloudRepository,
  deleteOwnedGitHubRepository,
  waitForImportJobId,
  type OwnedGitHubRepository
} from "../repositories-github/production"
import { gatewayCall, runSummary, waitForTerminalRun, type RunSummary, type RunTracker } from "./production"

export type OwnedWorkflowRepository = RunTracker & {
  readonly repo: string
  readonly workspaceId?: string
  readonly gatewayId?: string
  readonly runs: Set<string>
}

type WorkflowFixtures = { readonly workflowRepo: OwnedWorkflowRepository }

const importRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  testInfo: TestInfo,
  observed: (status: number, jobId?: string) => void
): Promise<{ readonly jobId: string; readonly terminal: Record<string, unknown> }> => {
  const [owner, name] = repo.split("/")
  const start = await realApi(page, request, "POST", "/api/cloud/api/github/import", { owner, repo: name })
  const body = await start.json().catch(() => undefined) as Record<string, unknown> | undefined
  const jobId = typeof body?.importJobId === "string" && body.importJobId !== "" ? body.importJobId : undefined
  observed(start.status(), jobId)
  await attachProductionJson(testInfo, "workflow-fixture-import-start", { repo, status: start.status(), jobId, jobStatus: body?.status })
  expect(start.status(), `import ${repo}`).toBeGreaterThanOrEqual(200)
  expect(start.status(), `import ${repo}`).toBeLessThan(300)
  expect(jobId, "the import service must return the exact accepted job id").toBeDefined()
  const terminal = await waitForImportJobId(page, request, jobId!, 240_000)
  expect(terminal.status).toBe("ready")
  return { jobId: jobId!, terminal }
}

const provisionRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: string,
  testInfo: TestInfo
): Promise<{ readonly workspaceId?: string; readonly gatewayId?: string }> => {
  const deadline = Date.now() + 180_000
  let last: Record<string, unknown> | undefined
  do {
    const response = await realApi(page, request, "POST", "/api/workflow/provision", { repo })
    expect(response.status(), `provision ${repo}`).toBe(200)
    last = await response.json() as Record<string, unknown>
    if (last.status === "ready") {
      const result = {
        ...(typeof last.workspaceId === "string" ? { workspaceId: last.workspaceId } : {}),
        ...(typeof last.gatewayId === "string" ? { gatewayId: last.gatewayId } : {})
      }
      await attachProductionJson(testInfo, "workflow-fixture-provision", { repo, ...last })
      return result
    }
    if (last.status !== "provisioning") break
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  } while (Date.now() < deadline)
  throw new Error(`Workflow fixture ${repo} did not provision: ${JSON.stringify(last)}`)
}

const deleteGitHub = async (owned: OwnedGitHubRepository): Promise<void> => {
  await deleteOwnedGitHubRepository(owned)
  await owned.page.close()
}

const drainRuns = async (
  page: Page,
  request: APIRequestContext,
  owned: OwnedWorkflowRepository
): Promise<ReadonlyArray<RunSummary>> => {
  const terminal: RunSummary[] = []
  const failures: unknown[] = []
  for (const runId of owned.runs) {
    try {
      const current = await gatewayCall(page, request, owned.repo, "Projection.Snapshot", {
        selector: { _tag: "run-summary", runId }
      }, owned.workspaceId)
      let row = runSummary(current)
      if (row === undefined) throw new Error(`Owned run ${runId} disappeared before cleanup.`)
      if (row.runId !== runId) throw new Error(`Projection for owned run ${runId} returned row ${row.runId}.`)
      if (!/^(completed|failed|cancelled)$/.test(row.status)) {
        await gatewayCall(page, request, owned.repo, "Cancel", {
          runId,
          idempotencyKey: `cancel:${runId}`,
          reason: "owned real E2E fixture cleanup"
        }, owned.workspaceId)
        row = await waitForTerminalRun(page, request, owned.repo, runId, 120_000, owned.workspaceId)
      }
      terminal.push(row)
    } catch (error) {
      failures.push(new Error(`Owned run ${runId} did not drain.`, { cause: error }))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Not every owned run on ${owned.repo} reached a terminal projection; preserving its dependencies.`)
  return terminal
}

const setup = async (
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
  testInfo: TestInfo
): Promise<{ readonly owned: OwnedGitHubRepository; readonly fixture: OwnedWorkflowRepository }> => {
  await bootProductionRepository(page)
  const name = fixtureRepositoryName(`smithers-e2e-import-s15-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const owned = await createOwnedGitHubRepository(context, name)
  let importJobId: string | undefined
  let importStatus: number | undefined
  let importAttempted = false
  try {
    await attachProductionJson(testInfo, "workflow-fixture-owned-source", {
      repo: owned.fullName,
      githubUrl: owned.url,
      cleanupNamespace: "codeplanesmithers/smithers-e2e-import-*"
    })
    importAttempted = true
    const imported = await importRepository(page, request, owned.fullName, testInfo, (status, accepted) => {
      importStatus = status
      if (accepted !== undefined) importJobId = accepted
    })
    const provisioned = await provisionRepository(page, request, owned.fullName, testInfo)
    const cloud = await realApi(page, request, "GET", cloudRepoPath(owned.fullName))
    expect(cloud.status(), `Cloud repository ${owned.fullName}`).toBe(200)
    await attachProductionJson(testInfo, "workflow-fixture-ready", {
      repo: owned.fullName,
      importJobId: imported.jobId,
      terminal: imported.terminal,
      provisioned,
      cloud: await cloud.json().catch(() => undefined)
    })
    return { owned, fixture: { repo: owned.fullName, ...provisioned, runs: new Set(), ambiguities: [] } }
  } catch (error) {
    const failures: unknown[] = []
    let authoritative = false
    if (importJobId !== undefined) {
      try { await waitForImportJobId(page, request, importJobId, 120_000); authoritative = true } catch (cleanupError) { failures.push(cleanupError) }
    } else if (!importAttempted) {
      authoritative = true
    }
    if (!authoritative) {
      failures.push(new Error(`Preserved ${owned.fullName}: import ${importAttempted ? "returned no authoritative accepted job id" : "was not observed"}; GitHub and Cloud state remain for diagnosis.`))
      try {
        await attachProductionJson(testInfo, "workflow-fixture-preserved", {
          repo: owned.fullName,
          githubUrl: owned.url,
          importStatus,
          importJobId,
          reason: "The import result or its accepted job did not reach an authoritative terminal state; dependencies were preserved."
        })
      } catch (attachmentError) {
        failures.push(attachmentError)
      }
    } else {
      const deletions = await Promise.allSettled([
        deleteGitHub(owned),
        deleteOwnedCloudRepository(page, request, owned.fullName)
      ])
      for (const deletion of deletions) if (deletion.status === "rejected") failures.push(deletion.reason)
    }
    if (failures.length > 0) throw new AggregateError([error, ...failures], `Workflow fixture setup failed and cleanup for ${owned.fullName} was incomplete.`)
    throw error
  }
}

export const workflowTest = authenticatedTest.extend<WorkflowFixtures>({
  workflowRepo: async ({ page, request, context }, use, testInfo) => {
    const { owned, fixture } = await setup(page, request, context, testInfo)
    let bodyError: unknown
    try {
      await use(fixture)
    } catch (error) {
      bodyError = error
    }

    const cleanupFailures: unknown[] = []
    let runs: ReadonlyArray<RunSummary> = []
    let drained = false
    try {
      runs = await drainRuns(page, request, fixture)
      drained = true
    } catch (error) {
      cleanupFailures.push(error)
    }

    let githubDeleted = false
    let cloudDeleted: unknown
    if (drained && fixture.ambiguities.length === 0) {
      const deletions = await Promise.allSettled([
        deleteOwnedCloudRepository(page, request, fixture.repo),
        deleteGitHub(owned)
      ])
      if (deletions[0]?.status === "fulfilled") cloudDeleted = deletions[0].value
      else cleanupFailures.push(deletions[0]?.reason)
      if (deletions[1]?.status === "fulfilled") githubDeleted = true
      else cleanupFailures.push(deletions[1]?.reason)
    } else {
      cleanupFailures.push(new Error(`Preserved ${fixture.repo} because ${fixture.ambiguities.length > 0 ? fixture.ambiguities.join(" ") : "not every accepted run reached terminal"}.`))
    }
    await attachProductionJson(testInfo, "workflow-fixture-cleanup", {
      repo: fixture.repo, trackedRunIds: [...fixture.runs], ambiguities: fixture.ambiguities,
      runs, drained, githubDeleted, cloudDeleted,
      preserved: !drained || fixture.ambiguities.length > 0
    })
    const failures = [...(bodyError === undefined ? [] : [bodyError]), ...cleanupFailures]
    if (failures.length > 0) throw new AggregateError(failures, `Workflow scenario or cleanup for ${fixture.repo} failed.`)
  }
})
