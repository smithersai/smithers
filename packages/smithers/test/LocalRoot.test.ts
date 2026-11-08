import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as History from "../src/history/History.ts"
import * as Store from "../src/operator/Store.vibe"

const roots: Array<string> = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-local-root-"))
  roots.push(root)
  mkdirSync(join(root, ".flows"))
  mkdirSync(join(root, "nested"))
  return root
}

describe.each(
  [
    ["evaluation", Evaluation.localRoot],
    ["history", History.localRoot],
    ["operator", Store.localRoot]
  ] as const
)("%s local project selection", (_name, localRoot) => {
  it("uses the invocation environment, including blank remote values", () => {
    const root = fixture()
    vi.spyOn(process, "cwd").mockReturnValue(join(root, "nested"))
    vi.stubEnv("SMITHERS_REMOTE", "https://ambient.invalid")
    expect(localRoot({}, { SMITHERS_REMOTE: "" })).toBe(root)
    vi.stubEnv("SMITHERS_REMOTE", "")
    expect(() => localRoot({ root }, { SMITHERS_REMOTE: "https://supplied.invalid" })).toThrow(/remote/)
    expect(() => localRoot({ root, remote: "" }, {})).toThrow(/remote/)
  })

  it("validates explicit roots without creating them", () => {
    const root = fixture()
    writeFileSync(join(root, "file"), "not a directory")
    expect(() => localRoot({ root: join(root, "missing") }, {})).toThrow("is not an accessible directory")
    expect(() => localRoot({ root: join(root, "file") }, {})).toThrow("must be a directory")
  })
})
