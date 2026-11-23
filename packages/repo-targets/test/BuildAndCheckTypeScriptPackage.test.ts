import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import type * as Dprint from "@smthrs/targets/Dprint"
import type * as EsLint from "@smthrs/targets/EsLint"
import * as Filegroup from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import * as NodeTest from "@smthrs/targets/NodeTest"
import * as Target from "@smthrs/targets/Target"
import * as TsBuild from "@smthrs/targets/TsBuild"
import type * as Typecheck from "@smthrs/targets/Typecheck"
import type * as Vitest from "@smthrs/targets/Vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { globSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Package as PluginPackage } from "../../smithers/agent/plugin/PACKAGE.ts"
import { Package as RegistryPackage } from "../../smithers/agent/registry/PACKAGE.ts"
import * as Discovery from "../../smithers/agent/registry/src/Discovery.ts"
import { inputPackage } from "../../smithers/build/build-cli/src/internal/InputPackage.ts"
import { Package as StepCachePackage } from "../../smithers/flows/step-cache/PACKAGE.ts"
import { BuildAndCheckTypeScriptPackage } from "../src/BuildAndCheckTypeScriptPackage.ts"
import { WorkspaceSources } from "../src/WorkspaceSources.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

const context: Target.ImplementationContext = { sourceFile: undefined, packageDirectory: undefined }

describe("BuildAndCheckTypeScriptPackage docsFiles", () => {
  const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("emits a Filegroup over the package's documentation beside the verb targets", () => {
    const metadata = Target.metadata(targets.docsFiles)
    expect(metadata.target).toBe("Filegroup")
    expect(metadata.kinds).toEqual([])
    expect(Filegroup.isFilegroup(targets.docsFiles)).toBe(true)
  })

  it("names the colocated docs, the README, and the manifest under the package cwd", () => {
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs, context)).toEqual([
      { base: "", source: Input.glob("packages/smithers/flows/plan/docs/**/*.md") },
      { base: "", source: Input.file("packages/smithers/flows/plan/README.md") },
      { base: "", source: Input.file("packages/smithers/flows/plan/package.json") }
    ])
  })

  it("follows a readme override", () => {
    const overridden = BuildAndCheckTypeScriptPackage({
      packageManager,
      deps: [],
      cwd: "packages/x",
      readme: { _tag: "File", path: "docs/README.md" }
    })
    expect(Filegroup.sources(Target.metadata(overridden.docsFiles).attrs as Filegroup.Attrs, context)).toContainEqual(
      { base: "", source: Input.file("packages/x/docs/README.md") }
    )
  })
})

const attrsOf = <A>(target: Target.AnyTarget): A => Target.metadata(target).attrs as A

describe("BuildAndCheckTypeScriptPackage leaves the manager to the workspace", () => {
  it("every emitted target declares none and expects one filled in", () => {
    const standard = BuildAndCheckTypeScriptPackage({ cwd: "packages/example" })
    for (const target of [standard.lib, standard.check, standard.test, standard.lint, standard.fmt]) {
      const metadata = Target.metadata(target)
      expect((metadata.attrs as { readonly packageManager?: unknown }).packageManager).toBeUndefined()
      expect([...metadata.workspaceAttrs]).toContain("packageManager")
    }
    expect((Target.metadata(standard.circular).attrs as { readonly runtime?: unknown }).runtime).toBeUndefined()
    expect([...Target.metadata(standard.circular).workspaceAttrs]).toEqual(["runtime"])
  })

  it("a caller that names a manager still gets it", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(standard.check)).toEqual([
      "pnpm",
      "exec",
      "vibelang",
      "-p",
      "tsconfig.test.json",
      "--noEmit"
    ])
  })
})

describe("BuildAndCheckTypeScriptPackage reads VibeLang sources by default", () => {
  const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })

  it("keys check and test on the package's .vibe sources and tests beside its TypeScript", () => {
    expect(attrsOf<Typecheck.Attrs>(standard.check).srcs.slice(0, 2)).toEqual([
      Input.glob("src/**/*.{ts,vibe}"),
      Input.glob("test/**/*.{ts,vibe}")
    ])
    expect(attrsOf<Vitest.Attrs>(standard.test).tests).toEqual([Input.glob("test/**/*.test.{ts,vibe}")])
  })
})

