/**
 * Workspace package scaffolding.
 *
 * `smthrs generate package <name>` writes a manifest, a tsconfig, one source
 * file, one test, a README, and a `PACKAGE.ts` declaring the package's targets.
 * The CLI does not synthesize targets from `PackageDefaults` exports, so a
 * directory without a `PACKAGE.ts` would contribute no labels. A workspace that
 * needs more than the generic files names a template directory; its files are
 * written into every new package with the package's name and paths filled in.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import { failureMessage, type FilePayload, WriteFileError, writeGeneratedFile } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import { ensureDirectory, reclaimStaleTemporaries } from "./internal/ScaffoldDirectory.ts"
import { assertPackageName, License, merge, render } from "./PackageJson.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Target from "./Target.ts"

/**
 * Payload for one scaffold run.
 *
 * The package NAME is not here: it is a per-invocation argument, not a
 * declaration, so it arrives through the layer from `smthrs generate package <name>`. Attrs
 * that changed per invocation would re-key the target on every run and record a
 * cache entry per name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ScaffoldPayload = Schema.Struct({
  /** The workspace-relative directory new packages are created under. */
  directory: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  license: License,
  /** Shared manifest fields, normally a `PackageJsonTemplate` template's. */
  fields: Schema.Record(Schema.String, Schema.Unknown),
  /**
   * The tsconfig the generated package extends, relative to the new package.
   * Absent, it is the workspace-root `tsconfig.base.json`.
   */
  tsconfigExtends: Schema.optional(Schema.NonEmptyString),
  /**
   * A workspace-relative directory whose files are written into the new
   * package. See {@link withTemplate}.
   */
  template: Schema.optional(Schema.NonEmptyString)
})

/**
 * Payload for one scaffold run.
 *
 * @category models
 * @since 0.1.0
 */
export type ScaffoldPayload = typeof ScaffoldPayload.Type

/**
 * Result of one scaffold run: the created directory and every file written.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ScaffoldReport = Schema.Struct({
  directory: Schema.NonEmptyString,
  files: Schema.Array(Schema.NonEmptyString)
})

/**
 * Result of one scaffold run.
 *
 * @category models
 * @since 0.1.0
 */
export type ScaffoldReport = typeof ScaffoldReport.Type

/**
 * Creates one package directory in the source tree.
 *
 * @category actions
 * @since 0.1.0
 */
export const ScaffoldPackage = Action.make("smithers-build/scaffold-package", {
  payload: ScaffoldPayload,
  success: ScaffoldReport,
  error: WriteFileError,
  tier: "sealed"
})

/** The directory name a scoped npm name maps to: `@scope/foo` becomes `foo`. */
const directoryName = (name: string): string => name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name

const reservedIdentifiers = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
])

/** Maps an npm package component to a valid, non-reserved JavaScript identifier. */
const sourceIdentifier = (name: string): string => {
  const words = directoryName(name).split(/[^A-Za-z0-9]+/).filter((word) => word !== "")
  const candidate = words.map((word, index) => index === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join("")
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate) && !reservedIdentifiers.has(candidate)
    ? candidate
    : `package${candidate === "" ? "Name" : `${candidate[0]!.toUpperCase()}${candidate.slice(1)}`}`
}

/**
 * The workspace-root `tsconfig.base.json`, relative to a package created
 * under the resolved workspace-relative `directory`.
 */
const workspaceBaseTsconfig = (directory: string): string =>
  `${"../".repeat(directory === "." ? 1 : directory.split("/").length + 1)}tsconfig.base.json`

/** The generated manifest fields, before any template is laid over them. */
const manifest = (name: string, payload: ScaffoldPayload): Record<string, unknown> =>
  merge(payload.fields, {
    name,
    version: payload.version,
    license: payload.license,
    type: "module",
    sideEffects: [],
    exports: { "./package.json": "./package.json", ".": "./src/index.ts" },
    files: ["src/**/*.ts", "README.md"]
  })

/**
 * The static boilerplate a scaffolded package starts from.
 *
 * A model could write a better README and a better first test, and the
 * `packageJsonRefresh` target is where a model is allowed to. Scaffolding
 * itself stays static: `smthrs generate package <name>` must work on a machine with
 * no model CLI, offline, and produce the same tree every time.
 *
 * @category rendering
 * @since 0.1.0
 */
