---
"@smthrs/engine-store": patch
"@smthrs/platform-browser": patch
"@smthrs/ui": patch
---

Runs read like a CI system's. `RunInspection`'s run summaries carry their `origin`, the door and actor kind the engine kept when it admitted the run (`null` for a run kept before origins), on SQLite and PostgreSQL and through the browser engine's run reads. `RunInspection.list` takes `runIds` (at most 200) and `flows` (at most 64 tags) to list only those runs, so a host that indexes its runs elsewhere reads their state in one round trip. `RunList` shows trigger, branch and actor columns once any row has them, tags a row's host with `where`, and expands a row in place through `toggleHref`, `expanded` and `renderDetails`; the new `RunDetails` draws a run's jobs and steps, each opening to its log lines, a failed step open with its error code. Uses the library catalog's `@smthrs/flow` durable engine and `@smthrs/ui` entries.
