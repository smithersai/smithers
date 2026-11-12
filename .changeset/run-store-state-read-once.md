---
"@smthrs/run-store": patch
---

A read of a run whose state has not changed no longer parses and walks the state again. `RunStore` admits each distinct
state text once, when it is written or first read, and recognises the same text afterwards; a text it has not admitted
is still checked in full. `get` on a 65 KB state went from about 100 reads a second to about 15,000.
