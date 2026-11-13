/**
 * The SDK rules macro: Will's SDK-wide rules, which every SDK package declares
 * in its own PACKAGE.ts.
 *
 * The rules cover the packages the apps are built on, and each carries its id
 * from `apps/mvp/docs/rules.md`, their catalog. This module holds their text
 * once; a package names its `role` and gets an `ImportRules` target for the
 * rules a parser can check and a `JevRules` target for the ones that need
 * judgment. Every glob is relative to the declaring package, so neither target
 * reads across a package boundary.
 *
 * @since 0.1.0
 */

import { ImportRules } from "./ImportRules.ts"
import type { ImportRulesTarget } from "./ImportRules.ts"
import type { ImportRule } from "./ImportRulesCheck.ts"
import { JevRules } from "./JevRules.ts"
import type { JevRule, JevRulesTarget } from "./JevRules.ts"

/**
 * What an SDK package is, which decides the rules it takes.
 *
 * - `library`: a platform-neutral, Effect-first library meant for any app.
 *   Every rule applies.
 * - `app-library`: a platform-neutral, Effect-first library that holds the
 *   Smithers app's own contracts or host, such as `@smthrs/rpc`. Every rule
 *   but `sdk.generic-libraries` applies.
 * - `host`: a `@smthrs/platform-*` package, which owns platform code. Every
 *   rule but `sdk.platform-neutral` applies.
 * - `components`: `@smthrs/ui`, `@smthrs/repo-view` and
 *   `@smthrs/terminal-frame`, which render React. Only
 *   `sdk.root-imports-only`, `sdk.no-dead-code`, `test.no-mocks-of-our-code`
 *   and `test.behavioral` apply.
 *
 * @category models
 * @since 0.1.0
 */
export type Role = "library" | "app-library" | "host" | "components"

/**
 * Subpaths of Smithers packages that a package still imports: known
 * violations of `sdk.root-imports-only`.
 *
 * @category models
 * @since 0.1.0
 */
export interface KnownDeepImports {
  /** Package names under `@smthrs/`, such as `@smthrs/cli`, whose subpaths stay allowed. */
  readonly packages: ReadonlyArray<string>
  /** Why each import cannot use the root yet, and what removes it. */
  readonly because: string
}

/**
 * Options accepted by {@link SdkRules}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The workspace-relative directory of the declaring package, such as `packages/rpc`. */
  readonly cwd: string
  readonly role: Role
  /**
   * Package-relative globs of the package's test files, which
   * `test.behavioral` and `test.no-mocks-of-our-code` read.
   *
   * @default ["test/**\/*.test.ts", "test/**\/*.test.vibe"]
   */
  readonly tests?: ReadonlyArray<string> | undefined
  /** @default none: every `@smthrs/*` import names a package root */
  readonly knownDeepImports?: KnownDeepImports | undefined
}

/**
 * The targets {@link SdkRules} returns.
 *
 * @category models
 * @since 0.1.0
 */
export interface SdkRulesTargets {
  /** The deterministic rules, a `test`-kind target. */
  readonly importRules: ImportRulesTarget
  /** The judgment rules, a manual `lint`-kind target that needs `AI_GATEWAY_API_KEY`. */
  readonly jevRules: JevRulesTarget
}

// A package's TypeScript and VibeLang modules, tests left out.
const sources = ["src/**/!(*.test).ts", "src/**/!(*.test).tsx", "src/**/!(*.test).vibe"]
const defaultTests = ["test/**/*.test.ts", "test/**/*.test.vibe"]

const effectFirst: ReadonlyArray<Role> = ["library", "app-library", "host"]
const platformNeutral: ReadonlyArray<Role> = ["library", "app-library"]
const generic: ReadonlyArray<Role> = ["library", "host"]

const runnerNames = ["runPromise", "runPromiseExit", "runSync", "runSyncExit", "runFork", "runCallback"]
const runCalls = runnerNames.flatMap((name) => [name, `*.${name}`])

