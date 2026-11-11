---
"@smthrs/merge-queue": minor
---

`FileInbox`: the queue's inbox as a JSON-lines file on Effect's `FileSystem`. `FileInbox.append` is what an enqueue
command calls. A line that is not a letter is passed over and still counts toward the cursor (new `skip` letter).
