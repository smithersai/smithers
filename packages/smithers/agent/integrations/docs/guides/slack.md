---
title: "Slack"
description: "Run a Slack app over Socket Mode: owner-only intake from direct messages, threaded replies under role personas, Block Kit approval buttons, durable post/update/reconcile actions, and the Events API door."
sidebar:
  order: 4
---

How to wire one Slack app into a host application. Each section is a recipe;
the [API reference](../api.md#slack) has the full signatures.

## Create the app

One app is enough, even for a host that speaks as several roles. In the Slack
app settings:

- **Socket Mode:** on. Generate an app-level token with the
  `connections:write` scope (it starts with `xapp-`).
- **Bot token scopes:** `chat:write`; `chat:write.customize` to post under a
  role's name and icon; `im:history` and `im:write` for direct messages;
  `app_mentions:read` and `channels:history` for a channel the app is
  mentioned in; `users:read`.
- **Event subscriptions:** `message.im` and `app_mention`.
- **Interactivity:** on. Under Socket Mode no request URL is needed.

Install the app to the workspace and copy the bot token (`xoxb-`).

## Configure from the environment

A host configured only by variables needs no code to decide who may reach it:

| Variable                        | Meaning                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SMITHERS_SLACK_BOT_TOKEN`      | The bot token. Every Web API call except `apps.connections.open` carries it.                            |
| `SMITHERS_SLACK_APP_TOKEN`      | The app-level token. Only Socket Mode uses it.                                                          |
| `SMITHERS_SLACK_SIGNING_SECRET` | The Events API signing secret, for the HTTP door only.                                                  |
| `SMITHERS_SLACK_TEAM_IDS`       | Comma-separated workspace ids admitted. Required.                                                       |
| `SMITHERS_SLACK_USER_IDS`       | Comma-separated people who may reach the host. Their direct messages are admitted without listing them. |
| `SMITHERS_SLACK_CHANNEL_IDS`    | Comma-separated conversations admitted, such as one team channel.                                       |
| `SMITHERS_SLACK_SELF_USER_IDS`  | Further user ids that are this app, refused as echoes.                                                  |
| `SMITHERS_SLACK_API_BASE_URL`   | A fixture server, for tests.                                                                            |

`Config.resolve` holds each token as `Redacted`, so a logged config prints
`<redacted>`. `Config.policy` reads the four id lists and refuses a policy
that would admit nothing: it needs a workspace and at least a person or a
conversation.

## Receive the owner's messages

```ts
import { Slack } from "@smthrs/integrations"
import { Effect } from "effect"

const policy = Slack.Config.policy()
const source = Slack.SocketSource.make({ policy })

const intake = source.run((events) =>
  Effect.forEach(events, (event) => routeToFlow(event, Slack.SocketSource.idempotencyKey(event)))
)
```

Replace `routeToFlow` with your own dispatch, typically `Control.signal` or a
flow start with the idempotency key as its dedupe key.

Admission is fail-closed, in this order: the workspace must be listed; the
conversation must be listed, or be a direct message (`D…`) while
`allowedUserIds` is set; a bot's or this app's own message is refused as an
echo; and when `allowedUserIds` is set the author, or the person who pressed
a button, must be one of them. Everything refused is acknowledged and dropped,
so Slack does not redeliver it.

The envelope is acknowledged only after your handler succeeds. A handler that
fails ends `run` without acknowledging, and Slack delivers the event again. A
redelivery carries the same `slack:<team>:<event id>` key; the source drops
one it already handled in this process, and the durable deduplication is the
key you pass on. Slack's `disconnect` frames reconnect at once; a dropped
connection reconnects after a pause; `link_disabled` ends `run` with
`permission-denied`.

## Reply in the thread, as a role

Durable replies run as actions over a connection. For one app configured from
the environment:

```ts
const connections = Slack.Connections.layerFromEnvironment({ containers: ["*"] })
const actions = Slack.Actions.layer.pipe(Layer.provide(connections))
```

`containers: ["*"]` lets the actions post to any conversation, including an
owner's direct message whose id is not known in advance. List channel ids
instead to confine them.

Inside a flow:

```ts
yield * Slack.Actions.PostMessage.call({
  connectionId: "slack",
  channel: message.channel,
  threadTs: message.ts,
  text: "On it.",
  key: `${runId}/ack`,
  persona: { username: "Lead", iconEmoji: ":compass:" }
})
```

`persona` shows the post under that name and icon; it needs
`chat:write.customize`. `key` is stamped into the message metadata. The post
is irreversible and Slack takes no idempotency key, so a post whose answer
was lost fails with `outcomeUnknown: true` and is not repeated. Before
posting again, run `Slack.Actions.Reconcile` with the same key: only
`absent` makes a resend safe; `inconclusive` means the page budget ran out.

## Ask for approval with buttons

```ts
const token = Slack.Approval.token(`${runId}/merge`)

yield * Slack.Actions.PostMessage.call({
  connectionId: "slack",
  channel,
  threadTs,
  text: "Merge?",
  blocks: Slack.Approval.blocks({ mode: "approve", token, allowedUserIds: policy.allowedUserIds }),
  key: `${runId}/merge-prompt`
})
```

A press arrives on the same source as an `integration:slack:block_actions`
event. `Approval.pressedToken(payload)` names the prompt it belongs to, and
`Approval.decision(payload, spec)` answers `Decided` only for an allowed
person's press of an offered button; any other press is `Ignored` and the
approval stays pending. Update the prompt afterwards with
`Slack.Actions.UpdateMessage`.

## Credentials from the broker

A host that keeps tokens in the control plane's credential store builds the
connection with `Slack.Connections.fromConnection`: the bot token is the
connection's `credential`, the app token an optional `appCredential`. Each
call resolves its token through `Connection.resolveSecret`, so the host's
`authorize` decision runs before the broker and a revoked credential takes
effect on the next call.

## The Events API door

A host with a public URL can take deliveries over HTTP instead:
`Slack.Webhook.channel({ policy, … })` verifies the `v0` signature and the
timestamp skew before decoding, answers `url_verification`, and derives the
same idempotency keys. Block Kit interactions still need Socket Mode or the
app's interactivity URL.

## Conversation history as records

`Slack.Sync.make({ channel, … })` is a `Core.Sync` adapter over
`conversations.history` and `conversations.replies`. It writes messages as
source records scoped by conversation type, tracks recent threads, and maps
`message_changed` and `message_deleted` events to new versions and
tombstones through `Slack.Sync.eventRecord`.
