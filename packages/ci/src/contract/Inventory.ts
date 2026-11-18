/**
 * Contract 4: the inventory of what a repository's CI does today.
 *
 * The importer writes it and the target generator and the baseline run read
 * it. It names commands, never tools: a step is a shell command with a
 * working directory, so a Zig repository driven by a Justfile and a
 * TypeScript monorepo driven by GitHub Actions and Turborepo use one shape.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Where a job was read from.
 *
 * @category models
 * @since 0.1.0
 */
export const Source = Schema.Literals(["github-actions", "justfile", "makefile", "package-json", "turbo"])

/**
 * A decoded `Source`.
 *
 * @category models
 * @since 0.1.0
 */
export type Source = typeof Source.Type

/**
 * One shell command. `env` holds plain values; a secret appears only by name
 * in `secrets`, never by value.
 *
 * @category models
 * @since 0.1.0
 */
export const Step = Schema.Struct({
  id: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  secrets: Schema.Array(Schema.String),
  name: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `Step`.
 *
 * @category models
 * @since 0.1.0
 */
export type Step = typeof Step.Type

/**
 * Something the importer read and cannot reproduce, such as a hosted service
 * container or a third-party action with no command.
 *
 * @category models
 * @since 0.1.0
 */
export const Unsupported = Schema.Struct({
  feature: Schema.NonEmptyString,
  detail: Schema.String
})

/**
 * A decoded `Unsupported`.
 *
 * @category models
 * @since 0.1.0
 */
export type Unsupported = typeof Unsupported.Type

/**
 * One job: steps that run in order on one machine. `needs` names the jobs
 * that must pass first. `matrix` lists one variable assignment per variant;
 * an empty list means the job runs once.
 *
 * @category models
 * @since 0.1.0
 */
export const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  source: Source,
  file: Schema.NonEmptyString,
  name: Schema.String,
  needs: Schema.Array(Schema.String),
  triggers: Schema.Array(Schema.String),
  matrix: Schema.Array(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(Step),
  unsupported: Schema.Array(Unsupported),
  runsOn: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `Job`.
 *
 * @category models
 * @since 0.1.0
 */
export type Job = typeof Job.Type

/**
 * A tool the repository pins, and the file that pins it.
 *
 * @category models
 * @since 0.1.0
 */
export const Toolchain = Schema.Struct({
  name: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  version: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `Toolchain`.
 *
 * @category models
 * @since 0.1.0
 */
export type Toolchain = typeof Toolchain.Type

/**
 * Everything a repository's CI does at one commit.
 *
 * @category models
 * @since 0.1.0
 */
export const Inventory = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
  toolchains: Schema.Array(Toolchain),
  jobs: Schema.Array(Job)
})

/**
 * A decoded `Inventory`.
 *
 * @category models
 * @since 0.1.0
 */
export type Inventory = typeof Inventory.Type
