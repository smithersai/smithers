---
"@smthrs/platform-node": patch
---

The atomic filesystem helper is re-staged only when its bytes match the first staged copy. A workspace-local helper that a flow rewrote is refused with `helper_inside_workspace` after its staged copy is removed, instead of being copied out and run outside confinement.
