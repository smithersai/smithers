---
"@smthrs/build-cli": patch
"@smthrs/cli": patch
---

Load environment add/list/view/remove with Node's native TypeScript support,
then enable the declaration loader before running commands. Durable commands
retain the established compiler before importing callback bodies so persisted
plan fingerprints survive a process restart. Preserve shared Effect identity,
VibeLang loading, and typed CommonJS declaration helpers across that boundary.
Keep the first resolver's ownership when another physical copy completes
bootstrap, and leave older, fully installed resolvers intact.
