/**
 * Project skill libraries and their explicit, durable agent installation.
 * Libraries are workspace-relative data; declarations perform no I/O.
 *
 * @since 1.0.0
 */

import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * Normalizes one workspace-relative skill directory without I/O.
 *
 * @category validation
 * @since 1.0.0
 */
export const normalizeRoot = (root: string): string => {
  if (
    typeof root !== "string" || root.trim() === "" || root.length > 4096 ||
    /^([/\\]|[A-Za-z]:)/.test(root) || /[\u0000-\u001f\u007f]/.test(root)
  ) {
    throw new TypeError("Skills library root must be a workspace-relative directory")
  }
  const parts = root.trim().split(/[/\\]/).filter((part) => part !== "" && part !== ".")
  if (parts.length === 0 || parts.includes("..")) {
    throw new TypeError("Skills library root must stay inside the workspace")
  }
  return parts.join("/")
}

/**
 * The inert skill-library schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LibraryDeclaration = Schema.TaggedStruct("Skills.Library", { root: Schema.NonEmptyString })
/**
 * A declared skill-library root.
 *
 * @category models
 * @since 1.0.0
 */
export type Library = typeof LibraryDeclaration.Type

/** Declares the directory containing a project's SKILL.md entries.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Library = (options: { readonly root: string }): Library =>
  Object.freeze(LibraryDeclaration.make({ root: normalizeRoot(options.root) }))

/**
 * Attributes accepted by the skill installation target.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Attrs = Schema.Struct({
  library: LibraryDeclaration,
  agents: Schema.Array(Schema.Literals(["claude", "codex"])),
  /** Exact skill names; omitted selects every skill in this library. */
  select: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  deps: Schema.Array(Target.Target).pipe(Schema.withConstructorDefault(Effect.succeed([])))
})
/**
 * Validated skill installation attributes.
 *
 * @category models
 * @since 1.0.0
 */
export type Attrs = typeof Attrs.Type

/**
 * The destinations the installation action verified or created.
 *
 * @category schemas
 * @since 1.0.0
 */
export const InstallResult = Schema.Struct({ installed: Schema.Array(Schema.String) })
/**
 * A refused installation, without file contents or credentials.
 *
 * @category schemas
 * @since 1.0.0
 */
export const InstallError = Schema.TaggedStruct("SkillsInstallError", { message: Schema.String })

/** Agent-directory mutation runs only as an explicit durable action.
 *
 * @category actions
 * @since 1.0.0
 */
export const InstallAction = Action.make("smithers-build/skills-install", {
  payload: Attrs,
  success: InstallResult,
  error: InstallError,
  tier: "irreversible"
})

/** Links selected skills into Claude's ~/.claude/skills and Codex's ~/.agents/skills.
 * The host records ownership and refuses existing entries it did not create.
 * No installation can run through a build, test, lint, or cache replay.
 *
 * @category targets
 * @since 1.0.0
 */
export const Install = Target.make("Skills.Install", {
  attrs: Attrs,
  kinds: ["run"],
  verbGate: ["run"],
  cache: false,
  success: InstallResult,
  error: InstallError,
  inputs: (attrs) => [Input.glob(`//${normalizeRoot(attrs.library.root)}/**/*`)],
  implementation: (attrs) => InstallAction.call(attrs)
})
