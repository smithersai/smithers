---
"@smthrs/effect-tanstack-db": minor
---

A program logs its persisted synced collections' first roles in one line, not one per collection. A browser tab with
23 synced collections wrote 23 Info `persisted sync role` lines on every load.

- `Persistence.reportRoles` waits until every persisted synced collection made so far has taken its first role, or
  stopped without one, then logs `persisted sync roles` at Info with `writers` and `watchers` and answers them as
  `Persistence.Roles`. A first role comes as soon as the lock answers whether it is free, so a watcher's does not wait
  for the program holding the lock. Call it once, after building the collections.
- A first role the report counts is now logged at Debug. A change of role, such as a watcher taking the lock when the
  writing program closes, and the first role of a collection made after the report, stay Info.
- `Persistence.syncRoles` still counts every role.

```ts
const booted = Effect.gen(function*() {
  // ...build the program's collections, then:
  const { writers, watchers } = yield* Persistence.reportRoles
})
```
