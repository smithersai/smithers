---
"@smthrs/integrations": major
---

Remove the `@smthrs/integrations/core/IssueSync` subpath. It drove the backend's `issues/sync` events and deliveries
routes, which were removed with the Go backend, and nothing imported it. Importing the subpath now fails to resolve.

RC releases carry no stability commitment ([RELEASE_SUPPORT.md (MVP compatibility changes)](../RELEASE_SUPPORT.md#mvp-compatibility-changes)).
