/**
 * Delivery channels: one short message sent to people outside the app, by
 * email or Telegram.
 *
 * A deployment configures a provider per channel and hands {@link layer} the
 * credentials; a caller hands {@link ChannelsService.send} a {@link Destination}
 * and a {@link Message}. Each send is one HTTP request, so a caller that wants
 * it durable runs it as a flow step and lets the engine retry it: every failure
 * is classified once, here, as a {@link DeliveryFailed} another attempt may
 * clear (with the provider's `Retry-After` as `retryAfterMillis`, which the
 * flow engine honors) or a {@link DeliveryRefused} it never will.
 *
 * ## Providers
 *
 * - Email goes through Resend's `POST /emails`, with the message's id as its
 *   `Idempotency-Key`, so a retried send within Resend's 24-hour window sends
 *   one email.
 * - Telegram goes through the Bot API's `sendMessage`, as plain text with link
 *   previews off. The Bot API has no idempotency key: a process that dies
 *   between Telegram's answer and the caller's record of it sends twice. Put
 *   the send in its own `irreversible` step: with an `idempotencyKey` it is at
 *   least once, without one at most once.
 *
 * ## Credentials
 *
 * The email API key travels in the `Authorization` header and the bot token in
 * the request's path. Neither reaches an error, a span or a log: failures carry
 * the channel, a code, the HTTP status and the provider's short error name, the
 * HTTP client's own span is off for these requests, and the send's span
 * records only the channel, the status and the outcome. Redirects are never
 * followed, so a credential never reaches an origin the deployment didn't name.
 *
 * @since 1.0.0
 */
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect";
/**
 * The channels a message can go out on.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Channel: Schema.Literals<readonly ["email", "telegram"]>;
/**
 * A channel a message can go out on.
 *
 * @category models
 * @since 1.0.0
 */
export type Channel = typeof Channel.Type;
/**
 * The most email recipients one message may name: Resend's own limit.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maxEmailRecipients = 50;
/**
 * Whether `value` is an email address this module sends to: one `@`, a dot in
 * the domain, no spaces, brackets or separators, at most 254 characters.
 *
 * @category refinements
 * @since 1.0.0
 */
export declare const isEmailAddress: (value: string) => boolean;
/**
 * Whether `value` is a Telegram chat id: a number such as `123456789` or
 * `-1001234567890`, or a public channel's `@username`.
 *
 * @category refinements
 * @since 1.0.0
 */
export declare const isTelegramChatId: (value: string) => boolean;
/**
 * An email address, as {@link isEmailAddress} reads it.
 *
 * @category models
 * @since 1.0.0
 */
export declare const EmailAddress: Schema.String;
/**
 * A Telegram chat id, as {@link isTelegramChatId} reads it.
 *
 * @category models
 * @since 1.0.0
 */
export declare const TelegramChatId: Schema.String;
/**
 * Where a message goes: 1 to {@link maxEmailRecipients} email addresses, or
 * one Telegram chat.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Destination: Schema.Union<readonly [Schema.TaggedStruct<"email", {
    readonly to: Schema.NonEmptyArray<Schema.String>;
}>, Schema.TaggedStruct<"telegram", {
    readonly chatId: Schema.String;
}>]>;
/**
 * Where a message goes.
 *
 * @category models
 * @since 1.0.0
 */
export type Destination = typeof Destination.Type;
/**
 * One message: `id`, its idempotency key, the same on every attempt to send
 * it (1 to 256 printable ASCII characters); a subject line of up to 200
 * characters; and plain text of up to 3,500, so a Telegram message carrying
 * both stays under the Bot API's 4,096.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Message: Schema.Struct<{
    readonly id: Schema.String;
    readonly subject: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * One message.
 *
 * @category models
 * @since 1.0.0
 */
export type Message = typeof Message.Type;
/**
 * A provider took the message: the channel, and the provider's id for it,
 * `null` when its answer named none.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Receipt: Schema.Struct<{
    readonly channel: Schema.Literals<readonly ["email", "telegram"]>;
    readonly providerId: Schema.NullOr<Schema.String>;
}>;
/**
 * A provider took the message.
 *
 * @category models
 * @since 1.0.0
 */
export type Receipt = typeof Receipt.Type;
/**
 * Why a send failed in a way another attempt may clear: the provider couldn't
 * be reached, didn't answer in time, answered 5xx, 408 or 409, or rate limited
 * it (429).
 *
 * @category models
 * @since 1.0.0
 */
export declare const FailedCode: Schema.Literals<readonly ["unreachable", "timeout", "unavailable", "rate_limited"]>;
/**
 * Why a send failed in a way another attempt may clear.
 *
 * @category models
 * @since 1.0.0
 */
export type FailedCode = typeof FailedCode.Type;
/**
 * Why a send was refused for good: the provider rejected the message or its
 * destination (a 3xx or another 4xx), the credential (401 or 403), or the
 * deployment has no provider for the channel.
 *
 * @category models
 * @since 1.0.0
 */
