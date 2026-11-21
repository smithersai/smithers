---
"@smthrs/build-cli": patch
---

A uv step recorded with `smthrs-observe` is reused when nothing it read changed, and passes recorded as it passes plain.

- uv makes each directory of a package it unpacks as `dir/`, with a slash at the end. `smthrs-observe` wrote that call as failing, so moving the directory into uv's cache did not carry the files the step made, and every uv step ran again at every commit: `.../RECORD changed while it ran`. A name with a slash at its end is now the name before the slash, and only a directory is made there.
- A process `smthrs-observe` traced (one that sets a signal handler without `SA_RESTART`, as Python does) stayed its tracer's to reap for a moment after it ended, while its pidfd already said it had ended. A parent that waits as tokio does then panics (`pidfd is ready to read, the process should have exited`): uv failed so in a step run by tox, the step "failed while its reads were recorded", and ran unrecorded for a day. A traced thread is now let go when it starts to end.
