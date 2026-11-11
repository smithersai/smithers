---
"@smthrs/build": patch
---

`Runtime.makeNoop`, `PackageManager.makeNoop` and the store manifest no longer use Node's `Buffer` global to bound text,
so these browser-bundleable seams run in a browser or a Worker without Node compatibility instead of throwing
`ReferenceError: Buffer is not defined`.
