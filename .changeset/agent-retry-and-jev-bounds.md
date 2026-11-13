---
"@smthrs/agent": patch
"@smthrs/harness": patch
---

Quota waits no longer mistake dates, clock times or thousands-separated numbers after `Retry-After` for seconds. Ambiguous values use the configured default wait.

Jev states are limited to 120 KiB of encoded JSON, matching the measured safe gateway size. Larger states are refused before a request is sent, with instructions to shorten or split the evidence.
