import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as RepoTargets from "../src/index.ts"
import type {
  BuildAndCheckTypeScriptPackageOptions,
  CircularImportsOptions,
  ImportRulesOptions,
  ImportRulesTarget,
  JevRulesOptions,
  JevRulesTarget,
  PackageTargets,
  ReviewLint,
  ReviewLintOptions,
  SdkRulesOptions,
  SdkRulesTargets
} from "../src/index.ts"

const sourceDir = new URL("../src/", import.meta.url)

describe("@smthrs/repo-targets package entry", () => {
  it("re-exports every macro and the shared review prompt", () => {
    expect(Object.keys(RepoTargets).sort()).toEqual([
      "BuildAndCheckTypeScriptPackage",
      "CircularImports",
      "ImportRules",
      "JevRules",
      "ReviewDocsAgainstCode",
      "ReviewJsdocAgainstCode",
      "ReviewTagsMigrationsAndKeys",
      "SdkRules",
      "WorkspaceSources",
      "smithersReviewPrompt"
    ])
    expect(RepoTargets.smithersReviewPrompt).toContain("You are reviewing a diff in `smithers`")
  })

  it("names the option and result types of every macro", () => {
    expectTypeOf(RepoTargets.BuildAndCheckTypeScriptPackage).parameter(0).toEqualTypeOf<
      BuildAndCheckTypeScriptPackageOptions
    >()
    expectTypeOf(RepoTargets.BuildAndCheckTypeScriptPackage).returns.toEqualTypeOf<PackageTargets>()
    expectTypeOf(RepoTargets.CircularImports).parameter(0).toEqualTypeOf<CircularImportsOptions>()
    expectTypeOf(RepoTargets.ImportRules).parameter(0).toEqualTypeOf<ImportRulesOptions>()
    expectTypeOf(RepoTargets.ImportRules).returns.toEqualTypeOf<ImportRulesTarget>()
    expectTypeOf(RepoTargets.JevRules).parameter(0).toEqualTypeOf<JevRulesOptions>()
    expectTypeOf(RepoTargets.JevRules).returns.toEqualTypeOf<JevRulesTarget>()
    expectTypeOf(RepoTargets.SdkRules).parameter(0).toEqualTypeOf<SdkRulesOptions>()
    expectTypeOf(RepoTargets.SdkRules).returns.toEqualTypeOf<SdkRulesTargets>()
    for (const macro of [RepoTargets.ReviewDocsAgainstCode, RepoTargets.ReviewJsdocAgainstCode, RepoTargets.ReviewTagsMigrationsAndKeys]) {
      expectTypeOf(macro).parameter(0).toEqualTypeOf<ReviewLintOptions>()
      expectTypeOf(macro).returns.toEqualTypeOf<ReviewLint>()
    }
  })

  it("keeps one macro per module, named after its file", () => {
    for (const name of ["CircularImports", "ReviewDocsAgainstCode", "ReviewJsdocAgainstCode", "ReviewTagsMigrationsAndKeys"]) {
      const source = readFileSync(new URL(`${name}.ts`, sourceDir), "utf8")
      expect([...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([name])
    }
  })

  it("tags every module and export with one @since version", () => {
    const versions = new Set(
      readdirSync(sourceDir)
        .filter((file) => file.endsWith(".ts"))
        .flatMap((file) => [...readFileSync(new URL(file, sourceDir), "utf8").matchAll(/@since (\S+)/g)])
        .map((match) => match[1])
    )
    expect([...versions]).toEqual(["0.1.0"])
  })
})
