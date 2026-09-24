// Regression control: the pre-fix retained class from 00b7dd05.
// Its alarm intentionally loses provenance; never deploy this fixture.
import * as Effect from "effect/Effect"
import { runDurable } from "../../../src/Boundary"

/**
 * Inert storage owners after the verified one-time migration. Keeping each
 * class, binding and migration identity preserves Cloudflare storage for
 * rollback. No request reads or writes it, and old alarms cannot erase journal
 * output or launch repository jobs. Never activate before drain + migration.
 */
class RetainedDurableObject {
  fetch(): Promise<Response> { // effect-policy: boundary
    return runDurable(Effect.succeed(Response.json({ status: "error", code: "authority_retired" }, { status: 410 })))
  }
  alarm(): Promise<void> { // effect-policy: boundary
    return runDurable(Effect.void)
  }
}

export class TurnCancelRegistry extends RetainedDurableObject {}
export class GatewaySessionRegistry extends RetainedDurableObject {}
export class TurnRateLimiter extends RetainedDurableObject {}
export class ClientErrorLog extends RetainedDurableObject {}
export class RecommendLog extends RetainedDurableObject {}
export class AccountModelVault extends RetainedDurableObject {}
