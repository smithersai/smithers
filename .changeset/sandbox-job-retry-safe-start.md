---
"@smthrs/sandbox": patch
---

`Sandbox.job` start is retry-safe and runs on hosts without `setsid`. A start that fails before its worker runs
removes the job directory, so a retry with the same key launches instead of answering a job that never started as
`Lost`; a start that finds a directory whose launcher died takes the launch over. Without `setsid`, as on macOS, the
worker leads a process group of its own through `/bin/sh` job control, and where neither exists start fails naming
the missing process group.
