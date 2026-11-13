import { Smithers as S } from "@smthrs/targets"
import * as PackageValue from "@smthrs/targets/Package"
import * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { isPackageError } from "../src/PackageError.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import type * as PackageLoader from "../src/PackageLoader.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspace: WorkspaceDeclaration.WorkspaceDeclaration = S.Workspace("unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  flags: S.Flags({ mode: "--mode=test" })
})

const graph = (
  packages: ReadonlyArray<PackageLoader.LoadedPackage>,
  root = "/workspace"
): PackageLoader.LoadedGraph => ({ root, workspace, factory: undefined, packages }) as PackageLoader.LoadedGraph

const listed = (packagePath: string, targets: Readonly<Record<string, Target.AnyTarget>>) => ({
  file: packagePath === "" ? "PACKAGE.ts" : `${packagePath}/PACKAGE.ts`,
  packagePath,
  value: S.Package({ targets })
})

/** The PackageError code a call throws, or a failure naming what it did instead. */
const errorOf = (work: () => unknown): { readonly code: string; readonly message: string } => {
  try {
    work()
  } catch (cause) {
    if (isPackageError(cause)) return { code: cause.code, message: cause.message }
    throw cause
  }
  throw new Error("expected a PackageError")
}

/** A rule whose one attr is carried through untouched, so a test controls its exact runtime shape. */
const Probe = Target.make("Probe.Value", {
  attrs: Schema.Struct({ value: Schema.Unknown }),
  kinds: ["run"],
  implementation: () => Target.notImplemented("Probe.Value")
})

/**
 * A value carrying the Package marker without passing through `S.Package`,
 * the shape a module that hand-builds its export presents to the index.
 */
const forgedPackage = (entries: Readonly<Record<string, unknown>>): PackageValue.PackageValue => {
  const value: Record<string, unknown> = Object.create(null)
  for (const [key, entry] of Object.entries(entries)) {
    Object.defineProperty(value, key, { value: entry, enumerable: true })
  }
  Object.defineProperty(value, PackageValue.PackageTypeId, {
    value: { abi: PackageValue.abi, keys: Object.keys(entries) },
    enumerable: false,
    configurable: false,
    writable: false
  })
  return value as unknown as PackageValue.PackageValue
}

describe("package map validation", () => {
  it("refuses two Package modules that resolve to one package directory", () => {
    const failure = errorOf(() =>
      PackageIndex.make(graph([
        listed("app", { build: S.Shell.Test({ shell: "true" }) }),
        { ...listed("app", { lint: S.Shell.Test({ shell: "true" }) }), file: "app/nested/../PACKAGE.ts" }
      ]))
    )
    expect(failure.code).toBe("duplicate_package_path")
  })

  it("refuses a hand-built Package whose key fails the target grammar", () => {
    const value = forgedPackage({ "has space": S.Shell.Test({ shell: "true" }) })
    const failure = errorOf(() => PackageIndex.make(graph([{ file: "PACKAGE.ts", packagePath: "", value }])))
    expect(failure.code).toBe("invalid_target_key")
    expect(failure.message).toContain("\"has space\"")
  })

  it("refuses a hand-built Package whose key holds a plain value instead of a target", () => {
    const value = forgedPackage({ build: { shell: "true" } })
    const failure = errorOf(() => PackageIndex.make(graph([{ file: "PACKAGE.ts", packagePath: "", value }])))
    expect(failure.code).toBe("invalid_target_value")
    expect(failure.message).toContain("\"build\" does not hold a target")
  })
})

describe("private local ownership", () => {
  it("refuses an unlisted target reachable from two packages", () => {
    const shared = S.Shell.Test({ shell: "echo shared" })
    const failure = errorOf(() =>
      PackageIndex.make(graph([
        listed("a", { check: S.Shell.Test({ shell: "true", data: [shared] }) }),
        listed("b", { check: S.Shell.Test({ shell: "true", data: [shared] }) })
      ]))
    )
    expect(failure.code).toBe("private_owner_conflict")
    expect(failure.message).toContain("//a and //b")
  })

  it("lets one package reach the same unlisted target from two of its targets", () => {
    const shared = S.Shell.Test({ shell: "echo shared" })
    const index = PackageIndex.make(graph([
      listed("a", {
        first: S.Shell.Test({ shell: "true", data: [shared] }),
        second: S.Shell.Test({ shell: "true", data: [shared] })
      })
    ]))
    expect(index.resolve("//a:*").map((row) => row.label)).toEqual(["//a:first", "//a:second"])
  })
})

