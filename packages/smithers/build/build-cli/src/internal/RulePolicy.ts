/**
 * Package rule policy shared by planning, scheduling, and execution.
 *
 * @since 1.0.0
 */

import * as Input from "@smthrs/targets/Input"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Path from "node:path"
import type { Mode, PlannedRule, Selection } from "./RuleContract.ts"

interface Policy {
  readonly reads?: "declared" | "sandbox"
  readonly sandbox?: "none" | "network" | "unconfined-default"
  readonly overlay?: boolean
  readonly check?: boolean
  readonly outward?: boolean
  readonly attended?: boolean
  readonly keyOnly?: boolean
  readonly service?: boolean
  readonly exclusive?: boolean
  readonly writes?: boolean
  readonly cache?: "always" | "read" | "execute" | "check" | "clean-repository"
}

/** Every rule the planner selects natively; declaration bodies are named at runtime. */
type NativeRule = Exclude<Selection, { readonly family: "body" }>["rule"]

/** A row per native rule, so a new or renamed rule fails typecheck until it is stated here.
 * Declaration bodies may add rows; they are looked up through the string index.
 */
const policies: Readonly<Record<NativeRule, Policy>> & Readonly<Record<string, Policy>> = {
  "Agent.Diff": { outward: true, exclusive: true, writes: true },
  "Agent.Lint": { check: true },
  "Agent.Pr": { outward: true, exclusive: true, writes: true },
  "Alias": { reads: "declared" },
  "Anvil.Fork": { sandbox: "network", outward: true, service: true },
  "Api.Compat": { cache: "always" },
  "Bundler.Rspack.build": { writes: true, cache: "always" },
  "Bundler.Rspack.resolve": { cache: "always" },
  "Cargo.AppSet": { reads: "declared" },
  "Cargo.Build": { writes: true },
  "Cargo.Clippy": { writes: true, cache: "read" },
  "Cargo.Deny": { writes: true, cache: "read" },
  "Cargo.Doc": { writes: true },
  "Cargo.Fetch": { writes: true },
  "Cargo.Fmt": { check: true, cache: "read" },
  "Cargo.Nextest": { writes: true, cache: "read" },
  "Cargo.Test": { writes: true, cache: "read" },
  "Changesets.Publish": { outward: true },
  "Changesets.Version": { check: true, exclusive: true, writes: true, cache: "check" },
  "Clean": { outward: true, keyOnly: true, writes: true },
  "Copy": { writes: true, cache: "always" },
  "Cron": { keyOnly: true },
  "Docker.Bake": { sandbox: "unconfined-default", writes: true, cache: "always" },
  "Docker.Build": { sandbox: "unconfined-default", writes: true, cache: "always" },
  "Docker.Push": { sandbox: "unconfined-default", outward: true },
  "Docker.Serve": { sandbox: "none", outward: true, service: true },
  "Docker.Service": { sandbox: "none", outward: true, service: true },
  "Docs.Check": { check: true },
  "Docs.Page": { outward: true, attended: true, exclusive: true, writes: true },
  "FactoryProjection": { check: true },
  "Fetch": { sandbox: "network", writes: true, cache: "always" },
  "Filegroup": { reads: "declared" },
  "Foundry.Build": { overlay: true, writes: true, cache: "always" },
  "Foundry.Fmt": { check: true, cache: "check" },
  "Foundry.Test": { overlay: true, cache: "execute" },
  // Scratch checks still census the live ignored tree and restore escaping
  // symlink portals. Keep their snapshots apart from every peer's writes.
  "Generate": { check: true, exclusive: true, cache: "check" },
  "Git.Commit": { outward: true, exclusive: true, writes: true },
  "Git.Pr": { outward: true },
  "Git.Submodule": { sandbox: "network", writes: true, cache: "always" },
  "Git.Submodules": { sandbox: "network", writes: true, cache: "always" },
  "Github.CiGen": { check: true, keyOnly: true },
  "Github.Pages": { outward: true },
  "Github.Pr": { outward: true },
  "Github.Release": { outward: true },
  "Github.Setup": { keyOnly: true },
  "Github.Workflow": { keyOnly: true },
  "Go.Binary": { cache: "always" },
  "Go.Fuzz": { cache: "always" },
  "Go.Generate": { check: true, exclusive: true, cache: "check" },
  "Go.Lint": { check: true, exclusive: true, cache: "check" },
  "Go.ModDownload": { cache: "always" },
  "Go.Packages": { reads: "declared" },
  "Go.Test": { cache: "always" },
  "ImportClosure": {},
  "Install": {},
  "Literal": { writes: true, cache: "always" },
  "Markdown.CodeBlocks": { cache: "always" },
  "Materialize": { writes: true },
  "Memory.Retain": { outward: true },
  "Npm.Downstream": { cache: "always" },
  "Npm.Pack": { writes: true, cache: "always" },
  "Npm.Publish": { outward: true },
  "Npm.Published": { sandbox: "network", writes: true, cache: "always" },
  "Overlay": { cache: "always" },
  "Owners.Codeowners": { check: true },
  "Owners.Tree": { check: true },
  "Repo.Target": { cache: "clean-repository" },
  "Shell.Build": { reads: "sandbox", overlay: true, writes: true, cache: "always" },
  "Shell.Diff": { check: true, exclusive: true },
  "Shell.Run": { reads: "sandbox", overlay: true, outward: true },
  "Shell.Serve": { outward: true, service: true },
  "Shell.Test": { reads: "sandbox", overlay: true, cache: "execute" },
  "Size.Budgets": { cache: "always" },
  "Suite": { reads: "declared" },
  "TargetIndex": { check: true },
  "Test": { cache: "always" }
}