describe("BuildAndCheckTypeScriptPackage circular guard", () => {
  /**
   * `pnpm run circular` fanned out to a per-package script the target graph did
   * not know about, so `smithers-build ci` was not gate-equivalent to the pnpm scripts
   * it was meant to replace. The macro emits it now.
   */
  it("emits the repository's shared circular-dependency guard for the package", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/smithers/flows/plan" })
    const attrs = attrsOf<NodeTest.Attrs>(targets.circular)
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "../../../repo-targets/scripts/circular.mjs"])
    expect(attrs.cwd).toBe("packages/smithers/flows/plan")
    // The interpreter is the one the declared manager runs under, not a
    // hardcoded `node`.
    expect(attrs.runtime).toEqual(packageManager.runtime)
  })

  it("takes another guard when a package keeps one elsewhere", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/smithers/flows/plan",
      circularScript: Input.file("tools/cycles.mjs")
    })
    expect(NodeTest.runArgv(attrsOf<NodeTest.Attrs>(targets.circular)))
      .toEqual(["node", "tools/cycles.mjs"])
  })
})

describe("BuildAndCheckTypeScriptPackage lib", () => {
  it("builds the dual distribution the published manifests describe", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const metadata = Target.metadata(targets.lib)
    expect(metadata.attrs).toMatchObject({
      format: "dual",
      outDir: "dist",
      tool: { name: "program", entry: { _tag: "File", path: "scripts/build.mjs" } }
    })
    expect(metadata.outputs).toEqual({ cwd: "packages/example", paths: ["dist/esm", "dist/cjs"] })
  })

  it("takes another build program without replacing the macro", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      buildProgram: Input.file("scripts/dist.mjs")
    })
    expect(Target.metadata(targets.lib).attrs).toMatchObject({
      tool: { name: "program", entry: { _tag: "File", path: "scripts/dist.mjs" } }
    })
  })
})

describe("BuildAndCheckTypeScriptPackage", () => {
  const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("changes only the outer test deadline when a package needs a larger suite budget", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const extended = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      testTimeoutMs: 2_400_000
    })
    expect(plannedCalls(standard.test)[0]?.payload).toMatchObject({ timeoutMs: 1_200_000 })
    expect(plannedCalls(extended.test)[0]?.payload).toMatchObject({ timeoutMs: 2_400_000 })
    expect(plannedArgv(extended.test)).toEqual(plannedArgv(standard.test))
    expect(Target.metadata(extended.test).attrs).toEqual({
      ...attrsOf<Vitest.Attrs>(standard.test),
      timeoutMs: 2_400_000
    })
  })

  it("names the programs the suite starts on the test target alone", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const tools = [{ _tag: "HostBin", name: "zig" }, { _tag: "HostBin", name: "strace" }] as const
    const declared = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example", testTools: tools })
    expect(attrsOf<Vitest.Attrs>(standard.test).tools).toBeUndefined()
    expect(Target.metadata(declared.test).attrs).toEqual({ ...attrsOf<Vitest.Attrs>(standard.test), tools })
    expect(plannedArgv(declared.test)).toEqual(plannedArgv(standard.test))
    expect(Target.metadata(declared.check).attrs).toEqual(Target.metadata(standard.check).attrs)
  })

  it("makes the suite alone wait for the targets it names", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const warm = Filegroup.Filegroup({ srcs: [Input.file("warm.txt")], cwd: "packages/example" })
    const declared = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example", testDeps: [warm] })
    expect(Target.metadata(declared.test).dependencies).toEqual([...Target.metadata(standard.test).dependencies, warm])
    expect(Target.metadata(declared.lint).dependencies).toEqual(Target.metadata(standard.lint).dependencies)
  })

  it("gives the suite the variables it declares, on the test target alone", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const env = { ZIG_GLOBAL_CACHE_DIR: "{smthrs:cache-directory}/tools/zig/global" }
    const declared = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example", testEnv: env })
    expect(Target.metadata(declared.test).attrs).toEqual({ ...attrsOf<Vitest.Attrs>(standard.test), env })
    expect(Target.metadata(declared.lint).attrs).toEqual(Target.metadata(standard.lint).attrs)
  })

  it("emits a docs target beside lib, test, and lint", () => {
    expect(Target.metadata(targets.docs).target).toBe("DocsParity")
    expect(Target.metadata(targets.docs).kinds).toEqual(["docs"])
  })

  it("holds declared page examples to their sources and compiles and runs them under docs", () => {
    const example = {
      page: Input.file("docs/quickstart.md"),
      example: Input.file("examples/quickstart.vibe"),
      test: Input.file("test/quickstart.test.vibe")
    }
    const withExamples = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/errors", examples: [example] })
    expect(attrsOf<{ readonly examples: unknown }>(withExamples.docs).examples).toEqual([example])
    expect(Target.metadata(withExamples.docs).dependencies).toEqual([withExamples.check, withExamples.test])
    expect(attrsOf<{ readonly examples: unknown }>(targets.docs).examples).toEqual([])
  })

  it("keeps docs as a separately planned target kind", () => {
    for (const target of [targets.lib, targets.test, targets.lint]) {
      expect(Target.metadata(target).kinds).not.toContain("docs")
    }
  })

  it("requires cwd, since every default input is package-shaped", () => {
    expectTypeOf(() =>
      // @ts-expect-error cwd is required.
      BuildAndCheckTypeScriptPackage({ packageManager })
    ).toBeFunction()
  })

  it("roots an explicit '.' cwd at the workspace and explicitly disables a config when asked", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: ".", vitestConfig: null })
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs, context)).toEqual([
      { base: "", source: Input.glob("docs/**/*.md") },
      { base: "", source: Input.file("README.md") },
      { base: "", source: Input.file("package.json") }
    ])
    expect(plannedArgv(targets.test)).toEqual(["pnpm", "exec", "vitest", "run", "--environment", "node"])
  })

  it("runs the explicitly selected Vitest config from the declaring package", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      vitestConfig: Input.file("config/coverage.ts")
    })
    expect(Target.metadata(targets.test).attrs).toMatchObject({ cwd: "packages/example" })
    expect(plannedArgv(targets.test)).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "config/coverage.ts",
      "--environment",
      "node"
    ])
  })
})

