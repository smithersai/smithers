/**
 * Serializable placement annotations for flow graph values.
 *
 * The model itself is `@smthrs/plan`'s `Placement`, the lowest package this
 * one, `@smthrs/flow` and `@smthrs/registry` all depend on, and the package
 * that owns the `KeyMaterial.placement` field a directive ends up in. This
 * module is the name `@smthrs/core` consumers reach it through and carries no
 * logic of its own.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

/**
 * The directive and its host-selection detail.
 *
 * @category models
 * @since 0.0.0
 */
export type { Options, Placement } from "@smthrs/plan/Placement"

/**
 * The four directives: local process, viewer's browser, sandbox, remote
 * control plane.
 *
 * @category constructors
 * @since 0.0.0
 */
export { client, local, remote, sandbox } from "@smthrs/plan/Placement"
