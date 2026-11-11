---
"@smthrs/patterns": major
---

An unnamed pattern's default flow tag now names the members it calls after its
bounds: `reviewLoop(maxRounds=3)` becomes
`reviewLoop(maxRounds=3)[draft, critique, draft]`. The engine resolves a flow
by its tag and runs the last registration under it, so two unnamed patterns of
one kind with equal bounds, such as two `Trellis.make` calls with one envelope,
used to share a tag, and executing one ran the other's members with no error.
Each now has its own tag. An absent optional member leaves its slot empty, and
a member tag that contains a space, `,`, `=`, a parenthesis, a bracket or `"`
is JSON-quoted. A pattern given a `name` keeps it. Code that matched a default
tag string must match the new form, and a run journaled under an old default
tag resumes only under a pattern given that tag as its `name`.

RC releases carry no stability commitment ([RELEASE_SUPPORT.md (MVP compatibility changes)](../RELEASE_SUPPORT.md#mvp-compatibility-changes)).
