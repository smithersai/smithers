---
"@smthrs/canonical": patch
---

`sortCollections` keeps its own stack and ranks a shared object once. A set or map entry nested thousands of levels deep now sorts the same under every insertion order and on every runtime, where it used to keep insertion order once the call stack ran out, so one payload could derive two identities. A collection nested past the call stack is sorted and no longer throws `RangeError`, and a chain of shared references costs its objects, not its expanded tree. The order of every value that sorted correctly before is unchanged. A `RangeError` raised while an object is inspected now propagates and never becomes a rank.
