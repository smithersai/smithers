---
"@smthrs/flow": patch
"@smthrs/engine": patch
---

Allow an action's annotations to retain its prior cache declaration for an explicitly backward-compatible schema extension. Current decoders still validate results, and ordinary schema changes remain cache misses. The agent uses this for optional physical-call receipts so existing model answers retain their exact keys.