describe("package formatting", () => {
  it("joins BuildAndCheckTypeScriptPackage as the fmt target alongside check", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(Target.metadata(targets.fmt).target).toBe("Dprint")
    expect(Target.metadata(targets.fmt).kinds).toEqual(["lint"])
    expect(Target.metadata(targets.check).target).toBe("Typecheck")
    expect(Target.metadata(targets.check).kinds).toEqual(["build"])
    // check resolves workspace dependencies through built declarations, so
    // it must schedule after the package's own lib target.
    expect(Target.metadata(targets.check).dependencies).toContain(targets.lib)
  })
})

describe("BuildAndCheckTypeScriptPackage test data", () => {
  it("adds optional data globs to test inputs without changing the runner or other targets", () => {
    const options = {
      packageManager,
      cwd: "packages/example",
      testData: ["test/fixtures/*.mjs", "test/fixtures/*.cjs"] as const
    }
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: options.cwd })
    const withData = BuildAndCheckTypeScriptPackage(options)
    expect(Target.metadata(withData.test).inputs).toEqual([
      ...Target.metadata(standard.test).inputs.slice(0, 12),
      Input.glob("test/fixtures/*.mjs"),
      Input.glob("test/fixtures/*.cjs"),
      ...Target.metadata(standard.test).inputs.slice(12)
    ])
    expect(plannedArgv(withData.test)).toEqual(plannedArgv(standard.test))
    for (const name of ["lib", "check", "lint", "fmt", "docs", "circular", "docsFiles"] as const) {
      expect(Target.metadata(withData[name]).inputs).toEqual(Target.metadata(standard[name]).inputs)
    }
    const empty = BuildAndCheckTypeScriptPackage({ ...options, testData: [] })
    expect(Target.metadata(empty.test).inputs).toEqual(Target.metadata(standard.test).inputs)
  })

  /** Every package-relative file a test target's inputs name, with its globs expanded against the checkout. */
  const declaredInputs = (test: Target.AnyTarget): ReadonlyArray<string> => {
    const cwd = resolve(import.meta.dirname, "../../..", attrsOf<{ readonly cwd: string }>(test).cwd)
    return Target.metadata(test).inputs.flatMap((input) => {
      if (input._tag === "Glob") return globSync(input.pattern, { cwd, exclude: [...input.exclude] })
      if (input._tag === "File") return [input.path]
      return []
    }).map((path) => path.replaceAll("\\", "/"))
  }

  it("declares both artifact fixtures executed by the plugin suite", () => {
    const paths = declaredInputs(PluginPackage.test)
    expect(paths).toContain("test/fixtures/artifact-esm.mjs")
    expect(paths).toContain("test/fixtures/artifact-cjs.cjs")
  })

  /** Expands the registry's real test and filegroup inputs with package-scoped glob semantics. */
  const registryInputs = async (): Promise<ReadonlySet<string>> => {
    const root = resolve(import.meta.dirname, "../../..")
    const registry = "packages/smithers/agent/registry"
    const paths = new Set<string>()
    const visit = async (target: Target.AnyTarget): Promise<void> => {
      const metadata = Target.metadata(target)
      const anchor = inputPackage(metadata, registry)
      for (const input of metadata.inputs) {
        if (input._tag === "File") paths.add(Input.resolvePath(anchor, input.path))
        if (input._tag === "Glob") {
          for (const path of await Input.expandGlob(root, anchor, input)) paths.add(path)
        }
      }
      for (const dependency of metadata.dependencies) {
        if (Filegroup.isFilegroup(dependency)) await visit(dependency)
      }
    }
    await visit(RegistryPackage.test)
    return paths
  }

  it("keys the registry suite on executable, markdown, JSON, and hidden-directory fixtures", async () => {
    const paths = await registryInputs()
    for (
      const fixture of [
        "mdx-runner.mjs",
        "artifact-cjs.cjs",
        "mdx/prompt.mdx",
        "mdx/settings.json",
        "mdx/package.json",
        "foreign/template-skill/SKILL.md",
        "foreign/review/SKILL.md",
        "foreign/pdf/SKILL.md",
        "project/flows/review/flow.mdx",
        "project/flows/hidden/flow.mdx",
        "project/flows/broken/flow.mdx",
        "project/flows/changelog/flow.mdx",
        "executable/.smithers/flows/changelog/flow.mdx",
        "executable/modules/plain.mjs",
        "executable/modules/rev#2/plain.mjs"
      ]
    ) expect(paths.has(`packages/smithers/agent/registry/test/fixtures/${fixture}`), fixture).toBe(true)
  })

  it("keys the registry suite on the discovered production issue-sweep import closure", async () => {
    const paths = await registryInputs()
    const root = resolve(import.meta.dirname, "../../..")
    const modules = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const scan = yield* Discovery.make(fs, path).scan({
          source: "project",
          root: resolve(root, ".smithers/flows/issue-sweep"),
          naming: "frontmatter"
        })
        const body = scan.entries.find((entry) => entry.name === "issue-sweep")?.body
        expect(body?._tag).toBe("Module")
        if (body?._tag !== "Module") throw new Error("Expected the production issue-sweep module")
        return [
          body.path,
          ...(body.imports ?? []).map((module) => {
            expect(module.contentDigest, module.path).toBeDefined()
            return resolve(dirname(body.path), module.path)
          })
        ].map((module) => relative(root, module).replaceAll("\\", "/"))
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
    )
    expect(modules).toContain(".smithers/flows/coding/clip.ts")
    for (const module of modules) expect(paths.has(module), module).toBe(true)
  })

  it("declares the docs and fixtures the step-cache suite reads", () => {
    // Three suites assert on the text of the README and the docs, and one
    // executes the artifact fixtures. A file a suite reads that is not an
    // input lets a cached pass survive an edit to it.
    const paths = declaredInputs(StepCachePackage.test)
    for (
      const read of [
        "README.md",
        "docs/troubleshooting.md",
        "docs/concepts/admission.md",
        "docs/concepts/tiers.md",
        "docs/guides/implement-a-shared-tier.md",
        "docs/guides/share-results-across-machines.md",
        "test/fixtures/artifact-esm.mjs",
        "test/fixtures/artifact-cjs.cjs"
      ]
    ) expect(paths).toContain(read)
  })
})

