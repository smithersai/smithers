---
"@smthrs/effect-electric": minor
---

`ElectricCollection` gains `evict`: for a reader who may no longer read the
shape, it drops every row the collection holds, in memory and, with `persist`,
on the device, in one sync transaction that also stores Electric's `reset`
resume state. Every request in flight is aborted, nothing Electric was still
applying lands, and the shape syncs again from the start once its
`ShapeSource` next answers (keep it waiting with `ShapeSource.gated`). The
next collection made over the same id restores nothing. A persisted
collection nobody read yet evicts what the device stored too.

```ts
const notes = yield* ElectricCollection.make({ id: "notes", schema, getKey, shape, persist: { schemaVersion: 1 } })
// The reader lost access: what they may no longer read leaves the device.
yield* notes.evict
```
