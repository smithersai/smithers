---
"@smthrs/build-cli": patch
"@smthrs/platform-node": patch
---

A fresh install keeps the results of its first run. A tool run that keys an installed tree (`TsBuild`, `Typecheck`, `Vitest`, `EsLint`, `Dprint`, `NodeTest`) now finds the tree's keyed entries read-only even when the workspace does not confine its build, so a launcher that links its binary into its own package on first use writes nothing and the tree stays the one the plan measured. A changed tree is named on the `not cached` line by unit and path, and the run's summary counts results not stored by reason (`notStored`). `ProcessSandbox.writeProtected` and `writeProtectionRefusal` are the mechanism. Uses the library catalog's `@smthrs/platform-node` entry for confined processes.
