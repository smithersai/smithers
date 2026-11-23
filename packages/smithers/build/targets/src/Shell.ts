/**
 * PACKAGE.ts shell target flavors: `S.Shell.Build`, `S.Shell.Test`,
 * `S.Shell.Run`, `S.Shell.Serve`, and `S.Shell.Diff`.
 *
 * Phase W2 gives `Build`, `Test`, `Run`, and `Diff` real plan-time bodies:
 * each plans the one shared {@link Exec.runTool} exec node whose payload is
 * built by {@link execPayload}. Tool references, flag references, and bun
 * templates appear in the payload as sentinel argv tokens; the package
 * executor resolves them against the workspace immediately before spawn and
 * records the resolutions as key material. `Serve` stays a typed
 * `NotImplemented` refusal — service execution is a later lane.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Runtime from "./Runtime.ts"
import type * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

const durationPattern = /^(\d+)(ms|s|m|h)$/

const parsedDurationMs = (text: string): number | undefined => {
  const match = durationPattern.exec(text)
  if (match === null) return undefined
  const unit = match[2]
  return Number(match[1]) * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000)
}

/**
 * A declared tool duration such as `"90s"` or `"6h"`: digits followed by
 * `ms`, `s`, `m`, or `h`, whose value lies in the shared exec range of 1 ms
 * to {@link Exec.maximumTimeoutMs}. A duration outside that range fails at
 * declaration, not when the target runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Duration = Schema.NonEmptyString.check(
  Schema.isPattern(durationPattern),
  Schema.makeFilter((text) => {
    const ms = parsedDurationMs(text)
    return ms !== undefined && Number.isSafeInteger(ms) && ms >= 1 && ms <= Exec.maximumTimeoutMs
      ? undefined
      : `timeout ${JSON.stringify(text)} must be between 1ms and ${Exec.maximumTimeoutMs}ms`
  })
)

/** The attr fields every Shell flavor shares. */
const sharedFields = {
  bin: Schema.optional(Attr.Executable),
  bun: Schema.optional(Schema.NonEmptyString),
  shell: Schema.optional(Schema.NonEmptyString),
  script: Schema.optional(Input.File),
  using: Schema.optional(Attr.Using),
  // Executables the process spawns by itself, not through argv. Their bytes
  // are key material and an absent one refuses the target.
  tools: Schema.optional(Schema.Array(Reference.Tool)),
  args: Schema.optional(Attr.Args),
  runtimeArgs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Attr.Env),
  inheritEnv: Schema.optional(Attr.InheritEnv),
  data: Schema.optional(Attr.Data),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  hosts: Schema.optional(Attr.HostPlatforms),
  runtime: Schema.optional(Schema.Union([Runtime.Runtime, Runtime.NodeDeclaration, Runtime.BunDeclaration])),
  timeout: Schema.optional(Duration)
} as const

const executableSelectors = Attr.executableSelectors

const executableIssue = (attrs: ExecAttrs): string | undefined => {
  const selected = executableSelectors.filter((selector) => attrs[selector] !== undefined)
  if (selected.length !== 1) {
    return `shell declaration requires exactly one of ${executableSelectors.join(", ")}; received ${
      selected.length === 0 ? "none" : selected.join(", ")
    }`
  }
  if (
    attrs.shell !== undefined &&
    (attrs.args !== undefined || attrs.runtimeArgs !== undefined || attrs.using !== undefined)
  ) {
    return "shell text cannot take args, runtimeArgs, or using; put arguments in the shell text or use bin"
  }
  if (attrs.bun !== undefined && (attrs.args !== undefined || attrs.runtimeArgs !== undefined)) {
    return "bun templates cannot take args or runtimeArgs"
  }
  if (attrs.using !== undefined && attrs.bun === undefined) return "using is only supported by bun templates"
  if (attrs.script !== undefined && attrs.runtimeArgs !== undefined) return "script cannot take runtimeArgs"
  const twice = (attrs.inheritEnv ?? []).filter((name) => attrs.env !== undefined && Object.hasOwn(attrs.env, name))
  if (twice.length > 0) return `env sets ${twice.join(", ")}, which inheritEnv also names; declare each variable once`
  return undefined
}
const executableCheck = Schema.makeFilter(executableIssue)

