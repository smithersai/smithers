---
"@smthrs/build-cli": patch
"@smthrs/build": patch
---

Select audited confined native process targets and declarative file groups by
their declared inputs instead of unrelated package siblings. Keep unconfined
and incomplete contracts conservative, and deny undeclared sibling reads.
