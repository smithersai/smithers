import { describe, expect, it } from "vitest"
import {
  assemble,
  graph,
  join,
  managerOf,
  manifestMentions,
  type Mentions,
  outsideGlobs,
  packageDirectories,
  readObject,
  readPatterns,
  resolveFile,
  scanner,
  spineOf,
  type Workspace
} from "../../src/decompose/Workspace.ts"

const manifest = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, ...extra })

/** A workspace from `directory: manifest` pairs. */
const workspaceOf = (packages: Readonly<Record<string, string>>): Workspace =>
  assemble("pnpm", { name: "root", scripts: { test: "pnpm -r test" } }, false, Object.entries(packages)) as Workspace

/** A graph over file texts, scanned as the splitter scans them. */
const graphOf = (packages: Readonly<Record<string, string>>, texts: Readonly<Record<string, string>>) => {
  const workspace = workspaceOf(packages)
  const scan = scanner(workspace)
  const all = {
    ...texts,
    ...Object.fromEntries(Object.entries(packages).map(([directory, text]) => [`${directory}/package.json`, text]))
  }
  const none: Mentions = { names: [], relative: [], rooted: [] }
  const built = graph(
    workspace,
    new Set(Object.keys(all)),
    (file) => {
      const text = all[file]
      if (text === undefined) return none
      return file.endsWith("package.json") ? manifestMentions(scan, text) : scan(text, false)
    }
  )
  const reach = (name: string) => {
    const found = built.reachOf(built.named(name) ?? name)
    return { packages: [...found.packages].sort(), files: [...found.files].sort() }
  }
  return { built, reach, workspace }
}

describe("readObject", () => {
  it("reads a JSON object and nothing else", () => {
    expect(readObject(`{"a":1}`)).toEqual({ a: 1 })
    expect(readObject(`[1]`)).toBeUndefined()
    expect(readObject(`"text"`)).toBeUndefined()
    expect(readObject(`null`)).toBeUndefined()
    expect(readObject(`{broken`)).toBeUndefined()
  })
})

describe("managerOf", () => {
  it("takes the packageManager field, then the lockfile, then npm", () => {
    expect(managerOf({ packageManager: "pnpm@9.1.0+sha512.abc" }, new Set(["bun.lock"]))).toBe("pnpm")
    expect(managerOf({ packageManager: "deno@2" }, new Set(["yarn.lock"]))).toBe("yarn")
    expect(managerOf({ packageManager: 7 }, new Set(["bun.lockb"]))).toBe("bun")
    expect(managerOf({}, new Set(["pnpm-lock.yaml"]))).toBe("pnpm")
    expect(managerOf({}, new Set(["package-lock.json"]))).toBe("npm")
    expect(managerOf({}, new Set())).toBe("npm")
  })
})

describe("readPatterns", () => {
  it("reads pnpm-workspace.yaml when it exists, and notes configured tasks", () => {
    expect(readPatterns({ workspaces: ["ignored/*"] }, "packages:\n  - 'packages/*'\n  - '!packages/skip'\n")).toEqual({
      patterns: ["packages/*", "!packages/skip"],
      orchestrated: false
    })
    expect(readPatterns({}, "packages: ['a']\ntasks:\n  build:\n    dependsOn: ['^build']\n")).toEqual({
      patterns: ["a"],
      orchestrated: true
    })
  })

  it("notes settings that change which packages a run selects", () => {
    expect(readPatterns({}, "packages: ['a']\nincludeWorkspaceRoot: true\n")?.orchestrated).toBe(true)
    expect(readPatterns({}, "packages: ['a']\nincludeWorkspaceRoot: false\n")?.orchestrated).toBe(false)
    for (
      const line of [
        "include-workspace-root=true",
        "workspaces = true",
        "workspace=a",
        "recursive=true",
        "filter=a",
        " filter-prod=a"
      ]
    ) {
      expect(readPatterns({}, "packages: ['a']", `registry=https://r.test\n${line}\n`)?.orchestrated, line).toBe(true)
      expect(readPatterns({ workspaces: ["a"] }, undefined, line)?.orchestrated, line).toBe(true)
    }
    expect(
      readPatterns({ workspaces: ["a"] }, undefined, "registry=https://r.test\nlink-workspace-packages=true")
        ?.orchestrated
    )
      .toBe(false)
    // A settings file that exists and cannot be read may set anything.
    expect(readPatterns({ workspaces: ["a"] }, undefined, null)?.orchestrated).toBe(true)
  })

  it("reads the root manifest's workspaces, as a list or under packages", () => {
    expect(readPatterns({ workspaces: ["packages/*", 3] }, undefined)).toEqual({
      patterns: ["packages/*"],
      orchestrated: false
    })
    expect(readPatterns({ workspaces: { packages: ["apps/*"] } }, undefined)).toEqual({
      patterns: ["apps/*"],
      orchestrated: false
    })
  })

  it("gives nothing when no workspace is declared or the file does not parse", () => {
    expect(readPatterns({}, undefined)).toBeUndefined()
    expect(readPatterns({ workspaces: "packages/*" }, undefined)).toBeUndefined()
    expect(readPatterns({}, "packages: [unclosed")).toBeUndefined()
    expect(readPatterns({}, "- a list")).toBeUndefined()
    expect(readPatterns({}, "catalog: {}")).toBeUndefined()
  })
})

