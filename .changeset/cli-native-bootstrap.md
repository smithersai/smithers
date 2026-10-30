---
"@smthrs/build-cli": patch
"@smthrs/cli": patch
---

Load the CLI's own modules with Node's native TypeScript support, then enable
the declaration loader before running commands. Preserve shared Effect identity,
VibeLang loading, and typed CommonJS declaration helpers across that boundary.
Keep the first resolver's ownership when another physical copy completes
bootstrap, and leave older, fully installed resolvers intact.
