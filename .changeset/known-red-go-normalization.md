---
"@smthrs/build-cli": patch
---

Known-red failure digests now normalize Go test output: `--- FAIL|PASS|SKIP: Name (1.23s)` and `FAIL|ok <package> 1.23s` durations, and the random decimal suffix `os.MkdirTemp` and `t.TempDir` give directories under a temporary root. The same Go test failure in two runs or two checkouts now has one digest, so a known-red entry can name it. Diagnostics without these forms keep their digests.
