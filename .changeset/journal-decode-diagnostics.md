---
"@smthrs/flow": patch
"@smthrs/engine": patch
"@smthrs/engine-store": patch
"@smthrs/platform-cloudflare": patch
---

Fail persisted journal decoding with safe typed errors and fixed-tag telemetry. JournalDecodeError reports the step, object and code version without journal values or decoder messages; rollback payloads keep the existing payload_changed refusal. Cloudflare propagates its instance identity into these diagnostics.