describe("declaring-module instances", () => {
  it("refuses a target minted by a directory-case variant of a discovered PACKAGE.ts", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-index-case-")))
    temporaryDirectories.push(root)
    const variant = NodePath.join(root, "Pkg", "PACKAGE.ts")
    await Fs.mkdir(NodePath.dirname(variant), { recursive: true })
    // Takes the namespace as an argument so the module needs no package resolution from the temp dir.
    await Fs.writeFile(variant, "export const make = (S) => S.Shell.Test({ shell: \"true\" })\n", "utf8")
    const module = (await import(variant)) as { readonly make: (s: typeof S) => Target.AnyTarget }
    const target = module.make(S)
    expect(Target.metadata(target).sourceFile).toBe(variant)
    const failure = errorOf(() => PackageIndex.make(graph([listed("pkg", { build: target })], root)))
    expect(failure.code).toBe("case_collision")
    expect(failure.message).toContain("Pkg/PACKAGE.ts, a case variant of the discovered pkg/PACKAGE.ts")
    // The same handle indexed under a root that does not contain its declaring file is not a case variant.
    const elsewhere = PackageIndex.make(graph([listed("pkg", { build: target })], NodePath.join(root, "other")))
    expect(elsewhere.resolve("//pkg:build")).toHaveLength(1)
  })
})

describe("data edges", () => {
  it("refuses a Run target reachable through a data attr", () => {
    const run = S.Shell.Run({ shell: "echo side effect" })
    const failure = errorOf(() =>
      PackageIndex.make(
        graph([listed("", { check: S.Shell.Test({ shell: "true", data: [S.Suite({ tests: [run] })] }) })])
      )
    )
    expect(failure.code).toBe("illegal_data_target")
  })
})

describe("owners and teams", () => {
  const owned = (options: { readonly teams?: Readonly<Record<string, ReadonlyArray<string>>> }) =>
    PackageIndex.make({
      root: "/workspace",
      workspace: S.Workspace("unit", {
        repository: "git+https://example.invalid/unit.git",
        cache: S.Cache({ directory: ".flows" }),
        owners: { owners: ["team:platform"] },
        ...(options.teams === undefined ? {} : { teams: options.teams })
      }),
      factory: undefined,
      packages: [{
        file: "app/PACKAGE.ts",
        packagePath: "app",
        value: S.Package({ owners: { owners: ["team:data"] }, targets: { build: S.Shell.Test({ shell: "true" }) } })
      }]
    } as PackageLoader.LoadedGraph)

  it("refuses workspace owners naming a team the roster does not declare", () => {
    const failure = errorOf(() => owned({}))
    expect(failure.code).toBe("unknown_team")
    expect(failure.message).toContain("owners of the workspace name team:platform")
  })

  it("refuses package owners naming a team the roster does not declare", () => {
    const failure = errorOf(() => owned({ teams: { platform: ["alice"] } }))
    expect(failure.code).toBe("unknown_team")
    expect(failure.message).toContain("owners of //app name team:data")
  })

  it("answers package queries and owners once every team is declared", () => {
    const index = owned({ teams: { platform: ["alice"], data: ["bob"] } })
    expect(index.packages()).toEqual(["app"])
    expect(index.hasPackage("app")).toBe(true)
    expect(index.hasPackage("missing")).toBe(false)
    expect(index.ownersOf("app")).toBeDefined()
    expect(index.ownersOf("missing")).toBeUndefined()
  })
})

describe("workspace reference resolution", () => {
  it("refuses an S.Host.bin reference the workspace host does not declare", () => {
    const failure = errorOf(() =>
      PackageIndex.make(graph([listed("", { build: Probe({ value: { bin: S.Host.bin("cc") } }) })]))
    )
    expect(failure.code).toBe("undeclared_host_bin")
    expect(failure.message).toContain("S.Host.bin(\"cc\")")
  })

  it("refuses an S.Flags reference to an undeclared flag", () => {
    const failure = errorOf(() =>
      PackageIndex.make(graph([listed("", { build: Probe({ value: { args: [S.Flags["missing"]] } }) })]))
    )
    expect(failure.code).toBe("unknown_flag")
    expect(failure.message).toContain("S.Flags.missing")
  })

  it("accepts an S.Flags reference to a declared flag", () => {
    const index = PackageIndex.make(graph([listed("", { build: Probe({ value: { args: [S.Flags["mode"]] } }) })]))
    expect(index.resolve("//:build")).toHaveLength(1)
  })

  it("reads no references from a dependency selector's prototype or accessors", () => {
    class Selector {}
    const inherited = Object.assign(Object.create(Selector.prototype) as object, {
      _tag: "TargetDependencySelector",
      pattern: "//...",
      target: "build",
      ref: S.Flags["missing"]
    })
    const accessor = Object.defineProperty(
      { _tag: "TargetDependencySelector", pattern: "//...", target: "lint" },
      "ref",
      {
        enumerable: true,
        get: () => {
          throw new Error("indexing invoked an author accessor")
        }
      }
    )
    expect(Target.isDependencySelector(inherited)).toBe(true)
    expect(Target.isDependencySelector(accessor)).toBe(true)
    const index = PackageIndex.make(graph([
      listed("", { inherited: Probe({ value: inherited }), accessor: Probe({ value: accessor }) })
    ]))
    expect(index.resolve("//...").map((row) => row.label)).toEqual(["//:accessor", "//:inherited"])
  })
})

