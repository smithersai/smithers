# @smthrs/errors

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/errors/docs

`SmithersError` and the two error codes the Smithers integration adapters
raise.

```bash
npm install @smthrs/errors@next effect
```

`@smthrs/integrations` is its only consumer in Smithers; every other package
states its failures as `Schema.TaggedError` classes of its own.

## What it is for

An integration talks to somebody else's API, so its failures have to remain
readable to a human, classifiable by a caller, and safe to write into a log.
`SmithersError` provides stable error fields and stores caller-supplied context
verbatim. It does not redact values. Integration constructors must remove
credentials before constructing it.

- `code` classifies the failure (`INVALID_INPUT` or `INTEGRATION_ERROR`).
- `summary` is the message without the appended documentation URL.
- `details` carries caller-supplied context. The top-level record is copied and
  frozen at construction, so adding, removing, or replacing a top-level key on
  the caller's object afterwards cannot change it. Nested values are shared by
  reference and are not deep-frozen, so a caller must not mutate a nested
  record it has attached. Integration constructors must remove credentials
  before attaching the record.
- `cause` is stored verbatim and is not redacted. Callers must redact provider
  text, including bot tokens in URLs and API keys in messages, before attaching
  it.
- `docsUrl` points at the reference page for the code.

```ts
import { isSmithersError, SmithersError } from "@smthrs/errors"

const error = new SmithersError("INVALID_INPUT", "invalid integration signal name")
error.code // "INVALID_INPUT"
error.message // "invalid integration signal name See https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md"
isSmithersError(error) // true
```

## Codes

`SmithersErrorCode` is derived from the keys of the exported runtime table
`smithersErrorDefinitions`, so the set is closed and an exhaustive `switch`
over `error.code` stays exhaustive. Smithers 0.x carried 180 codes for an
engine that no longer exists; 1.0 keeps the two the integration trees raise.

| Code                | Raised when                                                                                                                                            | `details`                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `INVALID_INPUT`     | An integration signal service or event segment is empty after trimming or contains a colon.                                                            | `{ service: value }` or `{ event: value }`, naming the invalid segment |
| `INTEGRATION_ERROR` | An integration client, webhook source, or listener reconciliation fails. `reason` classifies the failure so a caller can map it to a transport status. | `{ reason, ...providerSafeDetails }`                                   |

Current construction sites, the `details` they attach, and the caller's move are at
https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md.

## Documentation

https://github.com/smithersai/smithers/tree/main/packages/errors/docs covers the error shape and its redaction contract,
handling a failure from the caller's side, raising one from an adapter,
detecting one across module copies, every code with its current construction sites, and the
API. The procedure for adding a code is at
https://github.com/smithersai/smithers/blob/main/packages/errors/docs/guides/add-an-error-code.md.
