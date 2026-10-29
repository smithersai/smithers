---
"@smthrs/build-cli": patch
---

Report an artifact target in a known-red list through the existing tagged KnownRedError instead of introducing a new plain Error. Preserve the refusal and operator message.
