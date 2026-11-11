---
"@smthrs/triggers": patch
---

Keep firing a trigger after another scheduler on the same store supersedes a run this scheduler launched or recovered. The refused settlement (`stale_owner`) used to fail that trigger on every later tick until the process restarted; the scheduler now drops its stale entry and claims the next occurrence.
