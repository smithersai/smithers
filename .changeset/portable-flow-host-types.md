---
"@smthrs/engine-store": patch
"@smthrs/run-store": patch
---

Allow portable flow consumers to typecheck without Node ambient declarations.
Retain the existing optional working-directory reflection and same-host PID
probe behavior, including conservative liveness on an unavailable host.
