/**
 * Coordinates of the action attempt whose terminal failure escaped dispatch.
 * The cause annotation survives propagation; durable hosts persist its bounded diagnostic.
 * @since 1.0.0
 */

import * as Context from "effect/Context"

/**
 * Action identity and actual durable attempt count, with a graph node when interpreted.
 * @category services
 * @since 1.0.0
 */
export class FailureSite extends Context.Service<FailureSite, {
  readonly executionId: string
  readonly action?: string | undefined
  readonly attempts: number | null
  readonly nodeId?: string | undefined
}>()("@smthrs/engine/FailureSite") {}
