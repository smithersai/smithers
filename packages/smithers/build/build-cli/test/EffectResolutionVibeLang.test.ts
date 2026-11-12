import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { findPackageJSON } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Declaration modules (PACKAGE.ts, flows) import workspace packages, whose
// exports name their source; a migrated package's source is VibeLang. These
// run real processes: the resolver, tsx, and vibelang/register together.

const resolver = fileURLToPath(new URL("../src/effect-resolution.js", import.meta.url))
const register = fileURLToPath(import.meta.resolve("vibelang/register"))
const packageDirectory = (name: string) => Path.dirname(findPackageJSON(name, import.meta.url)!)

let root: string

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-declaration-vibelang-")))
})

afterAll(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const rules = [
  "import { suffix } from \"./helper.ts\"",
  "",
  "error Refused { reason: string }",
  "",
  "export effect function refuse(reason: string): never ! Refused {",
  "  throw new Refused({ reason })",
  "}",
  "",
  "export function shout(text: string): string {",
  "  return text.toUpperCase() + suffix",
  "}",
  ""
].join("\n")

// A project whose PACKAGE.ts imports a .vibe module, which imports a .ts one.
const project = async (files: Record<string, string> = {}, type: string | undefined = "module") => {
  const directory = await Fs.mkdtemp(Path.join(root, "project-"))
  const modules = Path.join(directory, "node_modules")
  await Fs.mkdir(modules)
  for (const name of ["effect", "vibelang", "vibelang-runtime"]) {
    await Fs.symlink(packageDirectory(name), Path.join(modules, name), "dir")
  }
  const contents: Record<string, string> = {
    "package.json": JSON.stringify(type === undefined ? {} : { type }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        noEmit: true
      },
      include: ["src/**/*"]
    }),
    "src/helper.ts": "export const suffix: string = \"!\"\n",
    "src/rules.vibe": rules,
    "PACKAGE.ts": [
      "import { Effect } from \"effect\"",
      "import { refuse, shout } from \"./src/rules.vibe\"",
      "const failure = Effect.runSync(Effect.flip(refuse(\"no\")))",
      "export const probe = { text: shout(\"hi\"), tag: failure._tag, stack: String(failure.stack) }",
      ""
    ].join("\n"),
    ...files
  }
  for (const [path, text] of Object.entries(contents)) {
    await Fs.mkdir(Path.dirname(Path.join(directory, path)), { recursive: true })
    await Fs.writeFile(Path.join(directory, path), text)
  }
  return directory
}

type Order = "resolver only" | "register first" | "register after"

const evaluate = (directory: string, order: Order, using: string = resolver) =>
  spawnSync(process.execPath, [
    "--enable-source-maps",
    "--input-type=module",
    "-e",
    `
    ${order === "register first" ? `await import(${JSON.stringify(pathToFileURL(register).href)});` : ""}
    const resolver = await import(${JSON.stringify(pathToFileURL(using).href)});
    resolver.installEffectResolution();
    ${order === "register after" ? `await import(${JSON.stringify(pathToFileURL(register).href)});` : ""}
    const module = await resolver.importDeclarationModule(
      ${JSON.stringify(pathToFileURL(Path.join(directory, "PACKAGE.ts")).href)},
      ${JSON.stringify(pathToFileURL(using).href)})
    console.log(JSON.stringify(module.probe));
  `
  ], {
    encoding: "utf8",
    cwd: directory,
    // The runner exports its own preloads (vibelang/register) through NODE_OPTIONS;
    // each case decides what the child loads, so the child inherits none of them.
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      VIBELANG_CACHE_DIR: Path.join(directory, ".cache"),
      VIBELANG_DISABLE_CACHE: ""
    },
    timeout: 60_000
  })

describe("VibeLang declaration dependencies", () => {
  it.each<[Order, string | undefined]>([
    ["resolver only", "module"],
    ["register first", "module"],
    ["register after", "module"],
    ["resolver only", undefined],
    ["register first", undefined],
    ["register after", undefined]
  ])("load through tsx's loader with %s, in a package of type %s", async (order, type) => {
    const child = evaluate(await project({}, type), order)
    expect(child.status, child.stdout + child.stderr).toBe(0)
    const probe = JSON.parse(child.stdout) as { text: string; tag: string; stack: string }
    expect(probe.text).toBe("HI!")
    expect(probe.tag).toBe("Refused")
    // A stack frame names the .vibe line that raised the failure.
    expect(probe.stack).toMatch(/rules\.vibe:6:/)
  })

  it("stop with the compiler's diagnostic when the .vibe module does not type-check", async () => {
    const directory = await project({
      "src/rules.vibe": rules.replace("return text.toUpperCase() + suffix", "return text.length")
    })
    const child = evaluate(directory, "resolver only")
    expect(child.status).not.toBe(0)
    expect(child.stderr).toMatch(/tsconfig\.json did not compile/)
    expect(child.stderr).toMatch(/rules\.vibe:10:\d+ - error TS2322: Type 'number' is not assignable to type 'string'/)
  })

  it("name the .vibe file when no VibeLang is installed where the resolver or the project can see it", async () => {
    // A resolver installed without VibeLang, in a project without it.
    const installation = await Fs.mkdtemp(Path.join(root, "installation-"))
    await Fs.mkdir(Path.join(installation, "src"))
    await Fs.writeFile(Path.join(installation, "package.json"), "{\"type\":\"module\"}")
    await Fs.copyFile(resolver, Path.join(installation, "src/effect-resolution.js"))
    for (const name of ["effect", "tsx"]) {
      await Fs.mkdir(Path.join(installation, "node_modules"), { recursive: true })
      await Fs.symlink(packageDirectory(name), Path.join(installation, "node_modules", name), "dir")
    }
    const directory = await project()
    await Fs.rm(Path.join(directory, "node_modules/vibelang"))
    const child = evaluate(directory, "resolver only", Path.join(installation, "src/effect-resolution.js"))
    expect(child.status).not.toBe(0)
    expect(child.stderr).toMatch(/ERR_UNKNOWN_FILE_EXTENSION/)
    expect(child.stderr).toContain(Path.join(directory, "src/rules.vibe"))
  })
})
