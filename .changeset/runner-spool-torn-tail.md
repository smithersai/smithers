---
"@smthrs/cli": patch
---

A runner restarted after a crash that tore the last line of a job's transcript spool cuts that line off before it
writes again. The first new event no longer joins the torn line, so it survives the next restart and the host's
acknowledgement keeps advancing instead of `drain` sending the same events forever. A whole last event the crash left
without its newline is kept and ended.
