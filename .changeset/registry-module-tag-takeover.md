---
"@smthrs/registry": patch
---

`Executable.fromDescriptor`, `catalog` and `Refresh` refuse a module flow whose `Flow.make` tag differs from its registry name and is a tag something else answers to: another entry's registry name, a delegate the host registered (including `agent`), a tag in the registry's own `registry/` namespace, or a tag another loaded entry already declared. The refusal is `invalid_module`. The runtime runs a tag's newest registration, so such a module, for example a pack flow declaring `Flow.make("review")`, used to replace the project flow `review` or the host's agent delegate. A module whose tag matches its name, or whose differing tag nothing else uses, loads as before.