describe("packageDirectories", () => {
  const files = new Set([
    "package.json",
    "packages/a/package.json",
    "packages/b/package.json",
    "packages/b/nested/package.json",
    "packages/skip/package.json",
    "packages/a/node_modules/dep/package.json",
    "packages/no-manifest/index.ts",
    "tools/deep/er/package.json",
    "apps/web.app/package.json",
    "elsewhere/x/package.json"
  ])

  it("matches directories that hold a package.json, minus exclusions", () => {
    expect(packageDirectories(["packages/*", "!packages/skip", "tools/**", "./apps/web.*/"], files)).toEqual([
      "apps/web.app",
      "packages/a",
      "packages/b",
      "tools/deep/er"
    ])
    expect(packageDirectories(["packages/**"], files)).toEqual([
      "packages/a",
      "packages/b",
      "packages/b/nested",
      "packages/skip"
    ])
    expect(packageDirectories(["packages/b/nested", "!**/a"], files)).toEqual(["packages/b/nested"])
    expect(packageDirectories([], files)).toEqual([])
  })

  it("gives nothing when a pattern uses syntax it does not read", () => {
    for (const pattern of ["packages/{a,b}", "packages/[ab]", "packages/?", "../outside/*", "!packages/{a,b}"]) {
      expect(packageDirectories(["packages/*", pattern], files), pattern).toBeUndefined()
    }
  })
})

describe("assemble", () => {
  it("builds packages with their scripts and the workspace packages they declare", () => {
    const workspace = assemble("bun", { name: "root", scripts: { ci: "turbo run test", bad: 1 } }, true, [
      [
        "packages/a",
        manifest("a", {
          scripts: { test: "vitest run", broken: [] },
          dependencies: { b: "workspace:*", left: "1.0.0" }
        })
      ],
      [
        "packages/b",
        manifest("b", { devDependencies: { c: "*" }, peerDependencies: { a: "*" }, optionalDependencies: { c: "*" } })
      ],
      ["packages/c", manifest("c", { scripts: "not a record", dependencies: ["a"] })]
    ])
    expect(workspace).toEqual({
      manager: "bun",
      rootName: "root",
      rootScripts: { ci: "turbo run test" },
      orchestrated: true,
      packages: [
        { name: "a", directory: "packages/a", scripts: { test: "vitest run" }, dependencies: ["b"] },
        { name: "b", directory: "packages/b", scripts: {}, dependencies: ["a", "c"] },
        { name: "c", directory: "packages/c", scripts: {}, dependencies: [] }
      ]
    })
    expect(assemble("npm", {}, false, [])).toMatchObject({ rootName: undefined, rootScripts: {}, packages: [] })
  })

  it("gives nothing when a manifest is unreadable, unnamed or shares a name", () => {
    expect(assemble("npm", {}, false, [["a", "{broken"]])).toBeUndefined()
    expect(assemble("npm", {}, false, [["a", "{}"]])).toBeUndefined()
    expect(assemble("npm", {}, false, [["a", `{"name":""}`]])).toBeUndefined()
    expect(assemble("npm", {}, false, [["a", `{"name":7}`]])).toBeUndefined()
    expect(assemble("npm", {}, false, [["a", manifest("same")], ["b", manifest("same")]])).toBeUndefined()
  })
})

