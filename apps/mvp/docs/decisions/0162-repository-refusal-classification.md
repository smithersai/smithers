# Repository refusal classification

2026-11-04 · GH-4 · repo-refusals

GitHub metadata 404 is a definite denial of public readability, identical for an absent repository and a private repository the credential cannot access. It does not prove which case occurred. Visibility readers retain that negative receipt for the existing 60-second window; the database public-copy gate records it as non-public. A later observation may replace it under the existing timestamp ordering.

A 5xx, transport failure, timeout, malformed answer, authentication failure, or rate limit remains unavailable. Rate-limit and retry information survives the refs handler. Visibility refusals name the typed metadata stage and upstream status; logs correlate with the request ray and metrics contain bounded dimensions only.

A missing local ready head is not proof of either repository existence or absence. Refs consult the existing shared About reader before answering not-imported: confirmed public metadata permits 204, a missing/private refusal gives 404, and an upstream failure stays retryable. Tree and About retain their existing not-found behavior. The role route and notification gate consume the same bounded visibility denial, so repeated feed reads do not repeat missing-repository metadata calls.

This repairs existing access and repository infrastructure; it introduces no new plugin or dependency. Catalog entries: Effect HttpClient and the @smthrs/integrations GitHub client, existing @smthrs/ui home components.

Only a full repository route owns the refusal page header and Connection live region. Inline repository gates remain headerless. A repository home uses its existing header; a home rendered alone keeps its own connection status. The visitor notification test opens `/app`; the marketing landing keeps no notification control.
