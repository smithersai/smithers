# 0133: Head discovery and repository sync share the refs identity

Date: 2026-10-31. Status: accepted.

Head discovery stored a refs listing under repository id and head SHA, while
Electric's repository row also included `refsChangedAt`. The same repository
and head therefore requested `/refs` twice, including on a click after hover.

The refs contract carries `refsChangedAt` as nullable Postgres timestamp text,
the same representation Electric delivers. `Repos.readyHead` reads it without
converting to epoch milliseconds, preserving microseconds and rendering in UTC
independently of the SQL session timezone and date style. Both ordinary and
authorized ephemeral listings carry it. The tab's local head row keeps it and
both head discovery and the synced row use `refsKey(id, head, refsChangedAt)`.
Null remains a valid revision for rows whose refs have never changed.
The response schema also decodes older durable results without the revision;
current server responses always carry it, including when null.

This repairs the repository reader's existing core infrastructure. It uses the
catalog's `@smthrs/artifacts` immutable cache, `@smthrs/effect-electric` sync and
`@smthrs/effect-tanstack-db` collections; it adds no library or plugin interface.
Existing `repo.refs` HTTP metrics distinguish duplicate requests from cache hits
that make no additional forge read. Regression tests count those HTTP reads,
using real Postgres and Electric with delayed shape delivery, and retain the
existing invalidation test for a new branch while the head stays fixed.
