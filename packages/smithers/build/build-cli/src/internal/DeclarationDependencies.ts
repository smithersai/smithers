/**
 * Checks the physical runtime selected by ordinary Node package resolution.
 *
 * `findPackageJSON` uses Node's default resolver on the supported runtimes,
 * independently of installed resolve hooks. A bootstrap alias therefore cannot
 * hide a conflicting workspace installation from this check. This is a physical
 * installation check, not proof of identity across arbitrary loader namespaces.
 *
 * @since 1.0.0
 */

import { readFileSync, realpathSync } from "node:fs"
import * as NodeModule from "node:module"
const findPackageJSON = (
  specifier: string | URL,
  base?: string | URL
): string | undefined => NodeModule.findPackageJSON(specifier, base)
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import * as Diagnostic from "../Diagnostic.ts"
import { PackageError } from "../PackageError.ts"
import * as Fs from "./Fs.ts"

const sharedPackages = ["effect", "@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"] as const

const majorVersionOf = (manifestPath: string): number | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return undefined
    const version = (parsed as { readonly version?: unknown }).version
    if (typeof version !== "string") return undefined
    const match = /^(\d+)\./.exec(version.trim())
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

const hasLocalSmithersTargets = (file: string): boolean => {
  try {
    return findPackageJSON("@smthrs/targets", pathToFileURL(file)) !== undefined
  } catch {
    return false
  }
}

/**
 * Whether the declaration resolves the CLI's own `@smthrs/targets`. The
 * authoring API then imports Effect from its own installation, the CLI's, so a
 * different Effect a sibling package installs for its application code never
 * reaches a declaration that does not import `effect` itself.
 */
const resolvesCliTargets = (file: string): boolean => {
  try {
    const cli = findPackageJSON("@smthrs/targets", import.meta.url)
    const declared = findPackageJSON("@smthrs/targets", pathToFileURL(file))
    return cli !== undefined && declared !== undefined &&
      realpathSync.native(cli) === realpathSync.native(declared)
  } catch {
    return false
  }
}

const declarationImportsEffect = (file: string): boolean => {
  try {
    const source = readFileSync(file, "utf8")
    return /(?:from\s+|import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*["']effect(?:\/[^"']*)?["']/.test(source)
  } catch {
    // If unreadable, conservatively assume it may import effect.
    return true
  }
}

/**
 * The code and message of the failure a refusal is standing in for.
 *
 * The refusal carries its cause, and the documentation says to read it, but
 * nothing renders it: the Windows runner reported
 * `cannot resolve @smthrs/targets; install the workspace dependencies and run
 * its local CLI` and no more, which names neither the filesystem error nor the
 * resolution error that produced it. A host-only failure cannot be fixed from
 * a message that withholds the one fact that differs per host, so the cause
 * travels in the message too.
 */
const describeCause = (cause: unknown): string =>
  [Fs.errorCode(cause), Diagnostic.message(cause, String(cause))].filter((part) => part !== undefined).join(": ")

/**
 * Refuses a declaration closure that would select another physical runtime.
 *
 * Missing packages remain admissible only when the caller explicitly requests
 * the existing dependency-free bootstrap contract. Installed conflicts and
 * resolution errors always fail, including in bootstrap mode.
 *
 * @category validation
 * @since 1.0.0
 */
export const assertDeclarationDependencies = (
  files: ReadonlyArray<string>,
  options: { readonly bootstrap: boolean }
): void => {
  const checkedDirectories = new Map<string, { readonly skipConsumerEffect: boolean }>()
  for (const file of files) {
    const directory = dirname(file)
    const cached = checkedDirectories.get(directory)
    if (cached !== undefined) {
      if (cached.skipConsumerEffect && declarationImportsEffect(file)) {
        // Re-check this file because it imports effect directly alongside a foreign effect install.
      } else {
        continue
      }
    }
    let skipConsumerEffect = false
    for (const dependency of sharedPackages) {
      let expected: string
      let actual: string
      try {
        // Every shared package is a bare specifier, for which Node answers the
        // package's manifest path or throws; it never answers undefined.
        const cli = findPackageJSON(dependency, import.meta.url)!
        // Self-resolution can return an extended Windows path. Node's
        // JavaScript realpath walker misreads its drive root on supported
        // releases; the native resolver preserves the physical-file check.
        expected = realpathSync.native(cli)
        let declared: string
        try {
          declared = findPackageJSON(dependency, pathToFileURL(file))!
        } catch (cause) {
          if (
            options.bootstrap && typeof cause === "object" && cause !== null &&
            "code" in cause && cause.code === "ERR_MODULE_NOT_FOUND"
          ) continue
          throw cause
        }
        actual = realpathSync.native(declared)
      } catch (cause) {
        throw new PackageError(
          "declaration_dependency_unresolved",
          `cannot resolve ${dependency}; install the workspace dependencies and run its local CLI ` +
            `(${describeCause(cause)})`,
          { path: file, cause }
        )
      }
      if (actual !== expected) {
        // A consumer repo may depend on a different major version of Effect
        // (e.g. Effect v3) for its own application code while its PACKAGE.ts
        // only imports @smthrs/targets: either with no local install
        // (bootstrap) or with a local install that is the CLI's own copy.
        // The CLI's ESM resolve hooks pin @smthrs/targets and its Effect v4 runtime
        // to the CLI installation, so allow this when the declaration does not import
        // effect directly and the consumer manifest parses cleanly as another major.
        if (
          options.bootstrap &&
          dependency === "effect" &&
          (!hasLocalSmithersTargets(file) || resolvesCliTargets(file)) &&
          !declarationImportsEffect(file)
        ) {
          const expectedMajor = majorVersionOf(expected)
          const actualMajor = majorVersionOf(actual)
          if (expectedMajor !== undefined && actualMajor !== undefined && actualMajor !== expectedMajor) {
            skipConsumerEffect = true
            continue
          }
        }
        throw new PackageError(
          "declaration_dependency_mismatch",
          `${dependency} resolves to ${actual}, but the CLI uses ${expected}; ` +
            "install matching workspace dependencies and run the workspace-local CLI; " +
            "remove linked packages' private runtime copies",
          { path: file }
        )
      }
    }
    checkedDirectories.set(directory, { skipConsumerEffect })
  }
}
