import { describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.ts"
import { isCacheCredential, leaveCacheEmpty, markWithheld } from "../../src/inventory/CacheCredentials.ts"

describe("the credentials of a remote build cache", () => {
  it("are known by the variable a build tool reads them from", () => {
    for (const name of ["TURBO_TOKEN", "TURBO_TEAM", "NX_CLOUD_ACCESS_TOKEN", "CACHIX_AUTH_TOKEN"]) {
      expect(isCacheCredential(name), name).toBe(true)
    }
    for (const name of ["NPM_TOKEN", "GITHUB_TOKEN", "VERCEL_TOKEN", "turbo_token", ""]) {
      expect(isCacheCredential(name), name).toBe(false)
    }
  })

  it("are left empty wherever a workflow fills them from a secret alone: its own env, a job's, a step's", () => {
    const workflow = {
      on: "pull_request",
      env: { TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}", TURBO_TEAM: " ${{ secrets.TEAM }} ", CI: "true" },
      jobs: {
        lint: {
          env: { NX_CLOUD_ACCESS_TOKEN: "${{secrets.NX}}", NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" },
          steps: [
            { run: "pnpm lint", env: { CACHIX_AUTH_TOKEN: "${{ secrets.CACHIX }}" } },
            { run: "pnpm test" },
            "not a step"
          ]
        }
      }
    }
    expect(leaveCacheEmpty(workflow)).toEqual({
      on: "pull_request",
      env: { TURBO_TOKEN: "", TURBO_TEAM: "", CI: "true" },
      jobs: {
        lint: {
          // A secret that is not a cache's stays as written, and stops the job as before.
          env: { NX_CLOUD_ACCESS_TOKEN: "", NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" },
          steps: [{ run: "pnpm lint", env: { CACHIX_AUTH_TOKEN: "" } }, { run: "pnpm test" }, "not a step"]
        }
      }
    })
    // The workflow that was given is not changed.
    expect(workflow.env.TURBO_TOKEN).toBe("${{ secrets.TURBO_TOKEN }}")
  })

  it("leaves a value alone that is more than one secret, is no text, or is already plain", () => {
    const workflow = {
      env: {
        TURBO_TOKEN: "Bearer ${{ secrets.TURBO_TOKEN }}",
        TURBO_TEAM: "acme",
        NX_CLOUD_ACCESS_TOKEN: ["${{ secrets.NX }}"],
        CACHIX_AUTH_TOKEN: "${{ vars.CACHIX }}"
      },
      jobs: { a: { env: "${{ fromJSON(vars.ENV) }}", steps: "computed" }, b: "not a job", c: { steps: [] } }
    }
    expect(leaveCacheEmpty(workflow)).toEqual(workflow)
  })

  it("returns what is no workflow as it is", () => {
    for (const value of [undefined, "text", ["a"], { on: "push" }, { jobs: ["a"] }]) {
      expect(leaveCacheEmpty(value)).toBe(value)
    }
  })

  const job = (envs: ReadonlyArray<Readonly<Record<string, string>>>): Job => ({
    id: "ci.yml:lint",
    source: "github-actions",
    file: ".github/workflows/ci.yml",
    name: "lint",
    needs: [],
    triggers: ["pull_request"],
    matrix: [],
    steps: envs.map((env, index) => ({ id: `ci.yml:lint:${index + 1}`, command: "true", cwd: "", env, secrets: [] })),
    unsupported: []
  })

  it("marks each step that runs with one of them empty, by name", () => {
    const read = job([
      { TURBO_TOKEN: "", TURBO_TEAM: "", CI: "true" },
      // A step that sets the variable itself, to a value, does not run without it.
      { TURBO_TOKEN: "local", TURBO_TEAM: "" },
      { CI: "true" }
    ])
    const marked = markWithheld(read)
    expect(marked.steps.map((step) => step.withheld)).toEqual([
      ["TURBO_TEAM", "TURBO_TOKEN"],
      ["TURBO_TEAM"],
      undefined
    ])
    expect(marked.steps[2]).toBe(read.steps[2])
    // A job with no such variable is returned as it is, and so is one whose variable has a value.
    const plain = job([{ CI: "true", NPM_TOKEN: "" }, { TURBO_TOKEN: "local" }])
    expect(markWithheld(plain)).toBe(plain)
  })
})
