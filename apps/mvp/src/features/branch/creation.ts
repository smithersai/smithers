import { Schema } from "effect"

/**
 * What a branch's selected flow does (docs/features/branch-creation.md, docs/features/branch-publish.md): make a new
 * conversation branch, publish a Smithers-only branch to GitHub, or bring a published branch up to date with its base.
 * A repository may replace each with its own flow; the first-party `branches` plugin is the default.
 */
export const BRANCH_OPERATIONS = ["create", "publish", "update"] as const
export type BranchOperation = (typeof BRANCH_OPERATIONS)[number]

/** A selection is journaled before repository code or an external write runs. */
export const CreationSelection = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  tag: Schema.String,
  source: Schema.String,
  digest: Schema.String,
  revision: Schema.String,
  runtime: Schema.String,
  allowed: Schema.Array(Schema.String),
  /** The operation the flow was selected for: `create` when absent, as selections journaled before Publish say. */
  operation: Schema.optional(Schema.Literals(BRANCH_OPERATIONS)),
})
export type CreationSelection = typeof CreationSelection.Type

/** The only privileged operations a branch plugin's flow may request, with the capability each needs. */
export const CREATION_ACTIONS = {
  "branches/ephemeral": "git:write",
  "branches/github": "github:write",
  "branches/github-publish": "github:write",
  "branches/github-update": "github:write",
} as const

/** The host actions each operation's flow may call: creation's two, Publish's one, Update branch's one. */
export const OPERATION_ACTIONS: Readonly<Record<BranchOperation, ReadonlyArray<keyof typeof CREATION_ACTIONS>>> = {
  create: ["branches/ephemeral", "branches/github"],
  publish: ["branches/github-publish"],
  update: ["branches/github-update"],
}

/** `GET <route>?owner=<o>&name=<n>&operation=<op>`: a branch operation's selected flow (`create` unless named). */
export const CREATION_ROUTE = "/api/branches/creation"