export const boilerplate = (
  name: string,
  payload: ScaffoldPayload
): ReadonlyArray<readonly [string, string]> => {
  const identifier = sourceIdentifier(name)
  return [
    ["package.json", render(manifest(name, payload))],
    [
      "tsconfig.json",
      `${
        JSON.stringify(
          {
            extends: payload.tsconfigExtends ?? workspaceBaseTsconfig(Input.resolvePath("", payload.directory)),
            include: ["src/**/*", "test/**/*"]
          },
          undefined,
          2
        )
      }\n`
    ],
    [
      "src/index.ts",
      `/**\n * ${name}\n *\n * @since 0.1.0\n */\n\n/**\n * The package name.\n *\n * @category constants\n * @since 0.1.0\n */\nexport const ${identifier} = ${
        JSON.stringify(name)
      }\n`
    ],
    [
      "test/index.test.ts",
      `import { describe, expect, it } from "vitest"\nimport { ${identifier} } from "../src/index.ts"\n\ndescribe(${
        JSON.stringify(name)
      }, () => {\n  it("exports its own name", () => {\n    expect(${identifier}).toBe(${
        JSON.stringify(name)
      })\n  })\n})\n`
    ],
    [
      "README.md",
      `# ${name}\n\nCreated by \`smthrs generate package ${name}\`.\n\n\`PACKAGE.ts\` declares this package's targets. \`smthrs targets\` lists them.\n`
    ],
    [
      "PACKAGE.ts",
      `import { Smithers } from "@smthrs/targets"\n\n/** This package's targets. */\nexport const Package = Smithers.Package({\n  targets: {\n    test: Smithers.Vitest({\n      tests: [Smithers.glob("test/**/*.test.ts")],\n      sources: [Smithers.glob("src/**/*.ts")],\n      deps: [],\n      config: null,\n      environment: "node",\n      passWithNoTests: false,\n      coverage: false,\n      cwd: ${
        JSON.stringify(packagePath(name, payload))
      }\n    })\n  }\n})\n`
    ]
  ]
}

/** The workspace-relative directory a package named `name` is created in. */
const packagePath = (name: string, payload: ScaffoldPayload): string => {
  const directory = Input.resolvePath("", payload.directory)
  return directory === "." ? directoryName(name) : `${directory}/${directoryName(name)}`
}

/** The suffix that keeps a template file inert until it is written. */
const templateSuffix = ".template"

/**
 * Lays a template's files over the boilerplate.
 *
 * `template` holds `[relative path, contents]` pairs read from the template
 * directory. A trailing `.template` is dropped from each path, so a template
 * can hold `PACKAGE.ts.template` or `package.json.template` without the
 * workspace reading it as a package. Four placeholders are filled in every
 * file: `{{name}}` is the package name, `{{identifier}}` the JavaScript
 * binding of `src/index.ts`, `{{directory}}` the package's workspace-relative
 * path, and `{{root}}` the relative path from the package to the workspace
 * root. A template `package.json` is a JSON object merged over the generated
 * manifest; the name, version, and license still come from the scaffold. Any
 * other template file replaces the boilerplate file at its path or adds a new
 * one.
 *
 * @category rendering
 * @since 0.1.0
 */
export const withTemplate = (
  name: string,
  payload: ScaffoldPayload,
  template: ReadonlyArray<readonly [string, string]>
): ReadonlyArray<readonly [string, string]> => {
  const directory = packagePath(name, payload)
  const values: Readonly<Record<string, string>> = {
    name,
    identifier: sourceIdentifier(name),
    directory,
    root: directory.split("/").map(() => "..").join("/")
  }
  const fill = (contents: string): string =>
    contents.replace(/\{\{(name|identifier|directory|root)\}\}/g, (_match, key: string) => values[key]!)
  const files = new Map(boilerplate(name, payload))
  for (const [templatePath, contents] of template) {
    const relative = templatePath.endsWith(templateSuffix)
      ? templatePath.slice(0, -templateSuffix.length)
      : templatePath
    if (relative !== "package.json") {
      files.set(relative, fill(contents))
      continue
    }
    let fields: unknown
    try {
      fields = JSON.parse(fill(contents))
    } catch (cause) {
      throw new WriteFileError({
        path: templatePath,
        message: `template ${templatePath} is not JSON: ${failureMessage(cause)}`
      })
    }
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
      throw new WriteFileError({ path: templatePath, message: `template ${templatePath} must hold a JSON object` })
    }
    files.set(
      "package.json",
      render(merge(merge(manifest(name, payload), fields as Record<string, unknown>), {
        name,
        version: payload.version,
        license: payload.license
      }))
    )
  }
  return [...files]
}

