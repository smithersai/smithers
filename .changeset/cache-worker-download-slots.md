---
"@smthrs/build": patch
---

The hosted cache Worker admits sixteen artifact downloads per isolate instead of sharing two transfer slots with
uploads. A download streams its R2 body and buffers no artifact, so the two-slot ceiling bounded nothing it was meant
to bound and capped every cold restore at two streams. Uploads, which buffer up to 16 MiB each, keep their two slots.
The self-hosted service, which reads each artifact whole from Postgres, keeps two transfers of either kind.
