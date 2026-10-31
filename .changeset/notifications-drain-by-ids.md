---
"@smthrs/notifications": minor
"@smthrs/harness": minor
---

A consumer that confirms each steer it delivered can drain exactly those.

- `NotificationQueue.DrainInput.ids` delivers the pending steers named, whatever their sequences, and nothing else
  (`NotificationState.promoteIds`). An agent outside the run, which shows it read a steer only by answering after it,
  drains under this, so a steer handed over and never confirmed stays pending rather than riding along with a later one.
- `Notifications.text(notification)` in `@smthrs/harness` renders a notification as Smithers' agent reads it, as plain
  text, for an agent outside Smithers.
