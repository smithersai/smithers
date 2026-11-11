---
"@smthrs/observability": patch
---

`Logger.layerPrettyDev`, `Logger.layerStructuredJson` and `Logger.layer` now install their logger through `RedactedLogger.wrap` from `@smthrs/journal`. The journal's redaction rules run over each line's message, cause and log annotations before it reaches the console, so a credential a log line quotes is written as a marker instead of in clear. A logger passed to `Logger.layer` receives the redacted event.