describe("BuildAndCheckTypeScriptPackage dependencies", () => {
  const upstream = Filegroup.Filegroup({
    srcs: [Input.file("package.json")],
    cwd: "packages/upstream"
  })
  const second = Filegroup.Filegroup({
    srcs: [Input.file("package.json")],
    cwd: "packages/second"
  })

  /**
   * A package's declared dependencies are what makes `smithers-build ci`
   * order one package's build after the packages it imports. `check` and
   * `test` additionally read the package's own built declarations, so each
   * carries its own `lib` ahead of the caller's list.
   */
  it("hands every declared dependency to lib, check, and test, each behind its own lib", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      deps: [upstream, second]
    })
    expect(Target.metadata(targets.lib).dependencies).toEqual([upstream, second])
    expect(Target.metadata(targets.check).dependencies).toEqual([targets.lib, upstream, second])
    expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib, upstream, second])
    // The gates read the working tree, not a built dependency, so a declared
    // dependency must not serialize them behind a build.
    for (const name of ["lint", "fmt", "docs", "circular", "docsFiles"] as const) {
      expect(Target.metadata(targets[name]).dependencies).toEqual([])
    }
  })

  /**
   * The sources of other workspace packages are what a build, a test, a
   * type-check and a lint read; a format check and the docs do not.
   */
  it("hands the file groups it reads to lib, check, test and lint, and to nothing else", () => {
    const group = Filegroup.Filegroup({ srcs: [Input.glob("src/**")], cwd: "packages/other" })
    for (const testProgram of [undefined, Input.file("test/run.mjs")]) {
      const targets = BuildAndCheckTypeScriptPackage({
        packageManager,
        cwd: "packages/example",
        deps: [upstream],
        reads: [group],
        ...(testProgram === undefined ? {} : { testProgram })
      })
      expect(Target.metadata(targets.lib).dependencies).toEqual([upstream, group])
      expect(Target.metadata(targets.check).dependencies).toEqual([targets.lib, upstream, group])
      expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib, upstream, group])
      expect(Target.metadata(targets.lint).dependencies).toEqual([group])
      for (const name of ["fmt", "docs", "circular", "docsFiles"] as const) {
        expect(Target.metadata(targets[name]).dependencies).toEqual([])
      }
    }
  })

  /**
   * The keys package imports `@smthrs/canonical` and `@smthrs/crypto` and
   * declared neither, so a confined lint could not resolve them and every
   * result went unstored ("it passed, but failed when confined to its
   * declared inputs", release run 44825537152). Omitted, `reads` is the
   * package's own WorkspaceSources.
   */
  it("reads the workspace packages a member's manifest reaches when it names no reads", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/keys" })
    const expected = Object.values(WorkspaceSources({ cwd: "packages/smithers/flows/keys" }))
    const reached = (target: Target.AnyTarget) =>
      Target.metadata(target).dependencies.filter(Filegroup.isFilegroup).map((group) => Target.metadata(group).attrs)
    expect(expected.map((group) => (Target.metadata(group).attrs as { readonly cwd: string }).cwd))
      .toEqual(["packages/fuzz", "packages/smithers/flows/canonical", "packages/smithers/flows/crypto"])
    for (const name of ["lib", "check", "test", "lint"] as const) {
      expect(reached(targets[name])).toEqual(expected.map((group) => Target.metadata(group).attrs))
    }
    for (const name of ["fmt", "docs", "circular", "docsFiles"] as const) {
      expect(Target.metadata(targets[name]).dependencies).toEqual([])
    }
  })

  it("keeps the reads a member names, an empty list included", () => {
    const group = Filegroup.Filegroup({ srcs: [Input.glob("src/**")], cwd: "packages/other" })
    const named = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/smithers/flows/keys",
      reads: [group]
    })
    expect(Target.metadata(named.lint).dependencies).toEqual([group])
    const none = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/smithers/flows/keys", reads: [] })
    expect(Target.metadata(none.lint).dependencies).toEqual([])
  })

  it("reads nothing for a directory that is no workspace package", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(Target.metadata(targets.lint).dependencies).toEqual([])
    expect(Target.metadata(targets.lib).dependencies).toEqual([])
  })

  it("runs a suite in parts as one exclusive Suite over a Vitest per part config", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      testParts: {
        testCli: { config: Input.file("vitest.cli.config.ts") },
        testRest: { config: Input.file("vitest.rest.config.ts") }
      }
    })
    expect(Object.keys(targets.testParts)).toEqual(["testCli", "testRest"])
    expect(Target.metadata(targets.testParts["testCli"]!).target).toBe("Vitest")
    expect(attrsOf<Vitest.Attrs>(targets.testParts["testCli"]!).config).toEqual(Input.file("vitest.cli.config.ts"))
    expect(Target.metadata(targets.test).dependencies).toEqual([
      targets.testParts["testCli"],
      targets.testParts["testRest"]
    ])
  })

  it("runs the suite only on the hosts a package names, and on every host otherwise", () => {
    const linux = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example", testHosts: ["linux"] })
    expect(attrsOf<Vitest.Attrs>(linux.test).hosts).toEqual(["linux"])
    const every = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(attrsOf<Vitest.Attrs>(every.test).hosts).toBeUndefined()
  })

  it("keeps the self-lib edges when a package declares no dependencies", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/example" })
    expect(Target.metadata(targets.lib).dependencies).toEqual([])
    expect(Target.metadata(targets.check).dependencies).toEqual([targets.lib])
    expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib])
  })
})