const machineNeedsNoSandbox =
  "machine requires sandbox: \"none\"; a confined target is already held to the files it declares"

/**
 * Attrs for {@link Build}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...sharedFields,
  /**
   * Puts the build in the exclusive tier: wildcard `build` and `ci` selections
   * omit it unless `--include-exclusive` is set, and once selected it runs
   * alone in its executor invocation (useful for benchmarks or heavy native builds).
   */
  exclusive: Schema.optional(Schema.Boolean),
  /**
   * External assembly inputs without complete identities must opt out of
   * replay. An uncached build may declare no `outDirs` or `outFiles`: it runs
   * every time, and its dependents run after it.
   */
  cache: Schema.optional(Schema.Literal(false)),
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  outFiles: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /**
   * Names the machine the target runs on. Targets that name the same machine
   * run one at a time in one private copy of the workspace, with a home
   * directory and a temporary directory of their own, as the steps of one CI
   * job share a runner. The copy is a fresh checkout: what git tracks as the
   * working tree has it, and every other file `.gitignore` does not leave
   * out. It is made when the first of them has to run and removed when the
   * build ends, so no other target sees what they write, and they see
   * nothing another target wrote.
   *
   * The target needs `sandbox: "none"` and `cache: false`: what it builds
   * stays on its machine, for the targets there that wait for it.
   */
  machine: Schema.optional(Schema.NonEmptyString)
}).check(
  executableCheck,
  // An uncached build with no output is an action that runs every time and
  // that other targets can depend on. A cached one needs an output to restore.
  Schema.makeFilter((attrs) =>
    attrs.cache !== false && (attrs.outDirs?.length ?? 0) + (attrs.outFiles?.length ?? 0) === 0
      ? "Shell.Build requires at least one outDirs or outFiles entry unless cache is false"
      : undefined
  ),
  Schema.makeFilter((attrs) => {
    if (attrs.machine === undefined) return undefined
    if (attrs.sandbox !== "none") return machineNeedsNoSandbox
    return attrs.cache === false
      ? undefined
      : "machine requires cache: false; what a build leaves on a machine is never restored from the cache"
  })
)

/**
 * The host variables an `observe` attribute names in `env`: none for
 * `observe: true`, `false`, or an attribute that names none.
 *
 * @category accessors
 * @since 1.0.0
 */
export const observedEnv = (observe: unknown): ReadonlyArray<string> =>
  typeof observe === "object" && observe !== null
    ? (observe as { readonly env?: ReadonlyArray<string> }).env ?? []
    : []

/**
 * What a `given` attribute names: the host variables the test is given, and
 * every name that shows the test could read one: the variables' own names
 * and those of `names`. Nothing for a test that declares none.
 *
 * @category accessors
 * @since 1.0.0
 */
