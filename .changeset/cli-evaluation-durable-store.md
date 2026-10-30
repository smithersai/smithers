---
"@smthrs/cli": patch
---

Allow embedded evaluations to supply a scoped durable store. Refuse unsettled runs without publishing an artifact, and resume their admitted identity after persistence recovers.

Select the real Node or Bun adapter through an invocation-local Effect host service, without changing process globals.
Embedded invocations provide this identity through `runtime.host`.
