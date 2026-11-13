---
"@smthrs/plugin": patch
---

Attribute synchronous plugin layer build failures, restrict argument keys to the field grammar and keep arbitrary manifest keys out of diagnostics, and require declared dependencies for other plugins' flows. Export the loader's five supported contribution points as `loadablePoints` and `LoadablePoint`, and use them for host declarations.
