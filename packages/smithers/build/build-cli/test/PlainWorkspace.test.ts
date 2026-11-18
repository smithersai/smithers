/**
 * The plain workspace file, `.smithers/WORKSPACE.smithers`: a workspace whose
 * whole declaration, root package included, lives under `.smithers/`.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { factoryFileBeside } from "../src/FactoryLoader.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { isPackageError } from "../src/PackageError.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { rootPackageOf, validateWorkspaceModule } from "../src/WorkspaceLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const plain = PackageDiscovery.plainWorkspaceFile

const workspaceText = `import { Smithers as S } from "@smthrs/targets"

export const Workspace = S.Workspace("plain", {
  repository: "git+https://example.invalid/plain.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] })
})
`

const packageText = `
const sources = S.Shell.Test({ shell: "cat src/a.txt", sandbox: "none", data: [S.glob("src/**")] })
const everything = S.Shell.Test({ shell: "true", sandbox: "none", data: [S.glob("//**"), S.file("notes.md")] })

export const Package = S.Package({ targets: { sources, everything } })
`

/** A repository whose only build file is the plain workspace file. */
const repository = async (text: string = `${workspaceText}${packageText}`): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-plain-workspace-")))
  roots.push(root)
  await write(root, plain, text)
  await write(root, "src/a.txt", "a\n")
  await write(root, "notes.md", "notes\n")
  return root
}

const indexOf = async (root: string) =>
  PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))

/** The routing code and message a rejected load carries. */
const refusal = async (work: () => Promise<unknown> | unknown): Promise<{ code: string; message: string }> => {
  try {
    await work()
  } catch (cause) {
    if (isPackageError(cause)) return { code: cause.code, message: cause.message }
    throw cause
  }
  throw new Error("nothing was refused")
}

const workspace = S.Workspace("unit", {
  repository: "git+https://example.invalid/unit.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] })
})

