---
title: "Durable actions"
description: "What makes a client call a journaled flow step: plan nodes, implementation layers, the irreversible tier, and the IntegrationFailure schema."
sidebar:
  order: 3
---

A client is an ordinary Effect service. An action is what makes one of its
calls a step of a durable flow: a plan can name it, the journal can record
its result, and a restart replays the recorded result instead of posting a
second comment. For the underlying vocabulary of flows, actions, and plans,
see [flows, actions, and plans](/docs/concepts/flows-actions-plans/) and
[the flow API](/api/flow).

## Declaration, call, layer

Each provider declares its actions with `Action.make`: its tag, its payload
schema, its success schema, and `Core.ActionFailure.Failure` as its error
schema.

| Action                           | Tag                                    |
| -------------------------------- | -------------------------------------- |
| `GitHub.Actions.CommentOnIssue`  | `integrations/github/comment-on-issue` |
| `GitHub.Actions.AddLabels`       | `integrations/github/add-labels`       |
| `GitHub.Actions.UpsertComment`   | `integrations/github/upsert-comment`   |
| `GitHub.Actions.CheckRun`        | `integrations/github/check-run`        |
| `GitHub.Actions.LinkPullRequest` | `integrations/github/link-pr`          |

A flow body calls `CommentOnIssue.call(payload)`, which records a plan node
and runs nothing. The node demands a requirement that only the matching
implementation layer answers, so a composition that forgot the layer fails to
compile rather than at run time. `GitHub.Actions.layer` implements the actions
over the provider's client in context; the client is supplied separately,
through its own `layer`.

## The irreversible tier

Every action is `tier: "irreversible"`. The remote side has acted by
the time the call returns: the comment is visible, the issue notifies its
team, the message may already have been read. Deleting the evidence
afterwards is a different call with a different outcome, so the engine never
retries an unkeyed one on its own.

## The engine is the only retry

The clients never repeat a request. Every retry is the flow engine's: the
`retryPolicy` of the step that made the call decides whether there is another
attempt, and its attempt count is durable, so a process that dies between
attempts resumes on the next one instead of starting over. What the client
owns is the classification that policy reads:

- A rate limit is `retryable` for every method. A refused request was not
  performed, so repeating it is safe. The server's `Retry-After`, or for an
  exhausted budget its `x-ratelimit-reset`, capped at one minute, becomes
  `retryAfterMillis`, and the engine waits that instead of its backoff.
- A 5xx or a dropped connection on a read is `retryable`, with a 5xx's
  `Retry-After`.
- A 5xx or a dropped connection on a write (a POST, PATCH, PUT, DELETE, or a
  GraphQL mutation) is not. The provider may have committed it and lost the
  answer, so the failure reports `outcomeUnknown` rather than posting the
  comment twice. A caller that knows its endpoint is idempotent opts in with
  `retryUnsafeWrites` on `GitHubClient.request`.

`make(...).ingest` from `@smthrs/integrations/core/IssueSync` also makes one
request per call. An intake
conflict rejects with `status: 409` and preserves the response's `retryAfter`
header; it neither acknowledges the event nor calls `onMessage`. A durable
caller decides whether to retry and supplies the same provider delivery
identity on the next attempt.

`CommentOnIssue` declares no retry policy, so a rate-limited comment fails
with the server's `retryAfterMillis` and a flow may call again once it has
passed.

## Keyed write-back

The GitHub write-back actions
read before they write, which makes a repeat safe. They declare an
`idempotencyKey` and `Core.ActionFailure.retryPolicy`, so the engine repeats
one after a rate limit, a lost answer, or a process that died mid-step. One
write reaches GitHub at most three times:

- `AddLabels` adds only the labels the issue lacks.
- `UpsertComment` finds its comment by a hidden `<!-- smithers:key=... -->`
  first line and edits it. Without a `key` the comment is the running
  execution's, so each run keeps one progress comment and never takes over
  another run's; a `key` is for a domain key recorded before the write.
- `CheckRun` requires the authenticated App’s numeric `appId`, finds its run
  by that App and `external_id`, and updates it; without a `key`,
  the running execution's run of that name. Writing check runs needs a GitHub
  App installation token.
- `LinkPullRequest` uses GitHub’s `addCloseIssueReferences` mutation, preserving
  the description. Existing closing keywords and manual links are left alone.
  Servers without this mutation fail without a description edit.

A listed record that cannot be decoded fails reconciliation before any write;
it is never silently discarded as evidence that a previous write is absent.

GitHub does not enforce the comment marker or `external_id` as unique, so a
write still in flight when the repeat reads can land after it and leave two.
The retry backoff narrows that window; it does not close it.

## The journaled failure

`IntegrationError` is a class, and a class cannot cross the journal. A
durable action has to write its failure down and read it back after a
restart, so the action boundary uses a schema instead:
`Core.ActionFailure.Failure`, two tagged errors with the same fields.

The engine decides retries from a failure's tag, against the policy's
`nonRetryable` list, so the classification crosses as the tag.
`RetryableIntegrationFailure` is a failure another attempt may clear: a rate
limit, a 5xx or lost connection on a repeatable request, or a lost write in a
step that reads before it writes. `IntegrationFailure` is every other failure,
and `retryPolicy` lists its tag as non-retryable, so the engine reports it at
once. The client decides which, once; nothing else re-decides.

The fields are the ones an operator reads after a restart:

| Field                 | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `reason`              | The machine-readable classification, from the `IntegrationError` list.      |
| `message`             | Provider text already safe to persist, capped at 512 characters.            |
| `retryable`           | Whether another attempt could clear it.                                     |
| `outcomeUnknown`      | The write may already have been applied. Absent when it definitely was not. |
| `deliveredMessageIds` | Ids a partially completed external delivery already produced.               |
| `retryAfterMillis`    | How long the server asked to wait before another attempt.                   |

`outcomeUnknown` is the difference between "this did not happen" and "nobody
knows", and an operator deciding whether to run the step again needs it, so
it crosses the journal rather than living only on the client error.

`retryAfterMillis` crosses the journal under the name the engine's
`RetryPolicy.decide` reads, so a resumed run still waits what the server asked.

The conversion into the schema is total. `fromIntegrationError` reports any
failure that is not a well-formed `IntegrationError` (a forged name, a reason
this build cannot encode, a value that cannot even be stringified) as a
non-retryable `delivery-failed` rather than throwing inside
`Effect.mapError`, where a throw would become a defect. The persisted text is
the error's `summary` rather than its `message`, so one provider's failures
do not carry a documentation URL the others' do not. `toIntegrationError`
converts back to the class, for a caller that wants `isRetryable` or the
control-plane mappings.

## Write your own action

An application that needs an endpoint these actions do not cover writes its
own `Action.make` over the same client, with `error: Core.ActionFailure.Failure`,
`retryPolicy: Core.ActionFailure.retryPolicy`, and its client errors mapped
with `fromIntegrationError`. Pass `{ reconciles: true }` only when the step
reads before it writes, so a lost write is safe to repeat. That is the intended extension point, not
a gap: the client is the reusable part, and the action is a thin declaration
plus a `toLayer` implementation. The [API reference](../api.md) lists the
client methods available to build on.
