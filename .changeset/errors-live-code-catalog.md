---
"@smthrs/errors": patch
---

During the `1.0` release candidate, remove the unused `TELEGRAM_API_ERROR`,
`TELEGRAM_INIT_DATA_INVALID` and `UNSUPPORTED` codes from the runtime catalog
and `SmithersErrorCode` union. Callers using those literals must update their
code; `isSmithersErrorCode` and `hasSmithersErrorShape` now reject them.

Document the signal-name validation failures that raise `INVALID_INPUT`, and
remove references to the nonexistent `redactBotToken` export. Callers must
redact credentials before constructing an error.
