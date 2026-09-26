---
title: "X"
description: "Read an X account's mentions and direct messages as private source records. Read-only: the client can post, but no write is a durable action yet."
sidebar:
  order: 7
---

How to use the X adapter. It is **read-only** for now and is library code: no
host in this repository wires it yet. The [API reference](../api.md#x) has the
full signatures.

## Configure a client

The client speaks API v2 with an OAuth 2.0 user-context token. Like Gmail,
the token comes from the host's credential broker, never the environment:

```ts
import { X } from "@smthrs/integrations"

const client = X.XClient.make({ token, connection })
```

`X.Capabilities` maps each operation to the scopes it needs; an operation the
connection's scopes do not cover fails `permission-denied` before any
request. A rate limit longer than `maxRetryAfter` is not waited out in
process: the call fails at once as retryable, carrying `retryAfterMs`.
`SMITHERS_X_API_BASE_URL` points the client at a fixture server.

## Follow mentions and direct messages

`X.Sync.mentions({ … })` and `X.Sync.directMessages({ … })` build `Core.Sync`
adapters. Each keeps a high-water mark that moves only when a walk ends, so a
crash resumes the same page. `X.Records` maps posts and direct-message events
to `private` source records.

## Writes

`XClient.createTweet` and `XClient.sendDirectMessage` exist and report an
ambiguous failure as `outcomeUnknown` without repeating it. They are not
durable actions and have no reconcile step, so this package does not support
them for flows yet.