/** A handle that passes `Target.isTarget` but whose metadata carries non-record attrs. */
const handleWithAttrs = (attrs: unknown): Target.AnyTarget => {
  const metadata = Target.metadata(S.Shell.Test({ shell: "true" }))
  const handle = { _tag: metadata.target }
  Object.defineProperty(handle, Target.TargetTypeId, {
    value: Object.freeze({ ...metadata, attrs }),
    enumerable: false,
    configurable: false,
    writable: false
  })
  return handle as unknown as Target.AnyTarget
}

describe("handles without record attrs", () => {
  it.each([null, "text"])("indexes a handle whose attrs are %j and reports no data edges for it", (attrs) => {
    const handle = handleWithAttrs(attrs)
    expect(Target.isTarget(handle)).toBe(true)
    const index = PackageIndex.make(graph([listed("", { handle })]))
    expect(index.resolve("//:handle")).toHaveLength(1)
    expect(index.edges(index.resolve("//..."))).toEqual([])
  })
})

describe("pattern resolution", () => {
  const index = PackageIndex.make(graph([
    listed("app", { default: S.Shell.Test({ shell: "true" }), lint: S.Shell.Test({ shell: "true" }) })
  ]))

  it("resolves a bare package label to its default key", () => {
    expect(index.resolve("//app").map((row) => row.label)).toEqual(["//app:default"])
  })

  it("refuses a bare package label for a directory that holds no package", () => {
    const failure = errorOf(() => index.resolve("//missing"))
    expect(failure.code).toBe("unknown_label")
    expect(failure.message).toContain("no package at //missing")
  })

  it("refuses a package wildcard under a directory that holds no package", () => {
    const failure = errorOf(() => index.resolve("//missing:*"))
    expect(failure.code).toBe("unknown_label")
    expect(failure.message).toContain("no package at //missing")
  })
})

describe("edge classification", () => {
  it("reports each edge once when private helpers form a diamond", () => {
    const leaf = S.Shell.Test({ shell: "echo leaf" })
    const helper = S.Suite({ tests: [S.Shell.Test({ shell: "true", data: [leaf] })] })
    const left = S.Suite({ tests: [helper] })
    const right = S.Suite({ tests: [helper] })
    const top = S.Shell.Test({ shell: "true", data: [left, right] })
    const index = PackageIndex.make(graph([listed("", { top, leaf })]))
    expect(index.edges(index.resolve("//:top"))).toEqual([{ from: "//:top", to: "//:leaf", kind: "data" }])
  })

  it("reports one edge per kind when a shared helper is entered through data and gates", () => {
    const leaf = S.Shell.Test({ shell: "echo leaf" })
    const helper = S.Suite({ tests: [S.Shell.Test({ shell: "true", data: [leaf] })] })
    const top = S.Shell.Test({
      shell: "true",
      data: [S.Suite({ tests: [helper] })],
      gates: [S.Suite({ tests: [helper] })]
    })
    const index = PackageIndex.make(graph([listed("", { top, leaf })]))
    expect(index.edges(index.resolve("//:top"))).toEqual([
      { from: "//:top", to: "//:leaf", kind: "data" },
      { from: "//:top", to: "//:leaf", kind: "gates" }
    ])
  })

  it("reports each edge once when the selection names one target twice", () => {
    const leaf = S.Shell.Test({ shell: "echo leaf" })
    const top = S.Shell.Test({ shell: "true", data: [leaf] })
    const index = PackageIndex.make(graph([listed("", { top, leaf })]))
    const selected = [...index.resolve("//:top"), ...index.resolve("//...")]
    expect(index.edges(selected)).toEqual([{ from: "//:top", to: "//:leaf", kind: "data" }])
  })
})
