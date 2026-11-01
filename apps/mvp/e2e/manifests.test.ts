import type { TestInfo } from "@playwright/test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { writeManifest } from "./fixtures"
import { recordable } from "./frames"
import { readManifests } from "./manifests"

const results = mkdtempSync(join(tmpdir(), "e2e-manifests-"))
afterAll(() => rmSync(results, { recursive: true, force: true }))

/** As much of Playwright's TestInfo as writeManifest reads, for a test that ended `status`, in its own directory. */
const testInfoOf = (title: string, status: TestInfo["status"]) => {
  const outputDir = join(results, title.replace(/\W+/g, "-"))
  mkdirSync(outputDir, { recursive: true })
  // A page's recording exists whether or not the test ran: Playwright saves it when the context closes.
  writeFileSync(join(outputDir, "video.webm"), "a blank page")
  return {
    file: "/repo/apps/mvp/e2e/todos.spec.ts",
    title,
    titlePath: ["todos.spec.ts", title],
    annotations: [],
    status,
    outputDir,
    outputPath: (file: string) => join(outputDir, file),
    attach: async () => undefined,
  } as unknown as TestInfo
}

describe("a test's media", () => {
  it("is made for a test that ran, whatever its outcome, and never for a skipped one", async () => {
    for (const [title, status] of [["ran: passes", "passed"], ["broke: fails", "failed"], ["skipped: needs a stack", "skipped"]] as const) {
      await writeManifest(testInfoOf(title, status), "flow.json", 0, [{ name: "Ann", video: "video.webm", openedAt: 0 }])
    }
    // The skipped test's directory holds only its blank recording: no manifest names it, so no video or GIF is made.
    expect(readdirSync(join(results, "skipped-needs-a-stack"))).toEqual(["video.webm"])
    const { flows, skipped } = readManifests(results)
    expect(flows.map((flow) => [flow.flow, flow.status])).toEqual([["todos-broke", "failed"], ["todos-ran", "passed"]])
    expect(flows[1]!.videos[0]!.video).toBe(join(results, "ran-passes", "video.webm"))
    expect(skipped).toEqual([])
  })

  it("is not made from a skipped test's manifest an older run left behind", () => {
    const dir = join(results, "older")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "devices.json"), JSON.stringify({ flow: "todos-older", status: "skipped", videos: [{ video: "/abs/video.webm" }] }))
    writeFileSync(join(dir, "flow.json"), JSON.stringify({ flow: "todos-older-page", status: "passed", videos: [] }))
    const { flows, skipped } = readManifests(results)
    expect(flows.map((flow) => flow.flow)).not.toContain("todos-older")
    expect(flows.map((flow) => flow.flow)).not.toContain("todos-older-page")
    expect(skipped).toEqual(["todos-older"])
  })

  it("is made for every status but skipped", () => {
    for (const status of ["passed", "failed", "timedOut", "interrupted", undefined]) expect(recordable(status)).toBe(true)
    expect(recordable("skipped")).toBe(false)
  })
})
