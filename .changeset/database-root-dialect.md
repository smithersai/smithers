---
"@smthrs/database": patch
"@smthrs/platform-cloudflare": patch
---

The `@smthrs/database` root now exports `Dialect`, the SQL fragments that read the same on SQLite and PostgreSQL, so a host package registers its read transactions without a deep import. `@smthrs/platform-cloudflare`'s Durable Object database imports it from the root.
