---
"@smthrs/patterns": patch
---

`Saga.run` reports compensations that fail while the saga is interrupted. An
interrupted run cannot fail with `compensation_failed`, so it now logs the
failed step ids at error level and adds them to the current span as
`saga.compensation_failed`. Before, those failures were dropped silently.