/** The `@smthrs/*` glob that leaves out the packages a declaration still deep-imports. */
const rootImportPackages = (known: KnownDeepImports | undefined): string => {
  if (known === undefined) return "@smthrs/*"
  const names = known.packages.map((name) => {
    const short = name.startsWith("@smthrs/") ? name.slice("@smthrs/".length) : ""
    if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) {
      throw new TypeError(`SdkRules knownDeepImports package "${name}" must be a @smthrs/<name> package name`)
    }
    return short
  })
  if (names.length === 0 || known.because.trim() === "") {
    throw new TypeError("SdkRules knownDeepImports needs at least one package and a because")
  }
  return `@smthrs/!(${names.join("|")})`
}

const importRulesFor = (
  role: Role,
  known: KnownDeepImports | undefined,
  tests: ReadonlyArray<string>
): ReadonlyArray<ImportRule> => [
  ...(platformNeutral.includes(role)
    ? [{
      kind: "forbidHostModules" as const,
      files: ["src/**"],
      because: "sdk.platform-neutral: host code lives in @smthrs/platform-* and arrives as injected services. See " +
        "\"Use the Smithers libraries\" in the root AGENTS.md."
    }]
    : []),
  {
    kind: "rootImportsOnly",
    files: ["src/**", "examples/**"],
    packages: [rootImportPackages(known)],
    because: "sdk.root-imports-only: import Smithers packages from their root entry. See apps/mvp/docs/rules.md." +
      (known === undefined ? "" : ` Known deep imports: ${known.because}`)
  },
  ...(effectFirst.includes(role)
    ? [{
      kind: "forbidCalls" as const,
      files: ["src/**"],
      callees: runCalls,
      includeReferences: true,
      because: "effect.boundary-only: a library returns Effects and runs none; the program's boundary runs them. A " +
        "callback a third-party library calls captures Effect.context() and uses Effect.runPromiseWith. See " +
        "apps/mvp/docs/rules.md."
    }]
    : []),
  {
    kind: "forbidCalls",
    files: tests,
    callees: [
      "vi.spyOn().mockReturnValue",
      "vi.useFakeTimers",
      "vi.setSystemTime"
    ],
    because: "test.no-mocks-of-our-code: tests inject an Effect Clock or TestClock for controlled time. " +
      "Never replace the process clock with a return-value spy or fake timers. See apps/mvp/docs/rules.md."
  }
]

