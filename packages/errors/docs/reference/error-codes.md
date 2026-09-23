---
title: "Error code reference"
description: "Every SmithersErrorCode: what it means, the function that raises each condition, the details record it attaches, and what a caller should do about it."
sidebar:
  order: 1
---

Five codes exist, and every one of them is raised by
[`@smthrs/integrations`](/api/integrations). This page lists each raise site in
that package, the `details` it attaches, and the caller's move.

The summary table is the runtime table
[`smithersErrorDefinitions`](../api.md#smitherserrordefinitions), the rows the
package exports. The sections below expand it against the raise sites.

## Summary

| Code                         | Raised when                                                                                                                                                                                         | `details`                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `INVALID_INPUT`              | An integration helper receives an argument it cannot use: a missing bot token, an approval option key containing a colon, callback data over Telegram's 64-byte limit, or a non-https Mini App URL. | One key naming the offending field, on the raise sites that have a field to name. |
| `INTEGRATION_ERROR`          | An integration client, webhook source, or listener reconciliation fails. `reason` classifies the failure so a caller can map it to a transport status.                                              | `{ reason, ...providerSafeDetails }`                                              |
| `TELEGRAM_API_ERROR`         | The Telegram Bot API answers a call with `ok: false`, a non-JSON body, or a transport failure. The bot token is redacted from the message and details.                                              | `{ method, errorCode, description, retryAfterSeconds, deliveredMessageIds }`      |
| `TELEGRAM_INIT_DATA_INVALID` | Telegram Mini App `initData` is empty, expired, missing its hash or signature, or fails HMAC or Ed25519 verification.                                                                               | `{ authDate }` on the freshness failures, otherwise none.                         |
| `UNSUPPORTED`                | The runtime lacks a primitive an integration needs, such as Web Crypto or Ed25519 verification.                                                                                                     | None.                                                                             |

## INVALID_INPUT

**Meaning.** The call is wrong, and no retry will make it right. The value the
caller passed is outside what the helper or the provider accepts.

**Raised as.** A bare `SmithersError`, thrown synchronously. These helpers are
plain functions, not effects, so the failure arrives as a `throw` and not in a
failure channel.

| Raise site                               | Condition                                                                               | `details`                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Core.SignalName.eventName`              | The `service` or `event` segment is empty after trimming, or contains a `:`.            | `{ service }` or `{ event }`, whichever segment failed |
| `Telegram.Config.resolve`                | Neither `config.botToken` nor `SMITHERS_TELEGRAM_BOT_TOKEN` supplies a non-empty token. | None                                                   |
| `Telegram.Chunk.chunk`                   | `maxLength` is not a safe integer between 1 and 4096.                                   | `{ maxLength }`                                        |
| `Telegram.Approval.token`                | The prompt id is not a non-empty string.                                                | None                                                   |
| `Telegram.Approval.callbackData`         | The approval token is not a string, or contains a `:`.                                  | None                                                   |
| `Telegram.Approval.callbackData`         | A `select` option key is empty or contains a `:`.                                       | None                                                   |
| `Telegram.Approval.callbackData`         | The encoded `callback_data` exceeds Telegram's 64-byte limit.                           | None                                                   |
| `Telegram.Approval.webAppButton`         | The Mini App URL is empty or is not `https://`.                                         | None                                                   |
| `Telegram.Approval.keyboard`             | Mode is `select` and the options list is empty.                                         | None                                                   |
| `Telegram.InitData.verifyWithBotToken`   | The bot token argument is missing or empty.                                             | None                                                   |
| `Telegram.InitData.verifySignature`      | The bot id argument is missing or empty.                                                | None                                                   |
| `Telegram.InitData.verifySignature`      | `publicKeyHex` is not 64 hexadecimal characters.                                        | `{ length }`                                           |
| `Telegram.InitData` verification options | `maxAgeSeconds` is not an integer between 0 and 86400.                                  | `{ maxAgeSeconds }`                                    |
| `Telegram.InitData` verification options | `nowMs` is not a finite number.                                                         | `{ nowMs }`                                            |

**What to do.** Read `summary`: it names the argument and the accepted range or
format. Fix the call site. Do not retry, and do not surface the failure as a
provider outage: at a transport boundary this is a 400, which is what
`Core.IntegrationError.toInvalidInput` produces for the classified sibling.

## INTEGRATION_ERROR

**Meaning.** A call to a provider, a webhook read, or a listener reconciliation
failed. The `reason` in `details` is the classification a caller acts on.

**Raised as.** `Core.IntegrationError`, a subclass that adds a typed `reason`
field and passes `{ reason, ...details }` down as the `details` record. It is
raised from every provider client in the package: the GitHub client, repository
resolver, webhook reader, and listener registry; the Linear client and webhook
reader; the Telegram update source; the shared webhook channel; and the cursor
store.

The eight reasons and the transport status each implies:

| `reason`              | Meaning                                                                                                         | Typical caller move                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `invalid-config`      | The configuration cannot address the provider: a missing repository, an unusable base URL, a malformed setting. | Fix the configuration. Do not retry.                  |
| `invalid-signature`   | A webhook signature did not verify. Raised by `Core.Channel`.                                                   | Answer 401. Do not process the payload.               |
| `decode-failed`       | The provider answered, and the answer did not parse or did not name something that exists.                      | Answer 400 or 404. Do not retry.                      |
| `poll-failed`         | A polling cycle failed against the provider.                                                                    | Retry on the next cycle.                              |
| `delivery-failed`     | A request did not reach the provider, or the provider refused it in a way that may clear.                       | Retry when `details.retryable` is `true`.             |
| `credentials-missing` | No credential was available for the call.                                                                       | Supply the credential. Do not retry.                  |
| `permission-denied`   | The credential exists and is not allowed to do this.                                                            | Answer 403. Do not retry.                             |
| `listener-conflict`   | Another listener already owns the resource being reconciled.                                                    | Resolve the ownership conflict, then reconcile again. |

Beyond `reason`, `details` may carry:

- `retryable`: `true` when the client judged another attempt worthwhile.
  `Core.IntegrationError.isRetryable` reads exactly this key.
- `outcomeUnknown`: `true` when the request may have taken effect even though
  it reported failure, such as a transport failure or a 5xx.
- `deliveredMessageIds`: the messages a partially completed multi-chunk
  Telegram send had already delivered.

**What to do.** Branch on `reason`, not on `summary`. Use
`Core.IntegrationError.isIntegrationError` rather than `instanceof`: it accepts
an instance that crossed a module boundary and refuses one whose `reason` this
build cannot encode. `Core.IntegrationError.toUnauthorized` and
`toInvalidInput` map the failure onto the control plane's typed errors, and
they pass `summary` rather than `message`, so no documentation URL reaches the
transport.

Inside a durable action, convert instead of throwing.
`Core.ActionFailure.fromIntegrationError` produces `IntegrationFailure`, the
schema form that survives a journal round trip: the same `reason`, a message
capped at 512 characters, and `retryable`. `toIntegrationError` converts back
when a caller wants the class again. A value the conversion cannot classify
becomes a non-retryable `delivery-failed` rather than a defect.

## TELEGRAM_API_ERROR

**Meaning.** A single Bot API call failed. This code is about the transport and
the envelope, not about which Telegram operation you attempted.

**Raised as.** `Telegram.TelegramClient.TelegramApiError`, a subclass that adds
`errorCode`, `retryAfterSeconds`, `deliveredMessageIds`, and an optional
`reason` override. The `details` record always carries all five keys, with
`null` for the ones the failure could not fill.

| Condition                                                                              | `errorCode`                                              | Notes                                                                                                    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `fetch` rejected: DNS, connection, TLS, or an abort.                                   | `null`                                                   | The cause message passes through `redactBotToken` first.                                                 |
| The response body is not JSON.                                                         | The HTTP status                                          | A 2xx here sets `reason: "decode-failed"`, because the call did reach Telegram.                          |
| The body is JSON but is not a Bot API envelope, or claims `ok: true` with no `result`. | The HTTP status                                          | Same `reason` override on a 2xx.                                                                         |
| The envelope says `ok: false`.                                                         | Telegram's `error_code`, falling back to the HTTP status | `description` is Telegram's own text, redacted. `retryAfterSeconds` comes from `parameters.retry_after`. |
| A multi-chunk send failed partway through.                                             | Carried from the failing chunk                           | `deliveredMessageIds` names the messages already visible in the chat.                                    |

The client retries a 429 on its own schedule before the error escapes, so a
`TELEGRAM_API_ERROR` with `errorCode` 429 means the retries were spent.

**What to do.** Call `Telegram.TelegramClient.toIntegrationError` at the action
boundary. A `TelegramApiError` is not an `IntegrationError`, so an action that
maps it directly reports every Telegram failure as an unclassified,
non-retryable `delivery-failed`, and a spent rate limit becomes
indistinguishable from a chat that does not exist. The conversion classifies by
`errorCode`: 429 and 5xx become retryable `delivery-failed`, 401 and 403 become
`permission-denied`, 400 and 404 become `decode-failed`.

Before you resend a long message, read `deliveredMessageIds`. Resending
without it duplicates every chunk the chat already holds.

## TELEGRAM_INIT_DATA_INVALID

**Meaning.** Telegram Mini App `initData` did not authenticate. Treat it as an
authentication failure, never as a bug report.

**Raised as.** A bare `SmithersError`, rejected from
`Telegram.InitData.verifyWithBotToken` and
`Telegram.InitData.verifySignature`.

| Condition                                                                                   | Raised by            | `details`      |
| ------------------------------------------------------------------------------------------- | -------------------- | -------------- |
| `initData` is not a string, or is empty.                                                    | Both verifiers       | None           |
| The `hash` field is missing or empty.                                                       | `verifyWithBotToken` | None           |
| The `signature` field is missing or empty.                                                  | `verifySignature`    | None           |
| `auth_date` is missing, older than `maxAgeSeconds`, or more than 300 seconds in the future. | Both verifiers       | `{ authDate }` |
| The signature is not valid base64url.                                                       | `verifySignature`    | None           |
| The HMAC does not match.                                                                    | `verifyWithBotToken` | None           |
| The Ed25519 signature does not match.                                                       | `verifySignature`    | None           |

The default freshness window is 3600 seconds. Both ends of the window are
bounded: without a future bound, a correctly signed far-future `auth_date`
would stay fresh for as long as it was dated ahead. A `maxAgeSeconds` of 0
disables the freshness check entirely, including the missing-`auth_date`
refusal, so set it to 0 only in a test.

**What to do.** Answer 401 and stop. Do not log the `initData` string, do not
tell the client which check failed, and do not retry: every one of these
conditions is deterministic for a given payload. The messages are deliberately
coarse for the same reason.

If the failure is `{ authDate }` and your users see it often, the clock skew
between your server and the client is the likely cause, not an attack. Raise
`maxAgeSeconds`, up to the 86400 ceiling.

## UNSUPPORTED

**Meaning.** The runtime cannot do something the integration needs. Nothing
about the request is wrong.

**Raised as.** A bare `SmithersError`, from two places in
`Telegram.InitData`:

| Condition                                  | Message                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `globalThis.crypto.subtle` is undefined.   | `Web Crypto (crypto.subtle) is not available in this runtime.` |
| `subtle.importKey` refuses an Ed25519 key. | `Ed25519 verification is not supported in this runtime.`       |

The Ed25519 case carries the underlying failure as `cause`. The public key
argument is validated before the import is attempted, so a mistyped key raises
`INVALID_INPUT` instead of sending an operator to look at Node versions.

**What to do.** Change the runtime, not the call. Web Crypto and Ed25519 are
both available on Node.js 26.4.0 and later, which is the version this package
requires. Seeing `UNSUPPORTED` means the code is running somewhere
else: an old Node.js, a restricted edge runtime, or an insecure browser context
where `crypto.subtle` is not exposed.

If you cannot change the runtime, use `verifyWithBotToken` instead of
`verifySignature`. It needs HMAC-SHA-256 rather than Ed25519, which more
runtimes implement.
