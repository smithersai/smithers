/** Unit contracts for local repository declarations and Repo.Target attrs. */
import { describe, expect, it } from "vitest"
import { Smithers as S } from "../src/index.ts"
import * as LocalRepository from "../src/LocalRepository.ts"
import * as RepoTarget from "../src/RepoTarget.ts"
import * as Target from "../src/Target.ts"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

const workspace = (repos: Parameters<typeof S.Workspace>[1]["repos"]) =>
  S.Workspace("repo-test", {
    repository: "git+https://example.invalid/repo-test.git",
    cache: S.Cache({ directory: ".flows" }),
    runtime,
    packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
    nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
    repos
  })

describe("LocalRepository", () => {
  it("constructs tagged declarations with optional branch metadata", () => {
    const declaration = S.LocalRepository("vendor/child", { branch: "main" })
    expect(LocalRepository.isDeclaration(declaration)).toBe(true)
    expect(declaration).toEqual({ _tag: "LocalRepository", path: "vendor/child", branch: "main" })
  })

  it("normalizes portable paths in the Workspace declaration", () => {
    expect(workspace({ child: S.LocalRepository("./vendor\\child/") }).repos).toEqual({
      child: { _tag: "LocalRepository", path: "vendor/child", branch: undefined }
    })
  })

  it("refuses absolute, escaping, empty, duplicate, and untagged repository paths", () => {
    expect(() => workspace({ child: S.LocalRepository("../child") })).toThrow(/inside the workspace/)
    expect(() => workspace({ child: S.LocalRepository("/child") })).toThrow(/relative/)
    expect(() => workspace({ child: S.LocalRepository("./") })).toThrow(/inside the workspace/)
    expect(() => workspace({ a: S.LocalRepository("child"), b: S.LocalRepository("./child") })).toThrow(
      /distinct/
    )
    expect(() => workspace({ child: { _tag: "wrong", path: "child" } as never })).toThrow(/LocalRepository/)
  })
})

describe("Repo.Target", () => {
  it("records child identity, args, inputs, gates, and sandbox policy", () => {
    const gate = S.Shell.Test({ shell: "true" })
    const input = S.file("child/README.md")
    const target = S.Repo.Target("child", "//pkg:test", {
      args: ["--flag"],
      data: [input],
      gates: [gate],
      sandbox: { network: "loopback" }
    })
    expect(RepoTarget.attrsOf(target)).toMatchObject({
      repo: "child",
      label: "//pkg:test",
      args: ["--flag"],
      sandbox: { network: "loopback" }
    })
    expect(Target.metadata(target).target).toBe("Repo.Target")
    expect(Target.metadata(target).kinds).toEqual([])
    expect(Target.metadata(target).inputs).toEqual([input])
    expect(Target.metadata(target).dependencies).toEqual([gate])
  })

  it("accepts a declaration value and root-package label", () => {
    const declaration = S.LocalRepository("child")
    expect(RepoTarget.attrsOf(S.Repo.Target(declaration, "//:test")).repo).toEqual(declaration)
  })

  it("refuses relative, default-only, empty, and malformed child labels", () => {
    expect(() => S.Repo.Target("child", ":test")).toThrow(/relative/)
    expect(() => S.Repo.Target("child", "//pkg")).toThrow(/exact/)
    expect(() => S.Repo.Target("child", "//pkg:")).toThrow(/exact/)
    expect(() => S.Repo.Target("child", "//pkg/../other:test")).toThrow(/invalid child package/)
  })

  it("refuses attrsOf on an ordinary target", () => {
    expect(() => RepoTarget.attrsOf(S.Shell.Test({ shell: "true" }))).toThrow(/not a Repo.Target/)
  })
})
