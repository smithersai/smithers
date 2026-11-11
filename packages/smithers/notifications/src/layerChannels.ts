/**
 * The alert sink that pages a person: one alert, one message on a delivery
 * channel.
 *
 * `./layerWebhook.ts` hands an alert to another system. This sink hands it to
 * a person, through whichever of `./Channels.ts`' providers the destination
 * names: a Telegram chat or a list of email addresses.
 *
 * @since 1.0.0
 */

import { digestSync } from "@smthrs/crypto"
import { Effect, Layer } from "effect"
import { type Alert, alertId } from "./AlertPolicy.ts"
import { AlertError, type FailureCode, Sink } from "./AlertSink.ts"
import { Channels, type DeliveryError, type Destination, type Message } from "./Channels.ts"

/**
 * Where {@link layerChannels} sends every alert.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChannelsSinkOptions {
  readonly destination: Destination
}

/** The longest run id, condition, owner or runbook a message carries. */
const maxPartLength = 150

const part = (value: string): string => value.length > maxPartLength ? `${value.slice(0, maxPartLength)}…` : value

/**
 * The message's idempotency key: the alert's id when a provider accepts it as
 * one, and its digest when the id is too long to be one.
 */
const messageId = (id: string): string => id.length <= 256 ? id : `alert:${digestSync(id)}`

/**
 * One alert as a message a person reads.
 *
 * The subject is the severity and the condition. The text is the summary the
 * opening entry carried, the run, when the condition opened, the owner and
 * runbook when the policy names them, and the id to acknowledge the alert by.
 *
 * @param alert the alert
 * @category constructors
 * @since 1.0.0
 */
export const messageOf = (alert: Alert): Message => ({
  id: messageId(alertId(alert)),
  subject: `[${alert.severity}] ${part(alert.condition)}${
    alert.reminder === undefined ? "" : ` (reminder ${alert.reminder})`
  }`,
  text: [
    ...(alert.summary === undefined ? [] : [alert.summary]),
    `Run: ${part(alert.runId)}`,
    `Since: ${new Date(alert.since).toISOString()}`,
    ...(alert.owner === undefined ? [] : [`Owner: ${part(alert.owner)}`]),
    ...(alert.runbook === undefined ? [] : [`Runbook: ${part(alert.runbook)}`]),
    `Alert: ${part(alertId({ coalescingKey: alert.coalescingKey, since: alert.since }))}`
  ].join("\n")
})

const codes: Readonly<Record<DeliveryError["code"], FailureCode>> = {
  unreachable: "sink_unreachable",
  timeout: "sink_timeout",
  unavailable: "sink_rejected",
  rate_limited: "sink_rejected",
  rejected: "sink_rejected",
  unauthorized: "sink_rejected",
  unconfigured: "sink_rejected"
}

/**
 * An alert sink that sends each alert as one message on a delivery channel.
 *
 * The message's id is the alert's, so an email provider dedupes a repeated
 * send. Telegram's Bot API takes no idempotency key: a process that dies
 * between an accepted send and the delivery record sends the same Telegram
 * message again on the next tick.
 *
 * Every channel failure fails the delivery, so the tick records it and the
 * next tick tries again. That includes a destination the deployment has no
 * provider for, which fails with the reason `unconfigured`.
 *
 * @param options the destination every alert goes to
 * @category layers
 * @since 1.0.0
 */
export const layerChannels = (options: ChannelsSinkOptions): Layer.Layer<Sink, never, Channels> =>
  Layer.effect(
    Sink,
    Effect.map(Channels, (channels) =>
      Sink.of({
        deliver: (alert) =>
          channels.send(options.destination, messageOf(alert)).pipe(
            Effect.asVoid,
            Effect.mapError((error) =>
              new AlertError({
                code: codes[error.code],
                message: `The ${error.channel} channel did not take the alert`,
                reason: error.reason ?? error.code,
                ...(error.status === undefined ? {} : { status: error.status })
              })
            )
          )
      }))
  )