describe("scanner", () => {
  const workspace = workspaceOf({
    "packages/core": manifest("@acme/core"),
    "packages/ui": manifest("@acme/ui"),
    "apps/web": manifest("web"),
    "apps/api.v2": manifest("api.v2")
  })
  const scan = scanner(workspace)

  it("finds a scoped name wherever it appears", () => {
    expect(scan(`import { a } from "@acme/core/sub"\nrequire('@acme/ui')`, false).names).toEqual([
      "@acme/core",
      "@acme/ui"
    ])
    expect(scan(`pnpm --filter @acme/core... build # @acme/ui@1.2.3`, false).names).toEqual(["@acme/core", "@acme/ui"])
    expect(scan(`@acme/unknown @other/core @acme node_modules/@acme`, false).names).toEqual([])
  })

  it("finds an unscoped name only in quotes, after node_modules/, or in a manifest", () => {
    expect(scan(`const web = 1; import x from "web"; from 'web/sub'`, false).names).toEqual(["web"])
    expect(scan(`const web = 1 // web and web/sub are words here`, false).names).toEqual([])
    expect(scan(`cat node_modules/web/package.json ../node_modules/api.v2`, false).names).toEqual(["api.v2", "web"])
    expect(scan(`{"scripts":{"build":"pnpm --filter web build && cd web/x"}}`, true).names).toEqual(["web"])
    expect(scan(`"webpack" 'my-web' "web.config"`, false).names).toEqual([])
    expect(scan("`api.v2`", false).names).toEqual(["api.v2"])
    expect(scan(`web is the first word`, false).names).toEqual([])
    expect(scan(`web is the first word`, true).names).toEqual(["web"])
  })

  it("skips the unscoped search when every name is scoped", () => {
    const scoped = scanner(workspaceOf({ "packages/core": manifest("@acme/core") }))
    expect(scoped(`"core" "@acme/core"`, true).names).toEqual(["@acme/core"])
  })

  it("finds relative paths that name something, and ignores bare steps up", () => {
    const found = scan(
      `extends "../../tsconfig.base.json"; import "./local"; join(dir, "..", "../..", "../", "./")`,
      false
    )
    expect(found.relative).toEqual(["../../tsconfig.base.json", "./local"])
  })

  it("finds paths written from the root that start where packages live", () => {
    const found = scan(
      `read("packages/core/src/a.ts"); "apps/web"; "docs/guide.md"; "https://x.test/packages/core"`,
      false
    )
    expect(found.rooted).toEqual(["apps/web", "packages/core/src/a.ts"])
    expect(scan(`node_modules/packages/x`, false).rooted).toEqual([])
  })
})

describe("manifestMentions", () => {
  const scan = scanner(workspaceOf({ "apps/web": manifest("website"), "packages/ui": manifest("ui") }))

  it("counts an unscoped name anywhere in a script, and only in quotes elsewhere", () => {
    const found = manifestMentions(
      scan,
      JSON.stringify({
        name: "docs",
        scripts: { "build:website": "vite build", prebuild: "pnpm --filter ui build && node ../tools/gen.mjs", odd: 7 },
        keywords: ["a website builder"],
        prettier: "ui"
      })
    )
    // The script named `build:website` names no package; the script that runs `--filter ui` does.
    expect(found).toEqual({ names: ["ui"], relative: ["../tools/gen.mjs"], rooted: [] })
    expect(manifestMentions(scan, `{ "scripts": [], "files": ["packages/ui/dist"] }`)).toEqual({
      names: [],
      relative: [],
      rooted: ["packages/ui/dist"]
    })
    expect(manifestMentions(scan, `{ broken "website"`).names).toEqual(["website"])
  })
})

