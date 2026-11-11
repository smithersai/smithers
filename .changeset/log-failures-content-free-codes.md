---
"@smthrs/observability": patch
---

`LogFailures` no longer reads a line's code from the `reason`, `error` or `name` annotations by default: their values are as often a person's name, a repository or prose as a code, and every code becomes a metric attribute. A program whose annotations there are codes lists them in `codes`. The `Otel`, `NodeOtel` and `BrowserOtel` docs now say those layers do not redact; only `Otlp.layer` and `Otlp.layerFetch` do.