describe("BuildAndCheckTypeScriptPackage lint and fmt gates", () => {
  /**
   * Both targets are gates rather than fixers: CI fails on a warning and the
   * working tree is never rewritten under them. Asserting the planned argv
   * rather than the target kind is what holds that, since raising the warning
   * budget or enabling fix changes only the argv.
   */
  it("plans ESLint over the sources at zero warnings without fixing", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(targets.lint)).toEqual([
      "pnpm",
      "exec",
      "eslint",
      "--config",
      "eslint.config.js",
      "--max-warnings",
      "0",
      "src/**/*.{ts,vibe}"
    ])
    const attrs = attrsOf<EsLint.Attrs>(targets.lint)
    expect(attrs.maxWarnings).toBe(0)
    expect(attrs.fix).toBe(false)
    // The jsdoc rules are declared key material even though only the first
    // config reaches the argv, so editing them re-keys the target.
    // The flat config imports both shared rule sets.
    expect(attrs.configs).toEqual([
      Input.file("eslint.config.js"),
      Input.file("//eslint.jsdoc.js"),
      Input.file("//eslint.invariants.js")
    ])
    // Typed rules load both tsconfigs and resolve the test tsconfig's program,
    // so the test tree keys the run without being linted.
    expect(attrs.data).toEqual([
      Input.glob("test/**/*.{ts,vibe}"),
      Input.file("tsconfig.json"),
      Input.file("tsconfig.test.json")
    ])
  })

  /**
   * `//packages/smithers/flows/database:lint` names its own configs and left
   * out both tsconfigs, so its confined run's project service found no
   * project for any source and the result went unstored.
   */
  it("keeps the tsconfigs the typed rules load when a package names its own configs", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      eslintConfigs: [Input.file("eslint.config.js"), Input.file("//eslint.package.js")],
      testTsconfig: Input.file("tsconfig.lint.json")
    })
    const attrs = attrsOf<EsLint.Attrs>(targets.lint)
    expect(attrs.configs).toEqual([Input.file("eslint.config.js"), Input.file("//eslint.package.js")])
    expect(attrs.data).toEqual([
      Input.glob("test/**/*.{ts,vibe}"),
      Input.file("tsconfig.json"),
      Input.file("tsconfig.lint.json")
    ])
  })

  it("plans dprint in check mode over the sources and the test tree", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(targets.fmt)).toEqual(["pnpm", "exec", "dprint", "check", "--config", "dprint.json"])
    const attrs = attrsOf<Dprint.Attrs>(targets.fmt)
    expect(attrs.fix).toBe(false)
    expect(attrs.sources).toEqual([Input.glob("src/**/*.{ts,vibe}"), Input.glob("test/**/*.{ts,vibe}")])
  })

  it("keeps both gates strict under caller-selected sources and configs", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      sources: Input.glob("lib/**/*.ts"),
      eslintConfigs: [Input.file("//eslint.strict.js")],
      dprintConfig: Input.file("config/dprint.json")
    })
    expect(plannedArgv(targets.lint)).toEqual([
      "pnpm",
      "exec",
      "eslint",
      "--config",
      "../../eslint.strict.js",
      "--max-warnings",
      "0",
      "lib/**/*.ts"
    ])
    expect(plannedArgv(targets.fmt)).toEqual([
      "pnpm",
      "exec",
      "dprint",
      "check",
      "--config",
      "config/dprint.json"
    ])
    expect(attrsOf<EsLint.Attrs>(targets.lint).fix).toBe(false)
    expect(attrsOf<Dprint.Attrs>(targets.fmt).fix).toBe(false)
  })
})

