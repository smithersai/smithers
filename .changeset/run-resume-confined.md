---
"@smthrs/control": patch
---

`Run {_tag: "Resume"}` is confined like `Resume`: a principal whose `RunVisibility` does not see every run gets
`RunNotFound` for a run it did not launch, instead of claiming and restarting it. `RunInput` gains the server-stamped
`reader` field.
