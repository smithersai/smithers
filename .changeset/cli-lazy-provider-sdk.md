---
"@smthrs/cli": patch
---

Load the Claude Code SDK only when selecting that provider. A broken provider
installation leaves version, help and other providers usable; selecting Claude
Code returns a typed error naming the package it requires.

Embedded hosts can use the Effect CLI entry to preserve injected services and
wait for command cleanup on interruption. SDK failures retain safe diagnostic
codes and remain configuration errors when that provider supplies the judge.
