---
"@smthrs/build-cli": patch
---

`ci --remote` runs on an `S.Remote.Http` remote through `@smthrs/sandbox`'s `HttpSandbox`: each part asks the service for
a fresh machine with the declared limits and destroys it after. An unset token is refused before the tree is packed or
the service contacted.
