---
"@smthrs/crypto": minor
"@smthrs/engine-store": patch
---

`DisasterRecovery` backup, verify, and restore hash and copy every file in 1 MiB chunks with the new `@smthrs/crypto` `digestStream`, so a database or blob of 2 GiB or more no longer fails with `io` whatever `maxFileSizeBytes` says. The operations no longer require Effect's `Crypto` service.