export const givenEnv = (
  given: unknown
): { readonly env: ReadonlyArray<string>; readonly names: ReadonlyArray<string> } => {
  const declared = (given ?? {}) as { readonly env?: ReadonlyArray<string>; readonly names?: ReadonlyArray<string> }
  const env = declared.env ?? []
  return { env, names: [...env, ...(declared.names ?? [])] }
}

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  ...sharedFields,
  /**
   * Puts the test in the exclusive tier: wildcard `test` and `ci` selections
   * omit it unless `--include-exclusive` is set, and once selected it runs
   * alone in its executor invocation.
   */
  exclusive: Schema.optional(Schema.Boolean),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates),
  shards: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /**
   * Optional directories and files captured and materialized on cache hits
   * (e.g. benchmark JSON reports emitted by an exclusive `Shell.Test`).
   * Cannot be combined with `shards > 1`.
   */
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  outFiles: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /**
   * Records every path a run looks at: the files it opens, the directories
   * it lists and the paths it finds missing. A later run is answered from
   * the cache when each of them is unchanged, whatever else in `data`
   * changed. `ignore` names paths left out of the record: a file or a
   * directory with all it holds, from the workspace root, absolute, under
   * the home directory as `~/...`, or under the run's temporary directory as
   * `$TMPDIR/...`. Use it for what a tool writes on every run and never reads
   * to decide its result, such as a log directory or a compiled-code cache.
   *
   * `env` names variables of the host the run is given whose values differ
   * from one run to the next, such as the commit a CI run is for. Each
   * reaches the command with its host value, as with `inheritEnv`, and its
   * value is no part of the key. A stored result holds the value of each one
   * the run could have used: one whose name is in `shell`, or in a file of
   * the workspace the run read that git does not ignore, or whose value is in
   * what the run printed, in a file it wrote and left, or in the arguments of
   * a program it started. The result is reused only while each of those
   * variables holds the same value. A value shorter than six characters is
   * found by its name alone.
   *
   * `readAsData` names files the run reads as data, from the workspace root:
   * a file, or a directory with all it holds. A variable's name in one of
   * them does not show the run used the variable, as a CI's workflow files
   * name variables the CI sets and a check that reads them never uses. Each
   * is still an input: a change to one runs the target again.
   *
   * `byValue` names variables of `env` whose name in a file the run read
   * shows nothing: such a variable counts only when its name is in `shell`,
   * or its value is in what the run printed, in a file it wrote and left, or
   * in the arguments of a program it started. Use it for a value made up for
   * each run, such as a CI run's id, that nothing in the workspace can be
   * compared with: a run depends on it only by using it.
   *
   * `quiet` names words that mark a question the command asks for itself,
   * such as a wrapper asking git which commit is checked out to hand it on
   * in a variable, as a CI runner hands it on. A program the run starts with
   * one of them among its arguments, and every program that one starts,
   * reads nothing the record holds; what it writes is the run's.
   *
   * The run needs `sandbox: "none"` and a host that can trace it: Linux with
   * `strace`. On any other host the target is keyed by its `data` and by the
   * value of every variable `env` names.
   */
  observe: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({
        ignore: Schema.optional(Schema.Array(Schema.NonEmptyString)),
        quiet: Schema.optional(Schema.Array(Schema.NonEmptyString)),
        env: Schema.optional(Attr.InheritEnv),
        readAsData: Schema.optional(Schema.Array(Schema.NonEmptyString)),
        byValue: Schema.optional(Schema.Array(Schema.NonEmptyString))
      })
    ])
  ),
  /**
   * Names variables of the host a test held to its declared files is given
   * whose values differ from one run to the next, such as the commit a CI run
   * is for. Each variable of `env` reaches the command with its host value,
   * as with `inheritEnv`.
   *
   * The read sandbox lets the test read no file of the workspace but those
   * `data` names. So the values are in the key only when the test could read
   * one: when `shell`, or a file `data` names, holds the name of one of the
   * variables or one of `names`. `names` lists other names that tell as
   * much, such as a variable the command works out from one of them. When
   * one name is found, every value is in the key. When none is, the result
   * is reused at any value, from the remote cache too.
   *
   * The values are always in the key where the declared files are not all
   * the test can read: with `sandbox: "none"`, with a dependency, whose
   * outputs it may read, or with a symbolic link among the files.
   */
  given: Schema.optional(
    Schema.Struct({
      env: Attr.InheritEnv,
      names: Schema.optional(Schema.Array(Schema.NonEmptyString))
    })
  ),
  /**
   * Names the machine the target runs on. Targets that name the same machine
   * run one at a time in one private copy of the workspace, with a home
   * directory and a temporary directory of their own, as the steps of one CI
   * job share a runner. The copy is a fresh checkout: what git tracks as the
   * working tree has it, and every other file `.gitignore` does not leave
   * out. It is made when the first of them has to run and removed when the
   * build ends, so no other target sees what they write, and they see
   * nothing another target wrote.
   *
   * The target needs `sandbox: "none"`: a confined target is already held to
   * the files it declares.
   */
  machine: Schema.optional(Schema.NonEmptyString)
}).check(
  executableCheck,
  Schema.makeFilter((attrs) => {
    if (attrs.machine === undefined) return undefined
    if (attrs.sandbox !== "none") return machineNeedsNoSandbox
    if ((attrs.shards ?? 1) > 1) return "machine cannot be combined with shards"
    if ((attrs.services ?? []).length > 0) return "machine cannot be combined with services"
    return undefined
  }),
  Schema.makeFilter((attrs) => {
    if (attrs.observe === undefined || attrs.observe === false) return undefined
    if (attrs.sandbox !== "none") {
      return "observe requires sandbox: \"none\"; a confined target is already held to its declared inputs"
    }
    if ((attrs.shards ?? 1) > 1) return "observe cannot be combined with shards"
    if ((attrs.services ?? []).length > 0) {
      return "observe cannot be combined with services, which run outside the observed process"
    }
    const twice = observedEnv(attrs.observe).filter((name) =>
      (attrs.inheritEnv ?? []).includes(name) || (attrs.env !== undefined && Object.hasOwn(attrs.env, name))
    )
    if (twice.length > 0) {
      return `observe.env names ${twice.join(", ")}, which env or inheritEnv also names; declare each variable once`
    }
    return undefined
  }),
  Schema.makeFilter((attrs) => {
    if ((attrs.shards ?? 1) > 1 && ((attrs.outDirs ?? []).length > 0 || (attrs.outFiles ?? []).length > 0)) {
      return "shards > 1 cannot declare outDirs or outFiles"
    }
    return undefined
  }),
  Schema.makeFilter((attrs) => {
    if (attrs.given === undefined) return undefined
    if (attrs.observe !== undefined && attrs.observe !== false) {
      return "given cannot be combined with observe; an observed test names such variables in observe.env"
    }
    const twice = attrs.given.env.filter((name) =>
      (attrs.inheritEnv ?? []).includes(name) || (attrs.env !== undefined && Object.hasOwn(attrs.env, name))
    )
    if (twice.length > 0) {
      return `given.env names ${twice.join(", ")}, which env or inheritEnv also names; declare each variable once`
    }
    return undefined
  })
)

