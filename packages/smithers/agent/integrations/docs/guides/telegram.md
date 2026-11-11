---
title: "Telegram"
description: "Receive a bot's messages without a public URL: long-poll getUpdates and start a flow or signal a run for each message."
sidebar:
  order: 2
---

`Telegram.Source` receives the messages people send to a Telegram bot. It
long-polls the Bot API's `getUpdates`, so it needs no public webhook URL and
runs on a laptop. Sending is a separate package: see the
[Channels guide](../../../../notifications/docs/guides/send-by-email-and-telegram.md).

## Start a flow for each message

```ts
import { Core, Telegram } from "@smthrs/integrations"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"

const door = Core.Channel.fromSource({ name: "telegram", route: Core.Channel.startFlow("triage") })

// Inside a flow action: poll, start one flow per message, then commit the offset.
const receive = Effect.gen(function*() {
  const source = yield* Telegram.Source.make({ allowedChatIds: [123456789] })
  yield* source.run(door.handle)
}).pipe(Effect.provide(FetchHttpClient.layer))
```

Register `door.channel` with the `Channels` service once at host startup, as
the [polling source guide](./polling-source.md) shows. Route to
`Core.Channel.signalRun(runId)` instead to wake a run that waits for the
message. The flow that calls `receive` needs `Core.CursorStore` (`layerSql`
keeps the offset across restarts) and a durable host.

The bot token comes from `botToken` or `SMITHERS_TELEGRAM_BOT_TOKEN`. Passing
an `env` record as the second argument to `make` replaces the ambient
environment.

## Options

| Option               | Default                       | Meaning                                                                |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `allowedChatIds`     | required                      | The chats whose messages become events. Every other update is dropped. |
| `botToken`           | `SMITHERS_TELEGRAM_BOT_TOKEN` | The BotFather token, as a string or `Redacted`.                        |
| `sourceId`           | `telegram`                    | The cursor key, the events' `source`, and the dedupe scope.            |
| `pollTimeoutSeconds` | 25                            | How long Telegram holds a poll open, 0 to 50.                          |
| `requestTimeout`     | 10 seconds                    | The deadline for one request beyond the poll's hold.                   |
| `apiBaseUrl`         | `https://api.telegram.org`    | Another origin, such as a fixture server.                              |

## What a message becomes

| Update           | Signal name                           | Correlation      |
| ---------------- | ------------------------------------- | ---------------- |
| `message`        | `integration:telegram:message`        | `chat:<chat id>` |
| `edited_message` | `integration:telegram:edited_message` | `chat:<chat id>` |

A message in a forum topic or reply thread yields a second event correlated
`chat:<chat id>:thread:<thread id>`, so a run waiting on the thread wakes as
well. The payload is the Bot API message; `Telegram.Payload.Message` decodes
its common fields and keeps the rest. Each event's dedupe key is built from
the source id and the `update_id`, so a batch polled again after a crash
starts each flow once.

## Guarantees

- **The offset moves only past handled updates.** `run` is
  `Core.Source.runWithCursor`: it commits `update_id + 1` to the cursor store
  after the door took the batch.
- **The allowlist fails closed.** An update from another chat, or one whose
  chat cannot be read, produces no event; the offset still moves past it.
- **The token stays out of errors.** It travels only in the request path. The
  HTTP client's span is off for these requests, redirects are never followed,
  and no failure message or detail holds the token.
- **One driver per bot.** Telegram answers a second concurrent poll, or a poll
  while a webhook is set, with 409.

## Failures

Each poll is one request. `details.retryable` says whether another poll can
clear a failure, and the flow engine decides whether to retry.

| Reason                | When                                                                                 | Retryable |
| --------------------- | ------------------------------------------------------------------------------------ | --------- |
| `credentials-missing` | No token, or one that is not BotFather's `<id>:<secret>` shape.                      | No        |
| `invalid-config`      | Bad options, or a stored cursor that is not an update offset.                        | No        |
| `poll-failed`         | The Bot API was unreachable, timed out, or answered 5xx or 408.                      | Yes       |
| `poll-failed`         | A 429. `details.retryAfterMillis` is Telegram's `retry_after`, capped at one minute. | Yes       |
| `poll-failed`         | Any other status, such as 401 (revoked token) or 409 (a second driver).              | No        |
| `decode-failed`       | The answer holds no update array, or an update has no `update_id`.                   | No        |
