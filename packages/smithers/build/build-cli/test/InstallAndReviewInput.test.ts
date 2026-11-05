import { Smithers as S } from "@smthrs/targets"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { selectInstallTarget } from "../src/Cli.ts"
import type { IndexedTarget } from "../src/PackageIndex.ts"
import { prepare, ReviewPolicyRequired } from "../src/TrustedReview.ts"
import { serve } from "./helpers/ServeCli.ts"

const install = (packagePath: string, key = "install"): IndexedTarget => ({
  packagePath,
  key,
  label: `//${packagePath}:${key}`,
  target: S.Install({ lockfilePath: "pnpm-lock.yaml" })
})

describe("Install selection", () => {
  it("selects an overlay's unique non-root Install", () => {
    const overlay = install(".smithers/upstream")
    expect(selectInstallTarget([overlay])).toBe(overlay)
  })

  it("retains the root Install's precedence over nested installs", () => {
    const root = install("")
    expect(selectInstallTarget([install(".smithers/upstream"), root, install("tools")])).toBe(root)
  })

  it("ignores non-install targets", () => {
    const overlay = install(".smithers/upstream")
    expect(selectInstallTarget([
      { ...install(""), target: S.Shell.Run({ shell: "true" }) },
      overlay
    ])).toBe(overlay)
  })

  it("refuses an absent install declaration", () => {
    expect(() => selectInstallTarget([])).toThrow("declares no Install target")
  })

  it("refuses ambiguous workspace installs and names the candidates", () => {
    expect(() => selectInstallTarget([install("one"), install("two")]))
      .toThrow("//one:install, //two:install")
  })

  it("refuses ambiguous root installs even with a unique nested install", () => {
    expect(() => selectInstallTarget([install("", "one"), install("", "two"), install("nested")]))
      .toThrow("root PACKAGE.ts declares more than one Install target")
  })
})

describe("review policy input", () => {
  it.each([undefined, "", "  "])(
    "refuses a missing policy before reading a repository (%s)",
    async (policyRevision) => {
      await expect(prepare({ workspace: "/does-not-exist", patterns: ["//..."], policyRevision }))
        .rejects.toBeInstanceOf(ReviewPolicyRequired)
    }
  )

  it.each(["HEAD", "main", "abcdef", "a".repeat(40) + "^{commit}"])(
    "still refuses an unpinned policy (%s)",
    async (policyRevision) => {
      await expect(prepare({ workspace: "/does-not-exist", patterns: ["//..."], policyRevision }))
        .rejects.toThrow("--policy-revision must be a full trusted commit SHA")
    }
  )

  it.each([false, true])("explains an absent trusted policy in a fresh project (plan=%s)", async (plan) => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-review-input-"))
    try {
      const result = await serve(root, ["review", "//...", ...(plan ? ["--plan"] : []), "--format", "json"])
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("review_policy_required")
      expect(result.output).toContain("--policy-revision")
      expect(result.output).toContain("LlmLint")
      expect(result.output).toContain("approved commit")
      expect(result.output).not.toContain("expected string, received undefined")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
