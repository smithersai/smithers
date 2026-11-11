---
"@smthrs/errors": minor
---

`SmithersError` is an Effect `Data.TaggedError` tagged with its class's own
name. A subclass such as `IntegrationError` sets its own tag and name,
`"IntegrationError"`.

- `SmithersErrorOptions` has no `name`, and `SmithersError` takes no tag type
  argument: a subclass carries its own tag instead of a name passed at
  construction.
- `_tag` is an enumerable own property, as Effect's tagged errors have it, so
  `Object.keys`, `toJSON` and `JSON.stringify` include it. `name` comes from
  the prototype.
- The constructor no longer throws a `TypeError` for a code outside
  `SmithersErrorCode`. The type closes the vocabulary, and
  `hasSmithersErrorShape` still checks it.
