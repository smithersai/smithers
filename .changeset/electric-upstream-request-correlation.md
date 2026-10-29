---
"@smthrs/effect-electric": patch
---

Preserve bodyless upstream responses, including retryable 503 refusals, without turning them into broken streams. Send the proxy's generated request correlation upstream so a private gateway can attribute failures without recording request content.
