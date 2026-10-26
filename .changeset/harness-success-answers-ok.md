---
"@smthrs/harness": patch
---

A successful `ctx.call` whose value is an object or array also answers `.ok` as `true`. A failure resolves
`{ ok: false, error }`, and the guard models write against it is `if (!result.ok)`: on a bare `{ path, bytes }` it read
every success as a failure, and the cell went on to `ctx.done` that it couldn't. The property is not enumerable, so
printing, JSON, `Object.keys`, spreading and the variables panel see the value as the flow answered it, and a value
with its own `ok` keeps it. Null and primitive values are unchanged.
