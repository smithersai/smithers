---
"@smthrs/time-travel": patch
---

Rewinds work with only the journal and run-store schema, and forks can carry children without engine-only tables. Invalid fork frames fail before reserving an id or creating a workspace. A refused commit removes its checkout through the injected filesystem and reports cleanup failures without hiding the original error.
