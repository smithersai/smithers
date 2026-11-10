---
"@smthrs/engine": patch
"@smthrs/canonical": patch
---

`FlowEngine.layerMemory` copies a payload after `sortCollections`, so a body sees every `Set` and `Map` in the sorted order its identity hashes, and compares joins with `Flow.payloadSnapshot`, so equal sets and maps in any insertion order join one execution (VIP-44). `sortCollections` never throws: an object it cannot inspect, such as a revoked proxy, is an unranked leaf. Uses the library catalog's `@smthrs/canonical` and `@smthrs/flow` entries.
