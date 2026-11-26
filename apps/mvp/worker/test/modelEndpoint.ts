// Test transport for existing admission and metering scenarios. ChatApi never serves it.
import { ModelProxy, type ModelRequest } from "@smthrs/model"
import { Effect, type Layer, Option } from "effect"
import type { SqlClient } from "effect/sql"
import type { ModelRole } from "../../src/features/model/contract.ts"
import { canAsk, Sessions } from "../Actor.vibe"
import { codeOf } from "../ErrorCode.ts"
import * as ModelSeats from "../ModelSeats.ts"
import * as ModelSpend from "../ModelSpend.vibe"
import type * as PersonalUsage from "../personal/Usage.vibe"

/**
 * The model endpoint's handler for one role, `POST /api/model/<role>`: it refuses a signed-out request, then admits and
 * meters the call (`metering`). Each admitted call starts
 * its window's spend alert through `Flows.FlowStarter` (`ModelSpend.alerter`, docs/features/spend-alerts.md): on unless
 * `MODEL_SPEND_ALERTS` says otherwise, whose default is `alerts`, on unless set.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: { readonly alerts?: boolean; readonly hosted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { admit, meter, meterOwn, maxBodyBytes, logFailure, budget } = yield* ModelSeats.metering(database, options.hosted)
    const alert = yield* ModelSpend.alerter(
      yield* ModelSpend.settings(options.alerts === undefined ? {} : { on: options.alerts }),
      budget,
    )
    /**
     * Anyone signed in, then the call's admission, answered by the person's own model when they saved one, whatever the
     * role, the timeline's summaries included (decision 0099), and by the deployment's model only for a Member or above
     * of its own repository, the session's role (ruling AUTH-8). Only a call the deployment pays for starts a spend
     * alert.
     */
    const prepare = (role: ModelRole) => (request: ModelRequest.ModelRequest, admission: ModelProxy.Admission) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const actor = yield* sessions.resolve.pipe(
          Effect.tapError((error) => logFailure(role, codeOf(error))),
          Effect.mapError(() => new ModelProxy.Refusal({ status: 503, code: "provider_internal", message: "Smithers can't reach its database. Try again." })),
        )
        if (Option.isNone(actor)) {
          return yield* new ModelProxy.Refusal({ status: 401, code: "authentication", message: "Sign in to ask Smithers." })
        }
        // The session's role is the one on the deployment's own repository: its Members' calls are the deployment's to
        // pay for when they have no model of their own.
        const admitted = yield* admit(role, actor.value.subject.id, canAsk(actor.value))(request, admission)
        if (admitted.own === undefined) yield* alert
        return admitted
      })

    /**
     * `POST /api/model/<role>`: one served model call, settled where it was admitted: a person's own call in their
     * ledger, any other against the deployment's budget.
     */
    return (role: ModelRole) =>
      Effect.suspend(() => {
        let own: PersonalUsage.Call | undefined
        return ModelProxy.serve({
          prepare: (request, admission) =>
            Effect.map(prepare(role)(request, admission), (admitted) => {
              own = admitted.own
              return admitted.prepared
            }),
          maxBodyBytes,
          attributes: { role },
          onEnd: (end) => own === undefined ? meter(role)(end) : meterOwn(own)(end),
        })
      })
  })

