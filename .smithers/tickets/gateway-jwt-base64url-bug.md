# Gateway JWT signature comparison bug

## Problem

`src/gateway/index.ts:313-321` — JWT signature comparison uses
`Buffer.from(encodedSignature)` (UTF-8 default) instead of
`Buffer.from(encodedSignature, 'base64url')`. The `timingSafeEqual` compares
base64url string bytes, not raw signature bytes.

If a JWT signature contains non-URL-safe base64 chars (`+`, `/` instead of
`-`, `_`), the strings won't match even for valid tokens.

## Fix

Decode both signatures from base64url to raw bytes before comparing:
```typescript
const actualSignature = Buffer.from(encodedSignature, 'base64url');
const expectedSignatureBuffer = Buffer.from(expectedSignature, 'base64url');
```

## Severity

**HIGH** — valid JWTs silently rejected.