/**
 * Attrs for {@link Run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunAttrs = Schema.Struct({
  ...sharedFields,
  /** Run only when explicitly selected. @since 0.1.0 */
  manual: Schema.optional(Schema.Boolean),
  approval: Schema.optional(Attr.Approval),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates)
}).check(executableCheck)

/**
 * Attrs for {@link Serve}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ServeAttrs = Schema.Struct({
  ...sharedFields,
  services: Schema.optional(Attr.Services),
  readiness: Schema.optional(Attr.Readiness),
  health: Schema.optional(Attr.Health),
  stop: Schema.optional(Attr.Stop)
}).check(executableCheck)

/**
 * Attrs for {@link Diff}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffAttrs = Schema.Struct({
  ...sharedFields,
  changes: Schema.Array(Schema.NonEmptyString)
}).check(executableCheck)

/**
 * Renders the sentinel argv token for one tool reference.
 *
 * The token is inert text: the plan-time body records it in the exec payload,
 * and the package executor replaces it with the resolved absolute executable
 * path immediately before spawn. The resolution — path, package version, or
 * host probe output — is key material at that point; the token itself never
 * reaches a spawned process.
 *
 * @category tokens
 * @since 0.1.0
 */
export const toolToken = (tool: Reference.Tool): string => `{smthrs:tool:${JSON.stringify(tool)}}`

/**
 * The sentinel argv token for a build target used as a tool edge,
 * `bin: sdk.buildCli`.
 *
 * A target cannot be serialized into a token the way a reference can, and it
 * does not have to be: a declaration names exactly one `bin`, so the planner
 * knows which dependency the token stands for and substitutes the executable
 * that target declares it produces.
 *
 * @category tokens
 * @since 0.1.0
 */
export const targetBinToken = "{smthrs:target-bin}"

/**
 * The sentinel argv token for a workspace flag reference, `S.Flags.<name>`.
 *
 * @category tokens
 * @since 0.1.0
 */
export const flagToken = (name: string): string => `{smthrs:flag:${name}}`

/**
 * The sentinel argv token for the bun binary that runs `bun:` templates.
 *
 * @category tokens
 * @since 0.1.0
 */
export const bunToken = "{smthrs:bun}"

/**
 * The sentinel argv token for the generated bun template program file.
 *
 * @category tokens
 * @since 0.1.0
 */
export const bunProgramToken = "{smthrs:bun-program}"

/**
 * The sentinel argv token for a package-relative generator script path.
 *
 * @category tokens
 * @since 0.1.0
 */
export const scriptToken = (path: string): string => `${Exec.scriptTokenPrefix}${path}}`

