import type { PlanCard, Receipt } from "@smthrs/control/ControlSchema"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const child = fileURLToPath(new URL("./fixtures/approval-content-child.ts", import.meta.url))
// Source-module loading took 15.7 s before a 20 s control operation even began,
// and another child exceeded the old 25 s process limit before loading ended.
// Give startup the same finite 60 s bound as UnifiedCli's fresh processes;
// readiness starts the child's existing 20 s operation budget separately.
const startupTimeoutMs = 60_000
const operationTimeoutMs = 20_000
// AgentSession permits five seconds for a settled drive's final commit when
// its scope closes. Leave that cleanup grace after the child's own deadline.
const cleanupTimeoutMs = 5_000
const journeyTimeoutMs = 2 * (startupTimeoutMs + operationTimeoutMs + cleanupTimeoutMs)
interface Result {
  readonly pid: number
  readonly card: PlanCard
  readonly receipt?: Receipt
  readonly error?: { readonly _tag: string; readonly message: string }
  readonly captured?: ReadonlyArray<{ readonly model: string; readonly original: boolean; readonly changed: boolean }>
}
const runChild = (action: string, root: string, cardFile?: string): Promise<Result> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let ready: string | undefined
    let loadingOutput = ""
    let expired: string | undefined
    const invoked = execFile(
      process.execPath,
      [child, action, root, ...cardFile === undefined ? [] : [cardFile]],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (cause, stdout) => {
        clearTimeout(timer)
        if (cause !== null) {
          reject(
            new Error(
              `Approval child ${action} ${expired ?? "failed"} ${
                ready === undefined ? "before module loading completed" : `after ${ready}`
              }`,
              { cause }
            )
          )
          return
        }
        try {
          const result = stdout.split("\n").find((line) => line.startsWith("APPROVAL_CONTENT_RESULT:"))
          if (result === undefined) throw new Error(`Child returned no result: ${stdout}`)
          resolve(JSON.parse(result.slice("APPROVAL_CONTENT_RESULT:".length)) as Result)
        } catch (cause) {
          reject(cause)
        }
      }
    )
    const bound = (milliseconds: number, phase: string) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        expired = `exceeded its ${milliseconds}ms ${phase} budget`
        invoked.kill("SIGKILL")
      }, milliseconds)
    }
    bound(startupTimeoutMs, "startup")
    invoked.stdout!.on("data", (chunk: string) => {
      if (ready !== undefined) return
      loadingOutput += chunk
      ready = loadingOutput.split("\n").slice(0, -1).find((line) => line.startsWith("APPROVAL_CONTENT_READY:"))
      if (ready !== undefined) bound(operationTimeoutMs + cleanupTimeoutMs, "operation/cleanup")
    })
  })
const source = (body = "ORIGINAL_APPROVED_PROMPT", model = "anthropic:claude-sonnet-4-5", effort = "low") =>
  `---\ndescription: Approval content test\nmodel: ${model}\neffort: ${effort}\ncapabilities: ["model:call:**"]\n---\n${body}\n`

describe("approval binds execution across independent processes", { timeout: journeyTimeoutMs }, () => {
  it.each([
    ["prompt", source("CHANGED_UNAPPROVED_PROMPT")],
    ["provider and model", source(undefined, "openai:gpt-5.6-sol")],
    ["parameters", source(undefined, undefined, "high")]
  ])("refuses an old approval after changing %s, before any provider dispatch", async (_name, changed) => {
    const root = mkdtempSync(join(tmpdir(), "smithers-approved-content-"))
    try {
      const flow = join(root, "flows", "review", "flow.mdx")
      mkdirSync(join(root, "flows", "review"), { recursive: true })
      writeFileSync(flow, source())
      const first = await runChild("plan", root)
      const cardFile = join(root, "approved.json")
      writeFileSync(cardFile, JSON.stringify(first.card))
      writeFileSync(flow, changed)
      const second = await runChild("run", root, cardFile)
      expect(second.pid).not.toBe(first.pid)
      expect(second.card.executionDigest).not.toBe(first.card.executionDigest)
      expect(second.card.digest).not.toBe(first.card.digest)
      expect(second.error?._tag).toBe("/control/LaunchFailed")
      expect(second.receipt).toBeUndefined()
      expect(second.captured).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("executes unchanged approved bytes after the approving process exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-approved-unchanged-"))
    try {
      mkdirSync(join(root, "flows", "review"), { recursive: true })
      writeFileSync(join(root, "flows", "review", "flow.mdx"), source())
      const first = await runChild("plan", root)
      const cardFile = join(root, "approved.json")
      writeFileSync(cardFile, JSON.stringify(first.card))
      const second = await runChild("run", root, cardFile)
      expect(second.pid).not.toBe(first.pid)
      expect(second.card.digest).toBe(first.card.digest)
      expect(second.receipt?._tag).toBe("Accepted")
      expect(second.captured).toEqual([{ model: "claude-sonnet-4-5", original: true, changed: false }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