describe("BuildAndCheckTypeScriptPackage option propagation", () => {
  const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })

  it("narrows the collected suite alone when tests excludes a tier", () => {
    const narrowed = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      tests: Input.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
    })
    expect(attrsOf<Vitest.Attrs>(narrowed.test).tests).toEqual([
      Input.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
    ])
    // The excluded tier stays typechecked and formatted, which is why the
    // suite glob does not reach check or fmt.
    expect(Target.metadata(narrowed.check).inputs).toEqual(Target.metadata(standard.check).inputs)
    expect(Target.metadata(narrowed.fmt).inputs).toEqual(Target.metadata(standard.fmt).inputs)
  })

  it("keys check on the base tsconfig the test tsconfig extends", () => {
    // tsconfig.test.json extends tsconfig.json, and Typecheck digests only the
    // tsconfig it names. Loosening a compiler option in the base must re-key
    // check itself, including when the caller relocates the base.
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(attrsOf<Typecheck.Attrs>(standard.check).tsconfig).toEqual(Input.file("tsconfig.test.json"))
    expect(attrsOf<Typecheck.Attrs>(standard.check).srcs).toContainEqual(Input.file("tsconfig.json"))
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      tsconfig: Input.file("tsconfig.build.json")
    })
    expect(attrsOf<Typecheck.Attrs>(relocated.check).srcs).toContainEqual(Input.file("tsconfig.build.json"))
  })

  it("keys the test target on the helpers its cases import", () => {
    // Vitest digests only the declared tests and sources. A helper such as
    // `test/toolchain.ts` matches no `*.test.ts` glob, so without
    // `testSources` an edit to it reused a cached green run.
    expect(Target.metadata(standard.test).inputs).toContainEqual(Input.glob("test/**/*.{ts,vibe}"))
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      tests: Input.glob("spec/**/*.test.ts"),
      testSources: Input.glob("spec/**/*.ts")
    })
    expect(Target.metadata(relocated.test).inputs).toContainEqual(Input.glob("spec/**/*.ts"))
    expect(Target.metadata(relocated.test).inputs).not.toContainEqual(Input.glob("test/**/*.{ts,vibe}"))
  })

  it("moves the typechecked and formatted test tree with testSources", () => {
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      tests: Input.glob("spec/**/*.test.ts"),
      testSources: Input.glob("spec/**/*.ts")
    })
    expect(attrsOf<Typecheck.Attrs>(relocated.check).srcs).toEqual([
      Input.glob("src/**/*.{ts,vibe}"),
      Input.glob("spec/**/*.ts"),
      Input.file("tsconfig.json"),
      Input.file("//packages/repo-targets/test-utils/test-schemas.ts"),
      Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"),
      Input.file("//packages/repo-targets/test-utils/effect-property.mjs"),
      Input.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
      Input.file("//packages/repo-targets/test-utils/vitest-root-temp.d.mts")
    ])
    expect(attrsOf<Dprint.Attrs>(relocated.fmt).sources).toEqual([
      Input.glob("src/**/*.{ts,vibe}"),
      Input.glob("spec/**/*.ts")
    ])
    expect(attrsOf<Vitest.Attrs>(relocated.test).tests).toEqual([Input.glob("spec/**/*.test.ts")])
  })

  it("reaches every source-reading target when sources moves", () => {
    const moved = Input.glob("lib/**/*.ts")
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      sources: moved
    })
    expect(attrsOf<TsBuild.Attrs>(relocated.lib).srcs).toEqual([
      moved,
      Input.file("//packages/repo-targets/scripts/build-library.mjs"),
      Input.file("//packages/repo-targets/scripts/private-effect-adapters.mjs"),
      Input.file("//packages/repo-targets/package.json"),
      Input.file("//packages/smithers/scripts/compile-commonjs.mjs"),
      Input.file("//packages/repo-targets/contracts/check-single-effect-version.mjs")
    ])
    expect(attrsOf<Typecheck.Attrs>(relocated.check).srcs).toEqual([
      moved,
      Input.glob("test/**/*.{ts,vibe}"),
      Input.file("tsconfig.json"),
      Input.file("//packages/repo-targets/test-utils/test-schemas.ts"),
      Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"),
      Input.file("//packages/repo-targets/test-utils/effect-property.mjs"),
      Input.file("//packages/repo-targets/test-utils/effect-property.d.mts"),
      Input.file("//packages/repo-targets/test-utils/vitest-root-temp.d.mts")
    ])
    expect(attrsOf<Vitest.Attrs>(relocated.test).sources).toEqual([
      moved,
      Input.glob("test/**/*.{ts,vibe}"),
      Input.file("tsconfig.json"),
      Input.file("tsconfig.test.json"),
      Input.file("//packages/repo-targets/test-utils/effect-property.mjs"),
      Input.file("//packages/repo-targets/test-utils/coverage-teardown.mjs"),
      Input.file("//packages/repo-targets/test-utils/test-process-environment.mjs"),
      Input.file("//packages/repo-targets/test-utils/test-schemas.ts"),
      Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"),
      Input.file("//packages/repo-targets/test-utils/vitest-root-temp.mjs"),
      Input.file("//packages/repo-targets/test-utils/effect-property.d.mts")
    ])
    expect(attrsOf<EsLint.Attrs>(relocated.lint).sources).toEqual([moved])
    expect(attrsOf<Dprint.Attrs>(relocated.fmt).sources).toEqual([moved, Input.glob("test/**/*.{ts,vibe}")])
    expect(attrsOf<NodeTest.Attrs>(relocated.circular).srcs).toEqual([
      moved,
      Input.file("tsconfig.json"),
      Input.file("//packages/repo-targets/src/ImportAnalysis.ts"),
      Input.file("//packages/repo-targets/scripts/workspace-packages.mjs")
    ])
    // The published entry is one file, not the glob, so it stays where the
    // caller left it until `entry` moves it.
    expect(attrsOf<TsBuild.Attrs>(relocated.lib).entries).toEqual([Input.file("src/index.ts")])
  })

  it("names the built distribution's entry file from entry", () => {
    const relocated = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      sources: Input.glob("lib/**/*.ts"),
      entry: Input.file("lib/main.ts")
    })
    expect(attrsOf<TsBuild.Attrs>(relocated.lib).entries).toEqual([Input.file("lib/main.ts")])
    expect(TsBuild.distributionLayout(attrsOf<TsBuild.Attrs>(relocated.lib))).toEqual([
      { format: "esm", directory: "dist/esm", entry: "dist/esm/main.js", declaration: "dist/esm/main.d.ts" },
      { format: "cjs", directory: "dist/cjs", entry: "dist/cjs/main.js", declaration: null }
    ])
    expect(attrsOf<TsBuild.Attrs>(standard.lib).entries).toEqual([Input.file("src/index.ts")])
  })
})