/**
 * The argv[0] a declared `script` runs under, chosen from its extension.
 *
 * A repository writes generator and harness scripts in both dialects — the
 * design corpus has `.sh` scripts on `S.Shell.*` and on `S.Generate`, and
 * `.mjs` scripts on `S.Generate` — and the same file must spawn the same way
 * under either rule. A `.sh` script runs under `/bin/sh` and a `.bash` script
 * under `/bin/bash`, because `/bin/sh` is dash on Debian and Ubuntu and
 * rejects bash syntax. Anything else runs under the workspace runtime, which
 * is what a JavaScript generator needs.
 *
 * @category tokens
 * @since 0.1.0
 */
export const scriptInterpreterToken = (path: string): string =>
  path.endsWith(".sh") ? "/bin/sh" : path.endsWith(".bash") ? "/bin/bash" : Exec.runtimeBinToken

/**
 * Wall-clock bound for one build-system tool process.
 *
 * Package-mode targets include multi-minute compiles (tsc, relay-compiler
 * over a production tree), so the bound is deliberately far above the
 * ten-minute exec default.
 *
 * @category constants
 * @since 0.1.0
 */
export const packageExecTimeoutMs = 30 * 60 * 1000

/**
 * Parses a {@link Duration} to milliseconds. Unrecognized text uses the
 * package execution default.
 *
 * @category utilities
 * @since 0.1.0
 */
export const durationMs = (text: string): number => parsedDurationMs(text) ?? packageExecTimeoutMs

/**
 * The attr fields {@link execPayload} reads. Every Shell flavor and the
 * Generate bin form share this shape.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecAttrs {
  readonly bin?: Reference.Tool | Target.AnyTarget | undefined
  readonly bun?: string | undefined
  readonly shell?: string | undefined
  readonly script?: Input.File | undefined
  readonly using?: Readonly<Record<string, Reference.Tool>> | undefined
  readonly tools?: ReadonlyArray<Reference.Tool> | undefined
  readonly args?: ReadonlyArray<string | Reference.FlagRef> | undefined
  readonly runtimeArgs?: ReadonlyArray<string> | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly inheritEnv?: ReadonlyArray<string> | undefined
  readonly timeout?: string | undefined
  readonly secrets?: ReadonlyArray<Secret.HttpCredential> | undefined
}

const resolveArgs = (args: ReadonlyArray<string | Reference.FlagRef> | undefined): Array<string> =>
  (args ?? []).map((entry) => typeof entry === "string" ? entry : flagToken(entry.name))

/**
 * Builds the canonical exec payload one shell-shaped declaration plans.
 *
 * The same builder backs the target's plan-time body and the package
 * executor's spawn, so the two can never drift: the executor takes this
 * payload, substitutes the sentinel tokens with resolved tool paths, applies
 * the sandbox wrapper, and hands the result to the shared exec
 * implementation.
 *
 * - `shell` runs through `/bin/sh -c`, so the declared text keeps its
 *   shell semantics (`$TMPDIR` expansion, globs).
 * - `bun` templates run as `bun <generated program>`; the program file is
 *   generated by the executor from the resolved `using` tools plus the
 *   template text.
 * - `bin` spawns the referenced tool directly; `runtimeArgs` are runtime
 *   flags, so a non-runtime `bin` with `runtimeArgs` runs under the
 *   workspace runtime binary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const execPayload = (attrs: ExecAttrs): Exec.CallPayload => {
  if (attrs.bin !== undefined || attrs.bun !== undefined || attrs.shell !== undefined || attrs.script !== undefined) {
    const issue = executableIssue(attrs)
    if (issue !== undefined) throw new TypeError(issue)
  }
  const environment = attrs.env === undefined ? {} : { ...attrs.env }
  const args = resolveArgs(attrs.args)
  let argv: [string, ...Array<string>]
  if (attrs.shell !== undefined) {
    argv = ["/bin/sh", "-c", attrs.shell]
  } else if (attrs.script !== undefined) {
    argv = [scriptInterpreterToken(attrs.script.path), scriptToken(attrs.script.path), ...args]
  } else if (attrs.bun !== undefined) {
    argv = [bunToken, bunProgramToken]
  } else if (attrs.bin !== undefined) {
    const runtimeArgs = attrs.runtimeArgs ?? []
    // A build target as the tool edge is never a JavaScript runtime, so it
    // never takes runtime flags; it is the program itself. Running it under
    // the workspace runtime would spawn the wrong program and dropping the
    // flags would spawn the right one with a different argv, so the
    // declaration is rejected instead.
    if (Target.isTarget(attrs.bin)) {
      if (runtimeArgs.length > 0) {
        throw new Error(
          "a shell declaration whose bin is a build target cannot take runtimeArgs; " +
            "they are flags for a JavaScript runtime the built binary is not"
        )
      }
      argv = [targetBinToken, ...args]
    } else if (attrs.bin._tag === "RuntimeBin") {
      argv = [toolToken(attrs.bin), ...runtimeArgs, ...args]
    } else if (runtimeArgs.length > 0) {
      argv = [toolToken(Reference.runtimeBin), ...runtimeArgs, toolToken(attrs.bin), ...args]
    } else {
      argv = [toolToken(attrs.bin), ...args]
    }
  } else {
    throw new Error("shell declaration names no executable")
  }
  return {
    cwd: ".",
    argv,
    env: environment,
    timeoutMs: attrs.timeout === undefined ? packageExecTimeoutMs : durationMs(attrs.timeout)
  }
}

/** Plans the shared exec node for one shell-shaped declaration. */
const planExec = (attrs: ExecAttrs) =>
  Exec.runTool({
    ...execPayload(attrs),
    secrets: attrs.secrets === undefined ? [] : [...attrs.secrets]
  })

