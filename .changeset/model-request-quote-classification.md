---
"@smthrs/model": patch
---

`classifyHttpStatus` ignores quoted spans in a 400, 404, 409, 413 or 422 message when it looks for limit, sign-in and safety words, so a malformed request that names a tool like `get_rate_limit` classifies as `invalid_request`, not a retryable `rate_limited`. Authentication words on a 5xx page no longer override the server fault.
