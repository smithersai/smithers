---
"@smthrs/flow": minor
"@smthrs/engine-store": patch
"@smthrs/platform-cloudflare": patch
---

Every durable site that hashes or compares a flow payload now goes through `Flow.payloadSnapshot` (sort every `Set` and `Map`, then the payload's JSON codec) or `Flow.payloadPreimage` (the payload as written when it holds no set or map, else its snapshot), so none can skip VIP-44's collection sort. Child execution ids, the recorded plan's root input, handoff payloads, engine-store run admission and Cloudflare intents use them. A flow whose payload holds a set now runs instead of refusing its plan hash, and equal sets in any insertion order join one run. Payloads without a set or map keep their ids and stored bytes. Uses the library catalog's `@smthrs/flow` and `@smthrs/canonical` entries.
