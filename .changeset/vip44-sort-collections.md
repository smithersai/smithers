---
"@smthrs/canonical": minor
---

Add `sortCollections`, which copies a value with every `Set` and `Map` in sorted order at every depth so equal collections encode to equal bytes before they are hashed (VIP-44, durable values). Entries are ordered by a stable text rank of their sorted value in UTF-16 code units; a `Map` orders by key, then value. Arrays keep their order. It walks the value, not a Schema: every own data property, enumerable or not, is visited, and copies keep their prototype, descriptors and integrity level. Uses the library catalog's `@smthrs/canonical` entry.