/**
 * Options accepted by {@link scaffold} and {@link ScaffoldPackageLive}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScaffoldOptions {
  readonly workspaceRoot: string
  /** The name supplied by `smthrs generate package <name>`, absent when no name was given. */
  readonly packageName?: string | undefined
  /** Fault-injection seams used by publication tests. */
  readonly io?: ScaffoldIo | undefined
}

/**
 * Filesystem seams for atomic package publication tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScaffoldIo {
  readonly writeFile?: (root: string, payload: FilePayload, signal: AbortSignal) => Promise<void>
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly remove?: (path: string) => Promise<void>
}

const directoryIo = {
  lstat: Fs.lstat,
  mkdir: Fs.mkdir,
  realpath: Fs.realpath,
  readdir: Fs.readdir,
  join: NodePath.join,
  inside: SafeFs.inside,
  syncDirectory: SafeFs.syncDirectory,
  errorCode: SafeFs.errorCode
}

/**
 * Reads every file under a workspace template directory, sorted by path.
 *
 * The read is confined like a declared input: a symbolic link, a path leaving
 * the workspace, or a missing directory is refused rather than skipped, so a
 * template typo never produces a package that silently lacks its files.
 */
const readTemplate = async (root: string, template: string): Promise<ReadonlyArray<readonly [string, string]>> => {
  const relative = Input.resolvePath("", template)
  const options = { root, symlinks: "reject" as const, what: `template ${relative}` }
  const files: Array<readonly [string, string]> = []
  const walk = async (path: string, prefix: string): Promise<void> => {
    const entry = await SafeFs.resolveDirectory(path, options)
    if (entry === undefined) {
      throw new WriteFileError({ path: relative, message: `template ${relative} has no directory at ${path}` })
    }
    for (const child of await SafeFs.listDirectory(path, entry, options)) {
      const childPath = NodePath.join(path, child.name)
      const childRelative = prefix === "" ? child.name : `${prefix}/${child.name}`
      if (child.isDirectory()) await walk(childPath, childRelative)
      else if (child.isFile()) files.push([childRelative, (await SafeFs.readText(childPath, options))!])
      else {
        throw new WriteFileError({
          path: relative,
          message: `template ${relative} holds ${childRelative}, which is not a regular file`
        })
      }
    }
  }
  await walk(NodePath.join(root, relative), "")
  return files.sort(([left], [right]) => Number(left > right) - Number(left < right))
}

const absent = async (path: string): Promise<boolean> => {
  try {
    await Fs.lstat(path)
    return false
  } catch (cause) {
    if (SafeFs.errorCode(cause) === "ENOENT") return true
    throw cause
  }
}

/**
 * Writes one new package directory.
 *
 * The name is validated with the same {@link assertPackageName} a declaration
 * uses, and an existing directory is refused rather than merged into: a
 * scaffold that overwrote files would be a destructive command spelled like a
 * creative one.
 *
 * @category execution
 * @since 0.1.0
 */