const jevRulesFor = (role: Role, tests: ReadonlyArray<string>): ReadonlyArray<JevRule> => [
  ...(platformNeutral.includes(role)
    ? [{
      id: "sdk.platform-neutral",
      files: sources,
      lookFor: "Does this library module use a host-specific API, such as process, Buffer, __dirname, require, " +
        "node: or bun: modules, the DOM, child processes or the filesystem, instead of receiving it as an injected " +
        "service?",
      violation: "A library module reaches a host API directly.",
      compliant: "The module uses only platform-neutral APIs and receives host capabilities as injected services."
    }]
    : []),
  ...(effectFirst.includes(role)
    ? [
      {
        id: "effect.boundary-only",
        files: sources,
        lookFor: "Does this library module run an Effect, with Effect.runPromise, runSync, runFork or runCallback, " +
          "their ...With forms, or a ManagedRuntime or Runtime's run methods, instead of returning Effects for the " +
          "program's boundary to run? A callback a third-party library calls, which must return a Promise or a " +
          "value, may bridge.",
        violation: "A library module runs an Effect where it could return one.",
        compliant: "The module returns Effects, or bridges only inside a callback a third-party library calls."
      },
      {
        id: "effect.wrap-every-library",
        files: sources,
        lookFor: "Does this library module expose a third-party library's Promise, callback or class API to its " +
          "callers, or call it in its own logic, instead of wrapping it in Effect?",
        violation: "A third-party library's non-Effect API is used or exposed without an Effect wrapper.",
        compliant: "Third-party APIs are reached through Effect, or the module uses none."
      }
    ]
    : []),
  ...(generic.includes(role)
    ? [{
      id: "sdk.generic-libraries",
      files: sources,
      lookFor: "Does this library module contain names, tables, routes, copy or defaults specific to one app, such " +
        "as messages, chat, ChatApi or smithers.sh, that make it unusable by other apps?",
      violation: "The library is tied to one app.",
      compliant: "The library holds no app-specific names, tables, routes, copy or defaults."
    }]
    : []),
  ...(effectFirst.includes(role)
    ? [{
      id: "obs.content-free",
      files: sources,
      lookFor: "Does this module record user content or secrets, such as message text, a prompt, a model's output, " +
        "a provider's error text or a credential, in a log line, a span attribute, a span event, a span's failure, " +
        "or a metric attribute? Text returned to a caller or shown in a UI is not recorded. A span opened with " +
        "SpanFailure.fn records no failure text, and a value passed through redaction before it is recorded is " +
        "not content.",
      violation: "The module records content, provider text or a credential in telemetry.",
      compliant: "The module records only ids, counts, durations, sizes, status and error codes, or records nothing."
    }]
    : []),
  {
    id: "sdk.no-dead-code",
    files: sources,
    lookFor: "Treat every export as used: other files may import it. Does this module contain dead or duplicate " +
      "code: commented-out code, an unreachable branch, a local declaration or parameter the module never uses, a " +
      "placeholder or TODO stub, or a second implementation of logic the module already has?",
    violation: "The module contains dead, unused, placeholder or duplicated code.",
    compliant: "Every declaration and branch in the module is used, and nothing is implemented twice.",
    severity: "warning"
  },
  {
    id: "test.behavioral",
    files: tests,
    lookFor: "Does this test file contain a test that cannot fail or does not test behavior: an assertion that " +
      "only echoes a constant or the test's own setup, a tautology, a test with no meaningful assertion, a fixed " +
      "sleep instead of waiting on a condition or TestClock, or a check that code was called rather than what it " +
      "did?",
    violation: "At least one test cannot fail, asserts nothing meaningful, echoes constants or sleeps for a fixed " +
      "time.",
    compliant: "Every test drives behavior through a public interface and asserts observable outcomes that would " +
      "fail if the behavior broke."
  }
]

/**
 * Declares an SDK package's `importRules` and `jevRules` targets.
 *
 * `importRules` forbids host modules in `src/` (`sdk.platform-neutral`), a
 * deep import of a Smithers package in `src/` or `examples/`
 * (`sdk.root-imports-only`), and running an Effect in `src/`
 * (`effect.boundary-only`). `jevRules` asks Jev the judgment half of those
 * rules plus `effect.wrap-every-library`, `sdk.generic-libraries`,
 * `obs.content-free`, `sdk.no-dead-code` (advisory) and `test.behavioral`,
 * with a finding at a probability of 0.7. `role` drops the rules that do not
 * hold for the package; see {@link Role}. `knownDeepImports` lists the
 * packages whose subpaths the package still imports, and its `because` joins
 * the rule's message. An empty list, a name outside `@smthrs/`, or a blank
 * `because` throws a `TypeError`, as does a `cwd` either macro refuses.
 *
 * @example
 * ```ts
 * import { SdkRules } from "@smthrs/repo-targets"
 *
 * const { importRules, jevRules } = SdkRules({ cwd: "packages/effect-electric", role: "library" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const SdkRules = (options: Options): SdkRulesTargets => ({
  importRules: ImportRules({ cwd: options.cwd, rules: importRulesFor(options.role, options.knownDeepImports, options.tests ?? defaultTests) }),
  jevRules: JevRules({
    cwd: options.cwd,
    threshold: 0.7,
    summary: "Will's SDK-wide judgment rules, asked of Jev one file at a time.",
    rules: jevRulesFor(options.role, options.tests ?? defaultTests)
  })
})