const buildDefinition = Target.make("Shell.Build", {
  attrs: BuildAttrs,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["build"],
  implementation: (attrs) => planExec(attrs)
})

const testDefinition = Target.make("Shell.Test", {
  attrs: TestAttrs,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["test"],
  implementation: (attrs) => planExec(attrs)
})

const runDefinition = Target.make("Shell.Run", {
  attrs: RunAttrs,
  manual: (attrs) => attrs.manual === true,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["run"],
  implementation: (attrs) => planExec(attrs)
})

const serveDefinition = Target.make("Shell.Serve", {
  attrs: ServeAttrs,
  hosts: (attrs) => attrs.hosts,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Shell.Serve")
})

const diffDefinition = Target.make("Shell.Diff", {
  attrs: DiffAttrs,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["run", "lint"],
  implementation: (attrs) => planExec(attrs)
})

/**
 * Exactly one executable selector and only the options that selector consumes.
 * @category models
 * @since 0.1.0
 */
export type Executable =
  | {
    readonly shell: string
    readonly bin?: never
    readonly bun?: never
    readonly script?: never
    readonly args?: never
    readonly runtimeArgs?: never
    readonly using?: never
  }
  | {
    readonly bin: NonNullable<ExecAttrs["bin"]>
    readonly shell?: never
    readonly bun?: never
    readonly script?: never
    readonly using?: never
  }
  | {
    readonly script: Input.File
    readonly shell?: never
    readonly bin?: never
    readonly bun?: never
    readonly runtimeArgs?: never
    readonly using?: never
  }
  | {
    readonly bun: string
    readonly shell?: never
    readonly bin?: never
    readonly script?: never
    readonly args?: never
    readonly runtimeArgs?: never
  }

const exclusive = <D extends (attrs: never) => unknown>(
  definition: D
): Pick<D, keyof D> & ((attrs: Parameters<D>[0] & Executable) => ReturnType<D>) =>
  definition as Pick<D, keyof D> & ((attrs: Parameters<D>[0] & Executable) => ReturnType<D>)

/**
 * A tool run producing the declared output directories.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = exclusive(buildDefinition)

/**
 * A tool run whose exit status is the test verdict.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = exclusive(testDefinition)

/**
 * A tool run executed only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Run = exclusive(runDefinition)

/**
 * A scoped long-running service with the readiness/health/stop probe
 * contract.
 *
 * @category targets
 * @since 0.1.0
 */
export const Serve = exclusive(serveDefinition)

/**
 * A tool run whose writes are mechanically confined to the declared
 * `changes` write-set; check mode diffs, write mode applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Diff = exclusive(diffDefinition)
