import { execFile, spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import { findPackageJSON } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let root: string
const externalProjects: Array<string> = []

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-declaration-runtime-")))
  const source = Path.join(root, "src")
  await Fs.mkdir(source)
  await Fs.mkdir(Path.join(root, "dist/esm"), { recursive: true })
  await Fs.writeFile(Path.join(root, "package.json"), "{\"type\":\"module\"}")
  await Fs.copyFile(new URL("../src/effect-resolution.js", import.meta.url), Path.join(source, "effect-resolution.js"))
  for (const dependency of ["effect", "tsx"]) {
    const destination = Path.join(root, "node_modules", dependency)
    await Fs.mkdir(Path.dirname(destination), { recursive: true })
    await Fs.symlink(Path.dirname(findPackageJSON(dependency, import.meta.url)!), destination, "dir")
  }
  // Use the release compiler, including its actual import.meta transformation.
  const compiler = new URL("../../../scripts/compile-commonjs.mjs", import.meta.url).href
  const built = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { compileCommonJs } from ${JSON.stringify(compiler)};
    await compileCommonJs(${JSON.stringify(source)}, ${JSON.stringify(Path.join(root, "dist/cjs"))},
      ${JSON.stringify(Path.join(root, "dist/esm"))});
  `
  ], { encoding: "utf8", timeout: 30_000 })
  expect(built.status, built.stdout + built.stderr).toBe(0)
})

afterAll(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  for (const project of externalProjects) await Fs.rm(project, { recursive: true, force: true })
})

describe.each(["esm", "cjs"])("%s declaration runtime", (runtime) => {
  it.each(["legacy", "deferred"])(
    "preserves the first %s resolver when a different copy completes installation",
    async (installation) => {
      const project = await Fs.mkdtemp(Path.join(root, "first-owner-"))
      await Fs.writeFile(Path.join(project, "package.json"), "{\"type\":\"module\"}")
      const first = Path.join(project, "first")
      await Fs.mkdir(Path.join(first, "src"), { recursive: true })
      await Fs.mkdir(Path.join(first, "node_modules"))
      await Fs.writeFile(
        Path.join(first, "package.json"),
        JSON.stringify({ type: runtime === "cjs" ? "commonjs" : "module" })
      )
      // A real second Effect installation makes an ownership change observable.
      await Fs.cp(Path.dirname(findPackageJSON("effect", import.meta.url)!), Path.join(first, "node_modules/effect"), {
        recursive: true,
        dereference: true
      })
      await Fs.symlink(
        Path.dirname(findPackageJSON("tsx", import.meta.url)!),
        Path.join(first, "node_modules/tsx"),
        "dir"
      )
      const resolver = runtime === "cjs"
        ? Path.join(root, "dist/cjs/effect-resolution.js")
        : Path.join(root, "src/effect-resolution.js")
      const firstResolver = Path.join(first, "src/effect-resolution.js")
      await Fs.copyFile(resolver, firstResolver)
      for (const name of ["before.mjs", "after.mjs"]) {
        await Fs.writeFile(
          Path.join(project, name),
          "import { Schema } from \"effect\"; export default Schema.String;\n"
        )
      }
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import { createRequire, registerHooks } from "node:module";
        import { register } from "tsx/esm/api";
        const resolver = ${
          runtime === "cjs"
            ? `createRequire(import.meta.url)(${JSON.stringify(resolver)})`
            : `await import(${JSON.stringify(pathToFileURL(resolver).href)})`
        };
        ${
          installation === "deferred" ?
            `
        const first = ${
              runtime === "cjs"
                ? `createRequire(import.meta.url)(${JSON.stringify(firstResolver)})`
                : `await import(${JSON.stringify(pathToFileURL(firstResolver).href)})`
            };
        first.installEffectResolution({}, { deferTypeScript: true });
        ` :
            `
        // The previous installation protocol: real identity hooks and tsx,
        // with the original completion marker and no deferred activation.
        const hooks = { resolve(specifier, context, nextResolve) {
          return nextResolve(specifier, specifier === "effect" || specifier.startsWith("effect/")
            ? { ...context, parentURL: ${JSON.stringify(pathToFileURL(firstResolver).href)} } : context);
        }};
        register({ tsconfig: false });
        globalThis[Symbol.for("smthrs/effect-resolution-registration")] = registerHooks(hooks);
        Object.defineProperty(globalThis, Symbol.for("smthrs/effect-resolution-installed"), { value: true });
        `
        }
        const before = await import(${JSON.stringify(pathToFileURL(Path.join(project, "before.mjs")).href)});
        resolver.installEffectResolution();
        resolver.installEffectResolution({}, { deferTypeScript: true });
        resolver.installEffectResolution();
        const after = await import(${JSON.stringify(pathToFileURL(Path.join(project, "after.mjs")).href)});
        assert.equal(after.default, before.default, "the first resolver must keep Effect ownership");
        console.log(JSON.stringify({ same: true }));
      `
      ], { encoding: "utf8", cwd: project, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 })
      expect(child.status, child.stdout + child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({ same: true })
    }
  )

  it.each(["explicit", "declaration"])(
    "loads native bootstrap modules before %s loader promotion without changing Effect identity",
    async (promotion) => {
      const project = await Fs.mkdtemp(Path.join(root, "native-bootstrap-"))
      await Fs.writeFile(Path.join(project, "package.json"), "{\"type\":\"module\"}")
      const entry = Path.join(project, "native.ts")
      await Fs.writeFile(
        entry,
        "import { Schema } from \"effect\"; export const value: number = 42; export const schema = Schema.String;\n"
      )
      const declaration = Path.join(project, "PACKAGE.ts")
      await Fs.writeFile(declaration, "export { Schema } from \"effect\";\n")
      const bridge = Path.join(project, "bridge")
      await Fs.mkdir(bridge)
      await Fs.writeFile(Path.join(bridge, "package.json"), "{\"type\":\"commonjs\"}")
      await Fs.writeFile(Path.join(bridge, "helper.ts"), "export const answer: number = 43;\n")
      await Fs.writeFile(Path.join(bridge, "bridge.cjs"), "module.exports = require(\"./helper.js\");\n")
      const resolver = runtime === "cjs"
        ? Path.join(root, "dist/cjs/effect-resolution.js")
        : Path.join(root, "src/effect-resolution.js")
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import { createRequire, registerHooks } from "node:module";
        const require = createRequire(${JSON.stringify(resolver)});
        const resolver = ${
          runtime === "cjs"
            ? `require(${JSON.stringify(resolver)})`
            : `await import(${JSON.stringify(pathToFileURL(resolver).href)})`
        };
        resolver.installEffectResolution({}, { deferTypeScript: true });
        resolver.installEffectResolution({}, { deferTypeScript: true });
        const Schema = await import("effect/Schema");
        const entry = ${JSON.stringify(pathToFileURL(entry).href)};
        let format;
        const observer = registerHooks({ load(url, context, nextLoad) {
          const loaded = nextLoad(url, context);
          if (url === entry) format = loaded.format;
          return loaded;
        }});
        const native = await import(entry);
        observer.deregister();
        assert.equal(native.value, 42);
        assert.equal(native.schema, Schema.String);
        assert.equal(format, "module-typescript", "bootstrap must use Node's native TypeScript loader");
        ${promotion === "explicit" ? "resolver.installEffectResolution();" : ""}
        const declared = await resolver.importDeclarationModule(${JSON.stringify(pathToFileURL(declaration).href)},
          ${JSON.stringify(pathToFileURL(resolver).href)});
        assert.equal(declared.Schema.String, Schema.String);
        resolver.installEffectResolution({}, { deferTypeScript: true });
        assert.equal(createRequire(${JSON.stringify(Path.join(bridge, "bridge.cjs"))})("./bridge.cjs").answer, 43);
        console.log(JSON.stringify({ value: native.value, format }));
      `
      ], { encoding: "utf8", cwd: project, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 })
      expect(child.status, child.stdout + child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({ value: 42, format: "module-typescript" })
    }
  )

  it.each(["module", "commonjs", undefined])(
    "keeps schema identity and missing/default payload semantics with project type %s",
    async (type) => {
      const project = await Fs.mkdtemp(Path.join(root, "project-"))
      await Fs.writeFile(Path.join(project, "package.json"), JSON.stringify({ type }))
      const declaration = `
        import { Effect, Schema } from "effect";
        export const string = Schema.String;
        export const payload = Schema.Struct({ args: Schema.optionalKey(Schema.String) });
        export const defaults = Schema.Struct({ name: Schema.String.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("Ada"))) });
        export default payload;
      `
      for (
        const name of ["flow.ts", ".smithers-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1.ts"]
      ) {
        const target = name === "flow.ts" ? Path.join(project, "flows/probe/flow.ts") : Path.join(project, name)
        await Fs.mkdir(Path.dirname(target), { recursive: true })
        await Fs.writeFile(target, declaration)
      }
      const resolver = runtime === "cjs"
        ? Path.join(root, "dist/cjs/effect-resolution.js")
        : Path.join(root, "src/effect-resolution.js")
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import { createRequire } from "node:module";
        const require = createRequire(${JSON.stringify(resolver)});
        // Bootstrap loads part of Effect before installing declaration hooks.
        require("effect/Effect");
        const resolver = ${
          runtime === "cjs" ?
            `require(${JSON.stringify(resolver)})` :
            `await import(${JSON.stringify(pathToFileURL(resolver).href)})`
        };
        resolver.installEffectResolution();
        // Commands may load Schema afterwards. It must remain Effect's native
        // ESM instance, including SchemaAST's non-global missing-value symbols.
        const Schema = require("effect/Schema");
        for (const name of ["flows/probe/flow.ts", ".smithers-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1.ts"]) {
          const url = new URL(name, ${JSON.stringify(pathToFileURL(project + Path.sep).href)});
          // Repeat after namespace registration; the bridge must not recreate
          // Effect's private missing-value/default sentinels either.
          for (const loaded of [await import(url), await resolver.importDeclarationModule(url.href,
            ${JSON.stringify(pathToFileURL(resolver).href)})]) {
          assert.equal(loaded.string, Schema.String);
          assert.equal(loaded.default, loaded.payload);
          assert.deepEqual(Schema.decodeUnknownSync(loaded.payload)({}), {});
          assert.deepEqual(Schema.decodeUnknownSync(loaded.payload)({ args: "café 🦊" }), { args: "café 🦊" });
          assert.deepEqual(Schema.encodeSync(loaded.payload)({}), {});
          assert.deepEqual(Schema.decodeUnknownSync(loaded.defaults)({}), { name: "Ada" });
          assert.throws(() => Schema.decodeUnknownSync(loaded.payload)({ args: 7 }));
          }
        }
        console.log(JSON.stringify({ checked: 2 }));
      `
      ], {
        encoding: "utf8",
        cwd: project,
        env: { ...process.env, NODE_PATH: "" },
        timeout: 30_000
      })
      expect(child.status, child.stdout + child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({ checked: 2 })
    }
  )

  it("keeps builtin requires native inside a namespaced CommonJS declaration dependency", async () => {
    const project = await Fs.mkdtemp(Path.join(root, "builtin-"))
    await Fs.writeFile(Path.join(project, "package.json"), "{\"type\":\"module\"}")
    await Fs.writeFile(
      Path.join(project, "helper.cjs"),
      `
      const fs = require("fs");
      const nodeFs = require("node:fs");
      const promises = require("fs/promises");
      const nodePromises = require("node:fs/promises");
      const path = require("path");
      const nodePath = require("node:path");
      module.exports = { same: fs === nodeFs && promises === nodePromises && path === nodePath,
        text: fs.readFileSync(__filename, "utf8"), base: path.basename(__filename) };
    `
    )
    const entry = Path.join(project, "main.ts")
    await Fs.writeFile(
      entry,
      `
      import helper from "./helper.cjs";
      globalThis[Symbol.for("smthrs/builtin-regression")] = {
        ...helper
      };
    `
    )
    const resolver = runtime === "cjs"
      ? Path.join(root, "dist/cjs/effect-resolution.js")
      : Path.join(root, "src/effect-resolution.js")
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const resolver = ${
        runtime === "cjs" ?
          `createRequire(import.meta.url)(${JSON.stringify(resolver)})` :
          `await import(${JSON.stringify(pathToFileURL(resolver).href)})`
      };
      await resolver.importDeclarationModule(${JSON.stringify(pathToFileURL(entry).href)},
        ${JSON.stringify(pathToFileURL(resolver).href)});
      const loaded = globalThis[Symbol.for("smthrs/builtin-regression")];
      assert.equal(loaded.same, true);
      assert.equal(loaded.base, "helper.cjs");
      assert.match(loaded.text, /require\\("node:fs"\\)/);
    `
    ], { encoding: "utf8", cwd: project, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 })
    expect(child.status, child.stdout + child.stderr).toBe(0)
  })

  it("retains typed CommonJS bridges and NodeNext sibling resolution", async () => {
    const project = await Fs.mkdtemp(Path.join(root, "bridge-"))
    await Fs.writeFile(Path.join(project, "package.json"), "{\"type\":\"commonjs\"}")
    await Fs.writeFile(Path.join(project, "answer.cts"), "const answer: number = 42; module.exports = { answer };\n")
    await Fs.writeFile(Path.join(project, "helper.ts"), "export const answer: number = 43;\n")
    await Fs.writeFile(Path.join(project, "bridge.cjs"), "module.exports = require(\"./helper.js\");\n")
    const resolver = runtime === "cjs"
      ? Path.join(root, "dist/cjs/effect-resolution.js")
      : Path.join(root, "src/effect-resolution.js")
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const resolver = ${
        runtime === "cjs" ?
          `createRequire(import.meta.url)(${JSON.stringify(resolver)})` :
          `await import(${JSON.stringify(pathToFileURL(resolver).href)})`
      };
      resolver.installEffectResolution();
      await resolver.importDeclarationModule(${JSON.stringify(pathToFileURL(Path.join(project, "answer.cts")).href)},
        ${JSON.stringify(pathToFileURL(resolver).href)});
      const require = createRequire(${JSON.stringify(Path.join(project, "bridge.cjs"))});
      const typed = await import(${JSON.stringify(pathToFileURL(Path.join(project, "answer.cts")).href)});
      assert.deepEqual(typed.default, { answer: 42 });
      assert.equal(require("./bridge.cjs").answer, 43);
    `
    ], { encoding: "utf8", cwd: project, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 })
    expect(child.status, child.stdout + child.stderr).toBe(0)
  })

  it.each(["./leaf.js", "./lib", "./lib/"])(
    "bootstraps transitive typed declaration helper %s with the same Effect schema runtime",
    async (helper) => {
      const project = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-bootstrap-helper-")))
      externalProjects.push(project)
      // No project node_modules: only the runtime owns the declaration packages.
      await Fs.writeFile(Path.join(project, "package.json"), "{\"type\":\"commonjs\"}")
      const directory = Path.join(project, "flows/probe")
      await Fs.mkdir(directory, { recursive: true })
      await Fs.writeFile(
        Path.join(directory, "leaf.ts"),
        `import { Schema } from "effect";
      export const string = Schema.String; export const payload = Schema.Struct({ args: Schema.optionalKey(Schema.String) });`
      )
      await Fs.mkdir(Path.join(directory, "lib"))
      await Fs.copyFile(Path.join(directory, "leaf.ts"), Path.join(directory, "lib/index.ts"))
      await Fs.writeFile(
        Path.join(directory, "helper.ts"),
        `export { string, payload } from ${JSON.stringify(helper)};`
      )
      const entry = Path.join(directory, "flow.ts")
      await Fs.writeFile(entry, `export { string, payload } from "./helper.js";`)
      const resolver = runtime === "cjs"
        ? Path.join(root, "dist/cjs/effect-resolution.js")
        : Path.join(root, "src/effect-resolution.js")
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const require = createRequire(${JSON.stringify(resolver)});
      const resolver = ${
          runtime === "cjs"
            ? `require(${JSON.stringify(resolver)})`
            : `await import(${JSON.stringify(pathToFileURL(resolver).href)})`
        };
      resolver.installEffectResolution();
      const Schema = require("effect/Schema");
      for (const loaded of [await resolver.importDeclarationModule(${JSON.stringify(pathToFileURL(entry).href)}, ${
          JSON.stringify(pathToFileURL(resolver).href)
        }),
        await import(${JSON.stringify(pathToFileURL(entry).href)})]) {
        assert.equal(loaded.string, Schema.String);
        assert.deepEqual(Schema.decodeUnknownSync(loaded.payload)({}), {});
        assert.deepEqual(Schema.decodeUnknownSync(loaded.payload)({ args: "café 🦊" }), { args: "café 🦊" });
      }
    `
      ], { encoding: "utf8", cwd: project, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000 })
      expect(child.error, child.stdout + child.stderr).toBeUndefined()
      expect(child.signal, child.stdout + child.stderr).toBeNull()
      expect(child.status, child.stdout + child.stderr).toBe(0)
    }
  )
})

it("discovers the real workspace target catalog through the public source CLI", async ({ signal }) => {
  const repo = new URL("../../../../../", import.meta.url)
  const bin = new URL("../../../bin/smithers.mjs", import.meta.url)
  // The test's own timeout bounds the CLI through `signal`. The command takes
  // 8 to 16 s alone on 4 vCPUs; a fixed 30 s cap ran out under the release
  // gates job's load (dry run 43293593020). A failed exit rejects with its output.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(bin), "targets", "--workspace", fileURLToPath(repo)],
    { cwd: repo, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal }
  )
  expect(stdout).toContain("//:targetIndex")
})
