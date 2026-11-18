import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeGeneratedFile } from "../src/GeneratedFile.ts"
import { WriteFileError } from "../src/GeneratedFile.ts"
import * as Input from "../src/Input.ts"
import { ensureDirectory, reclaimStaleTemporaries } from "../src/internal/ScaffoldDirectory.ts"
import { boilerplate, scaffold, type ScaffoldPayload, type ScaffoldReport } from "../src/NewPackage.ts"
import { NewPackage } from "../src/NewPackage.ts"
import { matches, PackageDefaults } from "../src/PackageDefaults.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as SafeFs from "../src/SafeFs.ts"
import { plannedCalls } from "./plan.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-newpackage-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const template = PackageJsonTemplate.make({
  license: "MIT",
  author: "flows",
  engines: { node: ">=26.4.0" },
  scripts: PackageJsonTemplate.standardScripts
})

const payload: ScaffoldPayload = {
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: template.fields,
  tsconfigExtends: "../../tsconfig.json"
}

const run = (packageName?: string): Promise<ScaffoldReport> =>
  Effect.runPromise(scaffold({ workspaceRoot: root, packageName }, payload))

const failure = (packageName?: string): Promise<{ readonly message: string }> =>
  Effect.runPromise(Effect.flip(scaffold({ workspaceRoot: root, packageName }, payload)))

const temporaryEntries = async (): Promise<ReadonlyArray<string>> =>
  (await Fs.readdir(NodePath.join(root, "packages")))
    .filter((entry) => entry.startsWith(".smthrs-scaffold-"))

