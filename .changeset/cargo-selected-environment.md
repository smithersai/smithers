---
"@smthrs/build-cli": patch
---

Resolve the workspace's Cargo executable from its selected environment, including
its Nix closure or a caller-provided `PATH`. Planning no longer falls back to a
host Cargo installation when it is absent from that environment.
