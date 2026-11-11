/**
 * A package that declares its targets in `PACKAGE.vibe`, through the real
 * CLI: discovered, loaded through `vibelang/register`, and planned exactly
 * like a `PACKAGE.ts` package.
 */
import * as Fs from "node:fs/promises"
import { findPackageJSON } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const packageDirectory = (name: string): string => Path.dirname(findPackageJSON(name, import.meta.url)!)

type DeclarationFile = "PACKAGE.ts" | "PACKAGE.vibe"

/**
 * A workspace whose package declarations are all named `declaration`. The
 * source is valid as TypeScript and as VibeLang, so the two spellings are
 * twins. The project links the CLI's own installations, as a pnpm workspace
 * does, so the compiler resolves `@smthrs/targets` and the loader sees one
 * runtime.
 */
const fixture = async (declaration: DeclarationFile): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-vibe-package-")))
  roots.push(root)
  await Fs.mkdir(Path.join(root, "node_modules", "@smthrs"), { recursive: true })
  for (const name of ["effect", "vibelang", "vibelang-runtime", "@smthrs/targets"]) {
    await Fs.symlink(packageDirectory(name), Path.join(root, "node_modules", name), "dir")
  }
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true, type: "module" })}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  // The VibeLang compiler writes each module's declaration beside it.
  await write(root, ".gitignore", "node_modules\n*.d.vibe.ts\n")
  await write(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        noEmit: true
      },
      include: ["**/*.vibe"]
    })
  )
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await write(
    root,
    declaration,
    `import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: { srcs: S.Filegroup({ srcs: S.glob(["**/*.txt"]), summary: "Root sources" }) }
})
`
  )
  await write(
    root,
    `lib/${declaration}`,
    `import { Smithers as S } from "@smthrs/targets"
import { summary } from "./summary.vibe"

const srcs = S.Filegroup({ srcs: S.glob(["*.txt"]), summary })

export const Package = S.Package({
  targets: { srcs, test: S.Shell.Test({ shell: "test -f lib/input.txt", data: [srcs], sandbox: "none" }) }
})
`
  )
  await write(root, "lib/summary.vibe", "export const summary = \"Library sources\"\n")
  await write(root, "notes.txt", "root\n")
  await write(root, "lib/input.txt", "library\n")
  return root
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let output = ""
  let code = 0
  await makeCli({ cliName: "smthrs", cliVersion: "1.0.0-test" }).serve([...args, "--workspace", root, "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, output }
}

const labels = (output: string): ReadonlyArray<string> =>
  (JSON.parse(output) as { targets: ReadonlyArray<{ label: string }> }).targets.map((row) => row.label)

const explained = (output: string) =>
  JSON.parse(output) as {
    readonly inputs: ReadonlyArray<{ readonly files: ReadonlyArray<{ readonly path: string }> }>
    readonly cache: { readonly key: string }
  }

describe("a package declared in PACKAGE.vibe", () => {
  it("is listed, keeps its package boundary, and runs under ci", async () => {
    const root = await fixture("PACKAGE.vibe")
    const targets = await serve(root, ["targets"])
    expect(targets.code, targets.output).toBe(0)
    expect(labels(targets.output)).toEqual(["//:srcs", "//lib:srcs", "//lib:test"])
    expect(targets.output).toContain("Library sources")
    // The root glob stops at lib/, which PACKAGE.vibe makes its own package.
    const shown = await serve(root, ["explain", "//:srcs"])
    expect(shown.code, shown.output).toBe(0)
    expect(explained(shown.output).inputs.flatMap((input) => input.files.map((file) => file.path)))
      .toEqual(["notes.txt"])
    const ci = await serve(root, ["ci", "//..."])
    expect(ci.code, ci.output).toBe(0)
    expect(ci.output).toContain("//lib:test")
  })

  it.each<DeclarationFile>(["PACKAGE.vibe", "PACKAGE.ts"])(
    "reports a rejected declaration at its %s line",
    async (name) => {
      const root = await fixture(name)
      await write(
        root,
        `lib/${name}`,
        `import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: {
    test: S.Shell.Test({ shell: "" })
  }
})
`
      )
      const targets = await serve(root, ["targets"])
      expect(targets.code).not.toBe(0)
      expect(targets.output).toContain(`Shell.Test declaration at ${Path.join(root, "lib", name)}:5:`)
    }
  )

  it("plans the same labels and keys as its PACKAGE.ts twin", async () => {
    const vibe = await fixture("PACKAGE.vibe")
    const typescript = await fixture("PACKAGE.ts")
    const listed = await Promise.all([vibe, typescript].map((root) => serve(root, ["targets"])))
    expect(listed[0]!.output).toBe(listed[1]!.output)
    for (const label of ["//:srcs", "//lib:srcs", "//lib:test"]) {
      const [left, right] = await Promise.all([vibe, typescript].map((root) => serve(root, ["explain", label])))
      expect(left!.code, left!.output).toBe(0)
      expect(explained(left!.output).cache.key).toBe(explained(right!.output).cache.key)
    }
  })
})
