import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { writeGeneratedFile } from "../src/GeneratedFile.ts"
import * as Input from "../src/Input.ts"
import { boilerplate, scaffold, type ScaffoldPayload, type ScaffoldReport } from "../src/NewPackage.ts"
import { matches, PackageDefaults } from "../src/PackageDefaults.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"

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
  engines: { node: ">=22.19.0" },
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
  it("creates a package a default target can pick up, with no PACKAGE.ts", async () => {
    const report = await run("@smthrs/widget")
    expect(report.directory).toBe("packages/widget")
    expect(report.files).toEqual([
      "packages/widget/package.json",
      "packages/widget/tsconfig.json",
      "packages/widget/src/index.ts",
      "packages/widget/test/index.test.ts",
      "packages/widget/README.md"
    ])
    expect(await Fs.readdir(NodePath.join(root, "packages/widget"))).not.toContain("PACKAGE.ts")
    const readme = await Fs.readFile(NodePath.join(root, "packages/widget/README.md"), "utf8")
    expect(readme).toContain("Created by `smthrs generate package @smthrs/widget`")
    expect(readme).toContain("This package has no `PACKAGE.ts`")
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
    expect(manifest["engines"]).toEqual({ node: ">=22.19.0" })
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
