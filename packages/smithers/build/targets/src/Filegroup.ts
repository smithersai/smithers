/**
 * Bazel-style file groups.
 *
 * A file group names a set of files under one label so other targets can
 * depend on the set instead of repeating its globs. It follows Bazel's
 * `filegroup`: `srcs` accepts declared files, declared globs, and other
 * targets, groups compose, and the group's contents are the deterministic,
 * deduplicated transitive union of everything it names.
 *
 * The target participates in no CLI verb. `kinds` is empty, so `smithers-build build`,
 * `test`, `lint`, and `docs` never select a group as a root; the CLI handles
 * that cleanly because {@link Target.Metadata} kinds are only consulted when the
 * planner filters roots, while dependency traversal, `query`, and `graph`
 * ignore them. A group reached as a dependency still executes, and executing
 * it is a successful no-op: {@link ExpandFilegroup} reads nothing but the
 * files the group names and returns them digested.
 *
 * ## Deviations from Bazel
 *
 * These are deliberate, and the general target when the two disagree is to
 * follow Bazel:
 *
 * - **No visibility.** Bazel gates every target behind `visibility`, and a
 *   `filegroup` is the usual way to publish files across package boundaries.
 *   smithers build has no visibility system yet, so every group is effectively
 *   public. When visibility lands, groups get it with every other target.
 * - **No `exports_files`, and `//`-anchored `file()` references stay legal.**
 *   In Bazel a package must export a file before another package may name it,
 *   and naming a file in another package without that export is an error.
 *   smithers build lets any target write `file("//path/to/file")` directly. A group
 *   is therefore a convenience for naming a set, not the only legal way to
 *   cross a package boundary.
 * - **A non-group target in `srcs` contributes no files.** Bazel takes such a
 *   target's default output group. smithers build has no output-file model yet, so a
 *   plain target in `srcs` is kept as an ordinary dependency edge — it is
 *   built before the group and its key reaches the group's key — but it adds
 *   nothing to the file list.
 *
 * Package-scoped globs, the other half of Bazel's file model, are implemented
 * in {@link Input.expandGlob} for every target, not only for groups.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import { failureMessage } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Target from "./Target.ts"

/**
 * One declared file source a group can expand on its own.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Source = Schema.Union([Input.File, Input.Glob])

/**
 * One declared file source a group can expand on its own.
 *
 * @category models
 * @since 0.1.0
 */
export type Source = typeof Source.Type

/**
 * One entry of a group's `srcs`: a declared file, a declared glob, or another
 * target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Member = Schema.Union([Input.File, Input.Glob, Target.Target])

/**
 * One entry of a group's `srcs`.
 *
 * @category models
 * @since 0.1.0
 */
export type Member = typeof Member.Type

/**
 * One expanded group member: a workspace-relative path and its content
 * digest, null when the file does not exist.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Entry = Schema.Struct({
  path: Schema.String,
  digest: Schema.NullOr(Schema.String)
})

/**
 * One expanded group member.
 *
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type

/**
 * A group's expanded contents, sorted by path and deduplicated.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Files = Schema.Array(Entry)

/**
 * A group's expanded contents.
 *
 * @category models
 * @since 0.1.0
 */
export type Files = typeof Files.Type

/**
 * Expanding a group's declared sources failed on a filesystem error.
 *
 * A member that does not exist is not an error: it expands to a null digest.
 *
 * @category errors
 * @since 0.1.0
 */
export class FilegroupError extends Schema.TaggedError<FilegroupError>()(
  "smithers-build/FilegroupError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * Attributes for {@link Filegroup}.
 *
 * `srcs` names declared files, declared globs, and other targets in the order
 * they should be read. `cwd` is the workspace-relative package directory the
 * declared paths and patterns resolve from when the group expands. The CLI
 * interprets the default `.` as the declaring PACKAGE.ts package, matching
 * Bazel; an explicit non-dot value is workspace relative.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  srcs: Schema.Array(Member),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Filegroup}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * One declared source together with the directory its paths resolve from.
 *
 * `base` is the absolute directory of the PACKAGE.ts that declared the
 * source, or `""` for an explicit workspace-relative cwd or a target constructed
 * outside a PACKAGE.ts module, as tests do. A source's `//` prefix still
 * resolves from the workspace root. The executing layer maps a
 * non-empty `base` onto its workspace-relative package path; it is carried
 * as context for that mapping and is never cache-key material.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AnchoredSource = Schema.Struct({
  base: Schema.String,
  source: Source
})