describe("BuildAndCheckTypeScriptPackage declaration failures", () => {
  it("rejects a non-integer testTimeoutMs at declaration time, as the README's failure contracts state", () => {
    expect(() =>
      BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/smithers/flows/plan", testTimeoutMs: 1.5 })
    )
      .toThrow(/declaration.* is invalid/)
  })
})

it("runs a package-owned test matrix with the same source and dependency boundary", () => {
  const targets = BuildAndCheckTypeScriptPackage({
    packageManager,
    cwd: "packages/example",
    testProgram: Input.file("//scripts/sql-matrix.mjs"),
    testTimeoutMs: 1_800_000,
    testData: ["docs/**/*.md"]
  })
  const attrs = attrsOf<NodeTest.Attrs>(targets.test)
  expect(Target.metadata(targets.test).target).toBe("NodeTest")
  expect(NodeTest.runArgv(attrs)).toEqual(["node", "../../scripts/sql-matrix.mjs"])
  expect(attrs.timeout).toBe("1800000ms")
  expect(Target.metadata(targets.test).dependencies).toEqual([targets.lib])
  expect(attrs.srcs).toContainEqual(Input.glob("docs/**/*.md"))
  expect(attrs.srcs).toContainEqual(Input.file("vitest.config.ts"))
  expect(attrs.srcs).toContainEqual(Input.glob("test/**/*.{ts,vibe}"))
  expect(attrs.srcs).toContainEqual(Input.file("//packages/repo-targets/test-utils/coverage-teardown.mjs"))
  expect(attrs.srcs).toContainEqual(Input.file("//packages/repo-targets/test-utils/test-process-environment.mjs"))
  expect(attrs.srcs).toContainEqual(Input.file("//packages/repo-targets/test-utils/test-schemas.ts"))
  expect(attrs.srcs).toContainEqual(Input.file("//packages/smithers/flows/database/src/TestSchemas.ts"))
  expect(attrs.srcs).toContainEqual(Input.file("//packages/repo-targets/test-utils/vitest-root-temp.mjs"))
})

