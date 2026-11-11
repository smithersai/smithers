---
"@smthrs/cli": minor
---

Host pattern flows from an installed CLI. A flow file now imports
`@smthrs/patterns` and `@smthrs/integrations` from the CLI's own installation,
so `smthrs flow start` runs a Burndown over a repository's issues in a project
that installs nothing. The new guide prints one complete flow file.
