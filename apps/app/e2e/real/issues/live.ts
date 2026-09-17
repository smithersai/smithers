import type { APIRequestContext, Page } from "@playwright/test"
import { expect, realApi } from "../support/test"

export type LiveOperation = "research" | "plan" | "implement" | "poc"

export type LiveRun = {
  readonly sessionId: string
  readonly runId: string
  readonly operation: LiveOperation
  readonly phase: "queued" | "running" | "completed" | "failed"
  readonly error?: string
  readonly result?: string
  readonly events: ReadonlyArray<{ readonly id: string; readonly label: string; readonly status: string; readonly detail?: string }>
  readonly plan?: { readonly id: string; readonly baseCommitId: string; readonly files: ReadonlyArray<string>; readonly steps: ReadonlyArray<string> }
  readonly commits?: ReadonlyArray<{ readonly commitId: string; readonly parentCommitId: string; readonly message: string; readonly files: ReadonlyArray<string>; readonly additions: number; readonly deletions: number }>
  readonly diff?: ReadonlyArray<{ readonly path: string; readonly patch?: string; readonly additions: number; readonly deletions: number }>
  readonly files?: Readonly<Record<string, string>>
  readonly baseCommitId?: string
  readonly branch?: string
  readonly tests?: { readonly command: string; readonly exitCode: number; readonly output: string }
}

const protectedCases = ["missing name receives world", "empty name receives world", "provided name is preserved"] as const

export const expectReproductionEvidence = (run: LiveRun): void => {
  expect(run.tests?.command).toContain("/app/regression.mjs")
  expect(run.tests?.exitCode).not.toBe(0)
  expect(run.tests?.output.trim().length).toBeGreaterThan(80)
  const reproduction = run.events.find((event) => event.id === "reproduce")
  expect(reproduction?.status).toBe("completed")
  expect(reproduction?.detail?.trim().length).toBeGreaterThan(80)
  expect(run.files?.["src/hello.ts"]).toContain("Hello")
  expect(run.result?.trim().length).toBeGreaterThan(100)
  expect(run.result).toMatch(/Hello, (?:null!|!)/)
  expect(run.result).toContain("Hello, world!")
}

export const expectVerifiedGreetingChange = (run: LiveRun): void => {
  expect(run.tests?.command).toContain("/app/regression.mjs")
  expect(run.tests?.exitCode).toBe(0)
  for (const name of protectedCases) expect(run.tests?.output).toContain(name)
  expect(run.files?.["src/hello.ts"]).toContain("world")
  expect(run.files?.["src/hello.test.ts"]).toContain("world")
  expect(run.diff?.some((file) => file.path === "src/hello.ts")).toBe(true)
  expect(run.diff?.reduce((bytes, file) => bytes + file.additions + file.deletions, 0)).toBeGreaterThan(0)
  for (const file of run.diff ?? []) {
    expect(["src/hello.ts", "src/hello.test.ts", "README.md"]).toContain(file.path)
    expect(file.patch).toContain(`diff --git a/${file.path} b/${file.path}`)
    expect(run.files?.[file.path]?.length).toBeGreaterThan(0)
  }
  expect(run.result?.trim().length).toBeGreaterThan(40)
}

export const runLiveOperation = async (
  page: Page,
  request: APIRequestContext,
  operation: LiveOperation,
  start: () => Promise<void>
): Promise<LiveRun> => {
  const started = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/tutorial/live/${operation}`).then(async response => ({ status: response.status(), body: await response.json() as Partial<LiveRun> }))
  await start()
  const response = await started
  expect(response.status, `live ${operation} must be accepted by the real tutorial service`).toBe(202)
  const first = response.body
  expect(first.operation).toBe(operation)
  expect(first.runId).toEqual(expect.any(String))
  const runId = first.runId!

  let latest: LiveRun | undefined
  await expect.poll(async () => {
    const polled = await realApi(page, request, "GET", `/api/tutorial/live/run/${encodeURIComponent(runId)}`)
    if (polled.status() !== 200) return `http-${polled.status()}`
    latest = await polled.json() as LiveRun
    if (latest.phase === "failed") throw new Error(`Live ${operation} ${runId} failed: ${latest.error ?? latest.result ?? "no failure detail"}`)
    return latest.phase
  }, { timeout: 300_000, intervals: [1_000, 1_000, 2_000, 3_000] }).toBe("completed")
  expect(latest?.operation).toBe(operation)
  expect(latest?.error).toBeUndefined()
  expect(latest?.events.length).toBeGreaterThan(0)
  return latest!
}