describe("scaffold", () => {
  it("creates a package with a PACKAGE.ts declaring a test target in its own directory", async () => {
    const report = await run("@smthrs/widget")
    expect(report.directory).toBe("packages/widget")
    expect(report.files).toEqual([
      "packages/widget/package.json",
      "packages/widget/tsconfig.json",
      "packages/widget/src/index.ts",
      "packages/widget/test/index.test.ts",
      "packages/widget/README.md",
      "packages/widget/PACKAGE.ts"
    ])
    const declaration = await Fs.readFile(NodePath.join(root, "packages/widget/PACKAGE.ts"), "utf8")
    expect(declaration).toContain("test: Smithers.Vitest({")
    expect(declaration).toContain("cwd: \"packages/widget\"")
    const readme = await Fs.readFile(NodePath.join(root, "packages/widget/README.md"), "utf8")
    expect(readme).toContain("Created by `smthrs generate package @smthrs/widget`")
    expect(readme).toContain("`PACKAGE.ts` declares this package's targets")
    expect(readme).not.toContain("default target")
  })

  it("names a package created at the workspace root by its own directory", async () => {
    await Effect.runPromise(
      scaffold({ workspaceRoot: root, packageName: "@smthrs/widget" }, { ...payload, directory: "." })
    )
    expect(await Fs.readFile(NodePath.join(root, "widget/PACKAGE.ts"), "utf8")).toContain("cwd: \"widget\"")
  })

  it("reclaims a temporary directory a crashed scaffold left behind", async () => {
    const leftover = NodePath.join(root, "packages/.smthrs-scaffold-crashed.tmp")
    await Fs.mkdir(leftover, { recursive: true })
    await Fs.writeFile(NodePath.join(leftover, "package.json"), "{}\n", "utf8")
    const past = new Date(Date.now() - 60 * 60 * 1000)
    await Fs.utimes(leftover, past, past)

    await run("@smthrs/widget")

    expect(await temporaryEntries()).toEqual([])
  })

  it("leaves a fresh temporary directory a concurrent scaffold may still own", async () => {
    await Fs.mkdir(NodePath.join(root, "packages/.smthrs-scaffold-live.tmp"), { recursive: true })

    await run("@smthrs/widget")

    expect(await temporaryEntries()).toEqual([".smthrs-scaffold-live.tmp"])
  })

  it("keeps scaffold temporary directories out of default-target matches", () => {
    const declaration = PackageDefaults({ directories: Input.glob("packages/*"), macro: () => ({}) })
    expect(matches(declaration, "", "packages/widget")).toBe(true)
    expect(matches(declaration, "", "packages/.smthrs-scaffold-crashed.tmp")).toBe(false)
  })

  it("writes a manifest carrying the template fields", async () => {
    await run("@smthrs/widget")
    const manifest = JSON.parse(
      await Fs.readFile(NodePath.join(root, "packages/widget/package.json"), "utf8")
    ) as Record<string, unknown>
    expect(manifest["name"]).toBe("@smthrs/widget")
    expect(manifest["version"]).toBe("0.1.0")
    expect(manifest["license"]).toBe("MIT")
    expect(manifest["author"]).toBe("flows")
    expect(manifest["engines"]).toEqual({ node: ">=26.4.0" })
    expect(manifest["scripts"]).toEqual(PackageJsonTemplate.standardScripts)
    // The manifest is already in the generated key order.
    expect(Object.keys(manifest).slice(0, 3)).toEqual(["name", "version", "license"])
  })

  it("writes a source file and a test that exercises it", async () => {
    await run("@smthrs/my-widget")
    const source = await Fs.readFile(NodePath.join(root, "packages/my-widget/src/index.ts"), "utf8")
    const test = await Fs.readFile(NodePath.join(root, "packages/my-widget/test/index.test.ts"), "utf8")
    expect(source).toContain("export const myWidget = \"@smthrs/my-widget\"")
    expect(test).toContain("import { myWidget } from \"../src/index.ts\"")
    const tsconfig = JSON.parse(
      await Fs.readFile(NodePath.join(root, "packages/my-widget/tsconfig.json"), "utf8")
    ) as { extends: string }
    expect(tsconfig.extends).toBe("../../tsconfig.json")
  })

  it.each([
    [".", "widget/tsconfig.json", "../tsconfig.base.json"],
    ["packages", "packages/widget/tsconfig.json", "../../tsconfig.base.json"],
    ["packages/smithers", "packages/smithers/widget/tsconfig.json", "../../../tsconfig.base.json"]
  ])("extends the workspace-root tsconfig.base.json from %s by default", async (directory, file, expected) => {
    const { tsconfigExtends: _declared, ...undeclared } = payload
    await Effect.runPromise(
      scaffold({ workspaceRoot: root, packageName: "@smthrs/widget" }, { ...undeclared, directory })
    )
    const tsconfig = JSON.parse(await Fs.readFile(NodePath.join(root, file), "utf8")) as { extends: string }
    expect(tsconfig.extends).toBe(expected)
    expect(NodePath.resolve(NodePath.dirname(NodePath.join(root, file)), tsconfig.extends))
      .toBe(NodePath.join(root, "tsconfig.base.json"))
  })

  it("exports its initial public module without exposing future helper files", async () => {
    await run("@smthrs/widget")
    const directory = NodePath.join(root, "packages/widget")
    await Fs.writeFile(NodePath.join(directory, "src/Hidden.ts"), "export const secret = 1\n")
    const require = createRequire(NodePath.join(directory, "package.json"))
    expect(require.resolve("@smthrs/widget")).toBe(NodePath.join(directory, "src/index.ts"))
    expect(require.resolve("@smthrs/widget/package.json")).toBe(NodePath.join(directory, "package.json"))
    expect(() => require.resolve("@smthrs/widget/Hidden")).toThrowError(
      expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
    )
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(directory, "package.json"), "utf8"))
    expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./package.json": "./package.json" })
  })

  it("always generates a valid non-reserved JavaScript binding", () => {
    expect(boilerplate("123", payload)[2]?.[1]).toContain("export const package123")
    expect(boilerplate("default", payload)[2]?.[1]).toContain("export const packageDefault")
    expect(boilerplate("eval", payload)[2]?.[1]).toContain("export const packageEval")
    expect(boilerplate("---", payload)[2]?.[1]).toContain("export const packageName")
  })

  it("names the public command when no package name was supplied", async () => {
    expect((await failure()).message).toContain("smthrs generate package <package-name>")
    expect((await failure("")).message).toContain("smthrs generate package <package-name>")
  })

  it("refuses an invalid npm name and an existing directory", async () => {
    expect((await failure("Widget")).message).toContain("lowercase")
    await run("@smthrs/widget")
    expect((await failure("@smthrs/widget")).message).toContain("already exists")
  })

  it("publishes no partial package when a generated-file write fails", async () => {
    let writes = 0
    const result = await Effect.runPromise(Effect.flip(scaffold({
      workspaceRoot: root,
      packageName: "@smthrs/widget",
      io: {
        writeFile: async (workspaceRoot, file, signal) => {
          writes += 1
          if (writes === 3) throw new Error("injected ENOSPC")
          await Effect.runPromise(writeGeneratedFile(workspaceRoot, file), { signal })
        }
      }
    }, payload)))

    expect(result.message).toContain("injected ENOSPC")
    await expect(Fs.lstat(NodePath.join(root, "packages/widget"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await temporaryEntries()).toEqual([])
  })

  it("publishes no partial package when the final rename fails", async () => {
    const result = await Effect.runPromise(Effect.flip(scaffold({
      workspaceRoot: root,
      packageName: "@smthrs/widget",
      io: { rename: () => Promise.reject(new Error("injected rename failure")) }
    }, payload)))

    expect(result.message).toContain("injected rename failure")
    await expect(Fs.lstat(NodePath.join(root, "packages/widget"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await temporaryEntries()).toEqual([])
  })

  it("reports both the primary failure and a failed temporary cleanup", async () => {
    const result = await Effect.runPromise(Effect.flip(scaffold({
      workspaceRoot: root,
      packageName: "@smthrs/widget",
      io: {
        writeFile: () => Promise.reject(new Error("injected write failure")),
        remove: () => Promise.reject(new Error("injected cleanup failure"))
      }
    }, payload)))

    expect(result.message).toContain("injected write failure")
    expect(result.message).toContain("injected cleanup failure")
    await expect(Fs.lstat(NodePath.join(root, "packages/widget"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await temporaryEntries()).toHaveLength(1)
  })

  it("allocates no temporary before injected I/O setup succeeds", async () => {
    const io = Object.defineProperty({}, "writeFile", {
      get: () => {
        throw new Error("injected I/O accessor failure")
      }
    })
    const result = await Effect.runPromise(Effect.flip(scaffold({
      workspaceRoot: root,
      packageName: "@smthrs/widget",
      io: io as never
    }, payload)))

    expect(result.message).toContain("injected I/O accessor failure")
    expect(await temporaryEntries()).toEqual([])
  })

  it("allows only one concurrent publication of the same package", async () => {
    const results = await Promise.allSettled([run("@smthrs/widget"), run("@smthrs/widget")])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await Fs.readdir(NodePath.join(root, "packages/widget"))).sort()).toEqual([
      "PACKAGE.ts",
      "README.md",
      "package.json",
      "src",
      "test",
      "tsconfig.json"
    ])
    expect(await temporaryEntries()).toEqual([])
  })

  it("refuses a linked scaffold parent", async () => {
    await Fs.mkdir(NodePath.join(root, "real-packages"))
    await Fs.symlink("real-packages", NodePath.join(root, "packages"), "dir")

    expect((await failure("@smthrs/widget")).message).toContain("not a real directory")
    expect(await Fs.readdir(NodePath.join(root, "real-packages"))).toEqual([])
  })

  it("renders the same tree every time, with no model in reach", () => {
    expect(boilerplate("@smthrs/widget", payload)).toEqual(boilerplate("@smthrs/widget", payload))
  })
})

describe("scaffold failure values", () => {
  it("reports cleanup failure when a dependency throws undefined", async () => {
    const result = await Effect.runPromise(Effect.flip(scaffold({
      workspaceRoot: root,
      packageName: "widget",
      io: {
        writeFile: () => Promise.reject(undefined),
        remove: () => Promise.reject(new Error("cleanup failed after undefined"))
      }
    }, payload)))
    expect(result.message).toBe("cleanup failed after undefined")
    expect(await temporaryEntries()).toHaveLength(1)
    await expect(Fs.lstat(NodePath.join(root, "packages/widget"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("scaffold directory fault boundary", () => {
  it("refuses a parent replaced with an escaping link after lstat", async () => {
    await Fs.mkdir(NodePath.join(root, "packages"))
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "scaffold-escape-"))
    try {
      const io = {
        ...Fs,
        join: NodePath.join,
        inside: SafeFs.inside,
        syncDirectory: SafeFs.syncDirectory,
        errorCode: SafeFs.errorCode,
        realpath: async (path: Parameters<typeof Fs.realpath>[0]) => {
          await Fs.rmdir(NodePath.join(root, "packages"))
          await Fs.symlink(outside, NodePath.join(root, "packages"), "dir")
          return Fs.realpath(path)
        }
      }
      await expect(ensureDirectory(root, "packages", io as never))
        .rejects.toThrow("package scaffold parent leaves the workspace")
      expect(await Fs.readdir(outside)).toEqual([])
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("ignores a stale temporary that disappears after enumeration", async () => {
    const temporary = NodePath.join(root, ".smthrs-scaffold-gone.tmp")
    await Fs.mkdir(temporary)
    let removed = false
    const io = {
      ...Fs,
      join: NodePath.join,
      inside: SafeFs.inside,
      syncDirectory: SafeFs.syncDirectory,
      errorCode: SafeFs.errorCode,
      lstat: async (path: Parameters<typeof Fs.lstat>[0]) => {
        await Fs.rmdir(temporary)
        return Fs.lstat(path)
      }
    }
    await reclaimStaleTemporaries(root, async () => {
      removed = true
    }, io as never)
    expect(removed).toBe(false)
    expect(await Fs.readdir(root)).toEqual([])
  })
})

it("plans a scaffold with the inferred workspace tsconfig", () => {
  const calls = plannedCalls(NewPackage({ license: "MIT" }))
  expect(calls[0]?.payload).not.toHaveProperty("tsconfigExtends")
})

it("preserves an already classified write failure", async () => {
  const original = new WriteFileError({ path: "generated", message: "classified failure" })
  const result = await Effect.runPromise(Effect.flip(scaffold({
    workspaceRoot: root,
    packageName: "widget",
    io: { writeFile: () => Promise.reject(original) }
  }, payload)))
  expect(result).toBe(original)
})

it("does not inspect a proxy payload after its accessor fails", async () => {
  const input = new Proxy(payload, {
    get: () => {
      throw new Error("payload unavailable")
    }
  })
  const result = await Effect.runPromise(Effect.flip(scaffold({ workspaceRoot: root, packageName: "widget" }, input)))
  expect(result.path).toBe("package")
  expect(result.message).toBe("payload unavailable")
})

it("uses a generic path when a payload directory is an accessor", async () => {
  const input = Object.defineProperty({ ...payload }, "directory", {
    get: () => {
      throw new Error("no directory")
    }
  })
  const result = await Effect.runPromise(Effect.flip(scaffold({ workspaceRoot: root, packageName: "widget" }, input)))
  expect(result.path).toBe("package")
  expect(result.message).toBe("no directory")
})

describe("scaffold template", () => {
  const templated = (template = "templates/package"): ScaffoldPayload => ({ ...payload, template })
  const writeTemplate = async (files: Readonly<Record<string, string>>, directory = "templates/package") => {
    for (const [relative, contents] of Object.entries(files)) {
      const path = NodePath.join(root, directory, relative)
      await Fs.mkdir(NodePath.dirname(path), { recursive: true })
      await Fs.writeFile(path, contents, "utf8")
    }
  }
  const scaffoldWith = (input: ScaffoldPayload, packageName = "@smthrs/my-widget") =>
    Effect.runPromise(scaffold({ workspaceRoot: root, packageName }, input))
  const templateFailure = (input: ScaffoldPayload) =>
    Effect.runPromise(Effect.flip(scaffold({ workspaceRoot: root, packageName: "@smthrs/my-widget" }, input)))
  const read = (relative: string) => Fs.readFile(NodePath.join(root, "packages/my-widget", relative), "utf8")

  it("writes template files with the package's name and paths filled in", async () => {
    await writeTemplate({
      "PACKAGE.ts.template": "// {{name}} at {{directory}} exports {{identifier}}\n",
      "scripts/build.mjs.template": "import \"../{{root}}/tools/build.mjs\"\n",
      "notes.md": "{{unknown}} stays; {{root}}\n"
    })
    const report = await scaffoldWith(templated())
    expect(await read("PACKAGE.ts")).toBe("// @smthrs/my-widget at packages/my-widget exports myWidget\n")
    expect(await read("scripts/build.mjs")).toBe("import \"../../../tools/build.mjs\"\n")
    expect(await read("notes.md")).toBe("{{unknown}} stays; ../..\n")
    expect(report.files).toEqual([
      "packages/my-widget/package.json",
      "packages/my-widget/tsconfig.json",
      "packages/my-widget/src/index.ts",
      "packages/my-widget/test/index.test.ts",
      "packages/my-widget/README.md",
      "packages/my-widget/PACKAGE.ts",
      "packages/my-widget/notes.md",
      "packages/my-widget/scripts/build.mjs"
    ])
    // The template's root resolves to the workspace root from the package.
    expect(NodePath.resolve(root, "packages/my-widget", "../..")).toBe(root)
  })

  it("replaces a boilerplate file the template also holds", async () => {
    await writeTemplate({ "tsconfig.json.template": "{ \"files\": [] }\n" })
    await scaffoldWith(templated())
    expect(await read("tsconfig.json")).toBe("{ \"files\": [] }\n")
  })

  it("merges a template manifest over the generated one and keeps the scaffold's identity", async () => {
    await writeTemplate({
      "package.json.template": JSON.stringify({
        name: "ignored",
        version: "9.9.9",
        private: true,
        scripts: { build: "node {{root}}/build.mjs" },
        devDependencies: { vitest: "5.0.0" },
        repository: { directory: "{{directory}}" }
      })
    })
    await scaffoldWith(templated())
    const manifest = JSON.parse(await read("package.json")) as Record<string, unknown>
    expect(manifest["name"]).toBe("@smthrs/my-widget")
    expect(manifest["version"]).toBe("0.1.0")
    expect(manifest["license"]).toBe("MIT")
    expect(manifest["private"]).toBe(true)
    expect(manifest["author"]).toBe("flows")
    expect(manifest["exports"]).toEqual({ "./package.json": "./package.json", ".": "./src/index.ts" })
    expect(manifest["scripts"]).toEqual({ ...PackageJsonTemplate.standardScripts, build: "node ../../build.mjs" })
    expect(manifest["devDependencies"]).toEqual({ vitest: "5.0.0" })
    expect(manifest["repository"]).toEqual({ directory: "packages/my-widget" })
  })

  it("refuses a template manifest that is not a JSON object, and publishes nothing", async () => {
    await writeTemplate({ "package.json": "{ not json" })
    expect((await templateFailure(templated())).message).toContain("template package.json is not JSON")
    await Fs.writeFile(NodePath.join(root, "templates/package/package.json"), "[]\n", "utf8")
    expect((await templateFailure(templated())).message).toContain("must hold a JSON object")
    await Fs.writeFile(NodePath.join(root, "templates/package/package.json"), "null\n", "utf8")
    expect((await templateFailure(templated())).message).toContain("must hold a JSON object")
    await expect(Fs.lstat(NodePath.join(root, "packages/my-widget"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a missing template directory instead of scaffolding without it", async () => {
    expect((await templateFailure(templated("templates/absent"))).message)
      .toContain("template templates/absent has no directory")
    await expect(Fs.lstat(NodePath.join(root, "packages"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a template that holds a symbolic link", async () => {
    await writeTemplate({ "README.md": "readme\n" })
    await Fs.writeFile(NodePath.join(root, "secret.txt"), "secret\n", "utf8")
    await Fs.symlink(NodePath.join(root, "secret.txt"), NodePath.join(root, "templates/package/secret.txt"))
    expect((await templateFailure(templated())).message).toContain("secret.txt, which is not a regular file")
    await expect(Fs.lstat(NodePath.join(root, "packages/my-widget"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a template directory that leaves the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "scaffold-template-outside-"))
    try {
      await Fs.writeFile(NodePath.join(outside, "PACKAGE.ts"), "outside\n", "utf8")
      await Fs.mkdir(NodePath.join(root, "templates"))
      await Fs.symlink(outside, NodePath.join(root, "templates/package"), "dir")
      expect((await templateFailure(templated())).message).toContain("has no directory")
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("plans the declared template into the scaffold payload", () => {
    const calls = plannedCalls(NewPackage({ license: "MIT", template: "templates/package" }))
    expect(calls[0]?.payload).toMatchObject({ template: "templates/package" })
  })
})