/** Looks up a rule's intrinsic policy; unknown target bodies keep their declaration policy.
 * @category policies
 * @since 1.0.0
 */
export const of = (rule: string): Policy => policies[rule] ?? {}

/** Whether a native rule adds cacheability beyond its declaration.
 * Cargo builds keep their incremental tree; only checks replay a verdict.
 * @category policies
 * @since 1.0.0
 */
export const cacheable = (rule: string, mode: Mode, repositoryDirty: boolean | undefined): boolean => {
  const cache = of(rule).cache
  return cache === "always" || cache === mode || (cache === "read" && mode !== "write") ||
    (cache === "clean-repository" && repositoryDirty === false)
}

/** Capabilities implied by the rule, invocation mode, and sandbox.
 * @category policies
 * @since 1.0.0
 */
export const capabilities = (rule: string, mode: Mode, sandbox: PlannedRule["sandbox"]): ReadonlyArray<string> => {
  const result = ["fs:read", "proc:spawn"]
  if (mode === "write" || of(rule).writes) result.push("fs:write")
  if (sandbox === "none" || (typeof sandbox === "object" && sandbox.network === true)) result.push("net:open")
  else if (typeof sandbox === "object" && sandbox.network === "loopback") result.push("net:loopback")
  return result
}

/** The intrinsic full-network policy; filesystem confinement is unchanged.
 * @category policies
 * @since 1.0.0
 */
export const networkSandbox = { network: true } as const

/** Resolves intrinsic rule overrides before either planning or affected selection.
 * This is declaration-only: an unavailable host mechanism fails execution closed.
 * @category policies
 * @since 1.0.0
 */
export const sandbox = (rule: string, declared: PlannedRule["sandbox"]): PlannedRule["sandbox"] => {
  switch (of(rule).sandbox) {
    case "network":
      return networkSandbox
    case "none":
      return "none"
    case "unconfined-default":
      return declared ?? "none"
    default:
      return declared
  }
}

/** Whether sibling files can be read beyond declared inputs.
 * Value rules marked declared read only their expanded inputs or dependency
 * results. Only audited native process routes promise exec confinement;
 * services, custom bodies, generated-output readers and host-side backends
 * remain conservative. Every kind must keep the promise.
 * @category policies
 * @since 1.0.0
 */
export const readsPackage = (
  rule: string,
  attrs: ReadonlyArray<unknown>,
  sandboxes: WorkspaceDeclaration.SandboxesDeclaration | undefined
): boolean => {
  const reads = of(rule).reads
  if (reads === "declared") return false
  const mechanism = sandboxes?.sandboxes["default"]
  if (reads !== "sandbox" || mechanism === undefined || mechanism._tag === "SandboxNone") return true
  return attrs.some((value) => {
    const declared = (value as { readonly sandbox?: PlannedRule["sandbox"] } | undefined)?.sandbox
    return sandbox(rule, declared) === "none"
  })
}

/** Resolves native build outputs once for both planning and affected read grants.
 * @category policies
 * @since 1.0.0
 */
export const buildOutputs = (attrs: unknown, packagePath: string) => {
  const values = attrs as { readonly outDirs?: unknown; readonly outFiles?: unknown }
  const paths = (value: unknown): ReadonlyArray<string> =>
    Array.isArray(value)
      ? value.filter((path): path is string => typeof path === "string").map((path) =>
        Input.resolvePath(packagePath, path)
      )
      : []
  return { outDirs: paths(values.outDirs), outFiles: paths(values.outFiles) }
}

/** Directories an exec sandbox admits in addition to source inputs.
 * Output files require a writable parent for atomic replacement. Those parents
 * are readable too, as are output directories, dependency trees and the cache.
 * Match these grants even across packages; confinement is not declared-only
 * access when a writable mount admits an undeclared sibling.
 * @category policies
 * @since 1.0.0
 */
export const sandboxReadDirectories = (
  rule: string,
  attrs: ReadonlyArray<unknown>,
  packagePath: string,
  cacheDirectory: string,
  moduleDirectories: ReadonlyArray<string>
): ReadonlyArray<string> => {
  if (of(rule).reads !== "sandbox") return []
  const directories = new Set([cacheDirectory, ...moduleDirectories])
  if (rule === "Shell.Build") {
    for (const value of attrs) {
      const outputs = buildOutputs(value, packagePath)
      for (const directory of outputs.outDirs) directories.add(directory)
      for (const file of outputs.outFiles) directories.add(Path.posix.dirname(file))
    }
  }
  return [...directories]
}