describe("join and resolveFile", () => {
  it("joins a relative path to a directory, and refuses to leave the repository", () => {
    expect(join("packages/a/src", "../../b/x.ts")).toBe("packages/b/x.ts")
    expect(join("", "./a//b/.")).toBe("a/b")
    expect(join("a", "..")).toBe("")
    expect(join("a", "../..")).toBeUndefined()
  })

  it("finds the file a path names, as a JavaScript resolver would", () => {
    const files = new Set(["a/x.ts", "a/y/index.tsx", "a/z.json", "a/w.mts", "a/v.cts", "a/u.tsx", "a/exact"])
    expect(resolveFile("a/exact", files)).toBe("a/exact")
    expect(resolveFile("a/x", files)).toBe("a/x.ts")
    expect(resolveFile("a/x.js", files)).toBe("a/x.ts")
    expect(resolveFile("a/u.js", files)).toBe("a/u.tsx")
    expect(resolveFile("a/u.jsx", files)).toBe("a/u.tsx")
    expect(resolveFile("a/w.mjs", files)).toBe("a/w.mts")
    expect(resolveFile("a/v.cjs", files)).toBe("a/v.cts")
    expect(resolveFile("a/y", files)).toBe("a/y/index.tsx")
    expect(resolveFile("a/z", files)).toBe("a/z.json")
    expect(resolveFile("a/missing", files)).toBeUndefined()
  })
})