export const scaffold = (
  options: ScaffoldOptions,
  payload: ScaffoldPayload
): Effect.Effect<ScaffoldReport, WriteFileError> =>
  Effect.tryPromise({
    try: async (signal): Promise<ScaffoldReport> => {
      const directory = Input.resolvePath("", payload.directory)
      const packageName = options.packageName
      if (packageName === undefined || packageName === "") {
        throw new Error("no package name was supplied; run `smthrs generate package <package-name>`")
      }
      const name = assertPackageName(packageName)
      const created = packagePath(name, payload)
      const root = await SafeFs.canonicalRoot(options.workspaceRoot)
      const tree = payload.template === undefined
        ? boilerplate(name, payload)
        : withTemplate(name, payload, await readTemplate(root, payload.template))
      const parent = await ensureDirectory(root, directory, directoryIo)
      const destination = NodePath.join(parent, directoryName(name))
      if (!await absent(destination)) throw new Error(`${created} already exists; scaffolding never overwrites`)

      const io = options.io
      const write = io?.writeFile ?? ((workspaceRoot, file, childSignal) =>
        Effect.runPromise(writeGeneratedFile(workspaceRoot, file), { signal: childSignal }))
      const rename = io?.rename ?? Fs.rename
      const remove = io?.remove ?? ((path) => Fs.rm(path, { recursive: true, force: true }))
      await reclaimStaleTemporaries(parent, remove, directoryIo)
      const temporary = NodePath.join(parent, `.smthrs-scaffold-${randomUUID()}.tmp`)
      const temporaryRelative = NodePath.relative(root, temporary).split(NodePath.sep).join("/")
      const files: Array<string> = []
      let temporaryCreated = false
      let published = false
      let primary: unknown
      try {
        await Fs.mkdir(temporary)
        temporaryCreated = true
        for (const [relative, contents] of tree) {
          signal.throwIfAborted()
          await write(root, { path: `${temporaryRelative}/${relative}`, contents }, signal)
          files.push(`${created}/${relative}`)
        }
        await SafeFs.syncDirectory(temporary)
        if (!await absent(destination)) throw new Error(`${created} already exists; scaffolding never overwrites`)
        await rename(temporary, destination)
        published = true
        await SafeFs.syncDirectory(parent)
      } catch (cause) {
        primary = cause
      }
      if (temporaryCreated && !published) {
        try {
          await remove(temporary)
        } catch (cause) {
          primary = primary === undefined
            ? cause
            : new Error(
              `package scaffold failed: ${failureMessage(primary)}; ` +
                `temporary directory cleanup also failed: ${failureMessage(cause)}`,
              { cause: new AggregateError([primary, cause]) }
            )
        }
      }
      if (primary !== undefined) throw primary
      return { directory: created, files }
    },
    catch: (cause) => {
      let directory = "package"
      if (!NodeUtil.isProxy(payload)) {
        const descriptor = Object.getOwnPropertyDescriptor(payload, "directory")
        if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
          directory = descriptor.value
        }
      }
      return !NodeUtil.isProxy(cause) && cause instanceof WriteFileError
        ? cause
        : new WriteFileError({ path: directory, message: failureMessage(cause) })
    }
  })

/**
 * Implements {@link ScaffoldPackage} against the source tree.
 *
 * @category layers
 * @since 0.1.0
 */
export const ScaffoldPackageLive = (
  options: ScaffoldOptions
): Layer.Layer<Action.Requirement<"smithers-build/scaffold-package">, never, FlowRuntime.FlowRuntime> =>
  ScaffoldPackage.toLayer((payload) => scaffold(options, payload))

/**
 * Attributes for {@link NewPackage}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** @default "packages" */
  directory: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("packages"))),
  /** @default "0.1.0" */
  version: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("0.1.0"))),
  license: License,
  /** @default {} */
  fields: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, unknown>>({}))
  ),
  /** Relative to the new package. Absent, the workspace-root `tsconfig.base.json`. */
  tsconfigExtends: Schema.optional(Schema.NonEmptyString),
  /** Workspace-relative directory of files written into every new package. Absent, none. */
  template: Schema.optional(Schema.NonEmptyString)
})

/**
 * Attributes for {@link NewPackage}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Scaffolds a new workspace package.
 *
 * The target participates in the `run` verb alone and is never cacheable: it
 * exists to leave a directory behind, and a cache hit would report success for
 * a package that was never created. The package name is a per-invocation
 * argument rather than an attr, so one declaration serves every new package:
 *
 * ```sh
 * smthrs generate package @smthrs/widget
 * ```
 *
 * A scoped name maps to an unscoped directory, so `@smthrs/widget` creates
 * `packages/widget`. The created tree holds a `PACKAGE.ts`, so the package's
 * targets are listed as soon as it exists. With a `template`, the template's
 * files are laid over the generic ones; see {@link withTemplate}.
 *
 * @category targets
 * @since 0.1.0
 */
export const NewPackage = Target.make("NewPackage", {
  attrs: Attrs,
  kinds: ["run"],
  success: ScaffoldReport,
  error: WriteFileError,
  cache: false,
  implementation: (
    attrs
  ): Node.Node<ScaffoldReport, WriteFileError, Action.Requirement<"smithers-build/scaffold-package">> =>
    ScaffoldPackage.call({
      directory: attrs.directory,
      version: attrs.version,
      license: attrs.license,
      fields: attrs.fields,
      ...(attrs.tsconfigExtends === undefined ? {} : { tsconfigExtends: attrs.tsconfigExtends }),
      ...(attrs.template === undefined ? {} : { template: attrs.template })
    })
})
