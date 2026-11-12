---
title: Preserve Responses stream errors with null codes
status: completed
area: model
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4722
---

The Responses stream decoder rejected a provider's nullable error code before
classification, replacing its message with an invalid-output failure.
The internal decoder now accepts nullable error codes and messages, letting
the existing normalization preserve the provider's message and reset metadata.
This repairs the existing model adapter without adding a library or changing
public constructors.

The [Responses streaming reference](https://developers.openai.com/api/reference/resources/responses/streaming-events#error)
documents nullable error codes. Both Responses protocols now cover null fields,
nested errors, fallback messages and retryability. Route tests exercise a
failure after partial text through the real executor with an injected HTTP
service. Unrecognized provider wording retains its existing
`unknown` classification and message.

All five regression cases fail with the original schema and pass with the
fix. The full package suite passed 1,150 tests with nine opt-in cases skipped,
with 100% statements, branches, functions and lines. Package typecheck and lint
passed. Validation loads VibeLang with `NODE_OPTIONS=--import=vibelang/register`
and runs lint before compilation creates declaration shims. Independent code
reviews found no blocking issues.
