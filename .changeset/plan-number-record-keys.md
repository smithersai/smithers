---
"@smthrs/plan": patch
---

A flow or action schema may use a number-keyed record, such as `Schema.Record(Schema.Number, Schema.Number)`. `Node.schemaIdentity` prints a number key with the pattern `effect@4.1.1` gives it, alone or in a union with string and template-literal keys; it used to refuse the flow with "Invalid schema representation document". `effect@4.0.0-rc.115` refused number keys too, so no recorded step key changes. A key type neither supports is refused by name: `Unsupported index key type <tag>`, with its path.
