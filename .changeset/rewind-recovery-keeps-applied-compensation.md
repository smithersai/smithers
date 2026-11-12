---
"@smthrs/time-travel": patch
---

Rewind recovery no longer undoes or misrecords durable work. A rewind audit that recorded its journal generation is judged committed by its archive row alone, so a committed rewind whose run was resumed and appended past the frame is no longer rolled back; recovery leaves that audit open as `Busy` instead of resetting the run state behind its journal. A compensation whose own cleanup failed closes the audit `terminal_failure` with `rollbackFailure` and the receipts still applied, instead of `rolled_back` with none. Recovery closes an audit whose detail it cannot decode by status alone and keeps the stored detail.
