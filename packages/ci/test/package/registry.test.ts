import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Pinned until the first release reaches npm: packages/repo-targets/contracts/test-pins.md says when to remove this.
describe.runIf(process.env["SMITHERS_CI_PUBLISHED"] === "1")("bunx smithers-ci from npm", () => {
  it("prints its help in an empty directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-ci-registry-"))
    try {
      const result = spawnSync("bunx", ["smithers-ci", "--help"], { cwd: directory, encoding: "utf8" })
      expect(result.stderr).not.toContain("error:")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("smithers-ci <subcommand>")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
