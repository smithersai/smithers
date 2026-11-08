---
"@smthrs/build-cli": patch
---

One plan reads each declared file and glob once, however many targets declare it. A glob shared by thousands of targets used to walk its static prefix once per target, so `smthrs ci --plan` over 3,200 test targets sharing `cases/*.mjs` took about an hour; it now takes about a minute. Keys do not change.
