---
"@smthrs/fs": patch
---

`Route` snapshots reject accessor-backed `Option` tags and payloads in `description`,
`placement`, and `ui` with `invalid_route`, without running getters.
