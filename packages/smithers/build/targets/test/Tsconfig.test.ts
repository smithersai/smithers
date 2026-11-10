/**
 * `include` and `exclude` take the workspace's declared file inputs.
 *
 * A declaration already names its file sets with `Smithers.glob` and
 * `Smithers.file`; a tsconfig that took only pattern strings made the same set
 * spelled twice, once as a declaration and once as text. These cases pin both
 * halves of the fix: every entry renders to its pattern text, and no entry
 * becomes a digested input, so a glob whose matches change never re-keys a
 * file whose bytes did not move.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.vibe"

const sections = (attrs: Tsconfig.Attrs): Record<string, ReadonlyArray<string>> =>
  JSON.parse(Tsconfig.render(attrs)) as Record<string, ReadonlyArray<string>>

describe("Tsconfig include and exclude take declared file inputs", () => {
  it("renders a declared glob as its pattern text", () => {
    const rendered = sections(Tsconfig.Attrs.make({ include: [Input.glob("packages/*/src/**/*")] }))
    expect(rendered["include"]).toEqual(["packages/*/src/**/*"])
  })

  it("renders a declared file as its path", () => {
    const rendered = sections(Tsconfig.Attrs.make({ include: [Input.file("PACKAGE.ts")] }))
    expect(rendered["include"]).toEqual(["PACKAGE.ts"])
  })

  it("renders strings, files, and globs in one list in declaration order", () => {
    const rendered = sections(Tsconfig.Attrs.make({
      include: ["globals.d.ts", Input.file("PACKAGE.ts"), Input.glob("packages/*/src/**/*")],
      exclude: ["**/dist/**", Input.glob("packages/coding-agent/examples/extensions/gondolin/**")]
    }))
    expect(rendered).toEqual({
      include: ["globals.d.ts", "PACKAGE.ts", "packages/*/src/**/*"],
      exclude: ["**/dist/**", "packages/coding-agent/examples/extensions/gondolin/**"]
    })
  })

  it("ignores a declared glob's own exclusions, which tsconfig cannot express", () => {
    const rendered = sections(Tsconfig.Attrs.make({
      include: [Input.glob("packages/*/src/**/*", { exclude: ["packages/*/src/**/*.test.ts"] })]
    }))
    expect(rendered["include"]).toEqual(["packages/*/src/**/*"])
  })

  it("rewrites a workspace-rooted declaration against the target cwd", () => {
    const rendered = sections(Tsconfig.Attrs.make({
      cwd: "packages/foo",
      include: [Input.glob("//packages/bar/src/**/*"), Input.file("//globals.d.ts"), Input.glob("src/**/*")],
      exclude: [Input.glob("//packages/foo/dist/**")]
    }))
    expect(rendered).toEqual({
      include: ["../bar/src/**/*", "../../globals.d.ts", "src/**/*"],
      exclude: ["dist/**"]
    })
  })

  it("leaves a package-relative pattern without the prefix extends needs", () => {
    const rendered = sections(Tsconfig.Attrs.make({ include: [Input.glob("src/**/*")] }))
    expect(rendered["include"]).toEqual(["src/**/*"])
  })

  it("keeps a declared include and exclude out of the target's digested inputs", () => {
    const metadata = Target.metadata(Tsconfig.Tsconfig({
      include: [Input.glob("packages/*/src/**/*"), Input.file("PACKAGE.ts")],
      exclude: [Input.glob("**/dist/**")]
    }))
    expect(metadata.inputs).toEqual([])
    expect(metadata.forKind("build").inputs).toEqual([])
    expect(metadata.forKind("lint").inputs).toEqual([])
  })

  it("resolves declared patterns to text before the target is constructed", () => {
    const attrs = Target.metadata(Tsconfig.Tsconfig({
      cwd: "packages/foo",
      include: [Input.glob("//packages/bar/src/**/*")],
      exclude: [Input.file("//packages/foo/dist/x.ts")]
    })).attrs as Tsconfig.Attrs
    expect(attrs.include).toEqual(["../bar/src/**/*"])
    expect(attrs.exclude).toEqual(["dist/x.ts"])
  })

  it("applies constructor tag defaults before resolving file and glob patterns", () => {
    const metadata = Target.metadata(Tsconfig.Tsconfig({
      cwd: "packages/foo",
      include: [{ pattern: "//packages/bar/src/**/*", exclude: [] }, { path: "//globals.d.ts" }],
      exclude: [{ path: "//packages/foo/dist/x.ts" }]
    }))
    expect(metadata.attrs).toMatchObject({
      include: ["../bar/src/**/*", "../../globals.d.ts"],
      exclude: ["dist/x.ts"]
    })
    expect(metadata.inputs).toEqual([])
  })

  it("spells every path from the directory the file is written into", () => {
    // The compiler resolves `extends`, `include`, and `exclude` against the
    // config file's own directory, so a file written below `cwd` must walk
    // back out to reach what the declaration named relative to `cwd`.
    const rendered = JSON.parse(Tsconfig.render(Tsconfig.Attrs.make({
      cwd: "packages/foo",
      path: "test/tsconfig.json",
      extends: Input.file("//tsconfig.base.json"),
      include: ["test/**/*.ts", "src/**/*.ts", "../../globals.d.ts"],
      exclude: ["test/fixtures"]
    }))) as Record<string, unknown>
    expect(rendered).toEqual({
      extends: "../../../tsconfig.base.json",
      include: ["**/*.ts", "../src/**/*.ts", "../../../globals.d.ts"],
      exclude: ["fixtures"]
    })
  })

  it("keeps a package-relative base reachable from a nested file", () => {
    const rendered = JSON.parse(Tsconfig.render(Tsconfig.Attrs.make({
      cwd: "packages/foo",
      path: "test/tsconfig.json",
      extends: Input.file("tsconfig.json")
    }))) as Record<string, unknown>
    expect(rendered["extends"]).toBe("../tsconfig.json")
  })

  it("still declares the base configuration it extends as an input", () => {
    const base = Input.file("//tsconfig.base.json")
    const metadata = Target.metadata(Tsconfig.Tsconfig({ extends: base, include: [Input.glob("src/**/*")] }))
    expect(metadata.inputs).toEqual([base])
  })

  it("keeps the rule identity of the definition it wraps", () => {
    expect(Tsconfig.Tsconfig.id).toBe("Tsconfig")
    expect(Tsconfig.Tsconfig.kinds).toEqual(["build", "lint"])
    expect(Tsconfig.Tsconfig.attrs).toBe(Tsconfig.Attrs)
  })

  /**
   * Resolving patterns is a read of the author's object, and the construction
   * boundary refuses three shapes by reading it exactly once. A wrapper that
   * copied first would spring a `Proxy`'s traps and flatten an accessor into a
   * data property, so each refusal is pinned here rather than left to the
   * unwrapped rules that still have it.
   */
  it("still refuses a declaration the construction boundary reads once", () => {
    expect(() => Tsconfig.Tsconfig(new Proxy({ include: ["src/**/*"] }, {}) as never))
      .toThrow(/must not contain a Proxy/)
    expect(() =>
      Tsconfig.Tsconfig({
        get include() {
          return ["src/**/*"]
        }
      } as never)
    ).toThrow(/only enumerable data properties/)
    expect(() =>
      Tsconfig.Tsconfig(
        new (class {
          include = ["src/**/*"]
        })() as never
      )
    ).toThrow(/plain data/)
  })
})
