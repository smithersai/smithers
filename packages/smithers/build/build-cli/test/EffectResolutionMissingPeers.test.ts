/**
 * The resolver on hosts whose installation lacks a peer, run in real Node
 * children that load this package's own `src/effect-resolution.js`.
 *
 * `effect` is a required peer and `vibelang` an optional one, so an install
 * can lack either. A child cannot remove a package from this checkout, so it
 * registers a resolve hook, older than the resolver's, that answers the
 * installation's lookups for the missing peer the way Node does for a package
 * that is not there: `ERR_MODULE_NOT_FOUND`, or `MODULE_NOT_FOUND` under
 * `require`. Lookups from anywhere else still reach Node.
 */
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { findPackageJSON } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const resolver = new URL("../src/effect-resolution.js", import.meta.url).href
const installation = new URL("../", import.meta.url).href
const packageDirectory = (name: string) => Path.dirname(findPackageJSON(name, import.meta.url)!)

let root = ""

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-resolver-peers-")))
})

afterAll(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const project = async (files: Record<string, string>, links: ReadonlyArray<string> = []) => {
  const directory = await Fs.mkdtemp(Path.join(root, "project-"))
  for (const [path, text] of Object.entries({ "package.json": "{\"type\":\"module\"}", ...files })) {
    await Fs.mkdir(Path.dirname(Path.join(directory, path)), { recursive: true })
    await Fs.writeFile(Path.join(directory, path), text)
  }
  for (const name of links) {
    await Fs.mkdir(Path.join(directory, "node_modules"), { recursive: true })
    await Fs.symlink(packageDirectory(name), Path.join(directory, "node_modules", name), "dir")
  }
  return directory
}

/** Runs `script` after hiding `missing` from this installation; returns its last stdout line as JSON. */
const run = (directory: string, missing: ReadonlyArray<string>, script: string) => {
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { registerHooks } from "node:module";
    const missing = ${JSON.stringify(missing)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      const hidden = missing.some((name) => specifier === name || specifier.startsWith(name + "/"));
      if (hidden && context.parentURL?.startsWith(${JSON.stringify(installation)})) {
        const error = new Error("Cannot find package '" + specifier + "' imported from " + context.parentURL);
        error.code = context.conditions.includes("require") ? "MODULE_NOT_FOUND" : "ERR_MODULE_NOT_FOUND";
        throw error;
      }
      return nextResolve(specifier, context);
    }});
    const resolver = await import(${JSON.stringify(resolver)});
    ${script}
  `
  ], {
    encoding: "utf8",
    cwd: directory,
    // The runner's preloads (vibelang/register) would install what the case hides.
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", VIBELANG_CACHE_DIR: Path.join(directory, ".cache") },
    timeout: 60_000
  })
  expect(child.status, child.stdout + child.stderr).toBe(0)
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as unknown
}

describe("an installation without the effect peer", () => {
  it("still loads the resolver and evaluates a declaration that imports Effect by file URL", async () => {
    const schema = pathToFileURL(Path.join(packageDirectory("effect"), "dist/Schema.js")).href
    const directory = await project({
      "PACKAGE.ts": `import * as Schema from ${
        JSON.stringify(schema)
      }\nexport const kind: string = Schema.String.ast._tag\n`
    })
    const declared = run(
      directory,
      ["effect"],
      `
      resolver.installEffectResolution();
      const module = await resolver.importDeclarationModule(
        ${JSON.stringify(pathToFileURL(Path.join(directory, "PACKAGE.ts")).href)}, ${JSON.stringify(resolver)});
      console.log(JSON.stringify({ kind: module.kind }));
    `
    )
    expect(declared).toEqual({ kind: (await import("effect/Schema")).String.ast._tag })
  })
})

describe("an installation without the optional vibelang peer", () => {
  it("installs VibeLang from the project in the working directory", async () => {
    const directory = await project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          types: [],
          skipLibCheck: true,
          noEmit: true
        },
        include: ["src/**/*"]
      }),
      "src/rules.vibe": "export function shout(text: string): string {\n  return text.toUpperCase()\n}\n",
      "PACKAGE.ts": "import { shout } from \"./src/rules.vibe\"\nexport const text: string = shout(\"hi\")\n"
    }, ["vibelang", "vibelang-runtime"])
    const declared = run(
      directory,
      ["vibelang"],
      `
      resolver.installEffectResolution();
      const module = await resolver.importDeclarationModule(
        ${JSON.stringify(pathToFileURL(Path.join(directory, "PACKAGE.ts")).href)}, ${JSON.stringify(resolver)});
      console.log(JSON.stringify({ text: module.text }));
    `
    )
    expect(declared).toEqual({ text: "HI" })
  })
})

describe("a deferred installation", () => {
  it("leaves TypeScript to Node until an ordinary installation enables tsx", async () => {
    const directory = await project({
      "before.ts": "export const value: number = 1\n",
      "after.ts": "export const value: number = 2\n"
    })
    const formats = run(
      directory,
      [],
      `
      const formats = {};
      registerHooks({ load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (url.endsWith(".ts")) formats[url.slice(url.lastIndexOf("/") + 1)] = loaded.format;
        return loaded;
      }});
      resolver.installEffectResolution({}, { deferTypeScript: true });
      await import(${JSON.stringify(pathToFileURL(Path.join(directory, "before.ts")).href)});
      resolver.installEffectResolution();
      await import(${JSON.stringify(pathToFileURL(Path.join(directory, "after.ts")).href)});
      console.log(JSON.stringify(formats));
    `
    )
    expect(formats).toEqual({ "before.ts": "module-typescript", "after.ts": "module" })
  })
})
