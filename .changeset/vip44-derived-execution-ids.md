---
"@smthrs/flow": patch
---

The opt-in `Flow.derived` execution-id source sorts every `Set` and `Map` in the payload with `@smthrs/canonical`'s `sortCollections` before encoding it, so equal collections inserted in different orders derive one execution id (VIP-44). A payload that holds no set or map is not copied and keeps its id; a test pins one. Uses the library catalog's `@smthrs/canonical` and `@smthrs/flow` entries.
