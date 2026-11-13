---
"@smthrs/ui": patch
"@smthrs/views": patch
"@smthrs/ui-css": patch
---

Preserve heading hashes and parenthesized note links, recognize complete and
empty frontmatter fences, correct repository homepages and singular counts,
and keep the date on older timestamps. Preview frames discard HTML and
permission overrides; page icons are fetched on the host and returned inline.
Remove redundant sandbox and graph copy and label outgoing note links clearly.
Strengthen model-selector group and disabled assertions and remove theme tests
that did not observe theme behavior.

Remove the unused `takesRunSource`, `runSearchRef`, `runSearchPayload` and
`runSourceCommand` exports from `@smthrs/ui/run-command`; `splitRunSource`
remains available.

Saved page views accept bounded inline icons and retain legacy HTTPS values.
Page writes allow `96 KiB` while forms retain their existing limit.
