/**
 * Digest-free input to `/keys`.
 *
 * The contract itself is `@smthrs/plan`'s `KeyMaterial`, the lowest package
 * that owns it. This module is the name `@smthrs/core` consumers reach it
 * through, with the two deliberately opaque fields narrowed to the types this
 * package's graph actually puts there.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * Graph-local ids may occur only inside dependency references. The key
 * compiler replaces those references with dependency digests; names and tree
 * positions are never hashed directly.
 *
 * @since 0.0.0
 */

import type * as PlanKeyMaterial from "@smthrs/plan/KeyMaterial"
import type * as Effects from "./Effects.ts"
import type * as Placement from "./Placement.ts"

/**
 * A declared input used to identify a planned node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type InputRef = PlanKeyMaterial.InputRef

/**
 * Digest-free key material for a planned node.
 *
 * `version`, `kind`, `body`, `inputs`, `layers` and `capabilities` are
 * `@smthrs/plan`'s, field for field. `effects` and `placement` are
 * `Schema.Unknown` there on purpose, because the key compiler serializes them
 * canonically and never interprets them; this package's graph puts a
 * {@link Effects.Declaration} and a {@link Placement.Placement} in them, and
 * says so here so its own readers keep their types.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type KeyMaterial =
  & Omit<PlanKeyMaterial.KeyMaterial, "effects" | "placement" | "nondeterministic">
  & {
    readonly effects: Effects.Declaration | undefined
    readonly placement: Placement.Placement | undefined
  }

/**
 * A graph-local association between a node and its digest-free key material.
 *
 * `nodeId` is traversal data and is never part of the material handed to the
 * key compiler.
 *
 * `/keys/StepKey.fromKeyMaterial` consumes these entries and performs
 * dependency-digest substitution before hashing.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Entry {
  readonly nodeId: string
  readonly material: KeyMaterial
}
