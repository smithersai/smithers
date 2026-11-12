---
"@smthrs/targets": patch
---

Hand a Node runtime's declared preloads to the processes a `NodeTest`, `NodeBinary` or `Vitest` program starts. `Runtime.environment` puts them in `NODE_OPTIONS`, and the exec boundary resolves each to an absolute `file:` URL from the target's working directory, so a test's `node child.ts` that imports a `.vibe` source loads it through `vibelang/register` instead of failing with `ERR_UNKNOWN_FILE_EXTENSION`.
