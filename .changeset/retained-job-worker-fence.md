---
"@smthrs/sandbox": patch
---

Fence retained workers before publishing their PID or opening output files so a
redelivered detached launch cannot run the command twice or corrupt its output.
Record PID-only launch attempts for diagnosis.
