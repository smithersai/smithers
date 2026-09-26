---
id: builder-small-change
principal: builder
kind: accepted
task:
  objective: Make slugify keep digits between words.
  inputs: [src/slug.js]
  acceptance: ["slugify('Release 2 Notes') returns 'release-2-notes'"]
  evidence: [test command output]
context: []
expect:
  status: done
  fields: [summary, commands]
---

A small scoped change with a test-backed acceptance criterion.