/**
 * One declared source together with the directory its paths resolve from.
 *
 * @category models
 * @since 0.1.0
 */
export type AnchoredSource = typeof AnchoredSource.Type

/**
 * Payload for one group expansion: declared sources with their package anchors.
 *
 * The executing layer maps each `base` onto its workspace before resolving
 * that source. Nested groups retain their own declaring package.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Payload = Schema.Struct({
  sources: Schema.Array(AnchoredSource)
})

/**
 * Payload for one group expansion.
 *
 * @category models
 * @since 0.1.0
 */
export type Payload = typeof Payload.Type

/**
 * The target id every {@link Filegroup} target reports as `Target.Metadata.target`.
 *
 * @category constants
 * @since 0.1.0
 */
export const ruleId = "Filegroup"

/**
 * Checks whether a value is a {@link Filegroup} target.
 *
 * @category guards
 * @since 0.1.0
 */
export const isFilegroup = (value: unknown): value is Target.AnyTarget =>
  Target.isTarget(value) && Target.metadata(value).target === ruleId

/** Rewrites one declared source so its paths are workspace-relative. */
const resolveSource = (cwd: string, source: Source): Source =>
  source._tag === "File"
    ? { _tag: "File", path: Input.resolvePath(cwd, source.path) }
    : {
      _tag: "Glob",
      pattern: Input.resolvePath(cwd, source.pattern),
      exclude: source.exclude.map((entry) => Input.resolvePath(cwd, entry))
    }

/** Walks one group's `srcs` depth first, entering nested groups once each. */
const gather = (
  attrs: Attrs,
  context: Target.ImplementationContext,
  seen: Set<Target.AnyTarget>,
  into: Array<AnchoredSource>
): void => {
  const packageRelative = attrs.cwd === "."
  const base = packageRelative ? context.packageDirectory ?? "" : ""
  for (const member of attrs.srcs) {
    if (Target.isTarget(member)) {
      if (!isFilegroup(member) || seen.has(member)) continue
      seen.add(member)
      const metadata = Target.metadata(member)
      gather(
        metadata.attrs as Attrs,
        {
          sourceFile: metadata.sourceFile,
          packageDirectory: metadata.sourceFile === undefined ? undefined : NodePath.dirname(metadata.sourceFile)
        },
        seen,
        into
      )
      continue
    }
    into.push({ base, source: packageRelative ? member : resolveSource(attrs.cwd, member) })
  }
}

/**
 * Flattens one group's `srcs` into declared sources with package anchors.
 *
 * The walk is depth first in `srcs` order and enters each nested group once,
 * so a diamond of groups contributes its shared members once and the result
 * is deterministic. The default `cwd: "."` anchors at
 * `context.packageDirectory`; an explicit cwd is workspace relative.
 * Nested groups use their own declaration context. Targets that are not
 * groups are skipped: they stay dependency edges and contribute no files.
 *
 * @category expansion
 * @since 0.1.0
 */
export const sources = (
  attrs: Attrs,
  context: Target.ImplementationContext
): ReadonlyArray<AnchoredSource> => {
  const found: Array<AnchoredSource> = []
  gather(attrs, context, new Set(), found)
  return found
}

/** Expands sources from their individual package directories into one digested union. */
const expandFromPackages = async (
  workspaceRoot: string,
  declared: ReadonlyArray<{ readonly packageDirectory: string; readonly source: Source }>,
  options: { readonly cacheDirectory?: string | undefined }
): Promise<Files> => {
  const paths = new Set<string>()
  for (const { packageDirectory, source } of declared) {
    if (source._tag === "File") {
      paths.add(Input.resolvePath(packageDirectory, source.path))
      continue
    }
    const matches = await Input.expandGlob(workspaceRoot, packageDirectory, source, {
      cacheDirectory: options.cacheDirectory
    })
    for (const match of matches) paths.add(match)
  }
  const digested = await Input.digestFiles(workspaceRoot, [...paths])
  return digested.map(({ digest, path }) => ({ path, digest: digest ?? null }))
}