export declare const RefusedCode: Schema.Literals<readonly ["rejected", "unauthorized", "unconfigured"]>;
/**
 * Why a send was refused for good.
 *
 * @category models
 * @since 1.0.0
 */
export type RefusedCode = typeof RefusedCode.Type;
declare const DeliveryFailed_base: Schema.Class<DeliveryFailed, Schema.TaggedStruct<"@smthrs/notifications/DeliveryFailed", {
    readonly channel: Schema.Literals<readonly ["email", "telegram"]>;
    readonly code: Schema.Literals<readonly ["unreachable", "timeout", "unavailable", "rate_limited"]>;
    readonly status: Schema.optional<Schema.Int>;
    readonly reason: Schema.optional<Schema.String>;
    readonly retryAfterMillis: Schema.optional<Schema.Int>;
}>, import("effect/Cause").YieldableError>;
/**
 * A send failed, and another attempt may clear it. A durable step lets the
 * engine retry it; `retryAfterMillis` is the provider's own wait, when it named
 * one, which the flow engine uses in place of its backoff. It holds no request,
 * url, header or destination.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class DeliveryFailed extends DeliveryFailed_base {
}
declare const DeliveryRefused_base: Schema.Class<DeliveryRefused, Schema.TaggedStruct<"@smthrs/notifications/DeliveryRefused", {
    readonly channel: Schema.Literals<readonly ["email", "telegram"]>;
    readonly code: Schema.Literals<readonly ["rejected", "unauthorized", "unconfigured"]>;
    readonly status: Schema.optional<Schema.Int>;
    readonly reason: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * A send was refused, and another attempt would be refused too: record it
 * and stop. It holds no request, url, header or destination.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class DeliveryRefused extends DeliveryRefused_base {
}
/**
 * Either failure of a send, as a schema a flow step declares.
 *
 * @category errors
 * @since 1.0.0
 */
export declare const DeliveryError: Schema.Union<readonly [typeof DeliveryFailed, typeof DeliveryRefused]>;
/**
 * Either failure of a send.
 *
 * @category errors
 * @since 1.0.0
 */
export type DeliveryError = DeliveryFailed | DeliveryRefused;
/**
 * The deployment's delivery channels.
 *
 * @category services
 * @since 1.0.0
 */
export interface ChannelsService {
    /** The channels this deployment has a provider for, in {@link Channel}'s order. */
    readonly available: ReadonlyArray<Channel>;
    /**
     * Sends `message` to `destination` with one request to its channel's
     * provider. A destination or message outside its schema is refused
     * `rejected`, and a channel with no provider `unconfigured`, before any
     * request.
     */
    readonly send: (destination: Destination, message: Message) => Effect.Effect<Receipt, DeliveryError>;
}
declare const Channels_base: Context.ServiceClass<Channels, "@smthrs/notifications/Channels", ChannelsService>;
/**
 * The {@link ChannelsService} tag.
 *
 * @category services
 * @since 1.0.0
 */
export declare class Channels extends Channels_base {
}
/**
 * Resend's API origin.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultEmailUrl = "https://api.resend.com";
/**
 * The Telegram Bot API's origin.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultTelegramUrl = "https://api.telegram.org";
/**
 * How long a send waits for its provider's whole answer.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultTimeout: Duration.Duration;
/**
 * The email provider: a Resend API key, the sender (`Name <address>` or an
 * address on a domain Resend verified), and Resend's origin
 * ({@link defaultEmailUrl} when absent).
 *
 * @category models
 * @since 1.0.0
 */
export interface EmailProvider {
    readonly apiKey: Redacted.Redacted<string>;
    readonly from: string;
    readonly url?: string | undefined;
}
/**
 * The Telegram provider: a bot's token from BotFather, and the Bot API's
 * origin ({@link defaultTelegramUrl} when absent).
 *
 * @category models
 * @since 1.0.0
 */
export interface TelegramProvider {
    readonly token: Redacted.Redacted<string>;
    readonly url?: string | undefined;
}
/**
 * The providers a deployment configured, and how long each send waits.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    readonly email?: EmailProvider | undefined;
    readonly telegram?: TelegramProvider | undefined;
    readonly timeout?: Duration.Duration | undefined;
}
/**
 * The deployment's channels: email through Resend when `email` is given,
 * Telegram through the Bot API when `telegram` is, each send bounded by
 * `timeout` ({@link defaultTimeout}).
 *
 * The layer owns its Fetch transport and makes every request with redirect
 * following off, so a 3xx is refused `rejected` rather than followed with the
 * credential. Tests and hosts supply the transport as `FetchHttpClient.Fetch`.
 * A provider url that isn't absolute `http:` or `https:` fails the layer as a
 * defect whose message names no url.
 *
 * Each send is a span `notifications.channel.send` with the channel, the
 * answering status and the outcome, and nothing of the request: the HTTP
 * client's own span is off for it, and no trace context is sent to the
 * provider.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layer: (options: Options) => Layer.Layer<Channels>;
export {};