describe("graph", () => {
  it("reaches declared packages to a fixed point, through a cycle", () => {
    const { reach } = graphOf({
      "packages/a": manifest("a", { dependencies: { b: "workspace:*" } }),
      "packages/b": manifest("b", { dependencies: { c: "workspace:*" } }),
      "packages/c": manifest("c", { dependencies: { a: "workspace:*" } }),
      "packages/leaf": manifest("leaf")
    }, {})
    expect(reach("a").packages).toEqual(["packages/a", "packages/b", "packages/c"])
    expect(reach("c").packages).toEqual(["packages/a", "packages/b", "packages/c"])
    expect(reach("leaf")).toEqual({ packages: ["packages/leaf"], files: [] })
  })

  it("reaches a package its files import by name without declaring it", () => {
    const { reach } = graphOf({ "packages/a": manifest("@x/a"), "packages/b": manifest("@x/b") }, {
      "packages/a/src/index.ts": `import { b } from "@x/b"`
    })
    expect(reach("@x/a").packages).toEqual(["packages/a", "packages/b"])
    expect(reach("@x/b").packages).toEqual(["packages/b"])
  })

  it("adds one file of another package, and what that file mentions", () => {
    const { reach } = graphOf({
      "packages/a": manifest("@x/a", { scripts: { test: "node ../tools/run.mjs" } }),
      "packages/tools": manifest("@x/tools", { dependencies: { "@x/big": "*" } }),
      "packages/big": manifest("@x/big"),
      "packages/c": manifest("@x/c")
    }, {
      "packages/tools/run.mjs": `import "./lib/helper.js"; import "@x/c"`,
      "packages/tools/lib/helper.ts": `export {}`,
      "packages/tools/other.mjs": `import "@x/big"`
    })
    // The script file and its helper, and the package the script imports: not the tools package whole.
    expect(reach("@x/a")).toEqual({
      packages: ["packages/a", "packages/c"],
      files: ["packages/tools/lib/helper.ts", "packages/tools/run.mjs"]
    })
  })

  it("reads a file two packages both name once", () => {
    const { reach } = graphOf({
      "packages/a": manifest("a"),
      "packages/b": manifest("b"),
      "packages/tools": manifest("tools")
    }, {
      "packages/a/x.ts": `import "../tools/run.mjs"`,
      "packages/b/y.ts": `import "../tools/run.mjs"`,
      "packages/tools/run.mjs": ``
    })
    expect(reach("a").files).toEqual(["packages/tools/run.mjs"])
    expect(reach("b").files).toEqual(["packages/tools/run.mjs"])
  })

  it("adds a package whole when a path into it names no file", () => {
    const { reach } = graphOf({
      "packages/a": manifest("a"),
      "packages/b": manifest("b"),
      "packages/c": manifest("c"),
      "packages/d": manifest("d")
    }, {
      "packages/a/tsconfig.json": `{ "references": [{ "path": "../b" }], "include": ["../c/src/gone.ts"] }`,
      "packages/a/x.ts": `read("packages/d/assets")`
    })
    expect(reach("a")).toEqual({ packages: ["packages/a", "packages/b", "packages/c", "packages/d"], files: [] })
  })

  it("adds a single file's own package whole when the file reads a path it cannot follow", () => {
    const { reach } = graphOf({ "packages/a": manifest("a"), "packages/tools": manifest("tools") }, {
      "packages/a/package.json.ts": `import "../tools/run.mjs"`,
      "packages/tools/run.mjs": `import "./generated/out.js"`,
      "packages/tools/secret.ts": ``
    })
    expect(reach("a")).toEqual({ packages: ["packages/a", "packages/tools"], files: [] })
  })

  it("tries a relative path from the file's directory and from its package's", () => {
    const { reach } = graphOf({
      "packages/a": manifest("a"),
      "packages/b": manifest("b"),
      "packages/a/b": manifest("inner")
    }, {
      // From the file's directory this stays in `a`; from the package's it names `b`.
      "packages/a/test/read.ts": `readFileSync("../b/data.json")`,
      "packages/b/data.json": `{}`
    })
    expect(reach("a")).toEqual({ packages: ["packages/a", "packages/a/b"], files: ["packages/b/data.json"] })
  })

  it("reads a relative path from the file's directory alone when it names something there", () => {
    const { reach } = graphOf({ "packages/dom": manifest("dom"), "packages/utils": manifest("utils") }, {
      // `../utils/rect` is this package's own src/utils/rect.ts, not the package named utils.
      "packages/dom/src/platform/a.ts": `import "../utils/rect"; import "../shared"`,
      "packages/dom/src/utils/rect.ts": ``,
      "packages/dom/src/shared/index.md": ``,
      "packages/utils/rect.ts": ``
    })
    expect(reach("dom")).toEqual({ packages: ["packages/dom"], files: [] })
  })

  it("ignores paths that stay inside the package, leave the repository, or name no package", () => {
    const { reach } = graphOf({ "packages/a": manifest("a"), "packages/b": manifest("b") }, {
      "packages/a/src/x.ts":
        `import "./y"; import "../lib/z"; import "../../../../outside"; import "../../../scripts/tool"`,
      "scripts/tool.ts": `import "../packages/b/x"`
    })
    expect(reach("a")).toEqual({ packages: ["packages/a"], files: [] })
  })

  it("follows a path written from the root", () => {
    const { reach } = graphOf({ "packages/a": manifest("a"), "packages/b": manifest("b") }, {
      "packages/a/x.ts": `join(root, "packages/b/src/y.ts")`,
      "packages/b/src/y.ts": ``
    })
    expect(reach("a")).toEqual({ packages: ["packages/a"], files: ["packages/b/src/y.ts"] })
  })

  it("answers for one file, and finds the owner of a path", () => {
    const { built, reach } = graphOf({
      "packages/a": manifest("a"),
      "packages/a/inner": manifest("inner"),
      "packages/b": manifest("b")
    }, {
      "packages/a/tool.ts": `import "b"`,
      "packages/b/index.ts": ``
    })
    expect(reach("packages/a/tool.ts")).toEqual({ packages: ["packages/b"], files: ["packages/a/tool.ts"] })
    expect(built.ownerOf("packages/a/inner/x.ts")?.name).toBe("inner")
    expect(built.ownerOf("packages/a")?.name).toBe("a")
    expect(built.ownerOf("packages/ab/x.ts")).toBeUndefined()
    expect(built.ownerOf("")).toBeUndefined()
    expect(built.named("missing")).toBeUndefined()
    // Asking twice gives the same answer from what was already read.
    expect(reach("a")).toEqual(reach("a"))
  })
})

describe("spineOf and outsideGlobs", () => {
  const workspace = workspaceOf({
    "packages/a": manifest("a"),
    "packages/cloud": manifest("cloud"),
    "packages/cloud/api": manifest("api"),
    "plugins/group/p": manifest("p")
  })

  it("lists the directories above a package, never a package itself", () => {
    expect([...spineOf(workspace)].sort()).toEqual(["", "packages", "plugins", "plugins/group"])
    expect([...spineOf(workspaceOf({}))]).toEqual([""])
  })

  it("names every file outside all packages", () => {
    const files = new Set([
      "package.json",
      "pnpm-lock.yaml",
      ".github/workflows/ci.yml",
      "scripts/build/x.mjs",
      "packages/a/src/x.ts",
      "packages/shared.json",
      "packages/not-a-package/x.ts",
      "packages/cloud/api/y.ts",
      "plugins/group/readme.md",
      "plugins/group/p/z.ts",
      "plugins/loose/q.ts"
    ])
    expect(outsideGlobs(workspace, files)).toEqual([
      "*",
      ".github/**",
      "packages/*",
      "packages/not-a-package/**",
      "plugins/*",
      "plugins/group/*",
      "plugins/loose/**",
      "scripts/**"
    ])
  })
})