/** Maps a declaration anchor onto this workspace without allowing it to escape. */
const packageDirectoryOf = (workspaceRoot: string, base: string): string => {
  if (base === "") return ""
  const root = NodePath.resolve(workspaceRoot)
  if (!SafeFs.inside(root, base)) {
    throw new FilegroupError({ message: "filegroup source is declared outside the workspace" })
  }
  return NodePath.relative(root, base).split(NodePath.sep).join("/")
}

/**
 * Expands and digests workspace-relative declared sources.
 *
 * Globs expand through {@link Input.expandGlob}, so package-scoped glob
 * semantics, `.gitignore`, and host-state exclusion apply exactly as they do
 * to any other declared input. The union is deduplicated by path and sorted,
 * so two groups naming the same file yield one entry and repeated expansion
 * of an unchanged tree is byte-identical. A named file that does not exist
 * digests to null rather than failing.
 *
 * @category expansion
 * @since 0.1.0
 */
export const expand = async (
  workspaceRoot: string,
  declared: ReadonlyArray<Source>,
  options: { readonly cacheDirectory?: string | undefined } = {}
): Promise<Files> =>
  expandFromPackages(workspaceRoot, declared.map((source) => ({ packageDirectory: "", source })), options)

/**
 * Reads the files one group names and returns them digested.
 *
 * @category actions
 * @since 0.1.0
 */
export const ExpandFilegroup = Action.make("smithers-build/filegroup", {
  payload: Payload,
  success: Files,
  error: FilegroupError,
  tier: "sealed"
})

/**
 * Implements {@link ExpandFilegroup} with per-source package anchors.
 * Each `base` is mapped onto `workspaceRoot` before resolving files or
 * expanding package-scoped globs. Anchors outside the workspace are refused.
 * `cacheDirectory` keeps host state out of the expansion the same way
 * declared-input discovery does.
 *
 * @category layers
 * @since 0.1.0
 */
export const ExpandFilegroupLive = (options: {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
}): Layer.Layer<Action.Requirement<"smithers-build/filegroup">, never, FlowRuntime.FlowRuntime> =>
  ExpandFilegroup.toLayer((payload) =>
    Effect.tryPromise({
      try: () =>
        expandFromPackages(
          options.workspaceRoot,
          payload.sources.map(({ base, source }) => ({
            packageDirectory: packageDirectoryOf(options.workspaceRoot, base),
            source
          })),
          { cacheDirectory: options.cacheDirectory }
        ),
      catch: (cause) =>
        new FilegroupError({
          message: failureMessage(cause)
        })
    })
  )

/**
 * Names a set of files under one label.
 *
 * A group is addressable like any other target: it has a label, it appears in
 * `smithers-build query`, and `deps()` traverses through it. Groups compose, so a
 * group whose `srcs` name other groups expands to their deduplicated
 * transitive union in `srcs` order.
 *
 * Declared files and globs inside `srcs` are collected by {@link Target.make}
 * as ordinary declared inputs, so the group's own key material already
 * carries their digests; nested groups become dependency edges, so their keys
 * reach the group's key. The planner projects the same transitive set onto
 * every consumer, so editing any group member invalidates every target that
 * names the group. See `Workspace.expandInputs`.
 *
 * The target joins no verb, so it never runs work under `build`, `test`, or
 * `lint`. Executing it as a dependency records one {@link ExpandFilegroup}
 * call, which reads the named files and succeeds with the expanded, digested
 * file list. Executing the plan requires {@link ExpandFilegroupLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Filegroup = Target.make(ruleId, {
  attrs: Attrs,
  kinds: [],
  success: Files,
  error: FilegroupError,
  cache: true,
  implementation: (attrs, context) => ExpandFilegroup.call({ sources: sources(attrs, context) })
})
