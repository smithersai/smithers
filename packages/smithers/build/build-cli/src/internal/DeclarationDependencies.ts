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

import { realpathSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import * as Diagnostic from "../Diagnostic.ts"
import { PackageError } from "../PackageError.ts"
import * as Fs from "./Fs.ts"

const sharedPackages = ["effect", "@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"] as const

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
  const directories = new Set<string>()
  for (const file of files) {
    const directory = dirname(file)
    if (directories.has(directory)) continue
    directories.add(directory)
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
        throw new PackageError(
          "declaration_dependency_mismatch",
          `${dependency} resolves to ${actual}, but the CLI uses ${expected}; ` +
            "install matching workspace dependencies and run the workspace-local CLI; " +
            "remove linked packages' private runtime copies",
          { path: file }
        )
      }
    }
  }
}