it("uses default matrix limits without a package manager or Vitest config", () => {
  const targets = BuildAndCheckTypeScriptPackage({
    cwd: "packages/example",
    testProgram: Input.file("test-matrix.mjs"),
    vitestConfig: null
  })
  const attrs = attrsOf<NodeTest.Attrs>(targets.test)
  expect(attrs.runtime).toBeUndefined()
  expect(attrs.timeout).toBe("1200000ms")
  expect(attrs.srcs).not.toContainEqual(Input.file("vitest.config.ts"))
})

it("forwards explicit lintEnv overrides to the package EsLint target", () => {
  const targets = BuildAndCheckTypeScriptPackage({
    packageManager,
    cwd: "packages/example",
    lintEnv: { NODE_OPTIONS: "--max-old-space-size=4096" }
  })
  expect(attrsOf<EsLint.Attrs>(targets.lint).env).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096" })
})

it("forwards explicit lintData entries to the package EsLint target data", () => {
  const targets = BuildAndCheckTypeScriptPackage({
    packageManager,
    cwd: "packages/example",
    lintData: [Input.glob("src/**/*.json")]
  })
  expect(attrsOf<EsLint.Attrs>(targets.lint).data).toContainEqual(Input.glob("src/**/*.json"))
})

it("forwards VitestBench options to the package bench target", () => {
  const extraDep = Input.file("README.md")
  const targets = BuildAndCheckTypeScriptPackage({
    packageManager,
    cwd: "packages/example",
    benchConfig: Input.file("vitest.bench.config.ts"),
    benchTimeoutMs: 120_000,
    benchTools: [{ _tag: "HostBin", name: "git" }],
    benchEnv: { BENCH_MODE: "fast" },
    benchHosts: ["linux"],
    benchData: ["fixtures/**"],
    benchDeps: [],
    benchEnvironment: "node",
    benchCache: false,
    readme: extraDep
  })
  expect(Target.metadata(targets.bench).target).toBe("VitestBench")
})

it("emits a NodeBench target when benchProgram is declared, with and without packageManager", () => {
  const withMgr = BuildAndCheckTypeScriptPackage({
    packageManager,
    cwd: "packages/example",
    benchProgram: Input.file("bench/run.mjs"),
    benchArgs: ["--quick"],
    benchData: ["fixtures/**"],
    benchDeps: [],
    benchEnv: { BENCH_MODE: "quick" },
    benchTimeoutMs: 300_000,
    benchCache: false
  })
  expect(Target.metadata(withMgr.bench).target).toBe("NodeBench")
  const withoutMgr = BuildAndCheckTypeScriptPackage({
    cwd: "packages/example",
    benchProgram: Input.file("bench/run.mjs")
  })
  expect(Target.metadata(withoutMgr.bench).target).toBe("NodeBench")
})
