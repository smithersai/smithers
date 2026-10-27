---
"@smthrs/triggers": patch
---

Validate cron interval endpoints before searching or applying a zero limit. Invalid dates produce invalid_options with the offending endpoint path instead of a fabricated catch-up overflow.
