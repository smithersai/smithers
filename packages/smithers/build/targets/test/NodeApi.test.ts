import { describe, expect, it } from "vitest"
import * as CronTarget from "../src/CronTarget.ts"
import * as S from "../src/Smithers.ts"
import * as Target from "../src/Target.ts"

const file = S.file("//package.json")
const build = S.Shell.Build({ shell: "true", outDirs: ["dist"] })
const check = S.Shell.Test({ shell: "true" })

const cases: ReadonlyArray<readonly [string, (extra?: Record<string, unknown>) => Target.AnyTarget, string]> = [
  ["Npm.Pack", (extra = {}) => S.Npm.Pack({ manifest: file, ...extra } as never), "Npm.Pack"],
  ["Npm.Publish", (extra = {}) => S.Npm.Publish({ pack: build, gates: [check], ...extra } as never), "Npm.Publish"],
  ["Npm.Published", (extra = {}) => S.Npm.Published({ manifest: file, ...extra } as never), "Npm.Published"],
  ["Npm.Downstream", (extra = {}) =>
    S.Npm.Downstream({
      repository: "https://example.invalid/repo",
      overrides: { pkg: build },
      run: ["test"],
      ...extra
    } as never), "Npm.Downstream"],
  ["Changesets.Version", (extra = {}) =>
    S.Changesets.Version({
      config: file,
      changes: ["package.json"],
      ...extra
    } as never), "Changesets.Version"],
  ["Changesets.Publish", (extra = {}) =>
    S.Changesets.Publish({
      config: file,
      pack: build,
      gates: [check],
      ...extra
    } as never), "Changesets.Publish"],
  ["Github.Release", (extra = {}) =>
    S.Github.Release({
      manifest: file,
      notes: S.Agent.Codex("luna"),
      gates: [check],
      ...extra
    } as never), "Github.Release"],
  ["Github.Pages", (extra = {}) => S.Github.Pages({ site: build, ...extra } as never), "Github.Pages"],
  ["Git.Pr", (extra = {}) => S.Git.Pr({ gates: [check], ...extra } as never), "Git.Pr"],
  [
    "Git.Submodules",
    (extra = {}) => S.Git.Submodules({ config: file, paths: ["vendor/x"], ...extra } as never),
    "Git.Submodules"
  ],
  ["Git.Submodule", (extra = {}) => S.Git.Submodule({ path: "vendor/x", ...extra } as never), "Git.Submodule"],
  ["Cron", (extra = {}) => S.Cron({ schedule: "0 6 * * 1", run: [check], ...extra } as never), "Cron"],
  ["Copy", (extra = {}) => S.Copy({ from: file, to: "dist/package.json", ...extra } as never), "Copy"],
  ["Literal", (extra = {}) => S.Literal({ path: "dist/package.json", content: "{}", ...extra } as never), "Literal"],
  ["Overlay", (extra = {}) => S.Overlay({ base: build, replace: { "x.ts": file }, ...extra } as never), "Overlay"],
  [
    "Markdown.CodeBlocks",
    (extra = {}) => S.Markdown.CodeBlocks({ file, lang: ["ts"], ...extra } as never),
    "Markdown.CodeBlocks"
  ],
  [
    "Api.Compat",
    (extra = {}) => S.Api.Compat({ baseline: build, surface: build, manifest: file, ...extra } as never),
    "Api.Compat"
  ],
  ["Size.Budgets", (extra = {}) => S.Size.Budgets({ manifest: file, ...extra } as never), "Size.Budgets"]
]

describe("Node/npm PACKAGE.ts constructors", () => {
  for (const [name, construct, rule] of cases) {
    it(`${name}: accepts the observed shape and rejects unknown keys`, () => {
      expect(Target.metadata(construct()).target).toBe(rule)
      expect(() => construct({ typo: true })).toThrow(/no excess property[\s\S]*typo/)
    })
  }

  it("rejects wrong field types", () => {
    expect(() => S.Npm.Pack({ manifest: "package.json" } as never)).toThrow(/Npm\.Pack declaration/)
    expect(() => S.Cron({ schedule: 1, run: [] } as never)).toThrow(/Cron declaration/)
    expect(() => S.Copy({ from: file, to: 1 } as never)).toThrow(/Copy declaration/)
    expect(() => S.Files.digest("nope" as never)).toThrow(/Files\.digest requires a target/)
  })

  it("reads Cron attrs only from Cron targets", () => {
    const cron = S.Cron({ schedule: "0 6 * * 1", run: [check] })
    expect(CronTarget.attrsOf(cron)).toEqual({ schedule: "0 6 * * 1", run: [check] })
    expect(() => CronTarget.attrsOf(check)).toThrowError(
      new TypeError("expected a Cron target, received Shell.Test")
    )
  })

  it("lowers compact Github.Ci to the existing CiGen object", () => {
    const ci = S.Github.Ci({
      workflows: { test: { on: { push: ["main"], pullRequest: true, dispatch: true }, run: check } },
      changes: [".github/workflows/**"]
    })
    expect(Target.metadata(ci).target).toBe("Github.CiGen")
    const bare = S.Github.Ci({ workflows: { manual: { on: {}, run: [check, check] } } })
    const attrs = Target.metadata(bare).attrs as { readonly workflows: ReadonlyArray<Target.AnyTarget> }
    expect(Object.keys(attrs)).toEqual(["workflows"])
    expect(Target.metadata(attrs.workflows[0]!).attrs).toMatchObject({ name: "manual", on: {}, run: [check, check] })
    expect(() => S.Github.Ci({ workflows: {}, typo: true } as never)).toThrow(/no excess property[\s\S]*typo/)
    expect(() => S.Github.Ci({ workflows: { test: { on: { push: "main" }, run: check } } } as never))
      .toThrow(/Github\.Ci declaration/)
  })

  it("constructs Files.digest as a typed file-set operand", () => {
    expect(S.Files.digest(build)).toEqual({ _tag: "FilesDigest", target: build })
  })
})
