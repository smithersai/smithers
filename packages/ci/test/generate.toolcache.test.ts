import { cacheDirectoryToken } from "@smthrs/targets/Exec"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.ts"
import { toolCache } from "../src/contract/Inventory.ts"
import { files } from "../src/generate/index.ts"
import { packagePath, stateDirectory, workflowPath } from "../src/generate/Render.ts"

const step = (id: string, command: string, env: Readonly<Record<string, string>> = {}, cwd = ""): Step => ({
  id,
  command,
  cwd,
  env,
  secrets: []
})

const job = (id: string, steps: ReadonlyArray<Step>): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps,
  unsupported: []
})

/** One generated file's text, for exactly these jobs taken as the CI. */
const generated = (jobs: ReadonlyArray<Job>, path: string): string => {
  const document: InventoryDocument = {
    version: 1,
    repository: "example/repo",
    commit: "0000000000000000000000000000000000000003",
    toolchains: [],
    jobs
  }
  return Effect.runSync(files(document as Ci)).find((file) => file.path === path)?.content ?? ""
}

/** A step that runs Zig, as the splitter writes it: no inputs, and Zig's caches in the tool cache. */
const zig = step("a:1", "zig build test", {
  ZIG_GLOBAL_CACHE_DIR: `${toolCache}/zig/global`,
  ZIG_LOCAL_CACHE_DIR: `${toolCache}/zig/local`
})

describe("a step that keeps a tool's cache", () => {
  it("has the workflow save the tool cache with the results", () => {
    expect(generated([job("a", [zig])], workflowPath)).toContain(
      `          path: |\n            ${stateDirectory}/cache\n            ${stateDirectory}/kept\n            ${stateDirectory}/tools\n`
    )
    // A step can name the tool cache itself.
    expect(generated([job("a", [step("a:1", "true", { CACHE: toolCache })])], workflowPath)).toContain(
      `            ${stateDirectory}/cache\n            ${stateDirectory}/kept\n            ${stateDirectory}/tools\n`
    )
    expect(generated([job("a", [step("a:1", "true", { CACHE: toolCache })])], packagePath)).toContain(
      `env: {"CACHE":"${toolCache}"}`
    )
    // A step that starts under the root names the same directory: it is named whole.
    const nested = step("a:1", "zig build test", { ZIG_LOCAL_CACHE_DIR: `${toolCache}/zig/local` }, "tools/gen")
    expect(generated([job("a", [nested])], workflowPath)).toContain(
      `            ${stateDirectory}/cache\n            ${stateDirectory}/kept\n            ${stateDirectory}/tools\n`
    )
  })

  it("leaves the workflow as it was for every other step", () => {
    const plain = generated([job("a", [step("a:1", "true", { CACHE: `${toolCache}-other`, CI: "1" })])], workflowPath)
    expect(plain).toContain(`            ${stateDirectory}/cache\n`)
    expect(plain).not.toContain(`${stateDirectory}/tools`)
    // A value that only starts like the tool cache is the step's own and stays as written.
    expect(generated([job("a", [step("a:1", "true", { CACHE: `${toolCache}-other`, CI: "1" })])], packagePath))
      .toContain(`env: {"CACHE":"${toolCache}-other","CI":"1"}`)
  })

  it("runs the step in the open and observed, with the tool told where its cache is", () => {
    const source = generated([job("a", [zig])], packagePath)
    // Nobody names what a Zig build reads: it runs again only when a file its last run read has changed.
    expect(source).toContain(`shell: "bash -e -c 'zig build test'"`)
    // The tool's cache is in Smithers build's cache directory, outside the checkout: Smithers build fills in where
    // that is when the step starts, and a key holds the text, never the directory. A GitHub job runs in a copy of
    // the checkout, and is given the same directory there.
    expect(toolCache).toBe(`${cacheDirectoryToken}/tools`)
    expect(source).toContain(
      `env: {"ZIG_GLOBAL_CACHE_DIR":"{smthrs:cache-directory}/tools/zig/global","ZIG_LOCAL_CACHE_DIR":"{smthrs:cache-directory}/tools/zig/local"}`
    )
    expect(source).toContain(`cache: S.Cache({ directory: ".flows", outside: true })`)
    expect(source).toContain(`sandbox: "none"`)
    expect(source).toMatch(/observe: \{ ignore: \[.*\] \}/)
  })
})
