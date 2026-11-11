---
title: "Error code reference"
description: "The integration error codes, their raise sites, and caller actions."
sidebar:
  order: 1
---

The public `SmithersErrorCode` union contains `INVALID_INPUT` and
`INTEGRATION_ERROR`. These are the codes the current integration helpers and
adapters raise.

## Summary

| Code                | Meaning                                                                        | Caller action                              |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `INVALID_INPUT`     | A signal service or event segment is empty after trimming or contains a colon. | Correct the segment before retrying.       |
| `INTEGRATION_ERROR` | A provider call, webhook or listener operation failed.                         | Inspect `reason` and the delivery outcome. |

[`smithersErrorDefinitions`](../api.md#smitherserrordefinitions) exports the
runtime definition table.

## INVALID_INPUT

The call is invalid. The integration package constructs this code in the two
checks in `requireSegment` in
[`core/SignalName.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/integrations/src/core/SignalName.ts).
`Core.SignalName.eventName(service, event)` validates both segments;
`Core.SignalName.receivedBy(service)` validates the service segment.

| Check                                                    | `details`                                                            | Caller action                          |
| -------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| The segment is empty after trimming, or is not a string. | `{ service: value }` or `{ event: value }`, with the original value. | Supply a non-empty string.             |
| The trimmed segment contains `:`.                        | `{ service: value }` or `{ event: value }`, with the original value. | Remove the separator from the segment. |

Correct the argument; retrying the same input cannot fix it. Custom adapters
can raise this code with their own safe details.

## INTEGRATION_ERROR

[`Core.IntegrationError`](/api/integrations) carries `reason` and a safe details
record. Current reasons are `invalid-config`, `invalid-signature`,
`decode-failed`, `poll-failed`, `delivery-failed`, `credentials-missing`,
`permission-denied`, `listener-conflict`, and `rate-limited`.

The construction site is the `IntegrationError` constructor in
[`core/IntegrationError.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/integrations/src/core/IntegrationError.ts),
with signature `(reason, message, details?, options?)`. It sets
`code` to `"INTEGRATION_ERROR"`, stores `reason` as a typed field, and passes
`{ reason, ...details }` to the base constructor for a frozen shallow copy.
Additional details are supplied by the adapter; common classification fields
are `retryable` and `outcomeUnknown`. A supplied `details.reason` overrides the
copy in `details`, so the typed `reason` field is the constructor's classification.
`options.cause` is forwarded without becoming an enumerable field.

Use `Core.IntegrationError.isIntegrationError` to refine a failure across module
copies. `isRetryable` reads the adapter's retry classification; a retryable
failure alone does not make an ambiguous outbound write safe to repeat.
`outcomeUnknown` means the provider may already have applied it. Reconcile
against its durable receipt before attempting another write.

`toUnauthorized` and `toInvalidInput` map to control-plane errors using
`summary`, so the documentation URL does not enter the transport response.

At a durable action boundary,
`Core.ActionFailure.fromIntegrationError` converts the class to
`IntegrationFailure`, with its reason, bounded message, retryability and
available outcome details. `toIntegrationError` converts it back. An
unrecognized value becomes a conservative non-retryable failure rather than a
defect in the converter.
