---
"@smthrs/build-cli": patch
---

Create an empty result-cache directory in scratch workspaces so Linux can seal it read-only while checking generated files and Diff targets. Keep the real result cache separate and preserve write-set and symlink confinement.
