---
"@smthrs/observability": patch
---

Redact credentials in every OTLP signal at the transport boundary, including
log bodies and annotations, nested values, creation-time span attributes and
span events. Preserve the journal policy for numeric token accounting. Public
declarations remain unchanged.
