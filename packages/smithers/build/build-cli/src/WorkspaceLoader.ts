/**
 * Workspace module validation.
 *
 * The workspace module exports exactly one `Workspace` declaration under the
 * export name `Workspace`. The plain workspace file, `.smithers/WORKSPACE.smithers`
 * or the file `--workspace-file` names, may also export `Package`: the root package, declared where no other tool
 * of the repository reads it. It may import its `.smithers/agents.js` and
 * `.smithers/sandbox.js` siblings and the root Package for git hooks; the
 * relationship is one-way — no Package module may import WORKSPACE.ts, which
 * the loader's static import scan enforces.
 *
 * @since 0.1.0
 */

import * as Package from "@smthrs/targets/Package"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodePath from "node:path"
import { byCodeUnit } from "./internal/Text.ts"
import { isPlainWorkspaceFile } from "./internal/WorkspaceFiles.ts"
import { PackageError } from "./PackageError.ts"

/**
 * The root package a plain workspace file declares, or undefined when the
 * module exports none. A plain workspace file is `.smithers/WORKSPACE.smithers`
 * or the file `--workspace-file` names, recorded by its absolute path. Any other workspace file declares no package, and
 * {@link validateWorkspaceModule} has refused one that tries.
 *
 * The package is `//`, exactly as a root `PACKAGE.ts` declares it: a path in
 * one of its targets resolves from the workspace root, because a target
 * written in this file belongs to the package that lists it.
 *
 * @category loading
 * @since 1.0.0
 */
export const rootPackageOf = (namespace: unknown, file: string): Package.PackageValue | undefined => {
  if (!isPlainWorkspaceFile(file) || typeof namespace !== "object" || namespace === null) return undefined
  const exported = (namespace as { readonly Package?: unknown }).Package
  if (exported === undefined) return undefined
  if (!Package.isPackage(exported)) {
    throw new PackageError("invalid_package_export", "the Package export is not an S.Package value", { path: file })
  }
  return exported
}

/**
 * Validates one evaluated workspace module namespace.
 *
 * @category loading
 * @since 0.1.0
 */
export const validateWorkspaceModule = (
  namespace: unknown,
  file: string
): WorkspaceDeclaration.WorkspaceDeclaration => {
  const name = NodePath.posix.basename(file)
  if (typeof namespace !== "object" || namespace === null) {
    throw new PackageError("module_import_failed", `${name} did not evaluate to a module namespace`, {
      path: file
    })
  }
  let workspace: WorkspaceDeclaration.WorkspaceDeclaration | undefined
  for (const [exportName, value] of Object.entries(namespace).sort(([left], [right]) => byCodeUnit(left, right))) {
    if (WorkspaceDeclaration.isWorkspaceDeclaration(value)) {
      if (exportName !== "Workspace") {
        throw new PackageError(
          "workspace_export_duplicate",
          `a workspace declaration is exported as ${
            JSON.stringify(exportName)
          }; the one legal export name is Workspace`,
          { path: file }
        )
      }
      workspace = value
      continue
    }
    if (Target.isTarget(value)) {
      throw new PackageError(
        "naked_target_export",
        `${name} exports a naked target ${
          JSON.stringify(exportName)
        }; targets are addressable only through a Package map`,
        { path: file }
      )
    }
    if (Package.isPackage(value)) {
      // The plain workspace file declares the root package under the one name a PACKAGE.ts uses.
      const plain = isPlainWorkspaceFile(file)
      if (plain && exportName === "Package") continue
      throw new PackageError(
        plain ? "invalid_package_export" : "workspace_export_duplicate",
        plain
          ? `a Package value is exported as ${JSON.stringify(exportName)}; the one legal export name is Package`
          : `${name} exports a Package value ${JSON.stringify(exportName)}`,
        {
          path: file
        }
      )
    }
  }
  if (workspace === undefined) {
    throw new PackageError("workspace_export_missing", `${name} has no Workspace export`, { path: file })
  }
  return workspace
}
