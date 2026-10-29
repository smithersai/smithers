---
"@smthrs/platform-browser": patch
"@smthrs/views": patch
---

Declare the database, TypeScript workspace compiler and QuickJS core as runtime
dependencies so consumer installs resolve the modules their public APIs load.