describe("the plain workspace file", () => {
  it("is found as the workspace declaration, from the root and from below it", async () => {
    const root = await repository()
    await Fs.mkdir(Path.join(root, "src", "deep"), { recursive: true })
    expect(await PackageDiscovery.workspaceFileOf(root)).toBe(plain)
    expect(await PackageDiscovery.findWorkspaceRoot(Path.join(root, "src", "deep"))).toBe(root)
    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.workspaceFile).toBe(plain)
    expect(discovery.packageFiles).toEqual([])
    expect(PackageDiscovery.workspaceFiles).toEqual([".smithers/WORKSPACE.ts", plain, "WORKSPACE.ts"])
    expect(PackageDiscovery.isWorkspaceFileName("WORKSPACE.smithers")).toBe(true)
    expect(PackageDiscovery.isWorkspaceFileName("WORKSPACE.ts")).toBe(true)
    expect(PackageDiscovery.isWorkspaceFileName("PACKAGE.ts")).toBe(false)
  })

  it("declares the root package: labels are //:name and paths resolve from the workspace root", async () => {
    const root = await repository()
    const index = await indexOf(root)
    expect(index.targets().map((row) => row.label)).toEqual(["//:everything", "//:sources"])
    const planned = await PackageExec.plan({ index, patterns: ["//..."], cacheDirectory: ".flows", verb: "test" })
    const filesOf = (label: string): ReadonlyArray<string> => {
      const node = planned.workList.find((entry) => entry.label === label)
      const inputs = node?.keyMaterial.inputs as {
        readonly declared: ReadonlyArray<{ readonly files: ReadonlyArray<{ readonly path: string }> }>
      }
      return [...new Set(inputs.declared.flatMap((input) => input.files.map((file) => file.path)))].sort()
    }
    // A package-relative glob and file resolve from the root, as they do in a root PACKAGE.ts.
    expect(filesOf("//:sources")).toEqual(["src/a.txt"])
    expect(filesOf("//:everything")).toEqual([plain, "notes.md", "src/a.txt"])
  })

  it("declares no package when it exports none", async () => {
    const root = await repository(workspaceText)
    const index = await indexOf(root)
    expect(index.targets()).toEqual([])
    expect(index.hasPackage("")).toBe(false)
  })

  it("is refused beside a root PACKAGE.ts: both declare //", async () => {
    const root = await repository()
    await write(
      root,
      "PACKAGE.ts",
      "import { Smithers as S } from \"@smthrs/targets\"\nexport const Package = S.Package({ targets: {} })\n"
    )
    const refused = await refusal(() => indexOf(root))
    expect(refused.code).toBe("duplicate_package_path")
    expect(refused.message).toContain(`${plain} and PACKAGE.ts both declare //; keep one of them`)
  })

  it("is refused beside .smithers/WORKSPACE.ts: neither wins", async () => {
    const root = await repository()
    await write(root, ".smithers/WORKSPACE.ts", workspaceText)
    const refused = await refusal(() => PackageDiscovery.discover(root))
    expect(refused.code).toBe("workspace_root_invalid")
    expect(refused.message).toContain(
      `.smithers/WORKSPACE.ts and ${plain} both declare the workspace; keep one of them`
    )
  })

  it("comes before a root WORKSPACE.ts, which stays the fallback", async () => {
    const root = await repository()
    await write(root, "WORKSPACE.ts", workspaceText)
    expect((await PackageDiscovery.discover(root)).workspaceFile).toBe(plain)
  })

  it("names all three places when a root has no workspace declaration", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-plain-workspace-")))
    roots.push(root)
    const refused = await refusal(() => PackageDiscovery.discover(root))
    expect(refused.code).toBe("workspace_root_invalid")
    expect(refused.message).toContain("no .smithers/WORKSPACE.ts, no .smithers/WORKSPACE.smithers and no WORKSPACE.ts")
  })

  it("marks a nested workspace that the root did not declare", async () => {
    const root = await repository()
    await write(root, `vendor/tool/${plain}`, workspaceText)
    const refused = await refusal(() => PackageDiscovery.discover(root))
    expect(refused.code).toBe("nested_workspace_undeclared")
    expect(refused.message).toContain(`vendor/tool/${plain}`)
  })

  it("keeps its factory beside it", () => {
    expect(factoryFileBeside(plain)).toBe(".smithers/FACTORY.ts")
    expect(factoryFileBeside(".smithers/WORKSPACE.ts")).toBe(".smithers/FACTORY.ts")
    expect(factoryFileBeside("WORKSPACE.ts")).toBe("FACTORY.ts")
  })

  it("exports its package as Package and nothing else", async () => {
    const renamed = await repository(
      `${workspaceText}${packageText.replace("export const Package", "export const Root")}`
    )
    const refused = await refusal(() => indexOf(renamed))
    expect(refused.code).toBe("invalid_package_export")
    expect(refused.message).toContain("a Package value is exported as \"Root\"; the one legal export name is Package")
    const check = S.Shell.Test({ shell: "true" })
    const targets = S.Package({ targets: { check } })
    expect(validateWorkspaceModule({ Workspace: workspace, Package: targets }, plain)).toBe(workspace)
    expect(rootPackageOf({ Workspace: workspace, Package: targets }, plain)).toBe(targets)
    expect((await refusal(() => validateWorkspaceModule({ Workspace: workspace, Root: targets }, plain))).code).toBe(
      "invalid_package_export"
    )
    expect((await refusal(() => rootPackageOf({ Workspace: workspace, Package: 1 }, plain))).code).toBe(
      "invalid_package_export"
    )
    expect(rootPackageOf({ Workspace: workspace }, plain)).toBeUndefined()
    expect(rootPackageOf(undefined, plain)).toBeUndefined()
    expect(rootPackageOf(null, plain)).toBeUndefined()
  })

  it("leaves a .ts workspace file as it was: a Package export is refused", async () => {
    const targets = S.Package({ targets: {} })
    const refused = await refusal(() =>
      validateWorkspaceModule({ Workspace: workspace, Package: targets }, ".smithers/WORKSPACE.ts")
    )
    expect(refused.code).toBe("workspace_export_duplicate")
    expect(refused.message).toContain("WORKSPACE.ts exports a Package value \"Package\"")
    expect(rootPackageOf({ Workspace: workspace, Package: targets }, ".smithers/WORKSPACE.ts")).toBeUndefined()
    expect((await refusal(() => validateWorkspaceModule({}, plain))).message).toContain(
      "WORKSPACE.smithers has no Workspace export"
    )
    expect((await refusal(() => validateWorkspaceModule(undefined, plain))).message).toContain(
      "WORKSPACE.smithers did not evaluate to a module namespace"
    )
  })

  it("is a declaration no Package module may import", async () => {
    const root = await repository(workspaceText)
    await write(
      root,
      "PACKAGE.ts",
      "import { Smithers as S } from \"@smthrs/targets\"\nimport \"./.smithers/WORKSPACE.smithers\"\nexport const Package = S.Package({ targets: {} })\n"
    )
    const refused = await refusal(() => indexOf(root))
    expect(refused.code).toBe("unsupported_module_specifier")
  })
})
